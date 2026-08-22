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
import {
  BUILTIN_RULES,
  createToolPolicyPlugin,
  type ToolPolicyPluginOptions,
} from '@ax/tool-policy';
import {
  isHold,
  isRejection,
  PluginError,
  type AgentContext,
  type Hold,
  type ToolCall,
} from '@ax/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UNDO_WINDOW_MS } from '../machine.js';
import { createDecisionsPlugin, type DecisionsPluginOptions } from '../plugin.js';
import type {
  Decision,
  DecisionExecutedPayload,
  DecisionRaisedPayload,
  DecisionsApproveOutput,
  DecisionsGetOutput,
  DecisionsListOutput,
  DecisionsSweepOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

/**
 * `sweepIntervalMs: 0` disables the maintenance timer in every boot below.
 * A background sweep firing mid-assertion would make the deferred-replay and
 * expiry tests race a clock; the ones that need a sweep drive `decisions:sweep`
 * themselves and get a deterministic answer back.
 */
async function boot(
  decisions: DecisionsPluginOptions = {},
  policy?: ToolPolicyPluginOptions,
  channels: Record<string, Channel> = DEFAULT_CHANNELS,
): Promise<TestHarness & { delivered: DeliveredEntry[] }> {
  const delivered: DeliveredEntry[] = [];
  const h = await createTestHarness({
    // AW-6. Two stand-ins for plugins @ax/decisions reaches through
    // `optionalCalls`. Nothing about attendance is injected any more — the
    // plugin resolves it through `conversations:get-metadata` exactly as it
    // does in the k8s preset, so a regression in that path fails HERE rather
    // than only in the cluster.
    services: {
      'conversations:get-metadata': async (_c, input) => {
        const { conversationId, userId } = input as {
          conversationId: string;
          userId: string;
        };
        const row = channels[conversationId];
        if (row === undefined || row.userId !== userId) {
          throw new PluginError({
            code: 'not-found',
            plugin: 'stub-conversations',
            message: `conversation '${conversationId}' not found`,
          });
        }
        return {
          conversationId,
          userId,
          agentId: 'a1',
          runnerType: null,
          runnerSessionId: null,
          workspaceRef: null,
          title: null,
          lastActivityAt: null,
          createdAt: '2026-08-21T09:00:00.000Z',
          origin: row.origin,
          activeSessionId: row.activeSessionId,
        };
      },
      'session:queue-work': async (_c, input) => {
        delivered.push(input as DeliveredEntry);
        return { cursor: delivered.length - 1 };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      // Registration order matters and is asserted in the k8s preset test:
      // decisions must be able to see tool-policy's hook, and its subscriber
      // must run after anything that can deny outright.
      createToolPolicyPlugin(policy),
      createDecisionsPlugin({ sweepIntervalMs: 0, ...decisions }),
    ],
  });
  harnesses.push(h);
  return Object.assign(h, { delivered });
}

/** What the stub conversations store holds for one conversation. */
interface Channel {
  origin: 'web' | 'routine';
  activeSessionId: string | null;
  userId: string;
}

interface DeliveredEntry {
  sessionId: string;
  entry: { type: string; decisionId: string; outcome: string; note: string };
}

/**
 * The two channels every canary boot has: a live web thread someone is
 * watching, and a routine's own conversation with no session behind it.
 *
 * `conv-web` carries an `activeSessionId` because that is what ATTENDED means
 * mechanically — the runner is parked on that session's inbox waiting for the
 * answer.
 */
const DEFAULT_CHANNELS: Record<string, Channel> = {
  'conv-web': { origin: 'web', activeSessionId: 'sess-warm', userId: 'u1' },
  'conv-tick': { origin: 'routine', activeSessionId: null, userId: 'u1' },
};

/**
 * No rule in `BUILTIN_RULES` is marked `irreversible` — deliberately, and the
 * rule table says so. So the deferred-replay path needs an injected table. It
 * is the same shape a real irreversible rule would have; only the flag differs
 * from `HOLD_RULE`.
 */
const IRREVERSIBLE_RULES = [
  { ...BUILTIN_RULES.find((r) => r.verdict === 'hold')!, irreversible: true },
];

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
/**
 * A SECOND held tool, and the one the host can never replay. `skill_propose`
 * is `executesIn: 'sandbox'`, so no `tool:execute:skill_propose` hook exists —
 * which is exactly the fourth row of AW-5's table, not a gap in the harness.
 */
const SANDBOX_HOLD_RULE = BUILTIN_RULES.find(
  (r) => r.verdict === 'hold' && r.match.tool === 'skill_propose',
)!;

/** The ATTENDED path: a live web thread with a warm session behind it. */
function userCtx(h: TestHarness): AgentContext {
  return h.ctx({ agentId: 'a1', userId: 'u1', conversationId: 'conv-web', sessionId: 's1' });
}

/**
 * The UNATTENDED path: a routine's own conversation.
 *
 * AW-6: attendance comes from the CONVERSATION's channel, not from
 * `ctx.source`. This ctx deliberately does NOT set `source: 'routine'` — if
 * anything in the gate ever starts reading it again, the unattended tests
 * below keep passing for the wrong reason, and this is where that would be
 * hidden.
 */
function routineCtx(h: TestHarness): AgentContext {
  return h.ctx({
    agentId: 'a1',
    userId: 'u1',
    conversationId: 'conv-tick',
    sessionId: 's-routine',
  });
}

const CALL = { id: 'c1', name: HOLD_RULE.match.tool, input: { to: 'a@b.c' } };
const SANDBOX_CALL = {
  id: 'c-sandbox',
  name: SANDBOX_HOLD_RULE.match.tool,
  input: { name: 'weekly-digest' },
};

/**
 * Stand in for a host-side tool executor — the same dynamic
 * `tool:execute:<name>` service hook `tool.execute-host` dispatches to. What
 * it records is the argument the replay actually handed it, which is the only
 * way to prove the card was WYSIWYG.
 */
function recordExecutor(
  h: TestHarness,
  toolName: string,
  opts: { throws?: string } = {},
): { calls: ToolCall[]; ctxs: AgentContext[] } {
  const calls: ToolCall[] = [];
  const ctxs: AgentContext[] = [];
  h.bus.registerService<ToolCall, unknown>(
    `tool:execute:${toolName}`,
    '@ax/decisions/test/host-tool',
    async (ctx, call) => {
      ctxs.push(ctx);
      calls.push(call);
      if (opts.throws !== undefined) throw new Error(opts.throws);
      return { ok: true };
    },
  );
  return { calls, ctxs };
}

/** Fire a held call and hand back the decision id off the hold itself. */
async function holdAndId(
  h: TestHarness,
  ctx: AgentContext,
  call: { id: string; name: string; input: unknown },
): Promise<string> {
  const fired = await h.bus.fire('tool:pre-call', ctx, call);
  expect(isHold(fired)).toBe(true);
  return (fired as unknown as Hold).hold.decisionId;
}

function approve(
  h: TestHarness,
  ctx: AgentContext,
  decisionId: string,
): Promise<DecisionsApproveOutput> {
  return h.bus.call<unknown, DecisionsApproveOutput>('decisions:approve', ctx, {
    decisionId,
    userId: 'u1',
  });
}

async function readDecision(
  h: TestHarness,
  ctx: AgentContext,
  decisionId: string,
): Promise<Decision> {
  const { decision } = await h.bus.call<unknown, DecisionsGetOutput>('decisions:get', ctx, {
    decisionId,
    userId: 'u1',
  });
  return decision!;
}

/** Collect every `decisions:executed` receipt this harness emits. */
function collectReceipts(h: TestHarness): DecisionExecutedPayload[] {
  const seen: DecisionExecutedPayload[] = [];
  h.bus.subscribe<DecisionExecutedPayload>(
    'decisions:executed',
    '@ax/decisions/test/receipts',
    async (_c, payload) => {
      seen.push(payload);
      return undefined;
    },
  );
  return seen;
}

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
    // The ATTENDED path: the agent is still warm, so the HOST ran nothing —
    // it says so, and it says whose job it is. The standing authorisation is
    // what the agent's own retry cashes in, two lines below.
    expect(approved.executed).toBe(false);
    expect(approved.path).toBe('agent-executes');
    expect(approved.error).toBeNull();
    expect(approved.pendingUntil).toBeNull();

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
    const h = await boot();
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
        // AW-5's four. A field added to `Decision` and not to `DecisionSchema`
        // is silently STRIPPED on the way out of the bus, and `irreversible`
        // going missing would mean an irreversible call replays with no undo
        // window at all.
        'irreversible',
        'replayDueAt',
        'replayClaimedAt',
        'replayedAt',
        'replayError',
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
    // A TTL already in the past by the time anyone looks.
    const h = await boot({ ttlMs: -1 });
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

  it('fires decisions:raised with the summary — and never with the tool input', async () => {
    // AW-11's SSE is the consumer. It is fire-and-forget on purpose: a slow
    // subscriber must not push the gate past the 10 s `tool.pre-call` ceiling,
    // which the runner converts into a deny.
    const h = await boot();
    const seen: DecisionRaisedPayload[] = [];
    let resolveFirst: () => void;
    const fired = new Promise<void>((r) => {
      resolveFirst = r;
    });
    h.bus.subscribe<DecisionRaisedPayload>(
      'decisions:raised',
      '@ax/decisions/test/listener',
      async (_c, payload) => {
        seen.push(payload);
        resolveFirst();
        return undefined;
      },
    );

    const ctx = userCtx(h);
    await h.bus.fire('tool:pre-call', ctx, CALL);
    await fired;

    expect(seen).toHaveLength(1);
    expect(seen[0]!.agentId).toBe('a1');
    expect(seen[0]!.conversationId).toBe('conv-web');
    expect(seen[0]!.decisionId).toMatch(/^dec_[0-9a-f]{32}$/);
    expect(seen[0]!.summary).toContain(HOLD_RULE.capability);
    // The payload carries no `call` at all: a subscriber that rendered raw
    // model output would put untrusted text on a trust surface.
    expect(Object.keys(seen[0]!).sort()).toEqual(
      ['agentId', 'conversationId', 'decisionId', 'summary'].sort(),
    );
  });

  it('a throwing decisions:raised subscriber cannot turn a hold into anything else', async () => {
    const h = await boot();
    h.bus.subscribe('decisions:raised', '@ax/decisions/test/thrower', async () => {
      throw new Error('SSE is down');
    });
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), CALL))).toBe(true);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      userCtx(h),
      { userId: 'u1' },
    );
    expect(decisions).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// AW-5. Approving an UNATTENDED decision actually does the thing — or says,
// in our own words, exactly why it did not.
//
// Every boot here approves from a normal web context (`userCtx`) a decision
// that was RAISED from a routine (`routineCtx`). That split is the point: the
// person clicking approve is not the turn that made the call, and the replay
// has to run under the decision's own owner and agent, not the clicker's.
// ---------------------------------------------------------------------------
describe('decisions canary — execute on approve', () => {
  it('replays the recorded call on the host, byte for byte', async () => {
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const id = await holdAndId(h, routineCtx(h), CALL);
    const stored = await readDecision(h, userCtx(h), id);

    const out = await approve(h, userCtx(h), id);

    // The executor saw the recorded call — same id, same name, same nested
    // input object. Nothing re-derived, re-serialised or "normalised" on the
    // way in; that is the whole basis of the card's WYSIWYG promise.
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toEqual(stored.call);
    expect(executor.calls[0]).toEqual(CALL);

    // …and it ran under the DECISION's owner and agent, not the approving
    // request's session. Firing with the clicker's ctx is how work lands in
    // somebody else's workspace.
    expect(executor.ctxs[0]!.userId).toBe('u1');
    expect(executor.ctxs[0]!.agentId).toBe('a1');
    expect(executor.ctxs[0]!.conversationId).toBe('conv-tick');

    expect(out.executed).toBe(true);
    expect(out.path).toBe('host-replays');
    expect(out.error).toBeNull();
    expect(out.pendingUntil).toBeNull();

    const after = await readDecision(h, userCtx(h), id);
    expect(after.status).toBe('executed');
    // The consume belongs to the agent-retry path. Replay IS the execution, so
    // nothing is left standing at the gate for an agent to take up as well.
    expect(after.consumedAt).toBeNull();
    expect(after.replayedAt).not.toBeNull();
    expect(after.replayError).toBeNull();
    expect(after.replayDueAt).toBeNull();

    // And the yes is SPENT. An agent making the identical call on its next run
    // holds again rather than sailing through on an authorisation the host
    // already used — otherwise one approval buys two sends.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), CALL))).toBe(true);
    expect(executor.calls).toHaveLength(1);
  });

  it('parks a sandbox-only tool instead of pretending to send it', async () => {
    // The fourth row of AW-5's table. `skill_propose` runs in the sandbox, the
    // turn is over, and there is no `tool:execute:skill_propose` hook — so the
    // host does not try, does not fail, and does not fabricate a receipt.
    const h = await boot();
    const id = await holdAndId(h, routineCtx(h), SANDBOX_CALL);

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(false);
    expect(out.path).toBeNull();
    expect(out.error).toBeNull();
    expect(out.decision!.status).toBe('approved-pending-agent');

    // The approval is REAL and waits at the gate. The next time that agent
    // runs, its call goes through…
    expect((await h.bus.fire('tool:pre-call', userCtx(h), SANDBOX_CALL)).rejected).toBe(false);
    // …exactly once.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), SANDBOX_CALL))).toBe(true);
  });

  it('the parked receipt promises the future and never claims a send', async () => {
    const h = await boot();
    const receipts = collectReceipts(h);
    const id = await holdAndId(h, routineCtx(h), SANDBOX_CALL);
    const stored = await readDecision(h, userCtx(h), id);

    await approve(h, userCtx(h), id);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('pending-agent');
    expect(receipts[0]!.decisionId).toBe(id);
    // `approvedText` says the call may run and would read as "done" next to a
    // decision where nothing has happened yet.
    expect(receipts[0]!.receipt).not.toBe(stored.approvedText);
    expect(receipts[0]!.receipt).toContain('the next time it runs');
  });

  it('two concurrent approvals execute exactly once', async () => {
    // A double click, two open tabs, a retried POST. The claim is a single
    // conditional UPDATE, so only one of these is entitled to run anything.
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const id = await holdAndId(h, routineCtx(h), CALL);

    const [a, b] = await Promise.all([
      approve(h, userCtx(h), id),
      approve(h, userCtx(h), id),
    ]);

    expect(executor.calls).toHaveLength(1);
    expect([a.executed, b.executed].filter(Boolean)).toHaveLength(1);

    // The loser reports the STORED outcome. `decision: null` would read as
    // "no such decision" for a decision the human is looking straight at.
    const loser = a.executed ? b : a;
    expect(loser.decision).not.toBeNull();
    expect(loser.decision!.status).toBe('executed');
    expect(loser.path).toBeNull();
    expect(loser.error).toBeNull();
  });

  it('an agent that calls again WHILE the host is replaying is held, not let through', async () => {
    // The window a review caught: between the host committing to the replay and
    // the call returning, the row is `executed` with nothing consumed. An agent
    // re-issuing the byte-identical call in that window would have spent the
    // same yes and run the call a second time. `replay_claimed_at` is set in the
    // same statement that claims the approval, so the door is shut the whole
    // time the call is in flight.
    const h = await boot();
    let insideReplay: Awaited<ReturnType<typeof h.bus.fire>> | undefined;
    h.bus.registerService<ToolCall, unknown>(
      `tool:execute:${HOLD_RULE.match.tool}`,
      '@ax/decisions/test/slow-host-tool',
      async () => {
        // The agent wakes up mid-send and asks for exactly the same thing.
        insideReplay = await h.bus.fire('tool:pre-call', userCtx(h), CALL);
        return { ok: true };
      },
    );
    const id = await holdAndId(h, routineCtx(h), CALL);

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(true);

    // Held — a SECOND decision row, so the human sees the second attempt rather
    // than it silently riding the first approval.
    expect(isHold(insideReplay)).toBe(true);
    expect((insideReplay as unknown as Hold).hold.decisionId).not.toBe(id);
    expect((await readDecision(h, userCtx(h), id)).consumedAt).toBeNull();
  });

  it('a failed replay never emits the approved receipt', async () => {
    // H1: an action that did not happen must not leave a log line saying it
    // did — and must not leave a standing "yes" behind either.
    const h = await boot();
    recordExecutor(h, HOLD_RULE.match.tool, { throws: 'upstream 503' });
    const receipts = collectReceipts(h);
    const id = await holdAndId(h, routineCtx(h), CALL);
    const stored = await readDecision(h, userCtx(h), id);

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(false);
    expect(out.error).not.toBeNull();
    expect(out.error).toContain('upstream 503');

    const after = await readDecision(h, userCtx(h), id);
    expect(after.status).toBe('failed');
    expect(after.replayError).toContain('upstream 503');

    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('failed');
    // The receipt a human reads is the AUTHORED failure line — never the
    // approved one, and never the executor's own message.
    expect(receipts[0]!.receipt).not.toContain(stored.approvedText);
    expect(receipts[0]!.receipt).not.toContain('upstream 503');

    // And the agent cannot quietly cash in a yes for something that failed.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), CALL))).toBe(true);
  });

  it('undoing an approval the host has NOT yet acted on retracts its receipt', async () => {
    // The sandbox-only case: the approval is real, the receipt says "it will
    // do this the next time it runs", and nothing has gone out yet — so there
    // is something an undo can actually take back.
    const h = await boot();
    const receipts = collectReceipts(h);
    const id = await holdAndId(h, routineCtx(h), SANDBOX_CALL);

    await approve(h, userCtx(h), id);
    expect(receipts.at(-1)!.outcome).toBe('pending-agent');

    const undone = await h.bus.call<unknown, { undone: boolean; decision: Decision | null }>(
      'decisions:undo',
      userCtx(h),
      { decisionId: id, userId: 'u1' },
    );
    expect(undone.undone).toBe(true);
    expect(undone.decision!.status).toBe('pending');

    // The receipt above is now describing something that no longer holds, so
    // AW-10's feed is told to remove it rather than leave the old claim
    // standing next to a decision that is open again.
    expect(receipts.at(-1)).toMatchObject({ decisionId: id, outcome: 'retracted' });
    // And the standing authorisation went with it.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), SANDBOX_CALL))).toBe(true);
  });

  it('refuses to undo a call the host has already made', async () => {
    // Undo does not un-send an email. Once the replay has run, the honest
    // answer is "no" — putting the row back on the queue would let a second
    // approval do the whole thing again.
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const receipts = collectReceipts(h);
    const id = await holdAndId(h, routineCtx(h), CALL);

    await approve(h, userCtx(h), id);
    expect(receipts.at(-1)!.outcome).toBe('executed');

    const undone = await h.bus.call<unknown, { undone: boolean; decision: Decision | null }>(
      'decisions:undo',
      userCtx(h),
      { decisionId: id, userId: 'u1' },
    );
    expect(undone.undone).toBe(false);
    expect(undone.decision!.status).toBe('executed');
    // No retraction was invented for a receipt that still stands…
    expect(receipts.at(-1)!.outcome).toBe('executed');
    // …and nothing ran a second time.
    expect(executor.calls).toHaveLength(1);
  });

  it('an irreversible rule waits out the undo window before the call goes out', async () => {
    // The grace period, end to end. `pendingUntil` is exactly when the undo
    // window closes, nothing has gone out in the meantime, and the sweep is
    // what finally sends it.
    // A clock we control: the deferral is measured in real milliseconds, and a
    // test that waited them out would be a test that sleeps.
    let clock = new Date('2026-08-21T09:00:00.000Z');
    const h = await boot({ now: () => clock }, { rules: IRREVERSIBLE_RULES });
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const receipts = collectReceipts(h);
    const id = await holdAndId(h, routineCtx(h), CALL);

    const out = await approve(h, userCtx(h), id);
    // Approved — and deliberately NOT executed yet.
    expect(out.executed).toBe(false);
    expect(out.path).toBe('host-replays');
    expect(out.pendingUntil).not.toBeNull();
    expect(executor.calls).toEqual([]);
    // No receipt yet either: nothing has happened, so nothing says it has.
    expect(receipts).toEqual([]);

    const stored = await readDecision(h, userCtx(h), id);
    expect(stored.irreversible).toBe(true);
    expect(stored.replayDueAt).toBe(out.pendingUntil);
    expect(Date.parse(stored.replayDueAt!) - Date.parse(stored.resolvedAt!)).toBe(
      UNDO_WINDOW_MS,
    );
    // And the agent cannot cash the authorisation in underneath the host while
    // the send is still pending — otherwise one approval buys two sends.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), CALL))).toBe(true);

    // The window closes.
    clock = new Date(clock.getTime() + UNDO_WINDOW_MS + 1);
    const swept = await h.bus.call<unknown, DecisionsSweepOutput>(
      'decisions:sweep',
      userCtx(h),
      {},
    );
    expect(swept.replayed).toBe(1);
    expect(executor.calls).toEqual([CALL]);
    expect(receipts.at(-1)).toMatchObject({ decisionId: id, outcome: 'executed' });

    const after = await readDecision(h, userCtx(h), id);
    expect(after.status).toBe('executed');
    expect(after.replayDueAt).toBeNull();
    expect(after.replayedAt).not.toBeNull();

    // Sweeping again does nothing — the claim cleared the due-time.
    const again = await h.bus.call<unknown, DecisionsSweepOutput>(
      'decisions:sweep',
      userCtx(h),
      {},
    );
    expect(again.replayed).toBe(0);
    expect(executor.calls).toHaveLength(1);
  });

  it('undo inside the window cancels the send outright', async () => {
    // This is the whole point of deferring an irreversible call: the undo
    // button has to stop the outward action, not apologise for it afterwards.
    let clock = new Date('2026-08-21T09:00:00.000Z');
    const h = await boot({ now: () => clock }, { rules: IRREVERSIBLE_RULES });
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const id = await holdAndId(h, routineCtx(h), CALL);
    await approve(h, userCtx(h), id);

    const undone = await h.bus.call<unknown, { undone: boolean; decision: Decision | null }>(
      'decisions:undo',
      userCtx(h),
      { decisionId: id, userId: 'u1' },
    );
    expect(undone.undone).toBe(true);
    expect(undone.decision!.status).toBe('pending');
    expect(undone.decision!.replayDueAt).toBeNull();

    // Even once the window has long passed, there is nothing left to send.
    clock = new Date(clock.getTime() + UNDO_WINDOW_MS * 10);
    const swept = await h.bus.call<unknown, DecisionsSweepOutput>(
      'decisions:sweep',
      userCtx(h),
      {},
    );
    expect(swept.replayed).toBe(0);
    // Nothing ever went out.
    expect(executor.calls).toEqual([]);
  });

  it('the sweep expires an unanswered decision, and an expired one cannot be approved', async () => {
    // A TTL that is already up. Nothing here reads the queue first, so the
    // SWEEP is what moves the row — `decisions:list` has its own sweep and
    // would otherwise be the one doing the work.
    const h = await boot({ ttlMs: 0 });
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const id = await holdAndId(h, routineCtx(h), CALL);

    const swept = await h.bus.call<unknown, DecisionsSweepOutput>(
      'decisions:sweep',
      userCtx(h),
      {},
    );
    expect(swept.expired).toBe(1);
    expect(swept.replayed).toBe(0);
    expect((await readDecision(h, userCtx(h), id)).status).toBe('expired');

    const out = await approve(h, userCtx(h), id);
    expect(out.decision!.status).toBe('expired');
    expect(out.executed).toBe(false);
    expect(out.path).toBeNull();
    // Approving a world that is gone runs nothing and authorises nothing.
    expect(executor.calls).toEqual([]);
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), CALL))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AW-6. Attendance is the conversation's channel, and a resolved ATTENDED
// decision comes back to the still-warm agent as its next inbox message.
//
// Nothing here injects `attendanceFor`. The plugin resolves it through
// `conversations:get-metadata` exactly as it does in the k8s preset, so if that
// path regresses these fail rather than only the cluster walk.
// ---------------------------------------------------------------------------
describe('decisions canary — attendance and delivery', () => {
  it('derives attendance from the conversation, not from the turn', async () => {
    const h = await boot();
    const web = await readDecision(h, userCtx(h), await holdAndId(h, userCtx(h), CALL));
    expect(web.attendance).toBe('attended');

    const tick = await readDecision(
      h,
      userCtx(h),
      await holdAndId(h, routineCtx(h), SANDBOX_CALL),
    );
    expect(tick.attendance).toBe('unattended');
  });

  it('is unattended when the conversation cannot be read at all', async () => {
    // The fail-safe. Unattended misread as attended strands the decision
    // waiting for a warm agent that is already gone; the reverse just means the
    // host replays the call itself.
    const h = await boot();
    const ctx = h.ctx({
      agentId: 'a1',
      userId: 'u1',
      conversationId: 'conv-nowhere',
      sessionId: 's-x',
    });
    const stored = await readDecision(h, userCtx(h), await holdAndId(h, ctx, CALL));
    expect(stored.attendance).toBe('unattended');
  });

  it('delivers an approval to the warm agent, and the retry cashes it in', async () => {
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    const out = await approve(h, ctx, id);
    expect(out.path).toBe('agent-executes');
    // The HOST ran nothing — that is the whole point of the attended path.
    expect(out.executed).toBe(false);
    expect(executor.calls).toEqual([]);

    // The delivery landed on the session the runner is parked on.
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.sessionId).toBe('sess-warm');
    expect(h.delivered[0]!.entry.type).toBe('decision-resolved');
    expect(h.delivered[0]!.entry.decisionId).toBe(id);
    expect(h.delivered[0]!.entry.outcome).toBe('approved');
    // HOST-AUTHORED. The recorded call's input is model-authored and never
    // reaches a line the model reads back as instruction.
    expect(h.delivered[0]!.entry.note).toContain(id);
    expect(h.delivered[0]!.entry.note).not.toContain('a@b.c');

    // And the authorisation the delivery is telling the agent about is real:
    // one byte-identical retry passes, the next holds again.
    expect((await h.bus.fire('tool:pre-call', ctx, CALL)).rejected).toBe(false);
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);
  });

  it('delivers a dismissal too, so the agent is not left parked on a dead question', async () => {
    const h = await boot();
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    await h.bus.call('decisions:dismiss', ctx, { decisionId: id, userId: 'u1' });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.entry.outcome).toBe('dismissed');
    // A dismissal authorises nothing: the call still holds.
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);
  });

  it('delivers a dismissal exactly once even when two tabs click it', async () => {
    // Only the caller who actually made the transition delivers. Otherwise the
    // second tab wakes the agent again with news it already has.
    const h = await boot();
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    await Promise.all([
      h.bus.call('decisions:dismiss', ctx, { decisionId: id, userId: 'u1' }),
      h.bus.call('decisions:dismiss', ctx, { decisionId: id, userId: 'u1' }),
    ]);
    expect(h.delivered).toHaveLength(1);
  });

  it('never delivers on the unattended path — nobody is listening', async () => {
    const h = await boot();
    recordExecutor(h, HOLD_RULE.match.tool);
    const id = await holdAndId(h, routineCtx(h), CALL);

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(true);
    expect(out.path).toBe('host-replays');
    expect(h.delivered).toEqual([]);
  });

  it('an attended decision whose session is gone degrades into the unattended path', async () => {
    // The design's no-special-case claim (§3.3). The person walked away, the
    // idle floor expired, the runner exited — and then they came back and
    // clicked Approve.
    //
    // Nothing branches on that. The delivery is a no-op, and the STANDING
    // AUTHORISATION is what carries the approval forward: the next time the
    // agent runs and makes the same call, the gate lets it through exactly
    // once. That is precisely what an unattended decision does.
    //
    // NOTE on what is deliberately NOT asserted: the row does not go back to
    // `pending`. AW-5's `claimForApproval` moved it to `executed` in the same
    // write that won the claim, and re-opening a decision a person has already
    // answered would be a lie about what they did.
    const h = await boot({}, undefined, {
      'conv-web': { origin: 'web', activeSessionId: null, userId: 'u1' },
      'conv-tick': { origin: 'routine', activeSessionId: null, userId: 'u1' },
    });
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);
    expect((await readDecision(h, ctx, id)).attendance).toBe('attended');

    const out = await approve(h, ctx, id);
    expect(out.executed).toBe(false);
    expect(out.path).toBe('agent-executes');
    // Nothing was delivered, and the host did not step in either.
    expect(h.delivered).toEqual([]);
    expect(executor.calls).toEqual([]);

    // The authorisation SURVIVED. A later run of the agent — a fresh session,
    // any session — makes the same call and it goes through, once.
    const later = h.ctx({
      agentId: 'a1',
      userId: 'u1',
      conversationId: 'conv-web',
      sessionId: 's-much-later',
    });
    expect((await h.bus.fire('tool:pre-call', later, CALL)).rejected).toBe(false);
    expect(isHold(await h.bus.fire('tool:pre-call', later, CALL))).toBe(true);
    expect((await readDecision(h, ctx, id)).consumedAt).not.toBeNull();
  });
});
