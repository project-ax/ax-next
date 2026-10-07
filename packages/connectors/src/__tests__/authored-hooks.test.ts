import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import type {
  ActivateAuthoredInput,
  ActivateAuthoredOutput,
  ClearAuthoredByIdInput,
  ClearAuthoredByIdOutput,
  InstallAuthoredInput,
  InstallAuthoredOutput,
  ListAuthoredInput,
  ListAuthoredOutput,
  ListAuthoredPendingAllInput,
  ListAuthoredPendingAllOutput,
  ResolveInput,
  ResolveOutput,
  UpsertInput,
  UpsertOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Authored-connector hooks through the bus against a real postgres container.
// Covers the install → list → activate path, the admin proposal queue, boundary validation, and
// the ZERO-REACH invariant: a pending authored draft is never seen by
// connectors:resolve (which reads only the LIVE registry table).
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConnectorsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

function installInput(over: Partial<InstallAuthoredInput> = {}): InstallAuthoredInput {
  return {
    ownerUserId: 'userA',
    agentId: 'agent1',
    connectorId: 'linear',
    name: 'Linear',
    hosts: ['api.linear.app'],
    slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
    usageNote: 'Drive the Linear API',
    keyMode: 'personal',
    ...over,
  };
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_authored');
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_connectors');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/connectors — install_authored_connector + lifecycle', () => {
  it('install persists a PENDING draft; list reads it back with the assembled proposal', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput({
        hosts: ['api.linear.app'],
        slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
        packages: { npm: ['@linear/sdk'] },
      }),
    );
    expect(out).toEqual({ connectorId: 'linear', status: 'pending' });

    const list = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(list.drafts).toHaveLength(1);
    const d = list.drafts[0]!;
    expect(d).toMatchObject({ connectorId: 'linear', name: 'Linear', status: 'pending', keyMode: 'personal' });
    // The flat install args were assembled into the canonical Capabilities.
    expect(d.proposal.allowedHosts).toEqual(['api.linear.app']);
    expect(d.proposal.credentials).toEqual([
      { slot: 'LINEAR_API_KEY', kind: 'api-key' },
    ]);
    expect(d.proposal.packages).toEqual({ npm: ['@linear/sdk'], pypi: [] });
    expect(d.proposal.mcpServers).toEqual([]);
  });

  it('ZERO-REACH: a pending authored draft is invisible to connectors:resolve', async () => {
    const h = await makeHarness();
    await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    // resolve reads ONLY the live connectors table — the pending draft grants
    // no reach, so the connector is not-found until a human approves + a later
    // phase materializes it into the live registry.
    await expect(
      h.bus.call<ResolveInput, ResolveOutput>(
        'connectors:resolve',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', connectorId: 'linear' },
      ),
    ).rejects.toThrow(/not found/);
  });

  it('activate flips pending → active (idempotent); list reflects it', async () => {
    const h = await makeHarness();
    await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    const a1 = await h.bus.call<ActivateAuthoredInput, ActivateAuthoredOutput>(
      'connectors:activate-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1', connectorId: 'linear' },
    );
    expect(a1.activated).toBe(true);
    const a2 = await h.bus.call<ActivateAuthoredInput, ActivateAuthoredOutput>(
      'connectors:activate-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1', connectorId: 'linear' },
    );
    expect(a2.activated).toBe(false);

    const list = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(list.drafts[0]!.status).toBe('active');
  });

  it('rejects a malformed credential slot (untrusted-input defense, I5)', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
        'connectors:install-authored',
        h.ctx({ userId: 'userA' }),
        installInput({ slots: [{ slot: 'lower case bad', kind: 'api-key' }] }),
      ),
    ).rejects.toThrow(PluginError);
  });

  it('rejects a malformed connectorId', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
        'connectors:install-authored',
        h.ctx({ userId: 'userA' }),
        installInput({ connectorId: 'Bad Id!' }),
      ),
    ).rejects.toThrow(PluginError);
  });

  it('drafts are isolated per (owner, agent)', async () => {
    const h = await makeHarness();
    await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput({ agentId: 'agent1', name: 'A1' }),
    );
    await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput({ agentId: 'agent2', name: 'A2' }),
    );
    const a1 = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(a1.drafts.map((d) => d.name)).toEqual(['A1']);
  });
});

// ---------------------------------------------------------------------------
// TASK-114 item 1 — re-propose dedup against the live registry.
//
// TASK-113 made approval PROMOTE the authored draft into the LIVE registry
// (`connectors_v1_connectors`). After that, a warm-turn re-propose of the SAME
// connector must NOT re-create a pending authored draft (and so must NOT re-fire
// the orchestrator's upfront approval card, which keys off pending drafts). The
// equivalence rule is the simplest-correct one: an active (not-deleted) registry
// connector owned by the same user with the SAME connector id.
// ---------------------------------------------------------------------------

/** Seed an active connector into the LIVE registry (the post-approval state). */
async function seedRegistryConnector(
  h: TestHarness,
  over: Partial<UpsertInput> = {},
): Promise<void> {
  await h.bus.call<UpsertInput, UpsertOutput>(
    'connectors:upsert',
    h.ctx({ userId: 'userA' }),
    {
      userId: 'userA',
      connectorId: 'linear',
      name: 'Linear',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' }],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      ...over,
    },
  );
}

describe('@ax/connectors — install_authored_connector re-propose dedup (TASK-114)', () => {
  it('is a NO-OP when an equivalent active registry connector already exists', async () => {
    const h = await makeHarness();
    await seedRegistryConnector(h);

    const out = await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    // Reports the connector is already active — not a fresh pending draft.
    expect(out).toEqual({ connectorId: 'linear', status: 'active' });

    // And it must NOT have created a pending authored draft (so the orchestrator
    // card path, which fires on a pending draft, never re-cards).
    const list = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(list.drafts).toEqual([]);
  });

  it('creating the live connector clears the pending draft, and a later re-propose stays a no-op', async () => {
    const h = await makeHarness();
    await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    await seedRegistryConnector(h); // creates 'linear' -> resolves the proposal
    const out = await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput({ name: 'Linear (re-proposed)' }),
    );
    expect(out.status).toBe('active');
    const after = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(after.drafts).toEqual([]);
  });

  it('still writes a pending draft for a DIFFERENT id with no registry match (control)', async () => {
    const h = await makeHarness();
    await seedRegistryConnector(h); // registers 'linear'

    const out = await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput({ connectorId: 'gmail', name: 'Gmail', hosts: ['gmail.googleapis.com'] }),
    );
    expect(out).toEqual({ connectorId: 'gmail', status: 'pending' });

    const list = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(list.drafts.map((d) => d.connectorId)).toEqual(['gmail']);
    expect(list.drafts[0]!.status).toBe('pending');
  });

  it('dedups against ANY owner’s live connector with that id (slice 2c: proposals go to admins)', async () => {
    const h = await makeHarness();
    // userB (an admin, in practice) owns a live 'linear'; userA's agent proposes it.
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userB' }),
      {
        userId: 'userB',
        connectorId: 'linear',
        name: 'Linear',
        keyMode: 'personal',
        visibility: 'shared',
        capabilities: {
          allowedHosts: ['api.linear.app'],
          credentials: [],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      },
    );

    const out = await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    expect(out).toEqual({ connectorId: 'linear', status: 'active' });
    // No draft lands in the admin queue.
    const all = await h.bus.call<ListAuthoredPendingAllInput, ListAuthoredPendingAllOutput>(
      'connectors:list-authored-pending-all',
      h.ctx({ userId: 'userA' }),
      {},
    );
    expect(all.drafts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// connectors:proposed (2026-06-03) — install-authored fires this subscriber
// event so the chat-orchestrator can surface the approval card AT PROPOSAL
// TIME (mid-turn), not only at the start of the user's NEXT turn. The event is
// the trigger for the bug fix: previously a connector proposed mid-turn was
// never carded until a turn the user might never send.
// ---------------------------------------------------------------------------
describe('@ax/connectors — install-authored fires connectors:proposed', () => {
  it('fires connectors:proposed once for a fresh PENDING draft, carrying the (owner, agent, id)', async () => {
    const h = await makeHarness();
    const events: Array<{ ownerUserId: string; agentId: string; connectorId: string; status: string }> = [];
    h.bus.subscribe('connectors:proposed', 'test/capture', async (_ctx, payload) => {
      events.push(payload as { ownerUserId: string; agentId: string; connectorId: string; status: string });
      return undefined;
    });

    await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );

    expect(events).toEqual([
      { ownerUserId: 'userA', agentId: 'agent1', connectorId: 'linear', status: 'pending' },
    ]);
  });

  it('does NOT fire connectors:proposed on the already-active no-op path (TASK-114 dedup)', async () => {
    const h = await makeHarness();
    await seedRegistryConnector(h); // 'linear' already active in the registry

    const events: unknown[] = [];
    h.bus.subscribe('connectors:proposed', 'test/capture', async (_ctx, payload) => {
      events.push(payload);
      return undefined;
    });

    const out = await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    // No-op: already active → no pending draft written → no card to surface.
    expect(out).toEqual({ connectorId: 'linear', status: 'active' });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice 2c — agent proposals go to admins. `connectors:list-authored-pending-all`
// is the admin queue (every owner's pending drafts, minus ids already live under
// any owner); `connectors:clear-authored-by-id` is Dismiss; and creating a live
// connector through `connectors:upsert` resolves every proposal for that id.
// ---------------------------------------------------------------------------

function sharedUpsert(over: Partial<UpsertInput> = {}): UpsertInput {
  return {
    userId: 'admin',
    connectorId: 'linear',
    name: 'Linear',
    keyMode: 'workspace',
    visibility: 'shared',
    capabilities: {
      allowedHosts: ['api.linear.app'],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    },
    ...over,
  };
}

/** Write a pending draft straight into the table, bypassing the install dedup. */
async function insertDraftBehindTheStore(owner: string, agent: string, id: string): Promise<void> {
  const pg = new (await import('pg')).default.Client({ connectionString });
  await pg.connect();
  try {
    await pg.query(
      `INSERT INTO connectors_v1_authored (owner_user_id, agent_id, connector_id, name, usage_note, key_mode, capability_proposal, status)
       VALUES ($1, $2, $3, $3, '', 'personal', '{"allowedHosts":[],"credentials":[],"mcpServers":[],"packages":{"npm":[],"pypi":[]}}'::jsonb, 'pending')`,
      [owner, agent, id],
    );
  } finally {
    await pg.end();
  }
}

async function pendingAll(h: TestHarness): Promise<ListAuthoredPendingAllOutput['drafts']> {
  const out = await h.bus.call<ListAuthoredPendingAllInput, ListAuthoredPendingAllOutput>(
    'connectors:list-authored-pending-all',
    h.ctx({ userId: 'admin' }),
    {},
  );
  return out.drafts;
}

describe('@ax/connectors — connectors:list-authored-pending-all (admin queue)', () => {
  it('lists every proposer’s pending drafts and drops an id already live under any owner', async () => {
    const h = await makeHarness();
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userA' }),
      installInput({ ownerUserId: 'userA', agentId: 'agent1', connectorId: 'linear', name: 'Linear A' }));
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userB' }),
      installInput({ ownerUserId: 'userB', agentId: 'agent7', connectorId: 'linear', name: 'Linear B', keyMode: 'workspace' }));
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userB' }),
      installInput({ ownerUserId: 'userB', agentId: 'agent7', connectorId: 'notion', name: 'Notion', hosts: ['api.notion.com'] }));
    // 'gmail' is live, and a draft for it exists anyway (drift: written behind
    // the install dedup, after creation cleared drafts). The queue must drop it.
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'admin' }),
      sharedUpsert({ connectorId: 'gmail', name: 'Gmail' }));
    await insertDraftBehindTheStore('userA', 'agent1', 'gmail');

    const drafts = await pendingAll(h);
    expect(drafts.map((d) => ({ connectorId: d.connectorId, ownerUserId: d.ownerUserId, agentId: d.agentId, name: d.name }))).toEqual([
      { connectorId: 'linear', ownerUserId: 'userA', agentId: 'agent1', name: 'Linear A' },
      { connectorId: 'linear', ownerUserId: 'userB', agentId: 'agent7', name: 'Linear B' },
      { connectorId: 'notion', ownerUserId: 'userB', agentId: 'agent7', name: 'Notion' },
    ]);
    const b = drafts[1]!;
    expect(b.keyMode).toBe('workspace');
    expect(b.usageNote).toBe('Drive the Linear API');
    expect(b.proposal.allowedHosts).toEqual(['api.linear.app']);
    expect(typeof b.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(b.updatedAt))).toBe(false);
  });
});

describe('@ax/connectors — connectors:clear-authored-by-id (Dismiss)', () => {
  it('clears every proposer’s draft with that id and nothing else', async () => {
    const h = await makeHarness();
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userA' }),
      installInput({ ownerUserId: 'userA', agentId: 'agent1' }));
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userB' }),
      installInput({ ownerUserId: 'userB', agentId: 'agent2' }));
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userB' }),
      installInput({ ownerUserId: 'userB', agentId: 'agent2', connectorId: 'notion', name: 'Notion' }));

    const out = await h.bus.call<ClearAuthoredByIdInput, ClearAuthoredByIdOutput>(
      'connectors:clear-authored-by-id',
      h.ctx({ userId: 'admin' }),
      { connectorId: 'linear' },
    );
    expect(out).toEqual({ cleared: 2 });
    expect((await pendingAll(h)).map((d) => d.connectorId)).toEqual(['notion']);

    const again = await h.bus.call<ClearAuthoredByIdInput, ClearAuthoredByIdOutput>(
      'connectors:clear-authored-by-id',
      h.ctx({ userId: 'admin' }),
      { connectorId: 'linear' },
    );
    expect(again).toEqual({ cleared: 0 });
  });

  it('rejects a malformed id', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('connectors:clear-authored-by-id', h.ctx({ userId: 'admin' }), { connectorId: 'Bad Id!' }),
    ).rejects.toThrow(PluginError);
  });
});

describe('@ax/connectors — creating a connector resolves its proposals', () => {
  it('connectors:upsert that CREATES clears both proposers’ drafts for that id', async () => {
    const h = await makeHarness();
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userA' }),
      installInput({ ownerUserId: 'userA', agentId: 'agent1' }));
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userB' }),
      installInput({ ownerUserId: 'userB', agentId: 'agent2' }));
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userB' }),
      installInput({ ownerUserId: 'userB', agentId: 'agent2', connectorId: 'notion', name: 'Notion' }));

    const up = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert', h.ctx({ userId: 'admin' }), sharedUpsert(),
    );
    expect(up.created).toBe(true);
    expect((await pendingAll(h)).map((d) => d.connectorId)).toEqual(['notion']);
    // Gone from the per-agent read too (no stale 'active' row left behind).
    const a = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored', h.ctx({ userId: 'userA' }), { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(a.drafts).toEqual([]);
  });

  it('an EDIT (created:false) does not clear drafts', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'admin' }), sharedUpsert());
    // A draft written behind the dedup (e.g. drift): the edit must leave it alone.
    await insertDraftBehindTheStore('userA', 'agent1', 'linear');
    const up = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert', h.ctx({ userId: 'admin' }), sharedUpsert({ name: 'Linear (renamed)' }),
    );
    expect(up.created).toBe(false);
    const a = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored', h.ctx({ userId: 'userA' }), { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(a.drafts).toHaveLength(1);
  });
});
