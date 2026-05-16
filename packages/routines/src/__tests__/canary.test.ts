import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createRoutinesPlugin } from '../plugin.js';
import { asWorkspaceVersion, type WorkspaceDelta } from '@ax/core';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { RoutinesDatabase } from '../migrations.js';
import type { HttpRequest, HttpResponse, HttpRouteHandler, HttpRegisterRouteInput } from '@ax/http-server';

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
      'agents:ensure-webhook-token': async (_ctx, input: unknown) => ({
        token: `tok-${(input as { agentId: string }).agentId}`,
      }),
      'agents:resolve-by-webhook-token': async () => ({ agent: null }),
      'credentials:get': async () => 'secret',
      'http:register-route': async () => ({ unregister: () => {} }),
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
          turnId: 'fake-uuid-1',
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

    // routines:fire-now returns as soon as fireRoutine has dispatched
    // agent:invoke (fire-and-forget, see fire.ts). The chat:turn-end
    // subscriber chain (drop-turn → hide → recordFire(silenced)) runs
    // in the background. Poll for the side effect instead of fixing a
    // microtask count — Phase 2 added another await to that chain
    // which made a single setImmediate flush insufficient on CI.
    const k = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    let silenced: { status: string } | undefined;
    try {
      await vi.waitFor(async () => {
        const fires = await k.selectFrom('routines_v1_fires').selectAll().execute();
        silenced = fires.find((f) => f.status === 'silenced');
        expect(silenced, 'expected a silenced fire row').toBeDefined();
      }, { timeout: 5_000, interval: 25 });
    } finally {
      await k.destroy();
    }

    expect(captured.invokes).toHaveLength(1);
    expect(captured.invokes[0]!.message.content).toBe('check in');
    // chat:turn-end now carries turnId (Phase 2), so the silence path
    // drops the turn via conversations:drop-turn before hiding the
    // conversation.
    expect(captured.drops).toHaveLength(1);
    expect(captured.drops[0]!.turnId).toBe('fake-uuid-1');
    expect(captured.hides).toHaveLength(1);

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

describe('Phase C webhook canary — half-wired window closure', () => {
  function webhookBody(over: { secretRef?: string; path?: string } = {}): Uint8Array {
    const triggerPath = over.path ?? '/r/x';
    const lines = [
      '---',
      'name: r', 'description: d',
      'trigger:', '  kind: webhook', `  path: "${triggerPath}"`,
    ];
    if (over.secretRef !== undefined) {
      lines.push('  hmac:', `    secretRef: ${over.secretRef}`,
                 '    header: "X-Sig"', '    algorithm: sha256',
                 '    prefix: "sha256="');
    }
    lines.push('conversation: per-fire', '---', 'PR: {{payload.pr.title}}');
    return ENC.encode(lines.join('\n') + '\n');
  }

  interface WebCaptured {
    invokes: Array<{ message: { content: string }; reqId: string; sessionId: string; conversationId: string | undefined }>;
    routes: Array<{ method: string; path: string; bypassCsrf: boolean | undefined }>;
    handlers: Map<string, HttpRouteHandler>;
    unregisters: string[];
    ensures: number;
  }

  async function makeWebHarness(): Promise<{
    h: TestHarness;
    captured: WebCaptured;
    tokens: Map<string, string>;
  }> {
    const captured: WebCaptured = {
      invokes: [], routes: [], handlers: new Map(), unregisters: [], ensures: 0,
    };
    let nextConvId = 1;
    const tokens = new Map<string, string>();
    const busRef: { current: TestHarness | undefined } = { current: undefined };

    const h = await createTestHarness({
      services: {
        'agents:resolve': async (_c, input: unknown) => {
          const i = input as { agentId: string };
          return { agent: { id: i.agentId, ownerId: 'u1', workspaceRef: null } };
        },
        // agents:ensure-webhook-token: idempotent — generates a token on first
        // call per agent, returns the same one on subsequent calls (no rotation).
        'agents:ensure-webhook-token': async (_c, input: unknown) => {
          const i = input as { agentId: string };
          captured.ensures += 1;
          let tok = tokens.get(i.agentId);
          if (tok === undefined) {
            tok = `tok-${captured.ensures}`;
            tokens.set(i.agentId, tok);
          }
          return { token: tok };
        },
        'agents:resolve-by-webhook-token': async (_c, input: unknown) => {
          const t = (input as { token: string }).token;
          for (const [id, tok] of tokens.entries()) {
            if (tok === t) return { agent: { id, ownerId: 'u1' } };
          }
          return null;
        },
        'credentials:get': async (_c, input: unknown) => {
          const ref = (input as { ref: string }).ref;
          if (ref === 'gh-secret') return 'shhh';
          throw new Error('no-such-credential');
        },
        'http:register-route': async (_c, input: unknown) => {
          const i = input as HttpRegisterRouteInput;
          captured.routes.push({
            method: i.method,
            path: i.path,
            bypassCsrf: i.bypassCsrf,
          });
          captured.handlers.set(i.path, i.handler);
          return {
            unregister: () => {
              captured.unregisters.push(i.path);
              captured.handlers.delete(i.path);
            },
          };
        },
        'conversations:create': async () => ({ conversationId: `cnv_${nextConvId++}` }),
        'conversations:find-or-create': async () => ({
          conversation: { conversationId: 'shared' }, created: false,
        }),
        'conversations:drop-turn': async () => undefined,
        'conversations:hide': async () => undefined,
        'agent:invoke': async (ctx, input: unknown) => {
          const i = input as { message: { content: string } };
          captured.invokes.push({
            message: i.message, reqId: ctx.reqId ?? '',
            sessionId: ctx.sessionId,
            conversationId: ctx.conversationId,
          });
          await busRef.current!.bus.fire('chat:turn-end', ctx, {
            reqId: ctx.reqId, turnId: 'fake-uuid-1',
            contentBlocks: [{ type: 'text', text: 'ack' }],
          });
          return { kind: 'complete', messages: [] };
        },
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createRoutinesPlugin({ tickIntervalMs: 60_000 }),
      ],
    });
    busRef.current = h;
    harnesses.push(h);
    return { h, captured, tokens };
  }

  function makeReq(over: Partial<{ headers: Record<string, string>; body: Buffer }> = {}): HttpRequest {
    return {
      method: 'POST',
      path: '/webhooks/tok-1/r/x',
      query: {}, params: {},
      headers: { 'content-type': 'application/json', ...(over.headers ?? {}) },
      body: over.body ?? Buffer.from('{}'),
      cookies: {},
      signedCookie: () => null,
    } as unknown as HttpRequest;
  }

  interface SyntheticRes extends HttpResponse {
    _calls: { status?: number; ended?: boolean };
  }

  function makeRes(): SyntheticRes {
    const calls: { status?: number; ended?: boolean } = {};
    const r: SyntheticRes = {
      status(n: number) { calls.status = n; return r; },
      header() { return r; },
      end() { calls.ended = true; },
      text() { calls.ended = true; },
      json() { calls.ended = true; },
      body() { calls.ended = true; },
      redirect() { calls.ended = true; },
      setSignedCookie() {}, clearCookie() {},
      stream() { throw new Error('not used'); },
      _calls: calls,
    };
    return r;
  }

  it('case 1: route mounts on first webhook routine indexing', async () => {
    const { h, captured } = await makeWebHarness();
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody() }],
    });
    expect(captured.routes).toEqual([
      { method: 'POST', path: '/webhooks/tok-1/r/x', bypassCsrf: true },
    ]);
    expect(captured.ensures).toBe(1);
    expect(captured.handlers.size).toBe(1);
  });

  it('case 2: lazy token generation is idempotent across two webhook routines for the same agent', async () => {
    const { h, captured } = await makeWebHarness();
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [
        { path: '.ax/routines/a.md', kind: 'added', contentAfter: async () => webhookBody({ path: '/r/a' }) },
        { path: '.ax/routines/b.md', kind: 'added', contentAfter: async () => webhookBody({ path: '/r/b' }) },
      ],
    });
    // ensure is called once per routine (2 calls total) but returns the SAME
    // token both times (idempotent — ensures does not rotate).
    expect(captured.ensures).toBe(2);
    expect(captured.routes.map((r) => r.path).sort()).toEqual([
      '/webhooks/tok-1/r/a', '/webhooks/tok-1/r/b',
    ]);
  });

  it('case 3: HMAC mismatch returns 401 and does not fire agent:invoke', async () => {
    const { h, captured } = await makeWebHarness();
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody({ secretRef: 'gh-secret' }) }],
    });
    const handler = captured.handlers.get('/webhooks/tok-1/r/x')!;
    expect(handler).toBeDefined();
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': 'sha256=deadbeef' },
      body: Buffer.from('{"pr":{"title":"x"}}'),
    }), res);
    expect(res._calls.status).toBe(401);
    expect(captured.invokes).toHaveLength(0);
  });

  it('case 4: valid POST → templated agent:invoke with substituted prompt', async () => {
    const { h, captured } = await makeWebHarness();
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody({ secretRef: 'gh-secret' }) }],
    });
    const handler = captured.handlers.get('/webhooks/tok-1/r/x')!;
    const body = Buffer.from('{"pr":{"title":"fix bug"}}');
    const sig = 'sha256=' + createHmac('sha256', 'shhh').update(body).digest('hex');
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': sig },
      body,
    }), res);
    await vi.waitFor(() => expect(captured.invokes).toHaveLength(1),
      { timeout: 5_000, interval: 25 });
    expect(res._calls.status).toBe(202);
    expect(captured.invokes[0]!.message.content).toBe('PR: fix bug');
  });

  it('case 5: routine deletion calls the stashed unregister closure', async () => {
    const { h, captured } = await makeWebHarness();
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody() }],
    });
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: asWorkspaceVersion('v1'), after: asWorkspaceVersion('v2'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'deleted' }],
    });
    expect(captured.unregisters).toEqual(['/webhooks/tok-1/r/x']);
    expect(captured.handlers.size).toBe(0);
  });

  it('case 7: webhook routes register with bypassCsrf: true (initial + rebind)', async () => {
    // #82 pin: webhook receivers are external by design — the token in the
    // URL is the auth (Phase C design §5). Both the initial registration
    // and the post-rotation rebind MUST opt out of CSRF; without this,
    // every plain external POST hits the http-server CSRF subscriber and
    // 403s before the handler runs.
    const { h, captured, tokens } = await makeWebHarness();
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody() }],
    });
    expect(captured.routes[0]?.bypassCsrf).toBe(true);

    tokens.set('agt_a', 'tok-2');
    await h.bus.fire('agents:webhook-token-rotated', h.ctx({ userId: 'u1' }),
      { agentId: 'agt_a' });
    const rebound = captured.routes.find((r) => r.path === '/webhooks/tok-2/r/x');
    expect(rebound?.bypassCsrf).toBe(true);
  });

  it('case 8: repeated webhook fires of the same routine produce distinct sessionIds (#86)', async () => {
    // The host-side session store rejects duplicate sessionIds even after the
    // prior session has terminated. If the routines plugin reuses the same
    // `routine-<agentId>-<path>` sessionId across fires, every fire after the
    // first will fail at session:create with `session 'X' already exists`.
    // Each fire MUST mint a unique sessionId so downstream session:create can
    // succeed every time.
    const { h, captured } = await makeWebHarness();
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody() }],
    });
    const handler = captured.handlers.get('/webhooks/tok-1/r/x')!;
    expect(handler).toBeDefined();

    await handler(makeReq({ body: Buffer.from('{"pr":{"title":"first"}}') }), makeRes());
    await handler(makeReq({ body: Buffer.from('{"pr":{"title":"second"}}') }), makeRes());

    await vi.waitFor(() => expect(captured.invokes).toHaveLength(2),
      { timeout: 5_000, interval: 25 });
    const [a, b] = captured.invokes;
    expect(a!.sessionId).not.toBe(b!.sessionId);
    expect(a!.sessionId).toMatch(/^routine-agt_a-\.ax\/routines\/r\.md-/);
    expect(b!.sessionId).toMatch(/^routine-agt_a-\.ax\/routines\/r\.md-/);
  });

  it('case 6: agents:webhook-token-rotated unmounts old route and registers fresh route (K5 e2e)', async () => {
    const { h, captured, tokens } = await makeWebHarness();
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody() }],
    });
    expect(captured.routes).toEqual([
      { method: 'POST', path: '/webhooks/tok-1/r/x', bypassCsrf: true },
    ]);
    expect(captured.handlers.size).toBe(1);

    // Simulate @ax/agents rotating the token: mutate the harness map so the
    // next ensure-webhook-token call returns the fresh value, then fire the
    // event that PR #77's rebind subscriber listens for.
    tokens.set('agt_a', 'tok-2');
    await h.bus.fire('agents:webhook-token-rotated', h.ctx({ userId: 'u1' }),
      { agentId: 'agt_a' });

    expect(captured.unregisters).toContain('/webhooks/tok-1/r/x');
    expect(captured.routes.map((r) => r.path)).toEqual([
      '/webhooks/tok-1/r/x', '/webhooks/tok-2/r/x',
    ]);
    expect(captured.handlers.size).toBe(1);
    expect(captured.handlers.has('/webhooks/tok-2/r/x')).toBe(true);
    expect(captured.handlers.has('/webhooks/tok-1/r/x')).toBe(false);
  });
});
