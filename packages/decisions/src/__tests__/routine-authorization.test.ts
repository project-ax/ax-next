import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError, SafeToolError, type ToolCall } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { callFingerprint } from '../fingerprint.js';
import { createDecisionsPlugin } from '../plugin.js';
import { registerRoutineAuthorization } from '../routine-authorization.js';
import { createDecisionsStore } from '../store.js';
import type { Kysely } from 'kysely';
import type { DecisionsDatabase } from '../migrations.js';
import { receiptFor } from '../receipts.js';
import type { Decision, DecisionsApproveOutput } from '../types.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const harnesses: TestHarness[] = [];
const T0 = Date.parse('2026-10-09T12:00:00Z');
let clock: number;
let verdict: 'hold' | 'allow' | 'deny';
let enabled: boolean;
let revision: string;
let outage: boolean;
let conflict: boolean;
let lostAck: boolean;
let grants: number;
let effects: number;
const ledger = new Set<string>();
const call = (requestId = 'r1', name = 'routine_update'): ToolCall => ({
  id: 'c1',
  name,
  input: {
    requestId,
    routineId: 'rtn_a',
    expectedRevision: 'rev_a',
    ...(name === 'routine_update' ? { patch: { name: 'Changed' } } : {}),
  },
});
const ctx = (userId = 'u1', agentId = 'a1') =>
  makeAgentContext({ sessionId: 'ordinary-host-context', userId, agentId, conversationId: 'conv' });

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 120_000);
beforeEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  clock = T0;
  verdict = 'hold';
  enabled = false;
  revision = '0';
  outage = false;
  conflict = false;
  lostAck = false;
  grants = 0;
  effects = 0;
  ledger.clear();
});
afterAll(async () => {
  for (const h of harnesses) await h.close();
  await pool?.end();
  if (container) await stopPostgresContainer(container);
});
async function boot(attended = false, executor = true) {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString: container.getConnectionUri() }),
      createDecisionsPlugin({
        now: () => new Date(clock),
        sweepIntervalMs: 0,
        attendanceFor: () => (attended ? 'attended' : 'unattended'),
      }),
    ],
    services: {
      'agents:can-manage-routines': async (c) => ({
        allowed: c.userId === 'u1' && c.agentId === 'a1',
      }),
      'tool-policy:evaluate': async () => ({
        verdict: verdict === 'hold' && enabled ? 'allow' : verdict,
        ruleId: 'routines.update',
        capability: null,
      }),
      'tool-policy:get-routine-consent': async () => {
        if (outage) throw new Error('outage');
        return { enabled, revision };
      },
      'tool-policy:grant-routine-consent': async (c, input) => {
        const i = input as { decisionId: string; expectedRevision: string };
        expect(c.state.get('decisions:routine-consent-grant')).toEqual({
          decisionId: i.decisionId,
          agentId: 'a1',
          userId: 'u1',
          toolName: 'routine_update',
          expectedRevision: i.expectedRevision,
        });
        if (outage) throw new Error('outage');
        if (!ledger.has(i.decisionId)) {
          if (conflict || revision !== i.expectedRevision)
            throw new PluginError({
              code: 'consent-revision-conflict',
              plugin: 'policy',
              message: 'SECRET',
            });
          ledger.add(i.decisionId);
          enabled = true;
          revision = '1';
          grants++;
        }
        if (lostAck) {
          lostAck = false;
          throw new Error('ack lost');
        }
        return { delivered: true, enabled, revision };
      },
      'conversations:get-metadata': async () => ({
        activeSessionId: attended ? 'live' : null,
        origin: 'web',
      }),
      'session:queue-work': async () => ({}),
    },
  });
  if (executor)
    h.bus.registerService('tool:execute:routine_update', 'test', async (c, input) => {
      const authority = await h.bus.call<{ call: ToolCall }, { authorizationId: string }>(
        'decisions:authorize-routine-call',
        c,
        { call: input as ToolCall },
      );
      effects++;
      await h.bus.call('decisions:settle-routine-call', c, {
        authorizationId: authority.authorizationId,
        outcome: 'succeeded',
      });
      return { ok: true };
    });
  harnesses.push(h);
  return h;
}
async function held(h: TestHarness, c = call()): Promise<Decision> {
  await h.bus.fire('tool:pre-call', ctx(), c);
  const out = await h.bus.call<unknown, { decisions: Decision[] }>('decisions:list', ctx(), {
    userId: 'u1',
  });
  return out.decisions.find((d) => d.callFingerprint === callFingerprint(c))!;
}
async function approve(h: TestHarness, d: Decision, scope = 'once', c = ctx()) {
  return h.bus.call<unknown, DecisionsApproveOutput>('decisions:approve', c, {
    decisionId: d.id,
    userId: 'u1',
    approvalScope: scope,
  });
}
const authorize = (h: TestHarness, c = call(), actor = ctx()) =>
  h.bus.call<unknown, { authorizationId: string; requestId: string }>(
    'decisions:authorize-routine-call',
    actor,
    { call: c },
  );
const sweep = (h: TestHarness) => h.bus.call('decisions:sweep', ctx(), {});

describe('routine host authorization', () => {
  it('refuses direct execution, changed person, agent and input during and after grace', async () => {
    const h = await boot(true);
    const d = await held(h);
    await expect(authorize(h)).rejects.toThrow();
    await approve(h, d);
    await expect(h.bus.call('tool:execute:routine_update', ctx(), call())).rejects.toThrow();
    expect(effects).toBe(0);
    await expect(authorize(h)).rejects.toThrow();
    clock += 11_000;
    await expect(authorize(h, call(), ctx('u2'))).rejects.toThrow();
    await expect(authorize(h, call(), ctx('u1', 'a2'))).rejects.toThrow();
    await expect(authorize(h, call('changed'))).rejects.toThrow();
    expect((await authorize(h)).requestId).toBe('r1');
  });
  it('binds the actual approver and rejects ineligible scopes', async () => {
    const h = await boot();
    const d = await held(h);
    await expect(approve(h, d, 'agent-routines', ctx('other'))).rejects.toThrow();
    await expect(approve(h, d, 'bad')).rejects.toThrow();
    const del = await held(h, call('del', 'routine_delete'));
    await expect(approve(h, del, 'agent-routines')).rejects.toThrow();
    expect(grants).toBe(0);
  });
  it('Undo grants nothing and no consent is delivered during grace', async () => {
    const h = await boot(true);
    const d = await held(h);
    const approved = await approve(h, d, 'agent-routines');
    expect(approved.decision?.consentDeliveryState).toBe('pending');
    expect(grants).toBe(0);
    await sweep(h);
    expect(grants).toBe(0);
    expect(
      await h.bus.call('decisions:undo', ctx(), { decisionId: d.id, userId: 'u1' }),
    ).toMatchObject({ undone: true });
    clock += 11_000;
    await sweep(h);
    expect(grants).toBe(0);
    await expect(authorize(h)).rejects.toThrow();
  });
  it('once is default; host replay settles only actual success', async () => {
    const h = await boot();
    const d = await held(h);
    const a = await h.bus.call<unknown, DecisionsApproveOutput>('decisions:approve', ctx(), {
      decisionId: d.id,
      userId: 'u1',
    });
    expect(a.executed).toBe(true);
    expect(effects).toBe(1);
    expect(grants).toBe(0);
    expect(a.decision?.approvalScope).toBe('once');
    expect(a.decision?.routineOutcome).toBe('succeeded');
    expect(receiptFor(a.decision!)).toMatchObject({ outcome: 'executed' });
    await expect(authorize(h, call('new'))).rejects.toThrow();
  });
  it('pending consent outage recovers after restart without duplicate delivery', async () => {
    let h = await boot();
    const d = await held(h);
    outage = true;
    // Approval needs a current revision before recording intent.
    await expect(approve(h, d, 'agent-routines')).rejects.toThrow();
    outage = false;
    lostAck = true;
    const a = await approve(h, d, 'agent-routines');
    expect(a.executed).toBe(false);
    expect(effects).toBe(0);
    expect(grants).toBe(1);
    await h.close();
    harnesses.splice(harnesses.indexOf(h), 1);
    h = await boot();
    await sweep(h);
    expect(grants).toBe(1);
    expect(effects).toBe(1);
  });
  it('revoked duplicate delivery stays revoked', async () => {
    const h = await boot();
    const d = await held(h);
    lostAck = true;
    await approve(h, d, 'agent-routines');
    enabled = false;
    revision = 'revoked';
    await sweep(h);
    expect(enabled).toBe(false);
    expect(grants).toBe(1);
    const out = await h.bus.call<unknown, { decision: Decision }>('decisions:get', ctx(), {
      decisionId: d.id,
      userId: 'u1',
    });
    expect(out.decision.consentGranted).toBe(false);
    await expect(authorize(h, call('new'))).rejects.toThrow();
  });
  it('consent CAS conflict is terminal and never retries the grant intent', async () => {
    const h = await boot(true);
    const d = await held(h);
    await approve(h, d, 'agent-routines');
    conflict = true;
    clock += 11_000;
    await sweep(h);
    await sweep(h);
    const out = await h.bus.call<unknown, { decision: Decision }>('decisions:get', ctx(), {
      decisionId: d.id,
      userId: 'u1',
    });
    expect(out.decision.status).toBe('failed');
    expect(out.decision.consentDeliveryState).toBe('failed');
    expect(effects).toBe(0);
    expect(grants).toBe(0);
  });
  it('deny wins over standing approval and live consent', async () => {
    const h = await boot(true);
    const d = await held(h);
    await approve(h, d);
    clock += 11_000;
    verdict = 'deny';
    enabled = true;
    expect((await h.bus.fire('tool:pre-call', ctx(), call())).rejected).toBe(true);
    await expect(authorize(h)).rejects.toThrow();
    expect(effects).toBe(0);
  });
  it('exact crash retry preserves authorization; different request cannot borrow it', async () => {
    let h = await boot(true);
    const d = await held(h);
    await approve(h, d);
    clock += 11_000;
    const first = await authorize(h);
    await h.close();
    harnesses.splice(harnesses.indexOf(h), 1);
    h = await boot(true);
    expect(await authorize(h)).toEqual(first);
    await expect(authorize(h, call('other'))).rejects.toThrow();
    const c = ctx();
    await authorize(h, call(), c);
    await h.bus.call('decisions:settle-routine-call', c, {
      authorizationId: first.authorizationId,
      outcome: 'succeeded',
    });
    expect(await authorize(h)).toEqual(first);
  });
  it('settlement requires matching invocation actor and rejects overwritten concurrent markers', async () => {
    const h = await boot();
    enabled = true;
    verdict = 'allow';
    const a = ctx(),
      b = ctx();
    const first = await authorize(h, call('first'), a);
    const second = await authorize(h, call('second'), b);
    await expect(
      h.bus.call('decisions:settle-routine-call', b, {
        authorizationId: first.authorizationId,
        outcome: 'succeeded',
      }),
    ).rejects.toThrow();
    await expect(
      h.bus.call('decisions:settle-routine-call', ctx('other'), {
        authorizationId: first.authorizationId,
        outcome: 'succeeded',
      }),
    ).rejects.toThrow();
    await h.bus.call('decisions:settle-routine-call', a, {
      authorizationId: first.authorizationId,
      outcome: 'succeeded',
    });
    await h.bus.call('decisions:settle-routine-call', b, {
      authorizationId: second.authorizationId,
      outcome: 'succeeded',
    });
  });
  it('safe failure never produces a success receipt and corrupted stored strings stay hidden', async () => {
    const h = await boot(false, false);
    h.bus.registerService('tool:execute:routine_update', 'test', async () => {
      const e = new SafeToolError('revision-conflict', 'expectedRevision');
      e.message = 'SECRET';
      throw e;
    });
    const d = await held(h);
    const a = await approve(h, d);
    expect(a.executed).toBe(false);
    expect(a.error).toContain('routine_get');
    expect(a.error).not.toContain('SECRET');
    const corrupt = {
      ...a.decision!,
      replayError: 'SECRET',
      routineFailureCode: 'forged SECRET',
    } as Decision;
    expect(receiptFor(corrupt)?.outcome).toBe('failed');
    expect(JSON.stringify(receiptFor(corrupt))).not.toContain('SECRET');
  });
  it('concurrent duplicate approval and authorization create one durable authority', async () => {
    const h = await boot(true);
    const d = await held(h);
    await Promise.all([approve(h, d), approve(h, d)]);
    clock += 11_000;
    const results = await Promise.all([authorize(h), authorize(h)]);
    expect(results[0]).toEqual(results[1]);
    expect(
      (await pool.query('SELECT count(*) n FROM decisions_v1_routine_authorizations')).rows[0].n,
    ).toBe('1');
    const stored = await h.bus.call<unknown, { decision: Decision }>('decisions:get', ctx(), {
      decisionId: d.id,
      userId: 'u1',
    });
    expect(receiptFor(stored.decision)?.outcome).not.toBe('executed');
    const changed = {
      ...call(),
      input: { ...(call().input as object), patch: { name: 'DIFFERENT' } },
    };
    await expect(authorize(h, changed)).rejects.toThrow(/request ID/);
  });
  it('pre-call cannot release the same approval during grace even with live consent', async () => {
    const h = await boot(true);
    const d = await held(h);
    await approve(h, d);
    enabled = true;
    expect((await h.bus.fire('tool:pre-call', ctx(), call())).rejected).toBe(true);
    await expect(authorize(h)).rejects.toThrow();
    clock += 11_000;
    expect((await h.bus.fire('tool:pre-call', ctx(), call())).rejected).toBe(false);
  });
  it('missing policy provider and consent outage fail closed', async () => {
    const h = await boot();
    const db = await h.bus.call<unknown, Kysely<DecisionsDatabase>>(
      'database:get-instance',
      ctx(),
      {},
    );
    const bus = new HookBus();
    registerRoutineAuthorization(bus, createDecisionsStore(db), () => new Date(clock));
    await expect(
      bus.call('decisions:authorize-routine-call', ctx(), { call: call() }),
    ).rejects.toThrow();
    enabled = true;
    outage = true;
    await expect(authorize(h)).rejects.toThrow();
  });
  it('consent authorizes create/update only, never delete/fire or another human', async () => {
    const h = await boot();
    enabled = true;
    const create: ToolCall = {
      id: 'create',
      name: 'routine_create',
      input: {
        requestId: 'create',
        definition: {
          name: 'Daily',
          promptBody: 'Do work',
          trigger: { kind: 'interval', every: '1m' },
        },
      },
    };
    expect((await authorize(h, create)).requestId).toBe('create');
    await expect(authorize(h, call('del', 'routine_delete'))).rejects.toThrow();
    await expect(authorize(h, call('fire', 'routine_fire_now'))).rejects.toThrow();
    await expect(authorize(h, create, ctx('another'))).rejects.toThrow();
  });
  it('a proved settled effect remains successful after the executor response is lost', async () => {
    const h = await boot(false, false);
    h.bus.registerService('tool:execute:routine_update', 'test', async (c, input) => {
      const authority = await authorize(h, input as ToolCall, c);
      effects++;
      await h.bus.call('decisions:settle-routine-call', c, {
        authorizationId: authority.authorizationId,
        outcome: 'succeeded',
      });
      throw new Error('response lost after durable effect');
    });
    const d = await held(h);
    const result = await approve(h, d);
    expect(result.executed).toBe(true);
    expect(effects).toBe(1);
    expect(receiptFor(result.decision!)?.outcome).toBe('executed');
  });
  it('returned error objects and unknown thrown errors cannot produce successful receipts', async () => {
    const h = await boot(false, false);
    h.bus.registerService('tool:execute:routine_update', 'test', async () => ({ error: 'SECRET' }));
    const d = await held(h);
    const result = await approve(h, d);
    expect(result.executed).toBe(false);
    expect(receiptFor(result.decision!)?.outcome).toBe('failed');
    expect(JSON.stringify(receiptFor(result.decision!))).not.toContain('SECRET');
    await expect(authorize(h)).rejects.toThrow();
  });
  it('reclaims a host flight after restart using the same logical request', async () => {
    let h = await boot(true);
    const d = await held(h);
    await approve(h, d);
    clock += 11_000;
    // Host claimed a fallback, then died before entering the executor.
    await pool.query(
      'UPDATE decisions_v1_decisions SET delivery_due_at=NULL, replay_claimed_at=$1 WHERE decision_id=$2',
      [new Date(clock), d.id],
    );
    await h.close();
    harnesses.splice(harnesses.indexOf(h), 1);
    h = await boot();
    clock += 16 * 60_000;
    await sweep(h);
    expect(effects).toBe(1);
    await sweep(h);
    expect(effects).toBe(1);
  });
  it('purges authority and fences a late already-checked invocation', async () => {
    const h = await boot();
    enabled = true;
    await authorize(h);
    await h.bus.fire('agents:deleted', ctx(), { agentId: 'a1' });
    expect(
      (await pool.query('SELECT count(*) n FROM decisions_v1_routine_authorizations')).rows[0].n,
    ).toBe('0');
    await expect(authorize(h)).rejects.toThrow();
  });
  it('reconciles a claimed grant lost acknowledgement after expiry without executing the expired call', async () => {
    let h = await boot();
    const d = await held(h);
    lostAck = true;
    await approve(h, d, 'agent-routines');
    expect(grants).toBe(1);
    expect(effects).toBe(0);
    await h.close();
    harnesses.splice(harnesses.indexOf(h), 1);
    clock += 49 * 60 * 60_000;
    h = await boot();
    await sweep(h);
    const stored = await h.bus.call<unknown, { decision: Decision }>('decisions:get', ctx(), {
      decisionId: d.id,
      userId: 'u1',
    });
    expect(stored.decision.consentDeliveryState).toBe('delivered');
    expect(stored.decision.consentGranted).toBe(true);
    expect(stored.decision.routineOutcome).toBe('failed');
    expect(effects).toBe(0);
    expect(grants).toBe(1);
    expect(receiptFor(stored.decision)?.outcome).toBe('failed');
    await expect(authorize(h)).rejects.toThrow();
  });
  it('an unstarted consent intent expires without granting permission', async () => {
    const h = await boot(true);
    const d = await held(h);
    await approve(h, d, 'agent-routines');
    clock += 49 * 60 * 60_000;
    await sweep(h);
    const stored = await h.bus.call<unknown, { decision: Decision }>('decisions:get', ctx(), {
      decisionId: d.id,
      userId: 'u1',
    });
    expect(stored.decision.status).toBe('expired');
    expect(stored.decision.consentGranted).toBe(false);
    expect(grants).toBe(0);
    expect(effects).toBe(0);
    await expect(authorize(h)).rejects.toThrow();
  });
});
