import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { createUsageLimitsPlugin } from '../plugin.js';
import type { ProviderVerdict } from '../store.js';
import { bootUsageLimits, truncateUsageTables, type Booted } from './helpers.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const booted: Booted[] = [];

async function boot(): Promise<Booted> {
  const b = await bootUsageLimits({ connectionString });
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

const start = (b: Booted, userId: string) =>
  b.harness.bus.fire('chat:start', b.harness.ctx({ userId }), { message: 'hello' });

const turnEnd = (b: Booted, userId: string, payload: unknown) =>
  b.harness.bus.fire('chat:turn-end', b.harness.ctx({ userId }), payload);

async function setLimits(b: Booted, body: Record<string, number>): Promise<void> {
  const r = await b.request('PUT', '/admin/usage/limits', { body });
  expect(r.status).toBe(200);
}

async function usageOf(b: Booted, userId: string) {
  const r = await b.request('GET', '/admin/usage');
  const users = (r.json as { users: Array<{ userId: string; spendUsd: number; turnsLast24h: number; inputTokens: number }> }).users;
  return users.find((u) => u.userId === userId);
}

describe('manifest', () => {
  it('subscribes to the gate + meters, registers the two provider hooks, declares its calls', () => {
    const m = createUsageLimitsPlugin().manifest;
    expect(m.name).toBe('@ax/usage-limits');
    expect(m.registers).toEqual(['usage:provider-status', 'usage:provider-record']);
    expect(m.subscribes).toEqual(['chat:start', 'chat:resume', 'chat:turn-end', 'llm:usage']);
    expect(m.calls).toEqual([
      'database:get-instance',
      'storage:get',
      'storage:set',
      'http:register-route',
      'auth:require-user',
    ]);
    expect(m.optionalCalls?.map((c) => c.hook)).toEqual([
      'auth:get-user',
      'conversations:list',
      'agent:interrupt',
    ]);
    for (const c of m.optionalCalls ?? []) expect(c.degradation.length).toBeGreaterThan(0);
  });
});

describe('the chat:start gate', () => {
  it('passes the payload through when under the limits', async () => {
    const b = await boot();
    expect(await start(b, 'alice')).toEqual({ rejected: false, payload: { message: 'hello' } });
  });

  it('refuses with usage-limit-daily once recorded spend reaches the cap; other users unaffected', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 100 });
    expect((await start(b, 'alice')).rejected).toBe(false);
    // 13_334 opus output tokens x 75 micros = $1.00005
    await turnEnd(b, 'alice', {
      role: 'assistant',
      reason: 'complete',
      usage: { model: 'anthropic/claude-opus-4-1', inputTokens: 0, outputTokens: 13_334 },
    });
    expect(await start(b, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-daily' });
    expect((await start(b, 'bob')).rejected).toBe(false);
  });

  it('refuses with usage-limit-rate past turnsPerHour', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 100, turnsPerHour: 3 });
    for (let i = 0; i < 3; i++) expect((await start(b, 'alice')).rejected).toBe(false);
    expect(await start(b, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-rate' });
    // An hour later the window has rolled.
    b.clock.advance(61 * 60_000);
    expect((await start(b, 'alice')).rejected).toBe(false);
  });

  it('refuses a suspended user with usage-suspended', async () => {
    const b = await boot();
    await b.request('PUT', '/admin/usage/users/:userId/suspension', { params: { userId: 'mallory' } });
    expect(await start(b, 'mallory')).toMatchObject({ rejected: true, reason: 'usage-suspended' });
    expect((await start(b, 'alice')).rejected).toBe(false);
  });

  it('refuses a context with no user', async () => {
    const b = await boot();
    expect(await start(b, '')).toMatchObject({ rejected: true, reason: 'usage-check-unavailable' });
  });

  it('FAILS CLOSED: a broken database refuses the turn instead of letting it through', async () => {
    const b = await boot();
    const { db } = await b.harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      b.harness.ctx(),
      {},
    );
    await db.destroy();
    expect(await start(b, 'alice')).toMatchObject({
      rejected: true,
      reason: 'usage-check-unavailable',
    });
  });

  it('the counter survives a plugin restart', async () => {
    const b1 = await boot();
    await setLimits(b1, { dailySpendUsd: 1, turnsPerHour: 100 });
    const storage = new Map(b1.storage);
    await turnEnd(b1, 'alice', {
      role: 'assistant',
      usage: { model: 'anthropic/claude-opus-4', inputTokens: 0, outputTokens: 20_000 },
    });
    await b1.harness.close({ onError: () => {} });

    const b2 = await boot();
    for (const [k, v] of storage) b2.storage.set(k, v);
    expect(await start(b2, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-daily' });
  });
});

// A parked agent that is woken by an approved/dismissed decision starts a turn
// WITHOUT passing `agent:invoke`, so `chat:start` never sees it. `chat:resume`
// (fired by @ax/decisions before it wakes the runner) is judged exactly like a
// `chat:start`: same suspension check, same caps, and it counts as a turn.
describe('the chat:resume gate (a wake-up is a turn)', () => {
  const resume = (b: Booted, userId: string) =>
    b.harness.bus.fire('chat:resume', b.harness.ctx({ userId }), {
      decisionId: 'dec_1',
      outcome: 'approved',
    });

  it('refuses a suspended user, admits another', async () => {
    const b = await boot();
    await b.request('PUT', '/admin/usage/users/:userId/suspension', { params: { userId: 'mallory' } });
    expect(await resume(b, 'mallory')).toMatchObject({ rejected: true, reason: 'usage-suspended' });
    expect((await resume(b, 'alice')).rejected).toBe(false);
  });

  it('refuses once the daily spend cap is reached', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 100 });
    await turnEnd(b, 'alice', {
      role: 'assistant',
      usage: { model: 'anthropic/claude-opus-4', inputTokens: 0, outputTokens: 20_000 },
    });
    expect(await resume(b, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-daily' });
  });

  it('counts against the hourly turn cap, shared with chat:start', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 100, turnsPerHour: 2 });
    expect((await start(b, 'alice')).rejected).toBe(false);
    expect((await resume(b, 'alice')).rejected).toBe(false);
    expect(await resume(b, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-rate' });
    expect(await start(b, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-rate' });
  });

  it('FAILS CLOSED when the database is broken', async () => {
    const b = await boot();
    const { db } = await b.harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      b.harness.ctx(),
      {},
    );
    await db.destroy();
    expect(await resume(b, 'alice')).toMatchObject({
      rejected: true,
      reason: 'usage-check-unavailable',
    });
  });
});

describe('the chat:turn-end meter', () => {
  it('charges the assumed cost for unreported turns, so N of them hit the cap', async () => {
    const b = await boot();
    // $1/day, $0.25 assumed per unreported turn -> 4 turns reach the cap.
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 100, assumedTurnCostUsd: 0.25 });
    for (let i = 0; i < 4; i++) {
      expect((await start(b, 'alice')).rejected).toBe(false);
      await turnEnd(b, 'alice', { role: 'assistant', reason: 'complete' });
    }
    expect(await start(b, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-daily' });
  });

  it('charges nothing for a role=tool turn-end', async () => {
    const b = await boot();
    await start(b, 'alice');
    await turnEnd(b, 'alice', {
      role: 'tool',
      usage: { model: 'anthropic/claude-opus-4', inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    await turnEnd(b, 'alice', { role: 'tool' });
    expect(await usageOf(b, 'alice')).toMatchObject({ spendUsd: 0, inputTokens: 0 });
  });

  it('hostile usage cannot reduce or corrupt the total', async () => {
    const b = await boot();
    await start(b, 'alice');
    await turnEnd(b, 'alice', {
      role: 'assistant',
      usage: { model: 'anthropic/claude-haiku-4', inputTokens: 1_000_000, outputTokens: 0 },
    });
    const before = (await usageOf(b, 'alice'))!.spendUsd;
    expect(before).toBe(1);
    const hostile: unknown[] = [
      { inputTokens: -1e12, outputTokens: -1e12 },
      { inputTokens: Number.NaN },
      { inputTokens: '99999999', outputTokens: 0 },
      { inputTokens: 1e18, outputTokens: 1e18, cacheReadTokens: 1e18, cacheWriteTokens: 1e18 },
      'not-an-object',
    ];
    for (const usage of hostile) await turnEnd(b, 'alice', { role: 'assistant', usage });
    const after = (await usageOf(b, 'alice'))!;
    expect(after.spendUsd).toBeGreaterThanOrEqual(before);
    expect(Number.isFinite(after.spendUsd)).toBe(true);
    expect(after.inputTokens).toBeGreaterThanOrEqual(1_000_000);
    // 1e18 is clamped to 1e9 per field, priced at the top tier:
    // 1e9 x (15 + 75 + 1.5 + 18.75) micros = $110,250.
    expect(after.inputTokens).toBe(1_000_000 + 1_000_000_000);
  });
});

describe('the llm:usage meter', () => {
  it('charges a helper call without counting a turn', async () => {
    const b = await boot();
    await b.harness.bus.fire('llm:usage', b.harness.ctx({ userId: 'alice' }), {
      model: 'anthropic/claude-haiku-4-5',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    expect(await usageOf(b, 'alice')).toMatchObject({ spendUsd: 1, turnsLast24h: 0, inputTokens: 1_000_000 });
  });

  it('lands in helper_cost_micros, not cost_micros', async () => {
    const b = await boot();
    await b.harness.bus.fire('llm:usage', b.harness.ctx({ userId: 'alice' }), {
      model: 'anthropic/claude-haiku-4-5',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    const { db } = await b.harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      b.harness.ctx(),
      {},
    );
    const r = await sql<{ cost_micros: string; helper_cost_micros: string; provider_cost_micros: string }>`
      SELECT cost_micros, helper_cost_micros, provider_cost_micros
      FROM usage_limits_v1_buckets WHERE user_id = 'alice'
    `.execute(db);
    expect(r.rows).toEqual([{ cost_micros: '0', helper_cost_micros: '1000000', provider_cost_micros: '0' }]);
  });
});

// TASK-715: the two service hooks the credential proxy calls for every model
// request that leaves the sandbox. Exercised through a real bus and a real
// Postgres, the way the proxy plugin will call them.
describe('the provider hooks (usage:provider-status / usage:provider-record)', () => {
  const status = (b: Booted, userId: string) =>
    b.harness.bus.call<unknown, ProviderVerdict>('usage:provider-status', b.harness.ctx({ userId }), {});
  const record = (b: Booted, userId: string, payload: unknown) =>
    b.harness.bus.call<unknown, ProviderVerdict>('usage:provider-record', b.harness.ctx({ userId }), payload);

  /** Haiku, 1M input tokens: exactly $1.00 of estimated spend. */
  const ONE_DOLLAR = {
    model: 'anthropic/claude-haiku-4-5',
    usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    requestBytes: 4_000_000,
  };
  const DAILY = { blocked: true, reason: 'usage-limit-daily' } as const;

  it('registers both hooks on the bus', async () => {
    const b = await boot();
    expect(b.harness.bus.hasService('usage:provider-status')).toBe(true);
    expect(b.harness.bus.hasService('usage:provider-record')).toBe(true);
  });

  it('is not blocked for a user with no usage', async () => {
    const b = await boot();
    expect(await status(b, 'alice')).toEqual({ blocked: false });
  });

  it('records, then flips to blocked once spend passes 2x the daily limit; other users unaffected', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 100 });
    expect(await record(b, 'alice', ONE_DOLLAR)).toEqual({ blocked: false });
    // At 1x a NEW turn is already refused, but the sandbox keeps its key: an
    // admitted turn may finish (this is the gap between the two ceilings).
    expect(await start(b, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-daily' });
    expect(await status(b, 'alice')).toEqual({ blocked: false });
    // The second dollar reaches exactly 2x.
    expect(await record(b, 'alice', ONE_DOLLAR)).toEqual(DAILY);
    expect(await status(b, 'alice')).toEqual(DAILY);
    expect(await status(b, 'bob')).toEqual({ blocked: false });
    expect(await record(b, 'bob', { ...ONE_DOLLAR, usage: { ...ONE_DOLLAR.usage, inputTokens: 1 } })).toEqual({
      blocked: false,
    });
    // Proxy-measured spend is visible in the admin view.
    expect(await usageOf(b, 'alice')).toMatchObject({ spendUsd: 2, turnsLast24h: 0 });
  });

  it('a spend only the proxy ever saw makes chat:start refuse the user', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 100 });
    await record(b, 'mallory', ONE_DOLLAR);
    expect(await start(b, 'mallory')).toMatchObject({ rejected: true, reason: 'usage-limit-daily' });
  });

  it('does not double-count what the runner and the proxy both saw; helper calls add on top', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 100, turnsPerHour: 100 });
    await turnEnd(b, 'alice', { role: 'assistant', usage: { ...ONE_DOLLAR.usage, model: ONE_DOLLAR.model } });
    await record(b, 'alice', ONE_DOLLAR);
    expect(await usageOf(b, 'alice')).toMatchObject({ spendUsd: 1 });
    await b.harness.bus.fire('llm:usage', b.harness.ctx({ userId: 'alice' }), {
      model: ONE_DOLLAR.model,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    expect(await usageOf(b, 'alice')).toMatchObject({ spendUsd: 2 });
  });

  it('a suspended user is blocked with usage-suspended, on both hooks; others are not', async () => {
    const b = await boot();
    await b.request('PUT', '/admin/usage/users/:userId/suspension', { params: { userId: 'mallory' } });
    expect(await status(b, 'mallory')).toEqual({ blocked: true, reason: 'usage-suspended' });
    expect(await record(b, 'mallory', ONE_DOLLAR)).toEqual({ blocked: true, reason: 'usage-suspended' });
    expect(await status(b, 'alice')).toEqual({ blocked: false });
    // Lifting the suspension lifts the block (the spend recorded meanwhile is far under 2x of $5).
    await b.request('DELETE', '/admin/usage/users/:userId/suspension', { params: { userId: 'mallory' } });
    expect(await status(b, 'mallory')).toEqual({ blocked: false });
  });

  it('charges an unreadable response the conservative estimate, enough to trip the ceiling on its own', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 100 });
    // Unknown size, unknown usage: 200_000 x $15/M + 4096 x $75/M = $3.31 > $2.
    expect(await record(b, 'alice', { usage: null, requestBytes: null })).toEqual(DAILY);
    // A tiny unread request is far cheaper but never free: 10 input + 4096
    // output tokens at the top tier = 307_350 micros = $0.3074 (4 d.p.).
    expect(await record(b, 'bob', { usage: null, requestBytes: 30 })).toEqual({ blocked: false });
    expect(await usageOf(b, 'bob')).toMatchObject({ spendUsd: 0.3074 });
  });

  it('a garbage payload is charged, not dropped, and never rejects the call', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 100 });
    expect(await record(b, 'alice', 'not-an-object')).toEqual(DAILY);
  });

  it('the window rolls: a day later the block is gone', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 100 });
    await record(b, 'alice', ONE_DOLLAR);
    await record(b, 'alice', ONE_DOLLAR);
    expect(await status(b, 'alice')).toEqual(DAILY);
    b.clock.advance(25 * 60 * 60_000);
    expect(await status(b, 'alice')).toEqual({ blocked: false });
  });

  it('a context with no user is blocked, and nothing is recorded for it', async () => {
    const b = await boot();
    expect(await status(b, '')).toEqual({ blocked: true, reason: 'usage-check-unavailable' });
    expect(await record(b, '', ONE_DOLLAR)).toEqual({ blocked: true, reason: 'usage-check-unavailable' });
    expect((await b.request('GET', '/admin/usage')).json).toMatchObject({ users: [] });
  });

  it('FAILS CLOSED: a broken database blocks instead of letting the sandbox keep the key', async () => {
    const b = await boot();
    const { db } = await b.harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      b.harness.ctx(),
      {},
    );
    await db.destroy();
    expect(await status(b, 'alice')).toEqual({ blocked: true, reason: 'usage-check-unavailable' });
    expect(await record(b, 'alice', ONE_DOLLAR)).toEqual({ blocked: true, reason: 'usage-check-unavailable' });
  });

  it('the existing subscribers keep working alongside the hooks', async () => {
    const b = await boot();
    await setLimits(b, { dailySpendUsd: 1, turnsPerHour: 2 });
    expect((await start(b, 'alice')).rejected).toBe(false);
    await turnEnd(b, 'alice', { role: 'assistant', reason: 'complete' });
    expect((await start(b, 'alice')).rejected).toBe(false);
    expect(await start(b, 'alice')).toMatchObject({ rejected: true, reason: 'usage-limit-rate' });
    expect(await status(b, 'alice')).toEqual({ blocked: false });
  });

  it('shutdown still completes with the hooks registered; a handler left on the bus then fails closed', async () => {
    // The bus has no service unregister, so the two handlers outlive shutdown.
    // With the database closed under them they must answer "blocked", never
    // "not blocked" and never a throw.
    const b = await boot();
    await expect(b.harness.close({ onError: () => {} })).resolves.toBeUndefined();
    expect(await status(b, 'alice')).toEqual({ blocked: true, reason: 'usage-check-unavailable' });
    expect(await record(b, 'alice', ONE_DOLLAR)).toEqual({ blocked: true, reason: 'usage-check-unavailable' });
  });
});

describe('lifecycle', () => {
  it('prunes buckets older than 8 days at init', async () => {
    const b1 = await boot();
    const { db } = await b1.harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      b1.harness.ctx(),
      {},
    );
    const old = new Date(b1.clock.now.getTime() - 9 * 24 * 60 * 60_000);
    const recent = new Date(b1.clock.now.getTime() - 7 * 24 * 60 * 60_000);
    await sql`
      INSERT INTO usage_limits_v1_buckets (user_id, bucket_start, turns)
      VALUES ('old', ${old}, 1), ('recent', ${recent}, 1)
    `.execute(db);
    await b1.harness.close({ onError: () => {} });

    const b2 = await boot();
    const { db: db2 } = await b2.harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      b2.harness.ctx(),
      {},
    );
    const rows = await sql<{ user_id: string }>`SELECT user_id FROM usage_limits_v1_buckets`.execute(db2);
    expect(rows.rows.map((r) => r.user_id)).toEqual(['recent']);
  });

  it('shutdown unregisters its routes and its subscribers', async () => {
    const b = await boot();
    await b.request('PUT', '/admin/usage/users/:userId/suspension', { params: { userId: 'mallory' } });
    await b.harness.close({ onError: () => {} });
    expect(b.unregistered.sort()).toEqual(
      [
        'DELETE /admin/usage/users/:userId/suspension',
        'GET /admin/usage',
        'PUT /admin/usage/limits',
        'PUT /admin/usage/users/:userId/suspension',
      ].sort(),
    );
    // No subscriber left: the (now closed) gate is gone rather than throwing.
    expect(await start(b, 'mallory')).toEqual({ rejected: false, payload: { message: 'hello' } });
  });
});
