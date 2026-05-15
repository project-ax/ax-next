import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { makeAgentContext, asWorkspaceVersion, type WorkspaceDelta } from '@ax/core';
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

describe('handleWorkspaceApplied', () => {
  it('upserts on added', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    const now = new Date('2026-05-14T12:00:00Z');
    await handleWorkspaceApplied(store, ctx, delta([
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
    await handleWorkspaceApplied(store, ctx, delta([
      { path: '.ax/routines/r.md', kind: 'deleted' },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('ignores changes outside .ax/routines/', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(store, ctx, delta([
      { path: 'README.md', kind: 'added', contentAfter: async () => ENC.encode('# hi') },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('skips when author.agentId or author.userId is missing', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(
      store, ctx,
      { before: null, after: asWorkspaceVersion('v'), changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => intervalBody() }] } as WorkspaceDelta,
      new Date(),
    );
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('does not throw on a malformed routine (I8 — log + skip)', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(store, ctx, delta([
      { path: '.ax/routines/bad.md', kind: 'added', contentAfter: async () => ENC.encode('no frontmatter') },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });

  it('skips nested routine paths (.ax/routines/sub/x.md)', async () => {
    const store = createRoutinesStore(db);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: console as never });
    await handleWorkspaceApplied(store, ctx, delta([
      { path: '.ax/routines/sub/x.md', kind: 'added', contentAfter: async () => intervalBody() },
    ], { agentId: 'agt_a', userId: 'u1' }), new Date());
    expect(await db.selectFrom('routines_v1_definitions').selectAll().execute()).toHaveLength(0);
  });
});
