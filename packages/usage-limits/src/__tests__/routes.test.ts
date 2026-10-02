import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import type { AgentContext, ServiceHandler } from '@ax/core';
import { bootUsageLimits, truncateUsageTables, type Booted } from './helpers.js';
import { LIMITS_STORAGE_KEY } from '../config.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const booted: Booted[] = [];

async function boot(services: Record<string, ServiceHandler> = {}): Promise<Booted> {
  const b = await bootUsageLimits({ connectionString, services });
  booted.push(b);
  return b;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (booted.length > 0) await booted.pop()!.harness.close({ onError: () => {} });
  await truncateUsageTables(connectionString);
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

/** Charge `usd` to `userId` through the real chat:turn-end subscriber. */
async function spend(b: Booted, userId: string, opts: { turns?: number; outputTokens?: number } = {}) {
  const ctx = b.harness.ctx({ userId });
  for (let i = 0; i < (opts.turns ?? 1); i++) {
    const r = await b.harness.bus.fire('chat:start', b.harness.ctx({ userId }), { message: 'hi' });
    expect(r.rejected).toBe(false);
  }
  if (opts.outputTokens !== undefined) {
    await b.harness.bus.fire('chat:turn-end', ctx, {
      role: 'assistant',
      reason: 'complete',
      // opus: 75 micro-USD per output token
      usage: { model: 'anthropic/claude-opus-4', inputTokens: 0, outputTokens: opts.outputTokens },
    });
  }
}

describe('auth', () => {
  it('401 unauthenticated and 403 non-admin on every route', async () => {
    const b = await boot();
    const calls: Array<[string, string, Record<string, string>?]> = [
      ['GET', '/admin/usage'],
      ['PUT', '/admin/usage/limits'],
      ['PUT', '/admin/usage/users/:userId/suspension', { userId: 'u1' }],
      ['DELETE', '/admin/usage/users/:userId/suspension', { userId: 'u1' }],
    ];
    b.setAuth('throw');
    for (const [m, p, params] of calls) {
      expect((await b.request(m, p, { params: params ?? {} })).status).toBe(401);
    }
    b.setAuth({ id: 'u9', isAdmin: false });
    for (const [m, p, params] of calls) {
      const r = await b.request(m, p, { params: params ?? {} });
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ error: 'forbidden' });
    }
  });

  it('registers the mutating routes with a 4 KiB body cap', async () => {
    const b = await boot();
    for (const r of b.routes.filter((x) => x.method !== 'GET')) {
      expect(r.maxBodyBytes).toBe(r.path === '/admin/usage/prices' ? 32768 : 4096);
    }
  });
});

describe('GET /admin/usage', () => {
  it('returns the documented shape with names from auth:get-user', async () => {
    const b = await boot({
      'auth:get-user': (async (_ctx: AgentContext, { userId }: { userId: string }) =>
        userId === 'alice'
          ? { id: 'alice', email: 'a@example.com', displayName: 'Alice', isAdmin: false }
          : null) as ServiceHandler,
    });
    await spend(b, 'alice', { turns: 2, outputTokens: 1000 });
    await spend(b, 'bob', { turns: 1 });

    const r = await b.request('GET', '/admin/usage');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      windowHours: 24,
      truncated: false,
      limits: { dailySpendUsd: 5, turnsPerHour: 60, assumedTurnCostUsd: 0.25, fleetDailySpendUsd: 100 },
      totals: { turns: 3, spendUsd: 0.075, users: 2 },
      users: [
        {
          userId: 'alice',
          displayName: 'Alice',
          email: 'a@example.com',
          turnsLastHour: 2,
          turnsLast24h: 2,
          inputTokens: 0,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          spendUsd: 0.075,
          status: 'ok',
          suspended: null,
        },
        {
          userId: 'bob',
          displayName: null,
          email: null,
          turnsLastHour: 1,
          turnsLast24h: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          spendUsd: 0,
          status: 'ok',
          suspended: null,
        },
      ],
    });
  });

  it('shows null names when auth:get-user is absent or throws', async () => {
    const b = await boot({
      'auth:get-user': (async () => {
        throw new Error('auth down');
      }) as ServiceHandler,
    });
    await spend(b, 'alice');
    const r = await b.request('GET', '/admin/usage');
    expect(r.status).toBe(200);
    expect((r.json as { users: Array<{ displayName: unknown; email: unknown }> }).users[0]).toMatchObject({
      displayName: null,
      email: null,
    });

    const c = await boot();
    const r2 = await c.request('GET', '/admin/usage');
    expect((r2.json as { users: unknown[] }).users).toHaveLength(1);
  });

  it('derives ok / near-limit / at-limit / suspended', async () => {
    const b = await boot();
    // Tight limits so the numbers are small: $1/day, 10 turns/hour.
    expect(
      (await b.request('PUT', '/admin/usage/limits', { body: { dailySpendUsd: 1, turnsPerHour: 10 } })).status,
    ).toBe(200);
    await spend(b, 'ok-user', { turns: 1 });
    await spend(b, 'near-spend', { turns: 1, outputTokens: 11_000 }); // $0.825 = 82.5%
    await spend(b, 'near-rate', { turns: 8 }); // 80% of 10
    await spend(b, 'at-spend', { turns: 1, outputTokens: 14_000 }); // $1.05
    await spend(b, 'at-rate', { turns: 10 });
    await spend(b, 'susp', { turns: 1 });
    expect(
      (await b.request('PUT', '/admin/usage/users/:userId/suspension', { params: { userId: 'susp' } })).status,
    ).toBe(200);

    const r = await b.request('GET', '/admin/usage');
    const byId = Object.fromEntries(
      (r.json as { users: Array<{ userId: string; status: string }> }).users.map((u) => [u.userId, u.status]),
    );
    expect(byId).toEqual({
      'ok-user': 'ok',
      'near-spend': 'near-limit',
      'near-rate': 'near-limit',
      'at-spend': 'at-limit',
      'at-rate': 'at-limit',
      susp: 'suspended',
    });
  });
});

describe('PUT /admin/usage/limits', () => {
  it('saves valid limits through storage and returns them', async () => {
    const b = await boot();
    const r = await b.request('PUT', '/admin/usage/limits', {
      body: { dailySpendUsd: 2.5, turnsPerHour: 30, assumedTurnCostUsd: 0.5, fleetDailySpendUsd: 100 },
    });
    expect(r).toEqual({
      status: 200,
      json: { limits: { dailySpendUsd: 2.5, turnsPerHour: 30, assumedTurnCostUsd: 0.5, fleetDailySpendUsd: 100 } },
    });
    const stored = JSON.parse(new TextDecoder().decode(b.storage.get(LIMITS_STORAGE_KEY)));
    expect(stored).toEqual({ dailySpendUsd: 2.5, turnsPerHour: 30, assumedTurnCostUsd: 0.5, fleetDailySpendUsd: 100 });
    const g = await b.request('GET', '/admin/usage');
    expect((g.json as { limits: unknown }).limits).toEqual(stored);
  });

  it('keeps assumedTurnCostUsd when it is omitted', async () => {
    const b = await boot();
    const r = await b.request('PUT', '/admin/usage/limits', { body: { dailySpendUsd: 3, turnsPerHour: 7 } });
    expect(r.json).toMatchObject({ limits: { dailySpendUsd: 3, turnsPerHour: 7, assumedTurnCostUsd: 0.25, fleetDailySpendUsd: 100 } });
  });

  it('rejects bad shapes and bounds with invalid-limits, and bad bodies', async () => {
    const b = await boot();
    const bad: unknown[] = [
      {},
      { dailySpendUsd: 5 },
      { turnsPerHour: 5 },
      { dailySpendUsd: 0, turnsPerHour: 5 },
      { dailySpendUsd: 10_001, turnsPerHour: 5 },
      { dailySpendUsd: 5, turnsPerHour: 0 },
      { dailySpendUsd: 5, turnsPerHour: 2.5 },
      { dailySpendUsd: 5, turnsPerHour: 100_001 },
      { dailySpendUsd: '5', turnsPerHour: 5 },
      { dailySpendUsd: 5, turnsPerHour: 5, assumedTurnCostUsd: -1 },
      { dailySpendUsd: 5, turnsPerHour: 5, assumedTurnCostUsd: 101, fleetDailySpendUsd: 100 },
      { dailySpendUsd: 5, turnsPerHour: 5, extra: true },
      [1, 2],
      null,
    ];
    for (const body of bad) {
      const r = await b.request('PUT', '/admin/usage/limits', { body });
      expect(r, JSON.stringify(body)).toEqual({ status: 400, json: { error: 'invalid-limits' } });
    }
    expect(await b.request('PUT', '/admin/usage/limits', { rawBody: Buffer.from('{nope') })).toEqual({
      status: 400,
      json: { error: 'invalid-json' },
    });
    expect(
      await b.request('PUT', '/admin/usage/limits', { rawBody: Buffer.alloc(4097, 0x20) }),
    ).toEqual({ status: 413, json: { error: 'body-too-large' } });
    expect(b.storage.has(LIMITS_STORAGE_KEY)).toBe(false);
  });
});

describe('suspension routes', () => {
  const put = (b: Booted, userId: string, body?: unknown) =>
    b.request('PUT', '/admin/usage/users/:userId/suspension', { params: { userId }, body });
  const del = (b: Booted, userId: string) =>
    b.request('DELETE', '/admin/usage/users/:userId/suspension', { params: { userId } });

  it('suspends (refusing new turns), then resumes (admitting again)', async () => {
    const b = await boot();
    const r = await put(b, 'u1', { note: 'looping' });
    expect(r.status).toBe(200);
    const body = r.json as { suspended: { at: string; by: string; note: string }; interrupted: number };
    expect(body.suspended).toEqual({ at: b.clock.now.toISOString(), by: 'admin-1', note: 'looping' });
    expect(body.interrupted).toBe(0);

    const ctx = b.harness.ctx({ userId: 'u1' });
    const refused = await b.harness.bus.fire('chat:start', ctx, { message: 'x' });
    expect(refused).toMatchObject({ rejected: true, reason: 'usage-suspended' });

    expect(await del(b, 'u1')).toEqual({ status: 200, json: { suspended: null } });
    expect(await del(b, 'u1')).toEqual({ status: 200, json: { suspended: null } });
    const ok = await b.harness.bus.fire('chat:start', ctx, { message: 'x' });
    expect(ok.rejected).toBe(false);
  });

  it('suspends with no body (note null)', async () => {
    const b = await boot();
    const r = await put(b, 'u1');
    expect((r.json as { suspended: { note: unknown } }).suspended.note).toBeNull();
  });

  it('rejects an invalid user id, an overlong note and suspending yourself', async () => {
    const b = await boot();
    for (const id of ['', '-lead', 'a b', 'x'.repeat(129), '../etc', 'a/b']) {
      expect(await put(b, id), id).toEqual({ status: 400, json: { error: 'invalid-user-id' } });
      expect((await del(b, id)).status, id).toBe(400);
    }
    expect((await put(b, 'u1', { note: 'n'.repeat(201) })).status).toBe(400);
    expect((await put(b, 'u1', { note: 5 })).status).toBe(400);
    expect(await put(b, 'admin-1')).toEqual({ status: 400, json: { error: 'cannot-suspend-self' } });
    const g = await b.request('GET', '/admin/usage');
    expect((g.json as { users: unknown[] }).users).toEqual([]);
  });

  it('interrupts the target user\'s in-flight turns, best-effort, under the target\'s identity', async () => {
    const listCalls: Array<{ ctxUser: string; input: unknown }> = [];
    const interruptCalls: Array<{ ctxUser: string; input: { conversationId: string; userId: string } }> = [];
    const b = await boot({
      'conversations:list': (async (ctx: AgentContext, input: { userId: string }) => {
        listCalls.push({ ctxUser: ctx.userId, input });
        return [
          { conversationId: 'c-idle', activeReqId: null },
          { conversationId: 'c-live', activeReqId: 'req-1' },
          { conversationId: 'c-boom', activeReqId: 'req-2' },
          { conversationId: 'c-done', activeReqId: 'req-3' },
          { conversationId: 'c-empty', activeReqId: '' },
        ];
      }) as ServiceHandler,
      'agent:interrupt': (async (ctx: AgentContext, input: { conversationId: string; userId: string }) => {
        interruptCalls.push({ ctxUser: ctx.userId, input });
        if (input.conversationId === 'c-boom') throw new Error('runner gone');
        return { interrupted: input.conversationId === 'c-live' };
      }) as ServiceHandler,
    });
    const r = await put(b, 'target');
    expect(r.status).toBe(200);
    expect((r.json as { interrupted: number }).interrupted).toBe(1);
    expect(listCalls).toEqual([{ ctxUser: 'target', input: { userId: 'target' } }]);
    expect(interruptCalls.map((c) => c.input.conversationId)).toEqual(['c-live', 'c-boom', 'c-done']);
    expect(interruptCalls.every((c) => c.ctxUser === 'target' && c.input.userId === 'target')).toBe(true);
  });

  it('still suspends when conversations:list throws', async () => {
    const b = await boot({
      'conversations:list': (async () => {
        throw new Error('db down');
      }) as ServiceHandler,
      'agent:interrupt': (async () => ({ interrupted: true })) as ServiceHandler,
    });
    const r = await put(b, 'target');
    expect(r.status).toBe(200);
    expect((r.json as { interrupted: number }).interrupted).toBe(0);
  });

  it('does not try to interrupt when only one of the two hooks exists', async () => {
    let listed = false;
    const b = await boot({
      'conversations:list': (async () => {
        listed = true;
        return [];
      }) as ServiceHandler,
    });
    const r = await put(b, 'target');
    expect((r.json as { interrupted: number }).interrupted).toBe(0);
    expect(listed).toBe(false);
  });
});
