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
  createLogger,
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
import { CLAIM_REFUSED_DETAIL } from '../templates.js';
import { createDecisionsPlugin, type DecisionsPluginOptions } from '../plugin.js';
import type {
  Decision,
  DecisionReceipt,
  DecisionRaisedPayload,
  DecisionsApproveOutput,
  DecisionsCountInput,
  DecisionsCountOutput,
  DecisionsDismissOutput,
  DecisionsGetOutput,
  DecisionsListOutput,
  DecisionsRecentReceiptsInput,
  DecisionsRecentReceiptsOutput,
  DecisionsSweepOutput,
  DecisionsUndoOutput,
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
  channels: Record<string, Channel> = liveChannels(),
  /**
   * Makes `session:queue-work` refuse, the way the real one does when the
   * reaper tore the session down after we had already looked and found it
   * alive. That millisecond is the only gap the liveness read cannot close, so
   * it needs a way to be reproduced.
   */
  queue: { throws?: string } = {},
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
        if (queue.throws !== undefined) {
          throw new PluginError({
            code: 'unknown-session',
            plugin: 'stub-sessions',
            message: queue.throws,
          });
        }
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
 *
 * A FUNCTION rather than a shared constant: a session ENDING between the hold
 * and the approval is the whole of TASK-277, and the only way to say that to
 * the stub is to mutate the map it reads. One shared object would carry that
 * mutation into every other test in the file.
 */
function liveChannels(): Record<string, Channel> {
  return {
    'conv-web': { origin: 'web', activeSessionId: 'sess-warm', userId: 'u1' },
    'conv-tick': { origin: 'routine', activeSessionId: null, userId: 'u1' },
  };
}

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

/**
 * Read this agent's receipts back off the rows, through the real hook.
 *
 * A PULL, not a spy on a fire, and that is the point of TASK-279. The old
 * helper subscribed to `decisions:executed` and collected what went past —
 * which measured that an event was emitted, not that any receipt existed. It
 * could not have caught the fact that nothing in the deployment subscribed, and
 * it did not. Reading is the same thing the Activity feed does, so a receipt
 * that fails to appear here fails to appear there.
 */
async function readReceipts(h: TestHarness): Promise<DecisionReceipt[]> {
  const out = await h.bus.call<DecisionsRecentReceiptsInput, DecisionsRecentReceiptsOutput>(
    'decisions:recent-receipts-for-agent',
    userCtx(h),
    { userId: 'u1', agentId: 'a1' },
  );
  return out.receipts;
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
        // TASK-253's. Stripped here, an abandoned row would read back as an
        // ordinary failure and the receipt would claim nothing was completed.
        'replayAbandonedAt',
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
    const id = await holdAndId(h, routineCtx(h), SANDBOX_CALL);
    const stored = await readDecision(h, userCtx(h), id);

    await approve(h, userCtx(h), id);

    const receipts = await readReceipts(h);
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
    const id = await holdAndId(h, routineCtx(h), CALL);
    const stored = await readDecision(h, userCtx(h), id);

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(false);
    expect(out.error).not.toBeNull();
    expect(out.error).toContain('upstream 503');

    const after = await readDecision(h, userCtx(h), id);
    expect(after.status).toBe('failed');
    expect(after.replayError).toContain('upstream 503');

    const receipts = await readReceipts(h);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('failed');
    // The receipt a human reads is the AUTHORED failure line — never the
    // approved one, and never the executor's own message.
    expect(receipts[0]!.receipt).not.toContain(stored.approvedText);
    expect(receipts[0]!.receipt).not.toContain('upstream 503');
    // The executor's words ride BESIDE it, as audit-trail detail.
    expect(receipts[0]!.error).toContain('upstream 503');

    // And the agent cannot quietly cash in a yes for something that failed.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), CALL))).toBe(true);
  });

  it('an undone execution\'s receipt DISAPPEARS', async () => {
    /*
      TASK-237's acceptance criterion, which could not be exercised until now:
      there was no receipt anywhere, so there was nothing for an undo to remove
      and the criterion could not fail in the interesting way.

      The sandbox-only case, because it is the one where an approval is real and
      nothing has gone out yet — so there is genuinely something an undo can
      take back. Driven through the REAL `decisions:undo` against real Postgres,
      and read back through the REAL hook the Activity feed reads: no fire-spy
      is involved on either side, because a spy would only have shown that an
      event went past and this repo has been bitten by exactly that.
    */
    const h = await boot();
    const id = await holdAndId(h, routineCtx(h), SANDBOX_CALL);

    await approve(h, userCtx(h), id);
    expect((await readReceipts(h))[0]).toMatchObject({
      decisionId: id,
      outcome: 'pending-agent',
    });

    const undone = await h.bus.call<unknown, { undone: boolean; decision: Decision | null }>(
      'decisions:undo',
      userCtx(h),
      { decisionId: id, userId: 'u1' },
    );
    expect(undone.undone).toBe(true);
    expect(undone.decision!.status).toBe('pending');

    // GONE. Nothing deleted it and nothing was told to: the row is open again,
    // and a receipt read off an open row does not exist. A line still claiming
    // the agent would go on to do this would be the same class of lie as
    // claiming an unsent email was sent (design H1).
    expect(await readReceipts(h)).toEqual([]);
    // And the standing authorisation went with it.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), SANDBOX_CALL))).toBe(true);
  });

  it('refuses to undo a call the host has already made', async () => {
    // Undo does not un-send an email. Once the replay has run, the honest
    // answer is "no" — putting the row back on the queue would let a second
    // approval do the whole thing again.
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const id = await holdAndId(h, routineCtx(h), CALL);

    await approve(h, userCtx(h), id);
    expect((await readReceipts(h))[0]!.outcome).toBe('executed');

    const undone = await h.bus.call<unknown, { undone: boolean; decision: Decision | null }>(
      'decisions:undo',
      userCtx(h),
      { decisionId: id, userId: 'u1' },
    );
    expect(undone.undone).toBe(false);
    expect(undone.decision!.status).toBe('executed');
    // The refusal changed nothing, so the receipt still stands and still says
    // the same thing — read back off the row, not remembered from earlier.
    expect((await readReceipts(h))[0]!.outcome).toBe('executed');
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
    const id = await holdAndId(h, routineCtx(h), CALL);

    const out = await approve(h, userCtx(h), id);
    // Approved — and deliberately NOT executed yet.
    expect(out.executed).toBe(false);
    expect(out.path).toBe('host-replays');
    expect(out.pendingUntil).not.toBeNull();
    expect(executor.calls).toEqual([]);
    // No receipt yet either: nothing has happened, so nothing says it has —
    // and for the next ten seconds an undo can still stop it.
    expect(await readReceipts(h)).toEqual([]);

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
    expect((await readReceipts(h))[0]).toMatchObject({
      decisionId: id,
      outcome: 'executed',
    });

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
// TASK-254. The gate raises ONE question per (agent, call shape) that is still
// open, so the human is never asked the same thing twice for one call — and
// the unique index's refusal, which TASK-253 made loud, stops being reachable
// from the ordinary "the agent tried again" path that used to produce it.
// ---------------------------------------------------------------------------
describe('decisions canary — the same call, held twice', () => {
  it('asks one question for two identical held calls, and approving it sends ONCE', async () => {
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);

    // The agent issues the identical call twice: a retry, a re-run of the turn,
    // two parallel tool calls in one turn. Both are held.
    const first = await holdAndId(h, routineCtx(h), CALL);
    const second = await holdAndId(h, routineCtx(h), { ...CALL, id: 'c1-retry' });

    // The card's own case: "two holds of the same call, then approving each".
    const a = await approve(h, userCtx(h), first);
    const b = await approve(h, userCtx(h), second);

    // THE ASSERTION, and it is a side effect rather than a row status: the
    // call went out ONCE. Before this collapse it went out TWICE on exactly
    // this path, and both rows read `executed` while it did — the index frees
    // its slot the moment `replayed_at` is stamped, so nothing refused the
    // second approval and nothing looked wrong afterwards.
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toEqual(CALL);

    // Because there was one question, not two. The call ids differ and the
    // fingerprints do not.
    expect(second).toBe(first);
    const { decisions } = await h.bus.call<unknown, DecisionsListOutput>(
      'decisions:list',
      userCtx(h),
      { userId: 'u1', status: 'executed' },
    );
    expect(decisions).toHaveLength(1);

    // And the second click is the idempotent one the machine already absorbs —
    // it reports the stored outcome rather than dying on the unique index and
    // coming back with TASK-253's refusal sentence. That branch still exists
    // and still speaks (a shared agent's two owners can still collide); the
    // ordinary "the agent tried again" path no longer reaches it.
    expect(a.executed).toBe(true);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(b.decision!.status).toBe('executed');
  });

  /**
   * THE RESIDUE, pinned as it actually behaves rather than as it reads better.
   *
   * `restore` (undo) walks a row back into `pending` without consulting the
   * open row the agent's retry raised in the meantime, and it does not take
   * the gate's lock. So dismiss → the agent tries the identical call → undo
   * still produces two open rows for one call shape, and the collapse never
   * sees it: both rows already existed when the undo landed.
   *
   * What happens next is NOT uniform, which is the whole reason these two
   * tests exist side by side. Where the first approval leaves the standing
   * authorisation in place, the index refuses the second out loud. Where the
   * first approval actually SENDS — the reversible unattended path, the one
   * this card's headline is about — `replayed_at` takes the row out of the
   * index, the second claim finds the slot free, and the call goes out again
   * with nothing refused and nothing said.
   *
   * Not closed here on purpose: doing so means either collapsing at approve
   * time or having `restore` decline to reopen over a colliding row, and both
   * are decisions about what undo MEANS. Filed as its own card.
   */
  it('RESIDUE: two open rows made by an undo double-execute a reversible call, silently', async () => {
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);

    const first = await holdAndId(h, routineCtx(h), CALL);
    await h.bus.call<unknown, DecisionsDismissOutput>('decisions:dismiss', userCtx(h), {
      decisionId: first,
      userId: 'u1',
    });
    // Dismissed is not open, so this is a genuinely new row.
    const second = await holdAndId(h, routineCtx(h), CALL);
    expect(second).not.toBe(first);

    const undone = await h.bus.call<unknown, DecisionsUndoOutput>('decisions:undo', userCtx(h), {
      decisionId: first,
      userId: 'u1',
    });
    expect(undone.undone).toBe(true);
    const open = await h.bus.call<unknown, DecisionsListOutput>('decisions:list', userCtx(h), {
      userId: 'u1',
      status: 'pending',
    });
    expect(open.decisions).toHaveLength(2);

    const a = await approve(h, userCtx(h), first);
    const b = await approve(h, userCtx(h), second);

    // TWICE. This is the true worst case, and it is the quiet one: no
    // `DuplicateAuthorisationError`, no refusal sentence, both rows reading
    // `executed`. If a later change closes this, THIS assertion is what
    // notices — flip it to 1 and delete the comment above it.
    expect(executor.calls).toHaveLength(2);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });

  it('RESIDUE: the same two rows on the ATTENDED path ARE refused out loud', async () => {
    // The contrasting half. Nothing has been sent when the second approval
    // arrives — the warm agent has not cashed the authorisation yet — so the
    // first row still occupies its (agent, fingerprint) slot and the index
    // does its job. This is the sub-case TASK-253 made audible.
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);

    const first = await holdAndId(h, userCtx(h), CALL);
    await h.bus.call<unknown, DecisionsDismissOutput>('decisions:dismiss', userCtx(h), {
      decisionId: first,
      userId: 'u1',
    });
    const second = await holdAndId(h, userCtx(h), CALL);
    expect(second).not.toBe(first);
    expect(
      (
        await h.bus.call<unknown, DecisionsUndoOutput>('decisions:undo', userCtx(h), {
          decisionId: first,
          userId: 'u1',
        })
      ).undone,
    ).toBe(true);

    const a = await approve(h, userCtx(h), first);
    expect(a.error).toBeNull();
    const b = await approve(h, userCtx(h), second);

    // Refused, and it SAYS so — the person is told, and the row stays open
    // rather than reading as answered.
    expect(b.error).toBe(CLAIM_REFUSED_DETAIL);
    expect(b.decision!.status).toBe('pending');
    // The host ran nothing on either: attended both times.
    expect(executor.calls).toHaveLength(0);
  });

  it('gives the human a fresh question after they said no, and it sends nothing until they say yes', async () => {
    // The collapse keys on the OPEN statuses only. A dismissal is an answer, so
    // an agent that tries again is asking something new — reviving the
    // dismissed row instead would put a "no" back on the queue as if the person
    // had never touched it.
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const first = await holdAndId(h, routineCtx(h), CALL);
    await h.bus.call<unknown, DecisionsDismissOutput>('decisions:dismiss', userCtx(h), {
      decisionId: first,
      userId: 'u1',
    });

    const second = await holdAndId(h, routineCtx(h), CALL);
    expect(second).not.toBe(first);
    expect(executor.calls).toHaveLength(0);

    const out = await approve(h, userCtx(h), second);
    expect(out.executed).toBe(true);
    expect(executor.calls).toHaveLength(1);
  });

  it('answers a reused question under the thread that RAISED it, not the one that reused it', async () => {
    // The collapse has no conversation in its key, so a hold raised on a
    // routine's thread can be reused by a live web thread — and the row's
    // ATTENDANCE came from the first thread. Approval routes on that stored
    // value, so the host replays and the warm agent watching the second thread
    // is never told its call went through.
    //
    // The call still runs exactly once and the person still sees exactly one
    // card on the Today queue, so nothing is lost or doubled; what is lost is
    // the narration in the second thread. It degrades in the direction
    // `attendance.ts` argues for — the host doing the work is the recoverable
    // mistake — and it is the price of keying the collapse the same way the
    // authorisation is keyed.
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);

    const first = await holdAndId(h, routineCtx(h), CALL);
    const second = await holdAndId(h, userCtx(h), CALL);
    expect(second).toBe(first);
    expect((await readDecision(h, userCtx(h), first)).conversationId).toBe('conv-tick');
    expect((await readDecision(h, userCtx(h), first)).attendance).toBe('unattended');

    const out = await approve(h, userCtx(h), first);
    expect(out.path).toBe('host-replays');
    expect(executor.calls).toHaveLength(1);
    // Nobody was told. `conv-web`'s session is warm and gets nothing, because
    // the row it would be told about belongs to `conv-tick`.
    expect(h.delivered).toHaveLength(0);
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
    // And it left no host-replay trace behind. TASK-277 made this branch
    // conditional on a LIVE session lookup, so this pair is now also the guard
    // against over-correcting: a lookup that failed to see the warm session
    // would send this decision down the host path and stamp `replayedAt`.
    const row = await readDecision(h, ctx, id);
    expect(row.status).toBe('executed');
    expect(row.replayedAt).toBeNull();

    // The delivery landed on the session the runner is parked on.
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.sessionId).toBe('sess-warm');
    expect(h.delivered[0]!.entry.type).toBe('decision-resolved');
    expect(h.delivered[0]!.entry.decisionId).toBe(id);
    expect(h.delivered[0]!.entry.outcome).toBe('approved');
    // HOST-AUTHORED. The recorded call's input is model-authored and never
    // reaches a line the model reads back as instruction. Nor does the
    // decision id — the model never saw it in the hold note either, so it
    // has no use for it here.
    expect(h.delivered[0]!.entry.note).not.toContain(id);
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

  it('an attended decision whose session has since ended is replayed by the host', async () => {
    // TASK-277, THE REGRESSION. `attendance` is captured at hold time and
    // answers which CHANNEL opened the conversation — a web thread is
    // `attended` forever, including hours after its runner was reaped. Routing
    // the approval on that alone took the attended branch anyway: the row was
    // claimed `executed`, no replay was scheduled, the delivery found no
    // session and logged, and the call never happened. The person's yes was
    // silently consumed.
    //
    // What proves the fix is the EXECUTOR's call count. The row's status
    // reading `executed` is precisely the false signal this test exists to
    // catch, so it is never the evidence.
    const channels = liveChannels();
    const h = await boot({}, undefined, channels);
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);
    // Held while somebody was watching…
    expect((await readDecision(h, ctx, id)).attendance).toBe('attended');

    // …and then they walked away. The idle reaper took the session down long
    // before they came back and clicked Approve.
    channels['conv-web']!.activeSessionId = null;

    const out = await approve(h, ctx, id);

    // The host made the call — once, byte for byte, exactly what was on the
    // card.
    expect(executor.calls).toEqual([CALL]);
    expect(out.executed).toBe(true);
    expect(out.path).toBe('host-replays');
    expect(out.error).toBeNull();
    // Nothing was queued: there was no session to queue onto.
    expect(h.delivered).toEqual([]);

    const after = await readDecision(h, ctx, id);
    expect(after.replayedAt).not.toBeNull();
    // The host decided it was making this call BEFORE it claimed the row, so
    // the row closed to the agent's gate and to undo in the same statement. A
    // decision that only discovers the host is replaying it afterwards leaves a
    // window wide enough for a byte-identical agent call to spend the same yes.
    expect(after.replayClaimedAt).not.toBeNull();
    // The consume belongs to the agent-retry path. The host ran it, so nothing
    // is left standing at the gate…
    expect(after.consumedAt).toBeNull();
    // …and a later agent run cannot cash the same yes in a second time.
    const later = h.ctx({
      agentId: 'a1',
      userId: 'u1',
      conversationId: 'conv-web',
      sessionId: 's-much-later',
    });
    expect(isHold(await h.bus.fire('tool:pre-call', later, CALL))).toBe(true);
    expect(executor.calls).toHaveLength(1);
  });

  it('an idle-expired decision the host cannot replay parks, rather than reading executed', async () => {
    // The same dead session, but for `skill_propose` — `executesIn: 'sandbox'`,
    // so there is no `tool:execute:skill_propose` hook and no sandbox left to
    // run in. Nothing can run here whichever branch is taken, which is exactly
    // why the STATUS is the thing to assert: `executed` would be a claim that
    // the call went out, and `approved-pending-agent` is the honest answer that
    // the approval stands and the agent will perform it next time it runs.
    const channels = liveChannels();
    const h = await boot({}, undefined, channels);
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, SANDBOX_CALL);
    expect((await readDecision(h, ctx, id)).attendance).toBe('attended');
    channels['conv-web']!.activeSessionId = null;

    const out = await approve(h, ctx, id);
    expect(out.decision!.status).toBe('approved-pending-agent');
    expect(out.executed).toBe(false);
    expect(out.path).toBeNull();
    expect(h.delivered).toEqual([]);

    // And the receipt promises the future instead of claiming a send.
    const receipts = await readReceipts(h);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('pending-agent');
    expect(receipts[0]!.receipt).toContain('the next time it runs');

    // The approval is REAL and waits at the gate — `approved-pending-agent` is
    // one of the two AUTHORISING_STATUSES, and a status the host chose for a
    // person's yes had better still be worth something. The next time that
    // agent runs, its call goes through…
    expect((await h.bus.fire('tool:pre-call', ctx, SANDBOX_CALL)).rejected).toBe(false);
    // …exactly once.
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, SANDBOX_CALL))).toBe(true);
  });

  it('an idle-expired irreversible decision gets the undo window it was owed', async () => {
    // An irreversible call raised on a web thread never used to get a grace
    // period at all: the attended branch hands the decision straight back to
    // the agent, and nothing can hold a warm agent back for ten seconds. Once
    // the session is gone that reasoning no longer applies — the HOST is
    // making this call, so the host can wait.
    let clock = new Date('2026-08-21T09:00:00.000Z');
    const channels = liveChannels();
    const h = await boot({ now: () => clock }, { rules: IRREVERSIBLE_RULES }, channels);
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);
    channels['conv-web']!.activeSessionId = null;

    const out = await approve(h, ctx, id);
    expect(out.path).toBe('host-replays');
    expect(out.executed).toBe(false);
    expect(out.pendingUntil).not.toBeNull();
    expect(executor.calls).toEqual([]);

    const stored = await readDecision(h, ctx, id);
    expect(stored.replayDueAt).toBe(out.pendingUntil);
    expect(Date.parse(stored.replayDueAt!) - Date.parse(stored.resolvedAt!)).toBe(
      UNDO_WINDOW_MS,
    );

    // "Not yet" and "never" look identical until the window closes, so the
    // sweep is the half of this test that carries it.
    clock = new Date(clock.getTime() + UNDO_WINDOW_MS + 1);
    const swept = await h.bus.call<unknown, DecisionsSweepOutput>(
      'decisions:sweep',
      ctx,
      {},
    );
    expect(swept.replayed).toBe(1);
    expect(executor.calls).toEqual([CALL]);
  });

  it('a session that dies between the liveness read and the queue falls back to the replay', async () => {
    // The millisecond the live read cannot close. The session is there when we
    // look and gone when we queue, so `session:queue-work` answers
    // `unknown-session`. The agent was NOT told, so the host must not assume it
    // was — and the fallback has to be loud, because a discarded delivery
    // result is what TASK-277 was in the first place.
    const lines: string[] = [];
    const h = await boot({}, undefined, liveChannels(), { throws: 'unknown-session' });
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const id = await holdAndId(h, userCtx(h), CALL);
    const approver = h.ctx({
      agentId: 'a1',
      userId: 'u1',
      conversationId: 'conv-web',
      sessionId: 's1',
      logger: createLogger({ reqId: 'req-approve', writer: (line) => lines.push(line) }),
    });

    const out = await approve(h, approver, id);
    expect(executor.calls).toEqual([CALL]);
    expect(out.executed).toBe(true);
    expect(out.path).toBe('host-replays');
    expect(lines.join('\n')).toContain('decision_delivery_fell_back_to_replay');

    const after = await readDecision(h, userCtx(h), id);
    expect(after.replayedAt).not.toBeNull();
    // One approval, one execution: the fallback replay spent the yes.
    expect(isHold(await h.bus.fire('tool:pre-call', userCtx(h), CALL))).toBe(true);
    expect(executor.calls).toHaveLength(1);
  });

  it('the fallback parks a sandbox-only tool rather than leaving the row reading executed', async () => {
    // The fallback's SECOND landing. The delivery failed, so the host takes
    // over — and then finds it cannot make this call either, because
    // `skill_propose` runs in the sandbox and the turn is over.
    //
    // The row has already been claimed `executed` by the time we get here: the
    // attended branch had no reason to check for an executor, since it was not
    // expecting to make the call itself. So this is the one path where
    // `executed` is written and then walked back, and the assertion that
    // matters is that it IS walked back.
    const h = await boot({}, undefined, liveChannels(), { throws: 'unknown-session' });
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, SANDBOX_CALL);

    const out = await approve(h, ctx, id);
    expect(out.executed).toBe(false);
    expect(out.path).toBeNull();
    expect(out.error).toBeNull();
    expect(out.decision!.status).toBe('approved-pending-agent');
    expect((await readDecision(h, ctx, id)).status).toBe('approved-pending-agent');

    // "Approved — it will do this the next time it runs", never "Sent".
    const receipts = await readReceipts(h);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('pending-agent');
    expect(receipts[0]!.receipt).toContain('the next time it runs');

    // And the yes is still there to be cashed in, once.
    expect((await h.bus.fire('tool:pre-call', ctx, SANDBOX_CALL)).rejected).toBe(false);
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, SANDBOX_CALL))).toBe(true);
  });

  it('the fallback records a THROWN replay as failed and drops the authorisation', async () => {
    // The fallback's THIRD landing. H1: an action that did not happen must not
    // leave a trace saying it did — and must not leave a standing yes behind
    // either, or the agent quietly inherits an approval for something that
    // failed.
    const h = await boot({}, undefined, liveChannels(), { throws: 'unknown-session' });
    recordExecutor(h, HOLD_RULE.match.tool, { throws: 'upstream 503' });
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);
    const stored = await readDecision(h, ctx, id);

    const out = await approve(h, ctx, id);
    expect(out.executed).toBe(false);
    expect(out.path).toBeNull();
    expect(out.error).not.toBeNull();
    expect(out.error).toContain('upstream 503');

    const after = await readDecision(h, ctx, id);
    expect(after.status).toBe('failed');
    expect(after.replayError).toContain('upstream 503');
    expect(after.replayedAt).toBeNull();

    const receipts = await readReceipts(h);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('failed');
    // The authored failure line — never the approved one, never the executor's
    // own message, which can quote model-authored input back at us.
    expect(receipts[0]!.receipt).not.toContain(stored.approvedText);
    expect(receipts[0]!.receipt).not.toContain('upstream 503');

    // Nothing left standing at the gate.
    expect(isHold(await h.bus.fire('tool:pre-call', ctx, CALL))).toBe(true);
  });

  it('never reports "undone" for a call the fallback replay has already made', async () => {
    // THE WINDOW THE FALLBACK OPENED, and the reason it is worth a test of its
    // own: the attended branch claims with `replayClaimedAt` null, because at
    // claim time it expects the warm agent to make the call. When the delivery
    // then fails and the host takes over, the row sat `executed` with both
    // `replay_claimed_at` and `replayed_at` null — exactly what `restore`
    // accepts — for the whole duration of the host tool. An undo landing there
    // answered `undone: true` — telling the person it was taken back — while
    // the call was already going out, and `markReplayed` then wrote `executed`
    // back over the person who thought they had stopped it.
    //
    // Undo needs no warm agent, which is what the first version of this branch
    // failed to consider. It is a person and a button.
    const h = await boot({}, undefined, liveChannels(), { throws: 'unknown-session' });
    const ctx = userCtx(h);
    const calls: ToolCall[] = [];
    let id = '';
    let undoInside: DecisionsUndoOutput | undefined;

    // The person hits Undo mid-flight — inside the host tool, which is the only
    // instant that can distinguish the guard from its absence.
    h.bus.registerService<ToolCall, unknown>(
      `tool:execute:${HOLD_RULE.match.tool}`,
      '@ax/decisions/test/slow-host-tool',
      async (_c, call) => {
        calls.push(call);
        undoInside = await h.bus.call<unknown, DecisionsUndoOutput>('decisions:undo', ctx, {
          decisionId: id,
          userId: 'u1',
        });
        return { ok: true };
      },
    );

    id = await holdAndId(h, ctx, CALL);
    const out = await approve(h, ctx, id);

    // THE INVARIANT, stated as one expression so it cannot be satisfied by
    // reading half of it: it must never be true both that the person was told
    // the approval was taken back AND that the call went out. Either undo is
    // refused, or nothing was ever sent.
    expect(undoInside!.undone && calls.length === 1).toBe(false);

    // Which way it resolves here: the host had already taken the flight, so
    // undo is refused and says so.
    expect(calls).toHaveLength(1);
    expect(undoInside!.undone).toBe(false);
    expect(undoInside!.decision!.status).toBe('executed');
    expect(out.executed).toBe(true);

    // The row is what a reader sees, and it says the call went out. There is
    // no separate retraction anybody could have written over it.
    expect((await readReceipts(h)).map((r) => r.outcome)).toEqual(['executed']);

    const after = await readDecision(h, ctx, id);
    expect(after.status).toBe('executed');
    expect(after.replayedAt).not.toBeNull();
    // The flight was taken BEFORE the call, not stamped after it.
    expect(after.replayClaimedAt).not.toBeNull();
    expect(Date.parse(after.replayClaimedAt!)).toBeLessThanOrEqual(
      Date.parse(after.replayedAt!),
    );
  });

  it('an attended decision whose conversation cannot be read at approve time still runs', async () => {
    // The fail-safe, on the approve side this time. The conversation was
    // deleted, or the store is unreachable, or this host has no conversations
    // plugin at all — `conversationChannel` answers null for every one of them,
    // and null is not "somebody is there". Unattended is the recoverable
    // reading: the host replays and the call still happens.
    const channels = liveChannels();
    const h = await boot({}, undefined, channels);
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);
    expect((await readDecision(h, ctx, id)).attendance).toBe('attended');

    delete channels['conv-web'];

    const out = await approve(h, ctx, id);
    expect(executor.calls).toEqual([CALL]);
    expect(out.executed).toBe(true);
    expect(out.path).toBe('host-replays');
    expect(h.delivered).toEqual([]);
  });
});

/**
 * A decision drafted at 7am and approved at 1pm may be approving a world that
 * no longer exists (design §3.4, AW-7).
 *
 * `world` below is a mutable box the test moves BETWEEN the hold and the
 * approval. That is the whole scenario, and it is why these live in the canary
 * rather than beside the pure machine: the machine already knows what to do
 * with a moved predicate — what has to be proved here is that a real hold
 * really captures one, a real approval really re-reads it, and a tripped guard
 * really stops the host executor from running.
 */
interface FreshWorld {
  value: string;
  changed?: string;
  captureThrows?: boolean;
  checkThrows?: boolean;
}

const FRESH_LABEL = "Priya's thread, last message 8:41 AM";

function freshnessProducer(h: TestHarness, toolName: string, world: FreshWorld): void {
  h.bus.registerService(
    `tool-freshness:capture:${toolName}`,
    '@ax/decisions/test/freshness',
    async () => {
      if (world.captureThrows === true) throw new Error('the mailbox is unreachable');
      return {
        predicate: { kind: 'thread-head', value: world.value, label: FRESH_LABEL },
      };
    },
  );
  h.bus.registerService(
    `tool-freshness:check:${toolName}`,
    '@ax/decisions/test/freshness',
    async () => {
      if (world.checkThrows === true) throw new Error('the mailbox is unreachable');
      return world.changed === undefined
        ? { value: world.value }
        : { value: world.value, changed: world.changed };
    },
  );
}

describe('decisions canary — the freshness guard', () => {
  it('captures a predicate at hold time and executes when the world has not moved', async () => {
    const h = await boot();
    const world: FreshWorld = { value: 'msg-8841' };
    freshnessProducer(h, HOLD_RULE.match.tool, world);
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = routineCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    // The row carries what the tool captured, and the clause a human reads.
    const held = await readDecision(h, ctx, id);
    expect(held.freshness).toEqual({
      kind: 'thread-head',
      value: 'msg-8841',
      label: FRESH_LABEL,
    });

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(true);
    expect(executor.calls).toEqual([CALL]);
  });

  it('re-opens instead of executing when the predicate moved', async () => {
    const h = await boot();
    const world: FreshWorld = { value: 'msg-8841' };
    freshnessProducer(h, HOLD_RULE.match.tool, world);
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = routineCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    // Six hours pass. Priya replies again.
    world.value = 'msg-9002';
    world.changed = 'Priya replied again after this was drafted.';

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(false);
    expect(out.decision!.status).toBe('stale');
    expect(out.decision!.staleReason).toBe('Priya replied again after this was drafted.');
    // NOTHING ran. That is the entire point of the guard.
    expect(executor.calls).toEqual([]);
    // And the row says so durably, not just in this response.
    expect((await readDecision(h, ctx, id)).status).toBe('stale');
  });

  it('drops the "checked against" clause on a stale row', async () => {
    // The clause describes hold-time and is FALSE once the guard has tripped.
    // Repeating it under an alert saying the opposite is worse than silence.
    const h = await boot();
    const world: FreshWorld = { value: 'msg-8841' };
    freshnessProducer(h, HOLD_RULE.match.tool, world);
    recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = routineCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    world.value = 'msg-9002';
    const { decision } = await approve(h, userCtx(h), id);
    expect(decision!.freshness!.label).toBeNull();
    // The predicate itself SURVIVES, re-captured at the new value — dropping
    // the sentence is not dropping the guard.
    expect(decision!.freshness!.value).toBe('msg-9002');
  });

  it('re-captures so a second approval proceeds', async () => {
    // Annoying but honest, once. A guard that could never be satisfied would
    // be a decision nobody can ever act on.
    const h = await boot();
    const world: FreshWorld = { value: 'msg-8841' };
    freshnessProducer(h, HOLD_RULE.match.tool, world);
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = routineCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    world.value = 'msg-9002';
    const first = await approve(h, userCtx(h), id);
    expect(first.executed).toBe(false);

    // The human looked at the new state and said yes anyway.
    const second = await approve(h, userCtx(h), id);
    expect(second.executed).toBe(true);
    expect(second.decision!.status).toBe('executed');
    expect(executor.calls).toEqual([CALL]);
  });

  it('executes with no guard when the tool produced no predicate', async () => {
    // No producer at all — the overwhelmingly common case, and the designed
    // one. An unguarded row claims nothing and runs on approval.
    const h = await boot();
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = routineCtx(h);
    const id = await holdAndId(h, ctx, CALL);
    expect((await readDecision(h, ctx, id)).freshness).toBeNull();

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(true);
    expect(executor.calls).toEqual([CALL]);
  });

  it('treats a check that THROWS as changed — an unreadable world is a changed world', async () => {
    const h = await boot();
    const world: FreshWorld = { value: 'msg-8841' };
    freshnessProducer(h, HOLD_RULE.match.tool, world);
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = routineCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    world.checkThrows = true;
    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(false);
    expect(out.decision!.status).toBe('stale');
    expect(out.decision!.staleReason).toMatch(/could not re-check/i);
    expect(executor.calls).toEqual([]);

    // Still broken on the second click — and the human, having been told once,
    // gets to proceed rather than bounce forever.
    const second = await approve(h, userCtx(h), id);
    expect(second.executed).toBe(true);
    expect(executor.calls).toEqual([CALL]);
  });

  it('leaves the row UNGUARDED when capture throws, rather than turning the hold into a deny', async () => {
    // The other asymmetry. Capture runs inside the pre-call gate, whose catch
    // turns a throw into a REJECT — so a broken producer must not be allowed
    // to propagate, or one tool takes the whole approval surface down.
    const h = await boot();
    const world: FreshWorld = { value: 'msg-8841', captureThrows: true };
    freshnessProducer(h, HOLD_RULE.match.tool, world);
    const executor = recordExecutor(h, HOLD_RULE.match.tool);
    const ctx = routineCtx(h);

    // Still a HOLD, not a deny.
    const id = await holdAndId(h, ctx, CALL);
    // And the row claims nothing: no predicate means no "checked against…".
    expect((await readDecision(h, ctx, id)).freshness).toBeNull();

    const out = await approve(h, userCtx(h), id);
    expect(out.executed).toBe(true);
    expect(executor.calls).toEqual([CALL]);
  });

  it('guards the ATTENDED path too, and hands nothing to the warm agent', async () => {
    // Attended staleness is a seconds-long risk rather than an hours-long one,
    // but the guard is not special-cased away: a moved predicate stops the
    // approval BEFORE the resolution is delivered, so the agent is never told
    // to go ahead with something the human would not have approved.
    const h = await boot();
    const world: FreshWorld = { value: 'msg-8841' };
    freshnessProducer(h, HOLD_RULE.match.tool, world);
    const ctx = userCtx(h);
    const id = await holdAndId(h, ctx, CALL);

    world.value = 'msg-9002';
    const out = await approve(h, ctx, id);
    expect(out.decision!.status).toBe('stale');
    expect(out.path).toBeNull();
    expect(h.delivered).toEqual([]);
  });
});

/**
 * TASK-253 — the host dies with a call already on its way out.
 *
 * Every host replay is bracketed by two writes: one that TAKES the flight
 * (`replay_claimed_at`) and one that records what happened (`markReplayed`,
 * `markFailed`, `parkForAgent`). Claim first, then act, is deliberate — acting
 * first would leave an action that happened behind a row that says it did not.
 * The cost is the window between them, and a host that dies inside it leaves a
 * row that is `executed`, claimed, and un-replayed forever: nothing retries it,
 * nothing consumes it, undo refuses it, and it goes on occupying its
 * `(agent, fingerprint)` slot in the partial unique index — so approving the
 * same call again collides and, before this card, was absorbed in silence.
 *
 * The crash is simulated by CRASHING, not by mocking the store: a host executor
 * that never returns, an approval nobody waits for, and then the whole harness
 * torn down with the call still out. The row the next host reads is the one a
 * real `SIGKILL` would have left, written by the real claim.
 */
describe('decisions canary — a replay stranded by a host crash', () => {
  /** When the host that dies takes the flight. */
  const T_CRASH = new Date('2026-08-21T09:00:00.000Z');
  /**
   * The next host's clock, well past any flight the bus could still be holding
   * open — `HookBus` bounds every service call at 120 s by default, so an hour
   * is not a guess about how long a tool takes, it is a bound plus room.
   */
  const T_RECOVERED = new Date(T_CRASH.getTime() + 60 * 60_000);
  /** A minute after the crash: too soon to say the flight is not still running. */
  const T_TOO_SOON = new Date(T_CRASH.getTime() + 60_000);

  /**
   * A host executor that takes the call and NEVER answers.
   *
   * It is never released, on purpose. Releasing it would run the settle writes
   * against a torn-down harness, which is not what a crashed process does — a
   * crashed process's in-flight call is simply gone. The pending promise is
   * garbage the moment the harness is closed.
   */
  function hangingExecutor(h: TestHarness, toolName: string): { calls: ToolCall[] } {
    const calls: ToolCall[] = [];
    h.bus.registerService<ToolCall, unknown>(
      `tool:execute:${toolName}`,
      '@ax/decisions/test/hanging-tool',
      async (_ctx, call) => {
        calls.push(call);
        return new Promise<never>(() => {});
      },
    );
    return { calls };
  }

  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  function sweep(h: TestHarness): Promise<DecisionsSweepOutput> {
    return h.bus.call<unknown, DecisionsSweepOutput>('decisions:sweep', routineCtx(h), {});
  }

  /**
   * Hold, approve, let the host take the flight — then kill it.
   *
   * `attended` picks WHICH of the two entry points takes the flight. Both end
   * at the same row shape and both have to be recoverable:
   *
   *   * unattended + a host executor + reversible — `claimForApproval` stamps
   *     the flight in the claim itself (the `immediate` path);
   *   * attended, with the session queue refusing — the row is claimed with no
   *     flight, the delivery fails, and `claimReplayFlight` takes it afterwards
   *     (TASK-277's fallback, which did not exist when this card was written).
   */
  async function strandOnACrash(attended: boolean): Promise<string> {
    const dead = attended
      ? await boot({ now: () => T_CRASH }, undefined, liveChannels(), {
          throws: 'the session ended under us',
        })
      : await boot({ now: () => T_CRASH });
    const ctx = attended ? userCtx(dead) : routineCtx(dead);
    const hung = hangingExecutor(dead, HOLD_RULE.match.tool);

    const id = await holdAndId(dead, ctx, CALL);
    // Nobody awaits this: the host is about to die underneath it.
    void approve(dead, ctx, id).catch(() => {});
    await waitFor(() => hung.calls.length === 1, 'the host to take the flight');

    // The shape a crash leaves, read back off the real row before we pull the
    // plug. Asserting it here is what makes the recovery below a test of
    // recovery rather than of a fixture somebody wrote by hand.
    const stranded = await readDecision(dead, ctx, id);
    expect(stranded.status).toBe('executed');
    expect(stranded.replayClaimedAt).not.toBeNull();
    expect(stranded.replayedAt).toBeNull();
    expect(stranded.consumedAt).toBeNull();

    // THE CRASH.
    await harnesses.pop()!.close({ onError: () => {} });
    return id;
  }

  it('recovers a flight the immediate path took and never came back from', async () => {
    const id = await strandOnACrash(false);

    const h = await boot({ now: () => T_RECOVERED });
    const exec = recordExecutor(h, HOLD_RULE.match.tool);
    expect((await sweep(h)).reclaimed).toBe(1);

    // THE ASSERTION THAT MATTERS. The reclaim does not re-run the call and
    // cannot: a status is a claim about what happened, and this epic keeps
    // producing rows that read `executed` with nothing behind them. The
    // executor's invocation count is the only thing that cannot be faked.
    expect(exec.calls).toEqual([]);

    const row = await readDecision(h, routineCtx(h), id);
    expect(row.status).toBe('failed');
    expect(row.replayAbandonedAt).not.toBeNull();
    expect(row.replayedAt).toBeNull();

    // And the receipt does not tell the person something we cannot know. The
    // crash could have landed either side of the tool's own side effect, so
    // "Nothing was completed" — the ordinary failure line — would be a claim we
    // have no standing to make.
    const receipts = await readReceipts(h);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('failed');
    expect(receipts[0]!.receipt).not.toContain('Nothing was completed');
  });

  it("recovers a flight the ATTENDED fallback took and never came back from", async () => {
    const id = await strandOnACrash(true);

    const h = await boot({ now: () => T_RECOVERED });
    const exec = recordExecutor(h, HOLD_RULE.match.tool);
    expect((await sweep(h)).reclaimed).toBe(1);
    expect(exec.calls).toEqual([]);
    expect((await readDecision(h, userCtx(h), id)).status).toBe('failed');
  });

  it('leaves a flight alone while it could still be running, and says so out loud', async () => {
    // The other half of the acceptance: BEFORE recovery, re-approving must not
    // be a silent no-op either. It cannot succeed — the stranded row still
    // holds the standing authorisation, and taking it away from a flight that
    // might genuinely still be in progress is how one approval becomes two
    // sends — so it has to fail, and be seen to.
    await strandOnACrash(false);

    const h = await boot({ now: () => T_TOO_SOON });
    const exec = recordExecutor(h, HOLD_RULE.match.tool);
    // A minute is not long enough to conclude anything. Nothing is reclaimed.
    expect((await sweep(h)).reclaimed).toBe(0);

    // The agent asks again; the person says yes again.
    const second = await holdAndId(h, routineCtx(h), CALL);
    const out = await approve(h, routineCtx(h), second);

    expect(exec.calls).toEqual([]);
    expect(out.executed).toBe(false);
    // THE BUG: this used to come back with `error: null` and a row still
    // reading `pending` — a button that did nothing and said nothing.
    expect(out.error).not.toBeNull();
    expect(out.decision!.status).toBe('pending');
  });

  it('lets the same call be approved again — and actually run — once it is recovered', async () => {
    await strandOnACrash(false);

    const h = await boot({ now: () => T_RECOVERED });
    const exec = recordExecutor(h, HOLD_RULE.match.tool);
    expect((await sweep(h)).reclaimed).toBe(1);
    expect(exec.calls).toEqual([]);

    // The slot is free, so the second approval is a real one.
    const second = await holdAndId(h, routineCtx(h), CALL);
    const out = await approve(h, routineCtx(h), second);
    expect(out.executed).toBe(true);
    expect(out.path).toBe('host-replays');
    expect(out.error).toBeNull();
    // ONCE. Not the reclaim plus this one.
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]).toEqual(CALL);
  });

  it('reports a TRANSIENT write failure as a fault, never as "already approved"', async () => {
    // The refusal branch this card added says something specific — an
    // identical request is already approved and has not been carried out —
    // and for a while it said it for EVERY way the claim could throw.
    //
    // Under the turbulence this whole feature exists for (eviction, failover,
    // load) that write can fail with a deadlock or a lock timeout, and those
    // are gone by the time the handler re-reads the row. The person would be
    // told their approval was not recorded because an identical one is
    // pending, and the correct recovery — press it again — is exactly what
    // that sentence talks them out of. A confident sentence about a cause
    // nobody checked is this epic's signature defect wearing our own uniform.
    //
    // Simulated with a trigger that raises a real `40P01`, so the store sees
    // the driver error a genuine deadlock produces. Nothing is mocked.
    const h = await boot({ now: () => T_CRASH });
    const exec = recordExecutor(h, HOLD_RULE.match.tool);
    const id = await holdAndId(h, routineCtx(h), CALL);

    const client = new pg.Client({ connectionString });
    await client.connect();
    let thrown: unknown;
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION decisions_v1_canary_boom() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END;
        $$ LANGUAGE plpgsql
      `);
      await client.query(`
        CREATE TRIGGER decisions_v1_canary_boom_trg
          BEFORE UPDATE ON decisions_v1_decisions
          FOR EACH ROW WHEN (NEW.status = 'executed')
          EXECUTE FUNCTION decisions_v1_canary_boom()
      `);
      thrown = await approve(h, routineCtx(h), id).then(
        () => null,
        (err: unknown) => err,
      );
    } finally {
      await client
        .query('DROP TRIGGER IF EXISTS decisions_v1_canary_boom_trg ON decisions_v1_decisions')
        .catch(() => {});
      await client.end().catch(() => {});
    }

    // It must FAIL, not resolve. Before the fix it resolved with the standing
    // authorisation sentence, so `thrown` was null here.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('deadlock detected');
    expect((thrown as Error).message).not.toContain(CLAIM_REFUSED_DETAIL);

    // And the decision is still an open question with nothing run, which is
    // what makes pressing approve again the right recovery.
    expect(exec.calls).toEqual([]);
    expect((await readDecision(h, routineCtx(h), id)).status).toBe('pending');
  });

  it('never reclaims a row that is not in flight at all, however long it sits', async () => {
    // The counter-control, and the one that would hurt most if it broke. An
    // ATTENDED approval waits for its warm agent with no flight and no clock —
    // `approved-pending-agent` waits the same way. Both are live standing
    // authorisations. Failing one because it is old would cancel a yes nobody
    // withdrew.
    const h = await boot({ now: () => T_CRASH });
    const waiting = await holdAndId(h, userCtx(h), CALL);
    expect((await approve(h, userCtx(h), waiting)).path).toBe('agent-executes');

    const parked = await holdAndId(h, routineCtx(h), SANDBOX_CALL);
    expect((await approve(h, routineCtx(h), parked)).decision!.status).toBe(
      'approved-pending-agent',
    );

    const later = await boot({ now: () => T_RECOVERED });
    expect((await sweep(later)).reclaimed).toBe(0);
    expect((await readDecision(later, userCtx(later), waiting)).status).toBe('executed');
    expect((await readDecision(later, routineCtx(later), parked)).status).toBe(
      'approved-pending-agent',
    );
  });
});

// ---------------------------------------------------------------------------
// TASK-266. The rail's counter, as ONE question.
//
// The number the workspace rail draws is "decisions this agent raised for you
// in the last 7 days, whatever you decided — including the ones that expired".
// `decisions:list` takes one exact status, so answering that meant walking all
// seven — and every one of those reads swept the expiry table before it
// answered. Seven table writes to draw one integer, on every render.
// ---------------------------------------------------------------------------
describe('decisions canary — counting a window', () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** The instant these tests pretend it is, so the window has a real edge. */
  const T_ASKED = new Date('2026-08-21T12:00:00.000Z');

  /** A second held call. A DIFFERENT input, so the gate does not collapse it
   * into the first (TASK-254 keys the collapse on the call's fingerprint). */
  function otherCall(id: string, to: string): ToolCall {
    return { id, name: HOLD_RULE.match.tool, input: { to } };
  }

  function countFor(
    h: TestHarness,
    input: Partial<DecisionsCountInput> & { since: string },
  ): Promise<DecisionsCountOutput> {
    return h.bus.call<DecisionsCountInput, DecisionsCountOutput>(
      'decisions:count',
      userCtx(h),
      { userId: 'u1', agentId: 'a1', ...input },
    );
  }

  it('counts what this agent raised in the window, whatever became of it', async () => {
    let clock = new Date(T_ASKED.getTime() - 8 * DAY);
    // A TTL long enough that nothing here expires on its own — this test is
    // about the WINDOW, and an expiry firing inside it would be a second
    // variable.
    const h = await boot({ now: () => clock, ttlMs: 30 * DAY });

    const tooOld = await holdAndId(h, userCtx(h), otherCall('c-old', 'old@b.c'));
    clock = new Date(T_ASKED.getTime() - 2 * DAY);
    const answered = await holdAndId(h, userCtx(h), otherCall('c-answered', 'yes@b.c'));
    clock = new Date(T_ASKED.getTime() - 1 * DAY);
    const open = await holdAndId(h, userCtx(h), otherCall('c-open', 'open@b.c'));

    await h.bus.call<unknown, DecisionsDismissOutput>('decisions:dismiss', userCtx(h), {
      decisionId: answered,
      userId: 'u1',
    });

    clock = T_ASKED;
    const since = new Date(T_ASKED.getTime() - 7 * DAY).toISOString();
    // Two: the one still waiting and the one already turned down. A dismissal
    // is still a time this agent stopped and asked, which is what the shipped
    // sentence promises to count.
    expect((await countFor(h, { since })).count).toBe(2);
    // The eight-day-old one is out, and it is out because of WHEN it was
    // raised, not what became of it — it is `pending`, exactly like `open`.
    expect((await readDecision(h, userCtx(h), tooOld)).status).toBe('pending');
    expect((await readDecision(h, userCtx(h), open)).status).toBe('pending');
  });

  it('a count expires nothing — asking for a number changes no row', async () => {
    // WHERE THE SWEEP LIVES, after this card. It rides `decisions:list` (still
    // — TASK-246 is its own card) and the maintenance timer, and it does NOT
    // ride the counter. The count is invariant under it: expiry rewrites a
    // status, and a count over a `createdAt` window naming no status cannot
    // see the difference. So the worst case of not sweeping here is a number
    // that is correct.
    const h = await boot({ ttlMs: 0 });
    const id = await holdAndId(h, routineCtx(h), CALL);
    const since = new Date(Date.now() - 7 * DAY).toISOString();

    expect((await countFor(h, { since })).count).toBe(1);
    // Past its TTL and still pending: the count did not sweep on its way past.
    expect((await readDecision(h, userCtx(h), id)).status).toBe('pending');

    // The queue read still does, which is the half this card deliberately
    // leaves alone — a pending card that has actually expired is a button that
    // lies, and that surface is where it matters.
    await h.bus.call<unknown, DecisionsListOutput>('decisions:list', userCtx(h), {
      userId: 'u1',
    });
    expect((await readDecision(h, userCtx(h), id)).status).toBe('expired');

    // And the number did not move when the row's status did.
    expect((await countFor(h, { since })).count).toBe(1);
  });

  it('counts one person\'s questions — a team-mate on the same agent gets zero', async () => {
    // The same rule `decisions:list` and `decisions:get` enforce. Reaching a
    // shared agent is not being entitled to know what it asked somebody else.
    const h = await boot();
    await holdAndId(h, userCtx(h), CALL);
    const since = new Date(Date.now() - 7 * DAY).toISOString();

    expect((await countFor(h, { since })).count).toBe(1);
    expect((await countFor(h, { since, userId: 'u2' })).count).toBe(0);
  });

  it('refuses a window it cannot read, rather than handing it to the database', async () => {
    const h = await boot();
    await expect(countFor(h, { since: 'last tuesday' })).rejects.toThrow(/since/);
    await expect(countFor(h, { since: '' })).rejects.toThrow(/since/);
  });
});
