import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { AgentContext, HookBus } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import { deriveToolNamespaces, type ToolNamespaceEntry } from '../tool-namespace.js';
import type {
  Capabilities,
  ListDefaultsInput,
  ListDefaultsOutput,
  ListEffectiveInput,
  ListEffectiveOutput,
  ListInput,
  ListOutput,
  ResolveInput,
  ResolveOutput,
  UpsertInput,
  UpsertOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-739 — `connectors:list-effective`, the one implementation of an agent's
// effective connector set, driven through the bus against real postgres.
//
// The PARITY block keeps the pre-TASK-739 orchestrator algorithm (defaults via
// list-defaults, attachments via resolve, legacy-owned via list + resolve) as a
// test ORACLE over the same bus, and pins that the new hook produces the same
// ids in the same order with the same capabilities / toolNamespaces / usageNote
// when no exclusions are given.
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

function caps(host: string, server?: string): Capabilities {
  return {
    allowedHosts: [host],
    credentials: [],
    mcpServers: server === undefined
      ? []
      : [{
          name: server,
          transport: 'http',
          url: `https://${host}/mcp`,
          allowedHosts: [host],
          credentials: [],
        }],
    packages: { npm: [], pypi: [] },
    services: [],
  };
}

async function upsert(
  h: TestHarness,
  userId: string,
  connectorId: string,
  over: Partial<UpsertInput> = {},
): Promise<void> {
  await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId }), {
    userId,
    connectorId,
    name: `Name ${connectorId}`,
    description: '',
    usageNote: `use ${connectorId}`,
    keyMode: 'personal',
    visibility: 'private',
    capabilities: caps(`${connectorId}.example.com`, `${connectorId}-srv`),
    ...over,
  });
}

/** Rows created before explicit attachment keep their implicit attachment. A
 *  fresh upsert always sets `requires_attachment`, so flip it directly. */
async function markLegacy(ownerUserId: string, connectorId: string): Promise<void> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'UPDATE connectors_v1_connectors SET requires_attachment = false WHERE owner_user_id = $1 AND connector_id = $2',
      [ownerUserId, connectorId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function listEffective(
  h: TestHarness,
  input: ListEffectiveInput,
): Promise<ListEffectiveOutput> {
  return h.bus.call<ListEffectiveInput, ListEffectiveOutput>(
    'connectors:list-effective',
    h.ctx({ userId: input.userId }),
    input,
  );
}

/**
 * Fixture for userA:
 *   def1     — own, default-attached (requires attachment, still a default)
 *   att1     — own, requires explicit attachment
 *   legacy1  — own, legacy (implicitly attached)
 *   legacy2  — own, legacy, older than legacy1
 *   shared1  — userB's shared definition (canEdit false for userA), legacy on B's side
 *   amb      — shared by BOTH userB and userC (ambiguous for userA → unresolvable)
 */
async function seed(h: TestHarness): Promise<void> {
  await upsert(h, 'userA', 'legacy2');
  await upsert(h, 'userA', 'def1', { defaultAttached: true });
  await upsert(h, 'userA', 'att1');
  await upsert(h, 'userA', 'legacy1');
  await upsert(h, 'userB', 'shared1', { visibility: 'shared' });
  await upsert(h, 'userB', 'amb', { visibility: 'shared' });
  await upsert(h, 'userC', 'amb', { visibility: 'shared' });
  await markLegacy('userA', 'legacy1');
  await markLegacy('userA', 'legacy2');
  await markLegacy('userB', 'shared1');
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
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_connectors');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('connectors:list-effective — union', () => {
  it('unions defaults, attachments and legacy-owned rows, in that order, with source tags', async () => {
    const h = await makeHarness();
    await seed(h);
    const out = await listEffective(h, { userId: 'userA', attachmentIds: ['att1'] });
    expect(out.connectors.map((c) => [c.summary.id, c.source])).toEqual([
      ['def1', 'default'],
      ['att1', 'attached'],
      // legacy-owned: newest-updated first (legacy1 was written after legacy2).
      ['legacy1', 'legacy-owned'],
      ['legacy2', 'legacy-owned'],
    ]);
  });

  it('summary is the connectors:list shape (no capabilities) and toolNamespaces match resolve', async () => {
    const h = await makeHarness();
    await seed(h);
    const out = await listEffective(h, { userId: 'userA', attachmentIds: ['att1', 'shared1'] });
    const listed = await h.bus.call<ListInput, ListOutput>(
      'connectors:list', h.ctx({ userId: 'userA' }), { userId: 'userA' },
    );
    for (const entry of out.connectors) {
      expect(entry.summary).not.toHaveProperty('capabilities');
      const fromList = listed.connectors.find((c) => c.id === entry.summary.id);
      expect(entry.summary).toEqual(fromList);
      const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
        'connectors:resolve', h.ctx({ userId: 'userA' }), { userId: 'userA', connectorId: entry.summary.id },
      );
      expect(entry.capabilities).toEqual(resolved.capabilities);
      expect(entry.toolNamespaces).toEqual(resolved.toolNamespaces);
      expect(entry.toolNamespaces).toHaveLength(1);
    }
    const shared = out.connectors.find((c) => c.summary.id === 'shared1')!;
    expect(shared.source).toBe('attached');
    expect(shared.summary.canEdit).toBe(false);
    // Namespaces derive from the ROW owner (userB), not the caller.
    expect(shared.toolNamespaces).toEqual(
      deriveToolNamespaces('userB', { id: 'shared1', capabilities: caps('shared1.example.com', 'shared1-srv') }),
    );
    expect(out.connectors.find((c) => c.summary.id === 'att1')!.summary).toMatchObject({
      canEdit: true,
      requiresAttachment: true,
    });
    expect(out.connectors.find((c) => c.summary.id === 'legacy1')!.summary).toMatchObject({
      canEdit: true,
      requiresAttachment: false,
    });
  });

  it('dedupes by id: a default wins over the same id attached, attached wins over legacy-owned', async () => {
    const h = await makeHarness();
    await seed(h);
    const out = await listEffective(h, {
      userId: 'userA',
      attachmentIds: ['legacy1', 'def1', 'att1', 'att1'],
    });
    expect(out.connectors.map((c) => [c.summary.id, c.source])).toEqual([
      ['def1', 'default'],
      ['legacy1', 'attached'],
      ['att1', 'attached'],
      ['legacy2', 'legacy-owned'],
    ]);
  });

  it('exclusions remove a default and a legacy-owned row', async () => {
    const h = await makeHarness();
    await seed(h);
    const out = await listEffective(h, {
      userId: 'userA',
      attachmentIds: ['att1'],
      exclusions: ['def1', 'legacy2'],
    });
    expect(out.connectors.map((c) => c.summary.id)).toEqual(['att1', 'legacy1']);
  });

  it('an explicit attachment wins over a stale exclusion (and is then sourced as attached)', async () => {
    const h = await makeHarness();
    await seed(h);
    const out = await listEffective(h, {
      userId: 'userA',
      attachmentIds: ['def1', 'shared1'],
      exclusions: ['def1', 'shared1'],
    });
    const rows = out.connectors.map((c) => [c.summary.id, c.source]);
    expect(rows).toContainEqual(['def1', 'attached']);
    expect(rows).toContainEqual(['shared1', 'attached']);
  });

  it('skips dangling, ambiguous and malformed attachment ids (they grant nothing, never throw)', async () => {
    const h = await makeHarness();
    await seed(h);
    const out = await listEffective(h, {
      userId: 'userA',
      attachmentIds: ['nope', 'Bad Id!', '../etc', '', 'amb', 'att1'],
    });
    expect(out.connectors.filter((c) => c.source === 'attached').map((c) => c.summary.id))
      .toEqual(['att1']);
  });

  it('never implicitly includes a requiresAttachment row or a shared row the user does not own', async () => {
    const h = await makeHarness();
    await seed(h);
    const out = await listEffective(h, { userId: 'userA' });
    const ids = out.connectors.map((c) => c.summary.id);
    expect(ids).toEqual(['def1', 'legacy1', 'legacy2']);
    expect(ids).not.toContain('att1');
    // shared1 is legacy on its OWNER's side, but userA cannot edit it.
    expect(ids).not.toContain('shared1');
    // ...while for its owner it IS legacy-owned.
    const forB = await listEffective(h, { userId: 'userB' });
    expect(forB.connectors.map((c) => [c.summary.id, c.source])).toEqual([['shared1', 'legacy-owned']]);
  });

  it('a tombstoned connector contributes nothing from any source', async () => {
    const h = await makeHarness();
    await seed(h);
    for (const id of ['def1', 'att1', 'legacy1']) {
      await h.bus.call('connectors:delete', h.ctx({ userId: 'userA' }), { userId: 'userA', connectorId: id });
    }
    const out = await listEffective(h, { userId: 'userA', attachmentIds: ['att1'] });
    expect(out.connectors.map((c) => c.summary.id)).toEqual(['legacy2']);
  });

  it('validates the boundary: userId required, id lists must be bounded string arrays', async () => {
    const h = await makeHarness();
    const call = (input: unknown) =>
      h.bus.call('connectors:list-effective', h.ctx({ userId: 'userA' }), input);
    await expect(call({})).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ userId: '' })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ userId: 'userA', attachmentIds: 'att1' })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ userId: 'userA', attachmentIds: [1] })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ userId: 'userA', exclusions: { a: 1 } })).rejects.toMatchObject({ code: 'invalid-payload' });
    const tooMany = Array.from({ length: 201 }, (_, i) => `c${i}`);
    await expect(call({ userId: 'userA', attachmentIds: tooMany })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ userId: 'userA', exclusions: tooMany })).rejects.toMatchObject({ code: 'invalid-payload' });
    const atLimit = Array.from({ length: 200 }, (_, i) => `c${i}`);
    await expect(call({ userId: 'userA', attachmentIds: atLimit, exclusions: atLimit }))
      .resolves.toEqual({ connectors: [] });
  });
});

// ---------------------------------------------------------------------------
// PARITY — the pre-TASK-739 orchestrator algorithm, kept verbatim in shape as
// an oracle (it used to live in @ax/chat-orchestrator's connector-union.ts).
// ---------------------------------------------------------------------------

interface OracleConnector {
  id: string;
  capabilities: Capabilities;
  usageNote?: string;
  toolNamespaces?: ToolNamespaceEntry[];
}

async function oldResolveEffectiveConnectors(
  bus: HookBus,
  ctx: AgentContext,
  attachmentIds: readonly string[] = [],
): Promise<OracleConnector[]> {
  const byId = new Map<string, OracleConnector>();
  const project = (c: OracleConnector): OracleConnector => ({
    id: c.id,
    capabilities: c.capabilities,
    ...(c.usageNote !== undefined ? { usageNote: c.usageNote } : {}),
    ...(c.toolNamespaces !== undefined ? { toolNamespaces: c.toolNamespaces } : {}),
  });

  if (bus.hasService('connectors:list-defaults')) {
    try {
      const r = await bus.call<ListDefaultsInput, ListDefaultsOutput>(
        'connectors:list-defaults', ctx, { userId: ctx.userId },
      );
      for (const c of r.connectors) if (!byId.has(c.id)) byId.set(c.id, project(c));
    } catch {
      // non-fatal in the old algorithm
    }
  }

  if (attachmentIds.length > 0 && bus.hasService('connectors:resolve')) {
    for (const connectorId of attachmentIds) {
      if (byId.has(connectorId)) continue;
      try {
        const resolved = await bus.call<ResolveInput, ResolveOutput>(
          'connectors:resolve', ctx, { userId: ctx.userId, connectorId },
        );
        byId.set(resolved.id, project(resolved));
      } catch {
        // dangling / malformed attachment — skipped
      }
    }
  }

  if (bus.hasService('connectors:list') && bus.hasService('connectors:resolve')) {
    try {
      const listed = await bus.call<ListInput, ListOutput>(
        'connectors:list', ctx, { userId: ctx.userId },
      );
      for (const summary of listed.connectors) {
        if (summary.canEdit === false || summary.requiresAttachment === true) continue;
        if (byId.has(summary.id)) continue;
        try {
          const resolved = await bus.call<ResolveInput, ResolveOutput>(
            'connectors:resolve', ctx, { userId: ctx.userId, connectorId: summary.id },
          );
          byId.set(resolved.id, project(resolved));
        } catch {
          // skipped
        }
      }
    } catch {
      // skipped
    }
  }
  return [...byId.values()];
}

describe('connectors:list-effective — parity with the pre-TASK-739 three-source algorithm', () => {
  const fixtures: Array<{ name: string; userId: string; attachmentIds: string[] }> = [
    { name: 'no attachments', userId: 'userA', attachmentIds: [] },
    { name: 'explicit attachment', userId: 'userA', attachmentIds: ['att1'] },
    {
      name: 'attachments overlapping defaults + legacy, shared, dangling, ambiguous, malformed, duplicates',
      userId: 'userA',
      attachmentIds: ['legacy2', 'def1', 'shared1', 'nope', 'amb', 'Bad Id!', 'att1', 'att1'],
    },
    { name: 'owner of a shared legacy row', userId: 'userB', attachmentIds: ['amb'] },
    { name: 'user with no connectors', userId: 'userZ', attachmentIds: ['shared1', 'def1'] },
  ];

  for (const fx of fixtures) {
    it(`agrees on ids, order, capabilities, usageNote and toolNamespaces — ${fx.name}`, async () => {
      const h = await makeHarness();
      await seed(h);
      const ctx = h.ctx({ userId: fx.userId });
      const oracle = await oldResolveEffectiveConnectors(h.bus, ctx, fx.attachmentIds);
      const next = await listEffective(h, {
        userId: fx.userId,
        attachmentIds: fx.attachmentIds,
        exclusions: [],
      });
      expect(
        next.connectors.map((c) => ({
          id: c.summary.id,
          capabilities: c.capabilities,
          usageNote: c.summary.usageNote,
          toolNamespaces: c.toolNamespaces,
        })),
      ).toEqual(oracle);
    });
  }
});
