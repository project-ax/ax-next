import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { HookBus, makeAgentContext, asWorkspaceVersion, type WorkspaceDelta } from '@ax/core';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';
import { handleWorkspaceApplied } from '../sync.js';

pg.types.setTypeParser(20, (v) => Number(v));

const ENC = new TextEncoder();

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

afterEach(async () => {
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

function delta(changes: WorkspaceDelta['changes'], author: { agentId: string; userId: string }): WorkspaceDelta {
  return {
    before: null,
    after: asWorkspaceVersion('v1'),
    author,
    changes,
  };
}

function intervalBody(every = '60s'): Uint8Array {
  return ENC.encode([
    '---',
    'name: r', 'description: d',
    'trigger:', '  kind: interval', `  every: "${every}"`,
    '---', '# prompt',
  ].join('\n') + '\n');
}

// Minimal deps for non-webhook tests: empty bus is fine (webhook arm won't fire for interval routines)
function makeDeps(store: ReturnType<typeof createRoutinesStore>) {
  return {
    store,
    bus: new HookBus(),
    webhookRoutes: new Map<string, () => void>(),
    fireRoutine: async () => ({
      status: 'ok' as const, conversationId: 'c1', error: null, renderedPrompt: 'p',
    }),
  };
}

describe('handleWorkspaceApplied', () => {
  it('upserts on added', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    const now = new Date('2026-05-14T12:00:00Z');
    await handleWorkspaceApplied(makeDeps(store), ctx, delta([
      {
        path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => intervalBody('60s'),
      },
    ], { agentId: 'agt_a', userId: 'u1' }), now);
    const rows = await db.selectFrom('routines_v1_definitions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.next_run_at?.toISOString()).toBe('2026-05-14T12:01:00.000Z');
  });

  it('deletes on deleted', async () => {
    const store = createRoutinesStore(db);
    await store.upsert({
      agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
      name: 'r', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '60s' }, activeHours: null,
      silenceToken: null, silenceMax: 300, conversation: 'per-fire',
      promptBody: '# x', nextRunAt: new Date(),
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(makeDeps(store), ctx, delta([
      { path: '.ax/routines/r.md', kind: 'deleted' },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('ignores changes outside .ax/routines/', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(makeDeps(store), ctx, delta([
      { path: 'README.md', kind: 'added', contentAfter: async () => ENC.encode('# hi') },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('skips when author.agentId or author.userId is missing', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(
      makeDeps(store), ctx,
      { before: null, after: asWorkspaceVersion('v'), changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => intervalBody() }] } as WorkspaceDelta,
      new Date(),
    );
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('does not throw on a malformed routine (I8 — log + skip)', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(makeDeps(store), ctx, delta([
      { path: '.ax/routines/bad.md', kind: 'added', contentAfter: async () => ENC.encode('no frontmatter') },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('skips nested routine paths (.ax/routines/sub/x.md)', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(makeDeps(store), ctx, delta([
      { path: '.ax/routines/sub/x.md', kind: 'added', contentAfter: async () => intervalBody() },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('on workspace-applied delete, purges the routine HMAC credential', async () => {
    const store = createRoutinesStore(db);

    // Seed a routine row so the deleted branch has something to remove.
    await store.upsert({
      agentId: 'agt-1', path: '.ax/routines/gh.md', authorUserId: 'u1',
      name: 'gh', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '60s' }, activeHours: null,
      silenceToken: null, silenceMax: 300, conversation: 'per-fire',
      promptBody: '# x', nextRunAt: new Date(),
    });

    // In-memory credential store keyed by (scope, ownerId, ref).
    interface CredRow { scope: 'global' | 'user' | 'agent'; ownerId: string | null; ref: string }
    const credStore: CredRow[] = [
      { scope: 'agent', ownerId: 'agt-1', ref: 'routine:agt-1:.ax/routines/gh.md:hmac' },
    ];

    const credDeleteSpy = vi.fn(async (_ctx: unknown, input: unknown) => {
      const inp = input as CredRow;
      const idx = credStore.findIndex(
        (r) => r.scope === inp.scope && r.ownerId === inp.ownerId && r.ref === inp.ref,
      );
      if (idx !== -1) credStore.splice(idx, 1);
    });

    // Build a HookBus that has credentials:list and credentials:delete wired.
    const bus = new HookBus();
    bus.registerService('credentials:list', 'stub', async () => ({ credentials: [...credStore] }));
    bus.registerService('credentials:delete', 'stub', credDeleteSpy);

    const deps = {
      store,
      bus,
      webhookRoutes: new Map<string, () => void>(),
      fireRoutine: async () => ({
        status: 'ok' as const, conversationId: 'c1', error: null, renderedPrompt: 'p',
      }),
    };

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(deps, ctx, delta([
      { path: '.ax/routines/gh.md', kind: 'deleted' },
    ], { agentId: 'agt-1', userId: 'u1' }), new Date());

    // Routine row should be gone.
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
    // HMAC credential should have been deleted.
    expect(credDeleteSpy).toHaveBeenCalledTimes(1);
    expect(credStore).toHaveLength(0);
  });

  it('on workspace-applied delete, continues if credential purge fails', async () => {
    const store = createRoutinesStore(db);

    await store.upsert({
      agentId: 'agt-1', path: '.ax/routines/gh.md', authorUserId: 'u1',
      name: 'gh', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '60s' }, activeHours: null,
      silenceToken: null, silenceMax: 300, conversation: 'per-fire',
      promptBody: '# x', nextRunAt: new Date(),
    });

    const bus = new HookBus();
    bus.registerService('credentials:list', 'stub', async () => {
      throw new Error('storage exploded');
    });
    bus.registerService('credentials:delete', 'stub', async () => {});

    const deps = {
      store,
      bus,
      webhookRoutes: new Map<string, () => void>(),
      fireRoutine: async () => ({
        status: 'ok' as const, conversationId: 'c1', error: null, renderedPrompt: 'p',
      }),
    };

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });

    // Should not throw even though credential purge fails.
    await expect(
      handleWorkspaceApplied(deps, ctx, delta([
        { path: '.ax/routines/gh.md', kind: 'deleted' },
      ], { agentId: 'agt-1', userId: 'u1' }), new Date()),
    ).resolves.toBeUndefined();

    // Routine row should still be deleted.
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('on workspace-applied delete, skips credential purge when credentials:list is absent', async () => {
    const store = createRoutinesStore(db);

    await store.upsert({
      agentId: 'agt-1', path: '.ax/routines/gh.md', authorUserId: 'u1',
      name: 'gh', description: 'd', specHash: 'h',
      trigger: { kind: 'interval', every: '60s' }, activeHours: null,
      silenceToken: null, silenceMax: 300, conversation: 'per-fire',
      promptBody: '# x', nextRunAt: new Date(),
    });

    // Bus has NO credentials services registered — simulates a stripped preset.
    const deps = makeDeps(store);

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });

    await expect(
      handleWorkspaceApplied(deps, ctx, delta([
        { path: '.ax/routines/gh.md', kind: 'deleted' },
      ], { agentId: 'agt-1', userId: 'u1' }), new Date()),
    ).resolves.toBeUndefined();

    // Routine row should be deleted even without credentials plugin.
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });
});
