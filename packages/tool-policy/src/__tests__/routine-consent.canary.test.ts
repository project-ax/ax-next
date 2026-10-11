import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createLogger, PluginError, type AgentContext } from '@ax/core';
import { createTestHarness, startTestContainer, stopPostgresContainer, type TestHarness } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createToolPolicyPlugin } from '../plugin.js';
import { ROUTINE_CONSENT_GRANT_CONTEXT_KEY } from '../routine-consent.js';
import type { EvaluateResult, GrantRoutineConsentOutput, ListCapabilitiesOutput, PolicyRule, RoutineConsent } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const managers = new Set(['alice', 'bob']);
const readable = new Set(['alice', 'bob', 'member']);
async function boot(opts: { missing?: boolean; missingManagement?: boolean; managementOutage?: boolean; rules?: PolicyRule[]; access?: (ctx: AgentContext) => Promise<void> } = {}) {
  const h = await createTestHarness({
    services: opts.missing ? {} : {
      'agents:resolve': async (ctx, raw) => {
        const input = raw as { userId: string; agentId: string };
        expect(input.userId).toBe(ctx.userId);
        if (!readable.has(ctx.userId)) throw new PluginError({ code: 'forbidden', plugin: 'test-agents', message: 'No access' });
        await opts.access?.(ctx);
        return { agent: { id: input.agentId } };
      },
      ...(!opts.missingManagement && { 'agents:can-manage-routines': async (ctx: AgentContext) => {
        if (opts.managementOutage) throw new Error('management offline');
        return { allowed: managers.has(ctx.userId) };
      } }),
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createToolPolicyPlugin(opts.rules ? { rules: opts.rules } : undefined)],
  });
  harnesses.push(h);
  return h;
}
const logger = createLogger({ reqId: 'routine-consent-test', writer: () => {} });
const actor = (h: TestHarness, userId = 'alice', agentId = 'agent-1') => h.ctx({ userId, agentId, logger });
function delivery(h: TestHarness, decisionId = 'decision-1', userId = 'alice', agentId = 'agent-1', expectedRevision = '0', toolName = 'routine_create') {
  const ctx = actor(h, userId, agentId);
  ctx.state.set(ROUTINE_CONSENT_GRANT_CONTEXT_KEY, { decisionId, userId, agentId, expectedRevision, toolName });
  return ctx;
}
const grant = (h: TestHarness, ctx = delivery(h), decisionId = 'decision-1', expectedRevision = '0') =>
  h.bus.call<unknown, GrantRoutineConsentOutput>('tool-policy:grant-routine-consent', ctx, { decisionId, expectedRevision });
const get = (h: TestHarness, ctx = actor(h), agentId = ctx.agentId) =>
  h.bus.call<unknown, RoutineConsent>('tool-policy:get-routine-consent', ctx, { agentId });
const revoke = (h: TestHarness, ctx = actor(h)) =>
  h.bus.call<unknown, RoutineConsent>('tool-policy:revoke-routine-consent', ctx, { agentId: ctx.agentId });
const evaluate = (h: TestHarness, name = 'routine_create', ctx = actor(h), agentId = ctx.agentId) =>
  h.bus.call<unknown, EvaluateResult>('tool-policy:evaluate', ctx, { call: { name, input: {} }, agentId });
async function query(sql: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try { return (await client.query(sql)).rows; } finally { await client.end(); }
}
beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
  await query('DROP TABLE IF EXISTS tool_policy_v1_routine_consent, tool_policy_v1_routine_consent_deliveries, tool_policy_v1_routine_consent_retired_agents');
});
afterAll(async () => { if (container) await stopPostgresContainer(container); });

describe('durable routine consent registered services (Postgres)', () => {
  it('holds before grant, survives restart, and binds only this agent and person', async () => {
    const h = await boot();
    expect(await get(h)).toEqual({ enabled: false, revision: '0' });
    expect((await evaluate(h)).verdict).toBe('hold');
    const saved = await grant(h);
    expect(saved).toMatchObject({ enabled: true, delivered: true });
    expect(saved.revision).not.toBe('0');
    const h2 = await boot();
    expect(await get(h2)).toEqual({ enabled: true, revision: saved.revision });
    for (const name of ['routine_create', 'routine_update']) {
      expect((await evaluate(h2, name)).verdict).toBe('allow');
      expect((await evaluate(h2, name, actor(h2, 'bob'))).verdict).toBe('hold');
      expect((await evaluate(h2, name, actor(h2, 'alice', 'agent-2'))).verdict).toBe('hold');
      expect((await evaluate(h2, name, actor(h2), 'agent-2')).verdict).toBe('hold');
    }
    for (const name of ['routine_delete', 'routine_fire_now', 'request_capability']) expect((await evaluate(h2, name)).verdict).toBe('hold');
    const rail = await h2.bus.call<unknown, ListCapabilitiesOutput>('tool-policy:list-capabilities', actor(h2), { agentId: 'agent-1' });
    expect(rail.rows.find(r => r.source === 'rule:routines.create')).toMatchObject({ verdict: 'allow', provenance: 'grant', capability: 'create routines', conditional: true });
    expect(rail.rows.find(r => r.source === 'rule:routines.fire-now')).toMatchObject({ verdict: 'hold', effect: ['spends', 'outward'] });
  });

  it('duplicate deliveries are atomic, and replay after revoke never restores permission', async () => {
    const h = await boot();
    const results = await Promise.all(Array.from({ length: 8 }, () => grant(h)));
    expect(new Set(results.map(r => r.revision)).size).toBe(1);
    expect(await query('SELECT * FROM tool_policy_v1_routine_consent_deliveries')).toHaveLength(1);
    const h2 = await boot();
    const revoked = await revoke(h2);
    expect(revoked.enabled).toBe(false);
    expect((await evaluate(h)).verdict).toBe('hold');
    expect(await grant(h)).toEqual({ ...revoked, delivered: true });
    expect(await grant(h2)).toEqual({ ...revoked, delivered: true });
    expect(await get(h)).toEqual(revoked);
    const restarted = await boot();
    expect(await get(restarted)).toEqual(revoked);
    expect((await evaluate(restarted)).verdict).toBe('hold');
    const freshCtx = delivery(h, 'decision-2', 'alice', 'agent-1', revoked.revision, 'routine_update');
    expect(await grant(h, freshCtx, 'decision-2', revoked.revision)).toMatchObject({ enabled: true, delivered: true });
  });

  it('revoking before first delivery conflicts even when no consent row existed', async () => {
    const h = await boot();
    const revoked = await revoke(h);
    expect(revoked.revision).not.toBe('0');
    await expect(grant(h)).rejects.toMatchObject({ code: 'consent-revision-conflict' });
    expect(await get(h)).toEqual(revoked);
    expect(await query('SELECT * FROM tool_policy_v1_routine_consent_deliveries')).toHaveLength(0);
  });

  it('a first grant concurrently queued behind revoke conflicts without restoring consent', async () => {
    const h = await boot();
    const lock = new pg.Client({ connectionString });
    await lock.connect();
    let revokeInFlight: Promise<RoutineConsent> | undefined;
    let grantInFlight: Promise<unknown> | undefined;
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 18427142))', [JSON.stringify(['agent-1', 'alice'])]);
      async function waitForBlocked(count: number) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const rows = await query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted");
          if ((rows[0] as { count: number }).count >= count) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Consent transactions did not reach the controlled lock');
      }
      revokeInFlight = revoke(h);
      await waitForBlocked(1);
      grantInFlight = grant(h).then(result => result, error => error);
      await waitForBlocked(2);
      await lock.query('COMMIT');
      const revoked = await revokeInFlight;
      expect(await grantInFlight).toMatchObject({ code: 'consent-revision-conflict' });
      expect(await get(h)).toEqual(revoked);
      expect(await query('SELECT * FROM tool_policy_v1_routine_consent_deliveries')).toHaveLength(0);
    } finally {
      await lock.query('ROLLBACK');
      await lock.end();
      await Promise.allSettled([revokeInFlight, grantInFlight]);
    }
  });

  it('rejects absent, mismatched, once/ordinary replay and noneligible grant contexts', async () => {
    const h = await boot();
    await expect(grant(h, actor(h))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(grant(h, h.ctx({ userId: 'alice', agentId: 'agent-1', sessionId: 'decision-replay-decision-1' }))).rejects.toMatchObject({ code: 'forbidden' });
    for (const patch of [{ decisionId: 'other' }, { expectedRevision: 'other' }, { userId: 'bob' }, { agentId: 'agent-2' }, { toolName: 'routine_delete' }, { toolName: 'routine_fire_now' }, { approvalScope: 'once' }]) {
      const ctx = delivery(h);
      ctx.state.set(ROUTINE_CONSENT_GRANT_CONTEXT_KEY, { ...(ctx.state.get(ROUTINE_CONSENT_GRANT_CONTEXT_KEY) as object), ...patch });
      await expect(grant(h, ctx)).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(h.bus.call('tool-policy:grant-routine-consent', delivery(h), { decisionId: 'decision-1', expectedRevision: '0', userId: 'bob' })).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(await query('SELECT * FROM tool_policy_v1_routine_consent')).toHaveLength(0);
  });

  it('gets only authenticated own consent and requires current access/management', async () => {
    const h = await boot();
    await grant(h);
    expect(await get(h, actor(h, 'bob'))).toEqual({ enabled: false, revision: '0' });
    expect(await get(h, actor(h, 'member'))).toEqual({ enabled: false, revision: '0' });
    for (const userId of ['member', 'outsider', 'system']) {
      await expect(grant(h, delivery(h, 'other', userId), 'other')).rejects.toMatchObject({ code: 'forbidden' });
      await expect(revoke(h, actor(h, userId))).rejects.toMatchObject({ code: 'forbidden' });
      expect((await evaluate(h, 'routine_create', actor(h, userId))).verdict).toBe('hold');
    }
    await expect(get(h, actor(h, 'outsider'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.bus.call('tool-policy:get-routine-consent', actor(h, 'bob'), { agentId: 'agent-1', userId: 'alice' })).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('does not share a delivery decision ID across a different agent/person scope', async () => {
    const h = await boot();
    await grant(h);
    await expect(grant(h, delivery(h, 'decision-1', 'bob'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(grant(h, delivery(h, 'decision-1', 'alice', 'agent-2'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await get(h, actor(h, 'bob'))).toEqual({ enabled: false, revision: '0' });
  });

  it('missing ACL provider and read/management outages never relax holds or fabricate disabled success', async () => {
    const h = await boot();
    await grant(h);
    const missing = await boot({ missing: true });
    expect((await evaluate(missing)).verdict).toBe('hold');
    await expect(get(missing)).rejects.toMatchObject({ code: 'consent-unavailable' });
    await expect(revoke(missing)).rejects.toMatchObject({ code: 'consent-unavailable' });
    await expect(grant(missing)).rejects.toMatchObject({ code: 'consent-unavailable' });
    const outage = await boot({ access: async () => { throw new Error('directory offline'); } });
    expect((await evaluate(outage)).verdict).toBe('hold');
    await expect(get(outage)).rejects.toThrow('directory offline');
    await query('DROP TABLE tool_policy_v1_routine_consent');
    expect((await evaluate(h)).verdict).toBe('hold');
    await expect(get(h)).rejects.toThrow();
    await expect(revoke(h)).rejects.toThrow();
    await expect(grant(h)).rejects.toThrow();
  });

  it('missing or failed management provider holds despite an existing grant and rejects mutations', async () => {
    const h = await boot();
    const saved = await grant(h);
    for (const options of [{ missingManagement: true }, { managementOutage: true }]) {
      const unavailable = await boot(options);
      // Access alone still permits a truthful own-consent read.
      expect(await get(unavailable)).toEqual({ enabled: true, revision: saved.revision });
      expect((await evaluate(unavailable)).verdict).toBe('hold');
      await expect(revoke(unavailable)).rejects.toThrow();
      await expect(grant(unavailable)).rejects.toThrow();
    }
    expect(await get(h)).toEqual({ enabled: true, revision: saved.revision });
  });

  it('saved consent cannot relax deny or unopted holds', async () => {
    const deny: PolicyRule = { id: 'routines.block', match: { tool: 'routine_create' }, verdict: 'deny', subject: 'agent', providedBy: 'host', capability: 'create routines', routineConsent: 'create-update' };
    const h = await boot({ rules: [deny] });
    await grant(h);
    expect((await evaluate(h)).verdict).toBe('deny');
    const { routineConsent: _consent, ...unopted } = deny;
    const h2 = await boot({ rules: [{ ...unopted, verdict: 'hold' }] });
    expect((await evaluate(h2)).verdict).toBe('hold');
  });

  it('purges consent/deliveries for only the deleted agent and rejects late already-authorized writes', async () => {
    const h = await boot();
    await grant(h);
    await grant(h, delivery(h, 'decision-b', 'bob'), 'decision-b');
    await grant(h, delivery(h, 'decision-2', 'alice', 'agent-2'), 'decision-2');
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const late = await boot({ access: async () => { entered(); await gate; } });
    const inFlight = grant(late);
    await reached;
    await h.bus.fire('agents:deleted', actor(h), { agentId: 'agent-1' });
    release();
    await expect(inFlight).rejects.toMatchObject({ code: 'not-found' });
    await expect(revoke(h)).rejects.toMatchObject({ code: 'not-found' });
    expect(await get(h)).toEqual({ enabled: false, revision: '0' });
    expect(await query("SELECT * FROM tool_policy_v1_routine_consent WHERE agent_id='agent-1'")).toHaveLength(0);
    expect(await query("SELECT * FROM tool_policy_v1_routine_consent_deliveries WHERE agent_id='agent-1'")).toHaveLength(0);
    expect(await get(h, actor(h, 'alice', 'agent-2'))).toMatchObject({ enabled: true });
  });
});
