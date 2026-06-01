import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import type {
  ActivateAuthoredInput,
  ActivateAuthoredOutput,
  ClearAuthoredInput,
  ClearAuthoredOutput,
  InstallAuthoredInput,
  InstallAuthoredOutput,
  ListAuthoredInput,
  ListAuthoredOutput,
  ResolveInput,
  ResolveOutput,
  UpsertInput,
  UpsertOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Authored-connector hooks through the bus against a real postgres container.
// Covers the install → list → activate → clear path, boundary validation, and
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
        slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' }],
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
      { slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' },
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

  it('clear removes the draft (reject path)', async () => {
    const h = await makeHarness();
    await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    const c = await h.bus.call<ClearAuthoredInput, ClearAuthoredOutput>(
      'connectors:clear-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1', connectorId: 'linear' },
    );
    expect(c.cleared).toBe(true);
    const list = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1' },
    );
    expect(list.drafts).toEqual([]);
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

  it('does NOT reset a pre-existing pending draft to a new pending when the registry already has it', async () => {
    const h = await makeHarness();
    // A draft exists pending (the pre-approval state), THEN it gets promoted into
    // the registry (approval). A re-propose afterwards must leave the draft as-is.
    await h.bus.call<InstallAuthoredInput, InstallAuthoredOutput>(
      'connectors:install-authored',
      h.ctx({ userId: 'userA' }),
      installInput(),
    );
    await seedRegistryConnector(h);
    const before = await h.bus.call<ListAuthoredInput, ListAuthoredOutput>(
      'connectors:list-authored',
      h.ctx({ userId: 'userA' }),
      { ownerUserId: 'userA', agentId: 'agent1' },
    );
    const beforeUpdatedAt = (before.drafts[0] as { updatedAt?: string }).updatedAt;

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
    // The draft is untouched — same single row, name NOT overwritten by the
    // re-propose (the no-op short-circuits before any write).
    expect(after.drafts).toHaveLength(1);
    expect(after.drafts[0]!.name).toBe('Linear');
    if (beforeUpdatedAt !== undefined) {
      expect((after.drafts[0] as { updatedAt?: string }).updatedAt).toBe(beforeUpdatedAt);
    }
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

  it('does NOT dedup against ANOTHER user’s registry connector (owner-scoped)', async () => {
    const h = await makeHarness();
    // userB owns a 'linear' registry connector; userA's re-propose is unaffected.
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userB' }),
      {
        userId: 'userB',
        connectorId: 'linear',
        name: 'Linear',
        keyMode: 'personal',
        visibility: 'private',
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
    // userA has no registry 'linear' → normal pending draft.
    expect(out).toEqual({ connectorId: 'linear', status: 'pending' });
  });
});
