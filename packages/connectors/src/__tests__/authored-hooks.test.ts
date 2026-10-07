import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError, type Logger } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import type {
  ClearAuthoredByIdInput,
  ClearAuthoredByIdOutput,
  InstallAuthoredInput,
  InstallAuthoredOutput,
  ListAuthoredPendingAllInput,
  ListAuthoredPendingAllOutput,
  ResolveInput,
  ResolveOutput,
  UpsertInput,
  UpsertOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Authored-connector hooks through the bus against a real postgres container.
// Covers install, the admin proposal queue, boundary validation, and
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

/** One stored draft, read straight from the table (any status). Slice 2c
 *  removed the per-agent `connectors:list-authored` read with the in-chat card,
 *  so the tests look at the rows themselves. */
interface StoredDraft {
  connectorId: string;
  name: string;
  status: string;
  keyMode: string;
  proposal: {
    allowedHosts: string[];
    credentials: unknown[];
    mcpServers: unknown[];
    packages: { npm: string[]; pypi: string[] };
  };
}
async function draftsOf(owner: string, agent: string): Promise<StoredDraft[]> {
  const pg = new (await import('pg')).default.Client({ connectionString });
  await pg.connect();
  try {
    const res = await pg.query(
      `SELECT connector_id, name, status, key_mode, capability_proposal
         FROM connectors_v1_authored
        WHERE owner_user_id = $1 AND agent_id = $2
        ORDER BY connector_id`,
      [owner, agent],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      connectorId: r.connector_id as string,
      name: r.name as string,
      status: r.status as string,
      keyMode: r.key_mode as string,
      proposal: r.capability_proposal as StoredDraft['proposal'],
    }));
  } finally {
    await pg.end();
  }
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
  it('install persists a PENDING draft with the assembled proposal', async () => {
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

    const drafts = await draftsOf('userA', 'agent1');
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
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

  it('the per-agent read and the approve flip are gone with the in-chat card (slice 2c)', async () => {
    const h = await makeHarness();
    expect(h.bus.hasService('connectors:list-authored')).toBe(false);
    expect(h.bus.hasService('connectors:activate-authored')).toBe(false);
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

  it('rejects the reserved id `authored` (it would be shadowed by the admin queue route)', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
        'connectors:install-authored',
        h.ctx({ userId: 'userA' }),
        installInput({ connectorId: 'authored' }),
      ),
    ).rejects.toThrow(/reserved/);
    await expect(
      h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'admin' }), {
        userId: 'admin',
        connectorId: 'authored',
        name: 'Authored',
        keyMode: 'personal',
        visibility: 'shared',
        capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      }),
    ).rejects.toThrow(/reserved/);
  });

  it('the reservation is create-only: connectors:live-ids answers for `authored` without throwing', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<{ connectorIds: string[] }, { live: string[] }>(
      'connectors:live-ids',
      h.ctx({ userId: 'admin' }),
      { connectorIds: ['authored', 'x'] },
    );
    expect(out.live).toEqual([]);
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
    expect((await draftsOf('userA', 'agent1')).map((d) => d.name)).toEqual(['A1']);
  });
});

// ---------------------------------------------------------------------------
// TASK-114 item 1 — re-propose dedup against the live registry, reshaped in
// slice 2c. A re-propose of an id that is already live as a SHARED connector
// must NOT create a draft (nothing for an admin to approve). The rule is a pure
// id match against live shared rows of any owner.
// ---------------------------------------------------------------------------

/** Seed a live SHARED connector into the registry (the admin-created state). */
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
      visibility: 'shared',
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

    // And it must NOT have created a draft for the admins' queue.
    expect(await draftsOf('userA', 'agent1')).toEqual([]);
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
    expect(await draftsOf('userA', 'agent1')).toEqual([]);
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

    const drafts = await draftsOf('userA', 'agent1');
    expect(drafts.map((d) => d.connectorId)).toEqual(['gmail']);
    expect(drafts[0]!.status).toBe('pending');
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

  it('does NOT dedup against another owner’s PRIVATE connector: the draft is written (no "taken" leak)', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userB' }),
      {
        userId: 'userB',
        connectorId: 'linear',
        name: 'Linear',
        keyMode: 'personal',
        visibility: 'private',
        capabilities: { allowedHosts: ['api.linear.app'], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      },
    );
    const out = await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    expect(out).toEqual({ connectorId: 'linear', status: 'pending' });
    expect((await draftsOf('userA', 'agent1')).map((d) => d.connectorId)).toEqual(['linear']);
  });
});

// Slice 2c — install-authored no longer fires `connectors:proposed`: nothing
// opens an in-chat card any more, so the draft just waits for an admin.
// ---------------------------------------------------------------------------
describe('@ax/connectors — install-authored fires no proposal event (slice 2c)', () => {
  it('writes the pending draft and fires nothing', async () => {
    const h = await makeHarness();
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
    expect(out).toEqual({ connectorId: 'linear', status: 'pending' });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice 2c — agent proposals go to admins. `connectors:list-authored-pending-all`
// is the admin queue (every owner's pending drafts, minus ids already live as a
// SHARED connector); `connectors:clear-authored-by-id` is Dismiss; and creating a live
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
  it('lists every proposer’s pending drafts and drops an id already live as a shared connector', async () => {
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

describe('@ax/connectors — one malformed request does not empty the admin queue', () => {
  it('skips the bad row, logs it with its owner and id, and returns the good ones', async () => {
    const h = await makeHarness();
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userA' }),
      installInput({ ownerUserId: 'userA', agentId: 'agent1' }));
    const pg = new (await import('pg')).default.Client({ connectionString });
    await pg.connect();
    try {
      await pg.query(
        `INSERT INTO connectors_v1_authored (owner_user_id, agent_id, connector_id, name, usage_note, key_mode, capability_proposal, status)
         VALUES ('userB', 'agent2', 'broken', 'Broken', '', 'personal', '{"allowedHosts": 5}'::jsonb, 'pending')`,
      );
    } finally {
      await pg.end();
    }
    const warns: Array<{ msg: string; bindings?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn(msg, bindings) {
        warns.push({ msg, bindings });
      },
      error() {},
      child() {
        return logger;
      },
    };
    const out = await h.bus.call<ListAuthoredPendingAllInput, ListAuthoredPendingAllOutput>(
      'connectors:list-authored-pending-all',
      h.ctx({ userId: 'admin', logger }),
      {},
    );
    expect(out.drafts.map((d) => d.connectorId)).toEqual(['linear']);
    const skipped = warns.filter((w) => w.msg === 'connectors_authored_pending_skipped_row');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.bindings).toMatchObject({ ownerUserId: 'userB', connectorId: 'broken' });
  });
});

describe('@ax/connectors — the admin queue hides only SHARED-live ids', () => {
  it('keeps a request whose id is live only as someone’s PRIVATE connector, so an admin can still see and dismiss it', async () => {
    const h = await makeHarness();
    // userC has a private 'linear'. userA's agent proposes 'linear' (the install
    // dedup ignores private rows, so the draft is written).
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userC' }),
      sharedUpsert({ userId: 'userC', keyMode: 'personal', visibility: 'private' }));
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userA' }),
      installInput({ ownerUserId: 'userA', agentId: 'agent1' }));
    // And a draft for an id that is live as SHARED, written behind the dedup.
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'admin' }),
      sharedUpsert({ connectorId: 'gmail', name: 'Gmail' }));
    await insertDraftBehindTheStore('userA', 'agent1', 'gmail');

    expect((await pendingAll(h)).map((d) => d.connectorId)).toEqual(['linear']);

    // Dismissable: the admin Dismiss clears it and the queue is empty.
    await h.bus.call<ClearAuthoredByIdInput, ClearAuthoredByIdOutput>(
      'connectors:clear-authored-by-id', h.ctx({ userId: 'admin' }), { connectorId: 'linear' },
    );
    expect(await pendingAll(h)).toEqual([]);
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
  it('connectors:upsert that CREATES a SHARED connector clears both proposers’ drafts for that id', async () => {
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
    // Gone from the table too (no stale row left behind).
    expect(await draftsOf('userA', 'agent1')).toEqual([]);
  });

  it('creating a PRIVATE connector leaves other people’s requests in place (no cross-tenant clear)', async () => {
    const h = await makeHarness();
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userA' }),
      installInput({ ownerUserId: 'userA', agentId: 'agent1' }));
    await h.bus.call('connectors:install-authored', h.ctx({ userId: 'userB' }),
      installInput({ ownerUserId: 'userB', agentId: 'agent2' }));

    const up = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert', h.ctx({ userId: 'userC' }),
      sharedUpsert({ userId: 'userC', keyMode: 'personal', visibility: 'private' }),
    );
    expect(up.created).toBe(true);
    for (const [owner, agent] of [['userA', 'agent1'], ['userB', 'agent2']] as const) {
      expect((await draftsOf(owner, agent)).map((d) => d.connectorId)).toEqual(['linear']);
    }
  });

  it('a failing clear never fails the create: upsert returns created:true and logs connectors_proposals_clear_failed', async () => {
    const h = await makeHarness();
    // Make the clear throw: drop the drafts table out from under the store.
    const pg = new (await import('pg')).default.Client({ connectionString });
    await pg.connect();
    try {
      await pg.query('DROP TABLE connectors_v1_authored');
    } finally {
      await pg.end();
    }
    const warns: Array<{ msg: string; bindings?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn(msg, bindings) {
        warns.push({ msg, bindings });
      },
      error() {},
      child() {
        return logger;
      },
    };
    const up = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert', h.ctx({ userId: 'admin', logger }), sharedUpsert(),
    );
    expect(up.created).toBe(true);
    expect(up.connector.id).toBe('linear');
    expect(warns.map((w) => w.msg)).toContain('connectors_proposals_clear_failed');
    expect(warns.find((w) => w.msg === 'connectors_proposals_clear_failed')?.bindings).toMatchObject({
      connectorId: 'linear',
    });
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
    expect(await draftsOf('userA', 'agent1')).toHaveLength(1);
  });
});
