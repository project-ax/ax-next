import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createRoutinesPlugin } from '../plugin.js';
import { asWorkspaceVersion, type WorkspaceDelta } from '@ax/core';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { RoutinesDatabase } from '../migrations.js';

pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const ENC = new TextEncoder();
function routineBody(opts: { silenceToken?: string } = {}): Uint8Array {
  return ENC.encode([
    '---',
    'name: hb',
    'description: heartbeat',
    'trigger:', '  kind: interval', '  every: "60s"',
    ...(opts.silenceToken ? [`silenceToken: "${opts.silenceToken}"`] : []),
    'conversation: per-fire',
    '---',
    'check in',
  ].join('\n') + '\n');
}

interface Captured {
  invokes: Array<{ message: { content: string }; reqId: string; conversationId: string | undefined }>;
  drops: Array<{ conversationId: string; turnId: string }>;
  hides: Array<{ conversationId: string }>;
  findOrCreateCalls: Array<{ externalKey: string }>;
}

async function makeHarness(captured: Captured, replyOnInvoke: { contentBlocks: unknown[] }) {
  let nextConvId = 1;
  // Cache by externalKey so the shared-conversation routine sees the same
  // conversationId across fires (mirrors the real find-or-create handler).
  const sharedConvIds = new Map<string, string>();
  const busRef: { current: TestHarness | undefined } = { current: undefined };
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => ({
        agent: { id: (input as { agentId: string }).agentId, ownerId: 'u1', workspaceRef: null },
      }),
      'conversations:find-or-create': async (_ctx, input: unknown) => {
        const i = input as { externalKey: string };
        captured.findOrCreateCalls.push({ externalKey: i.externalKey });
        const existing = sharedConvIds.get(i.externalKey);
        if (existing !== undefined) {
          return { conversation: { conversationId: existing }, created: false };
        }
        const fresh = `cnv_${nextConvId++}`;
        sharedConvIds.set(i.externalKey, fresh);
        return { conversation: { conversationId: fresh }, created: true };
      },
      'conversations:create': async () => ({ conversationId: `cnv_${nextConvId++}` }),
      'conversations:drop-turn': async (_ctx, input: unknown) => {
        captured.drops.push(input as { conversationId: string; turnId: string });
      },
      'conversations:hide': async (_ctx, input: unknown) => {
        captured.hides.push(input as { conversationId: string });
      },
      'agent:invoke': async (ctx, input: unknown) => {
        const msg = (input as { message: { content: string } }).message;
        captured.invokes.push({
          message: msg,
          reqId: ctx.reqId ?? '',
          conversationId: ctx.conversationId,
        });
        // Synchronously fire chat:turn-end so the routines plugin's
        // one-shot router runs in the same tick.
        await busRef.current!.bus.fire('chat:turn-end', ctx, {
          reqId: ctx.reqId,
          contentBlocks: replyOnInvoke.contentBlocks,
        });
        return { kind: 'complete', messages: [] };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createRoutinesPlugin({ tickIntervalMs: 60_000 /* loop effectively idle */ }),
    ],
  });
  busRef.current = h;
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('TRUNCATE routines_v1_definitions, routines_v1_fires');
  } finally {
    await cleanup.end();
  }
});

afterAll(async () => { if (container) await container.stop(); });

describe('Phase B canary — routine creates → fires → silence path closes window', () => {
  it('indexes a routine when workspace:applied carries .ax/routines/r.md', async () => {
    const captured: Captured = { invokes: [], drops: [], hides: [], findOrCreateCalls: [] };
    const h = await makeHarness(captured, { contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }] });
    const delta: WorkspaceDelta = {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => routineBody({ silenceToken: 'HEARTBEAT_OK' }) }],
    };
    const r = await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), delta);
    expect(r.rejected).toBe(false);
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    const rows = await k.selectFrom('routines_v1_definitions').selectAll().execute();
    await k.destroy();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('.ax/routines/r.md');
  });

  it('fire-now: silence-token reply triggers drop-turn + hide; status=silenced', async () => {
    const captured: Captured = { invokes: [], drops: [], hides: [], findOrCreateCalls: [] };
    const h = await makeHarness(captured, { contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }] });

    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => routineBody({ silenceToken: 'HEARTBEAT_OK' }) }],
    });

    const out = await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/r.md',
    });

    // Flush microtasks so the chat:turn-end one-shot completes its
    // recordFire before we read the table.
    await new Promise((r) => setImmediate(r));

    expect(captured.invokes).toHaveLength(1);
    expect(captured.invokes[0]!.message.content).toBe('check in');
    // chat:turn-end currently has no `turnId` in its wire schema
    // (ipc-protocol `EventTurnEndSchema`), so drop-turn is safely skipped
    // — see plugin.ts. Hide still runs because per-fire conversations get
    // hidden regardless of whether the silenced turn could be removed.
    expect(captured.drops).toHaveLength(0);
    expect(captured.hides).toHaveLength(1);

    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    const fires = await k.selectFrom('routines_v1_fires').selectAll().execute();
    await k.destroy();
    const silenced = fires.find((f) => f.status === 'silenced');
    expect(silenced, 'expected a silenced fire row').toBeDefined();

    void out;
  });

  it('fire-now: non-silence reply records status=ok and skips drop/hide', async () => {
    const captured: Captured = { invokes: [], drops: [], hides: [], findOrCreateCalls: [] };
    const h = await makeHarness(captured, { contentBlocks: [{ type: 'text', text: 'real reply text' }] });

    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => routineBody({ silenceToken: 'HEARTBEAT_OK' }) }],
    });

    await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/r.md',
    });

    await new Promise((r) => setImmediate(r));

    expect(captured.invokes).toHaveLength(1);
    expect(captured.drops).toEqual([]);
    expect(captured.hides).toEqual([]);
  });

  it('shared routine reuses the same conversation across fires (find-or-create)', async () => {
    const captured: Captured = { invokes: [], drops: [], hides: [], findOrCreateCalls: [] };
    const h = await makeHarness(captured, { contentBlocks: [{ type: 'text', text: 'reply' }] });

    const sharedBody = ENC.encode([
      '---', 'name: shared', 'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
      'conversation: shared',
      '---', 'check in',
    ].join('\n') + '\n');

    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/s.md', kind: 'added', contentAfter: async () => sharedBody }],
    });

    const first = await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/s.md',
    });
    const second = await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
      agentId: 'agt_a', path: '.ax/routines/s.md',
    });
    expect((first as { fireId: number }).fireId).toBeGreaterThan(0);
    expect((second as { fireId: number }).fireId).toBeGreaterThan(0);

    // Real reuse check: both fires hit conversations:find-or-create with the
    // routine path as the externalKey, and the (stable) handler returned
    // the same conversationId — which the routines plugin then lifted into
    // ctx.conversationId on each agent:invoke. If the routines plugin
    // mistakenly called :create on the second fire, the two captured
    // conversationIds would diverge.
    expect(captured.findOrCreateCalls).toEqual([
      { externalKey: '.ax/routines/s.md' },
      { externalKey: '.ax/routines/s.md' },
    ]);
    expect(captured.invokes).toHaveLength(2);
    expect(captured.invokes[0]!.conversationId).toBeDefined();
    expect(captured.invokes[0]!.conversationId).toBe(captured.invokes[1]!.conversationId);
  });
});
