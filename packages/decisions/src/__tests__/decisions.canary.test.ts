/**
 * The canary: the whole path, through a real bus, a real Postgres, and the
 * real `@ax/tool-policy` rule table.
 *
 * hold → durable row → approve → exactly one authorised retry.
 *
 * This is also where the half-wired window on `tool-policy:evaluate` is proved
 * closed: nothing here stubs it, so if `@ax/decisions` ever stopped calling it
 * the hold would stop happening and every test below would fail.
 */
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createTestHarness, stopPostgresContainer, type TestHarness } from '@ax/test-harness';
import { BUILTIN_RULES, createToolPolicyPlugin } from '@ax/tool-policy';
import { isHold, isRejection, type AgentContext } from '@ax/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDecisionsPlugin } from '../plugin.js';
import type { Decision, DecisionsApproveOutput, DecisionsListOutput } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function boot(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      // Registration order matters and is asserted in the k8s preset test:
      // decisions must be able to see tool-policy's hook, and its subscriber
      // must run after anything that can deny outright.
      createToolPolicyPlugin(),
      createDecisionsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query('DROP TABLE IF EXISTS decisions_v1_decisions');
  } finally {
    await c.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const HOLD_RULE = BUILTIN_RULES.find((r) => r.verdict === 'hold')!;
const DENY_RULE = BUILTIN_RULES.find((r) => r.verdict === 'deny')!;
const ALLOW_RULE = BUILTIN_RULES.find((r) => r.verdict === 'allow')!;

function userCtx(h: TestHarness): AgentContext {
  return h.ctx({ agentId: 'a1', userId: 'u1', conversationId: 'conv-1', sessionId: 's1' });
}

const CALL = { id: 'c1', name: HOLD_RULE.match.tool, input: { to: 'a@b.c' } };

describe('decisions canary', () => {
  it('a held call becomes a durable row, and approving it authorises exactly one retry', async () => {
    const h = await boot();
    const ctx = userCtx(h);

    const fired = await h.bus.fire('tool:pre-call', ctx, CALL);
    expect(isHold(fired)).toBe(true);

    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      ctx,
      { userId: 'u1', status: 'pending' },
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.call).toEqual(CALL);
    expect(decisions[0]!.ruleId).toBe(HOLD_RULE.id);
    // The sentence a human reads comes from the rule that held the call.
    expect(decisions[0]!.summary).toContain(HOLD_RULE.capability);

    const approved = await h.bus.call<unknown, DecisionsApproveOutput>(
      'decisions:approve',
      ctx,
      { decisionId: decisions[0]!.id, userId: 'u1' },
    );
    expect(approved.decision!.status).toBe('executed');
    // Nothing ran: AW-4 leaves a standing authorisation, AW-5 adds the replay.
    expect(approved.executed).toBe(false);
    expect(approved.path).toBeNull();

    // The warm agent re-issues its call…
    expect((await h.bus.fire('tool:pre-call', ctx, CALL)).rejected).toBe(false);
    // …exactly once.
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);
  });

  it('the durable row survives a full restart of the plugin', async () => {
    const first = await boot();
    await first.bus.fire('tool:pre-call', userCtx(first), CALL);
    await harnesses.pop()!.close({ onError: () => {} });

    // Same database, brand new bus and plugin instances.
    const h = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createToolPolicyPlugin(),
        createDecisionsPlugin(),
      ],
    });
    harnesses.push(h);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      userCtx(h),
      { userId: 'u1' },
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.call).toEqual(CALL);
  });

  it('an approval is byte-bound to the call the human read', async () => {
    const h = await boot();
    const ctx = userCtx(h);
    await h.bus.fire('tool:pre-call', ctx, CALL);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      ctx,
      { userId: 'u1' },
    );
    await h.bus.call('decisions:approve', ctx, {
      decisionId: decisions[0]!.id,
      userId: 'u1',
    });

    // One character different. Holds again — and leaves a second row, so the
    // human sees the substitution rather than it silently passing.
    const tampered = { ...CALL, input: { to: 'attacker@example.com' } };
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, tampered))).toBe(true);
    const after = await h.bus.call<unknown, DecisionsListOutput>('decisions:list', ctx, {
      userId: 'u1',
      status: 'pending',
    });
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]!.call).toEqual(tampered);
  });

  it('a denied tool is denied and NOT held — no row, no question for a human', async () => {
    const h = await boot();
    const ctx = userCtx(h);
    const fired = await h.bus.fire('tool:pre-call', ctx, {
      id: 'c2',
      name: DENY_RULE.match.tool,
      input: {},
    });
    expect(fired.rejected).toBe(true);
    expect(isHold(fired)).toBe(false);

    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      ctx,
      { userId: 'u1' },
    );
    expect(decisions).toEqual([]);
  });

  it('an allowed tool passes straight through with its call intact', async () => {
    const h = await boot();
    const call = { id: 'c3', name: ALLOW_RULE.match.tool, input: { q: 'weather' } };
    const fired = await h.bus.fire('tool:pre-call', userCtx(h), call);
    expect(fired.rejected).toBe(false);
    expect((fired as { payload: unknown }).payload).toEqual(call);
  });

  it('a tool no rule mentions passes through', async () => {
    const h = await boot();
    const fired = await h.bus.fire('tool:pre-call', userCtx(h), {
      id: 'c4',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(fired.rejected).toBe(false);
  });

  it('dismiss records the authored line and never authorises anything', async () => {
    const h = await boot();
    const ctx = userCtx(h);
    await h.bus.fire('tool:pre-call', ctx, CALL);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      ctx,
      { userId: 'u1' },
    );
    const dismissed = await h.bus.call<unknown, { decision: Decision | null }>(
      'decisions:dismiss',
      ctx,
      { decisionId: decisions[0]!.id, userId: 'u1' },
    );
    expect(dismissed.decision!.status).toBe('dismissed');
    // The dismissed line is the STORED one, not a rewrite of the approved one.
    expect(dismissed.decision!.dismissedText).toBe(decisions[0]!.dismissedText);
    expect(dismissed.decision!.dismissedText).not.toBe(decisions[0]!.approvedText);

    // Still held — a dismissal authorises nothing.
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);
  });

  it('undo inside the window returns the decision to the queue and revokes the authorisation', async () => {
    const h = await boot();
    const ctx = userCtx(h);
    await h.bus.fire('tool:pre-call', ctx, CALL);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      ctx,
      { userId: 'u1' },
    );
    const id = decisions[0]!.id;
    await h.bus.call('decisions:approve', ctx, { decisionId: id, userId: 'u1' });

    const undone = await h.bus.call<unknown, { decision: Decision | null; undone: boolean }>(
      'decisions:undo',
      ctx,
      { decisionId: id, userId: 'u1' },
    );
    expect(undone.undone).toBe(true);
    expect(undone.decision!.status).toBe('pending');
    // The standing authorisation went with it.
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);
  });

  it('undo refuses once the authorisation has been consumed', async () => {
    const h = await boot();
    const ctx = userCtx(h);
    await h.bus.fire('tool:pre-call', ctx, CALL);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      ctx,
      { userId: 'u1' },
    );
    const id = decisions[0]!.id;
    await h.bus.call('decisions:approve', ctx, { decisionId: id, userId: 'u1' });
    // The agent takes the authorisation up.
    await h.bus.fire('tool:pre-call', ctx, CALL);

    const undone = await h.bus.call<unknown, { undone: boolean }>('decisions:undo', ctx, {
      decisionId: id,
      userId: 'u1',
    });
    // That bell cannot be un-rung.
    expect(undone.undone).toBe(false);
  });

  it('a decision belongs to its owner — another user cannot see or resolve it', async () => {
    const h = await boot();
    await h.bus.fire('tool:pre-call', userCtx(h), CALL);

    const other = h.ctx({ agentId: 'a1', userId: 'u2', sessionId: 's2' });
    const list = await h.bus.call<unknown, DecisionsListOutput>('decisions:list', other, {
      userId: 'u2',
    });
    expect(list.decisions).toEqual([]);

    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      userCtx(h),
      { userId: 'u1' },
    );
    const stolen = await h.bus.call<unknown, DecisionsApproveOutput>(
      'decisions:approve',
      other,
      { decisionId: decisions[0]!.id, userId: 'u2' },
    );
    expect(stolen.decision).toBeNull();
    // And the real decision is untouched.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), CALL))).toBe(true);
  });

  it('survives the returns schema with every declared field intact', async () => {
    // A `z.object` STRIPS keys it does not declare, so this is the test that
    // fails if a field is added to `Decision` and not to `DecisionSchema`.
    const h = await boot();
    const ctx = userCtx(h);
    await h.bus.fire('tool:pre-call', ctx, CALL);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      ctx,
      { userId: 'u1' },
    );
    expect(Object.keys(decisions[0]!).sort()).toEqual(
      [
        'id',
        'agentId',
        'ownerUserId',
        'conversationId',
        'kind',
        'attendance',
        'status',
        'call',
        'callFingerprint',
        'ruleId',
        'freshness',
        'summary',
        'detail',
        'preview',
        'primaryLabel',
        'secondaryLabel',
        'ghostLabel',
        'approvedText',
        'dismissedText',
        'createdAt',
        'expiresAt',
        'resolvedAt',
        'staleReason',
        'consumedAt',
      ].sort(),
    );
  });

  it('an expired decision cannot be approved', async () => {
    const h = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createToolPolicyPlugin(),
        // A TTL already in the past by the time anyone looks.
        createDecisionsPlugin({ ttlMs: -1 }),
      ],
    });
    harnesses.push(h);
    const ctx = userCtx(h);
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);

    // The list sweep moves it out of the queue on its own.
    const open = await h.bus.call<unknown, DecisionsListOutput>('decisions:list', ctx, {
      userId: 'u1',
    });
    expect(open.decisions).toEqual([]);

    const expired = await h.bus.call<unknown, DecisionsListOutput>('decisions:list', ctx, {
      userId: 'u1',
      status: 'expired',
    });
    expect(expired.decisions).toHaveLength(1);

    const approved = await h.bus.call<unknown, DecisionsApproveOutput>(
      'decisions:approve',
      ctx,
      { decisionId: expired.decisions[0]!.id, userId: 'u1' },
    );
    expect(approved.decision!.status).toBe('expired');
    expect(approved.executed).toBe(false);
    // And no authorisation was left behind.
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);
  });

  it('resolving an already-resolved decision hands back the STORED row, not null', async () => {
    // The bug this caught: approve/dismiss ran the conditional update, got
    // "nothing changed" back because the row was already resolved, and
    // returned `decision: null` — which reads as "no such decision" for a
    // decision the caller is looking straight at.
    const h = await boot();
    const ctx = userCtx(h);
    await h.bus.fire('tool:pre-call', ctx, CALL);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      ctx,
      { userId: 'u1' },
    );
    const id = decisions[0]!.id;
    await h.bus.call('decisions:dismiss', ctx, { decisionId: id, userId: 'u1' });

    const reApproved = await h.bus.call<unknown, DecisionsApproveOutput>(
      'decisions:approve',
      ctx,
      { decisionId: id, userId: 'u1' },
    );
    expect(reApproved.decision).not.toBeNull();
    expect(reApproved.decision!.status).toBe('dismissed');
    expect(reApproved.executed).toBe(false);

    const reDismissed = await h.bus.call<unknown, { decision: Decision | null }>(
      'decisions:dismiss',
      ctx,
      { decisionId: id, userId: 'u1' },
    );
    expect(reDismissed.decision!.status).toBe('dismissed');

    // And a dismissal that was absorbed authorises nothing.
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);
  });

  it('holds do not pre-empt a deny when both would fire', async () => {
    // `HookBus.fire` stops at the FIRST rejection, so a subscriber returning a
    // hold ahead of one returning a deny would ask a human to permit something
    // the system already forbids. The k8s preset asserts the registration
    // order; this asserts what that order buys.
    const h = await boot();
    const ctx = userCtx(h);
    const denier = await h.bus.fire('tool:pre-call', ctx, {
      id: 'c9',
      name: DENY_RULE.match.tool,
      input: {},
    });
    expect(isRejection(denier)).toBe(true);
    expect(isHold(denier)).toBe(false);
  });
});
