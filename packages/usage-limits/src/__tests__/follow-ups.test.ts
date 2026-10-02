import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { bootUsageLimits, truncateUsageTables, type Booted } from './helpers.js';

let container: StartedPostgreSqlContainer;
const boots: Booted[] = [];
beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
}, 120_000);
afterEach(async () => {
  while (boots.length) await boots.pop()!.harness.close({ onError: () => {} });
  await truncateUsageTables(container.getConnectionUri());
});
afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});
async function boot() {
  const b = await bootUsageLimits({
    connectionString: container.getConnectionUri(),
  });
  boots.push(b);
  return b;
}
const usage = {
  inputTokens: 100_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
async function provider(b: Booted, userId: string) {
  return b.harness.bus.call('usage:provider-record', b.harness.ctx({ userId }), {
    model: 'claude-sonnet-4-5',
    usage,
    requestBytes: 10,
  });
}

describe('TASK-716 / TASK-722', () => {
  it('adds each user’s larger runner/proxy ledger; fleet cap stops fresh turns and provider requests across hosts', async () => {
    const b = await boot();
    expect(
      (
        await b.request('PUT', '/admin/usage/limits', {
          body: { dailySpendUsd: 5, turnsPerHour: 60, fleetDailySpendUsd: 0.6 },
        })
      ).status,
    ).toBe(200);
    await provider(b, 'u1'); // $0.30
    await b.harness.bus.fire('chat:turn-end', b.harness.ctx({ userId: 'u1' }), {
      role: 'assistant',
      usage: { model: 'claude-sonnet-4-5', ...usage },
    });
    expect(
      await b.harness.bus.call('usage:provider-status', b.harness.ctx({ userId: 'u2' }), {}),
    ).toEqual({ blocked: false });
    await provider(b, 'u2'); // fleet $0.60, not $0.90
    const peer = await boot();
    peer.storage.set('settings:usage-limits', b.storage.get('settings:usage-limits')!);
    expect(
      await peer.harness.bus.call(
        'usage:provider-status',
        peer.harness.ctx({ userId: 'new-user' }),
        {},
      ),
    ).toEqual({ blocked: true, reason: 'usage-limit-fleet' });
    expect(
      await peer.harness.bus.fire('chat:start', peer.harness.ctx({ userId: 'new-user' }), {}),
    ).toMatchObject({ rejected: true, reason: 'usage-limit-fleet' });
    expect(
      await peer.harness.bus.call('usage:check', peer.harness.ctx({ userId: 'new-user' }), {}),
    ).toEqual({ blocked: true, reason: 'usage-limit-fleet' });
  });

  it('applies per-user overrides to admission and the 2x provider ceiling, then restores defaults', async () => {
    const b = await boot();
    expect(
      (
        await b.request('PUT', '/admin/usage/users/:userId/limits', {
          params: { userId: 'u1' },
          body: { dailySpendUsd: 0.15, turnsPerHour: 1 },
        })
      ).status,
    ).toBe(200);
    expect(await provider(b, 'u1')).toEqual({
      blocked: true,
      reason: 'usage-limit-daily',
    });
    expect(
      await b.harness.bus.fire('chat:start', b.harness.ctx({ userId: 'u1' }), {}),
    ).toMatchObject({ rejected: true, reason: 'usage-limit-daily' });
    expect(
      await b.harness.bus.fire('chat:start', b.harness.ctx({ userId: 'u2' }), {}),
    ).toMatchObject({ rejected: false });
    expect(
      (
        await b.request('DELETE', '/admin/usage/users/:userId/limits', {
          params: { userId: 'u1' },
        })
      ).status,
    ).toBe(200);
    expect(
      await b.harness.bus.call('usage:provider-status', b.harness.ctx({ userId: 'u1' }), {}),
    ).toEqual({ blocked: false });
  });

  it('uses exact model price overrides for runner, proxy and helper calls', async () => {
    const b = await boot();
    const prices = [
      {
        model: 'openrouter/vendor/cheap-model',
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        cacheReadUsdPerMillion: 0.1,
        cacheWriteUsdPerMillion: 1.25,
      },
    ];
    expect((await b.request('PUT', '/admin/usage/prices', { body: { prices } })).status).toBe(200);
    const ctx = b.harness.ctx({ userId: 'u1' });
    await b.harness.bus.fire('chat:turn-end', ctx, {
      role: 'assistant',
      usage: { model: prices[0]!.model, ...usage },
    });
    await b.harness.bus.call('usage:provider-record', ctx, {
      model: 'vendor/cheap-model',
      usage,
      requestBytes: 10,
    });
    await b.harness.bus.fire('llm:usage', ctx, {
      model: prices[0]!.model,
      usage,
    });
    const r = await b.request('GET', '/admin/usage');
    expect(r.json).toMatchObject({ totals: { spendUsd: 0.2 } });
  });

  it('charges a killed admitted turn once; refused and already reported turns get no extra charge', async () => {
    const b = await boot();
    const ctx = b.harness.ctx({ userId: 'u1', reqId: 'killed' });
    await b.harness.bus.fire('chat:start', ctx, {});
    await b.harness.bus.fire('chat:turn-error', ctx, {
      reqId: 'killed',
      reason: 'sandbox-terminated',
    });
    await b.harness.bus.fire('chat:end', ctx, {
      outcome: { kind: 'terminated', reason: 'sandbox-terminated' },
    });
    await b.harness.bus.fire('chat:turn-error', ctx, {
      reqId: 'never-admitted',
      reason: 'usage-suspended',
    });
    const done = b.harness.ctx({ userId: 'u1', reqId: 'done' });
    await b.harness.bus.fire('chat:start', done, {});
    await b.harness.bus.fire('chat:turn-end', b.harness.ctx({ userId: 'u1', reqId: 'ipc-event-request' }), {
      reqId: 'done',
      role: 'assistant',
      usage: { model: 'claude-sonnet-4-5', ...usage },
    });
    await b.harness.bus.fire('chat:turn-error', done, {
      reqId: 'done',
      reason: 'sandbox-terminated',
    });
    const r = await b.request('GET', '/admin/usage');
    expect(r.json).toMatchObject({ totals: { spendUsd: 0.55, turns: 2 } });
  });

  it('rejects invalid person limits and malformed or ambiguous model prices', async () => {
    const b = await boot();
    for (const body of [{dailySpendUsd:0}, {turnsPerHour:1.5}, {fleetDailySpendUsd:100}, {}]) {
      expect((await b.request('PUT','/admin/usage/users/:userId/limits',{params:{userId:'u1'},body})).status).toBe(400);
    }
    const price = {model:'anthropic/claude-test',inputUsdPerMillion:1,outputUsdPerMillion:2,cacheReadUsdPerMillion:0,cacheWriteUsdPerMillion:0};
    for (const prices of [[{...price,model:'vendor/*'}], [{...price,inputUsdPerMillion:-1}], [price,{...price,model:'openrouter/anthropic/claude-test'}]]) {
      expect((await b.request('PUT','/admin/usage/prices',{body:{prices}})).status).toBe(400);
    }
    // The complete allowed 100-entry table fits the bounded request body.
    const prices=Array.from({length:100},(_,i)=>({...price,model:'vendor/'+String(i).padStart(3,'0')+'a'.repeat(185)}));
    expect((await b.request('PUT','/admin/usage/prices',{body:{prices}})).status).toBe(200);
  });

  it('returns only the signed-in user’s usage; non-admins cannot change overrides or prices', async () => {
    const b = await boot();
    await provider(b, 'u1');
    await provider(b, 'u2');
    b.setAuth({ id: 'u1', isAdmin: false });
    const r = await b.request('GET', '/api/usage');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      spendUsd: 0.3,
      limits: { dailySpendUsd: 5 },
    });
    expect(JSON.stringify(r.json)).not.toContain('u2');
    for (const [path, body] of [
      ['/admin/usage/prices', { prices: [] }],
      ['/admin/usage/users/:userId/limits', { dailySpendUsd: 10 }],
    ] as const) {
      expect((await b.request('PUT', path, { body, params: { userId: 'u2' } })).status).toBe(403);
    }
    b.setAuth('throw');
    expect((await b.request('GET', '/api/usage')).status).toBe(401);
  });
});
