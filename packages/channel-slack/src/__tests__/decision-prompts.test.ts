import { HookBus, PluginError, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findHeldDecision } from '../decision-prompts.js';

/*
  Which decision a held call is (decision-prompts.ts `findHeldDecision`). A
  held tool result names only its call, so the turn reads its conversation's
  decisions from @ax/decisions and takes the PENDING one whose recorded call
  has that id. Everything else is "no prompt": the reply keeps the Today
  link. The lookup never rejects, has a deadline, and logs codes only.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
/** The held call's id, as the runner's held tool result names it. */
const CALL_ID = 'toolu_01HELD';
/** A decision's host-authored summary (decisions/src/templates.ts). */
const SUMMARY = 'Wants to gain access to a new service or key';
const TIMEOUT_MS = 5_000;

/** Mel's attended turn in #support: the ctx the turn runs (and looks up) under. */
function turnCtx(logger: Logger): AgentContext {
  return makeAgentContext({
    sessionId: 'sess_turn',
    reqId: 'req-turn-0001',
    agentId: 'agt_support',
    userId: 'usr_mel',
    conversationId: 'conv_mel_support',
    source: 'user',
    audience: 'shared',
    logger,
  });
}

const QUERY = {
  userId: 'usr_mel',
  agentId: 'agt_support',
  conversationId: 'conv_mel_support',
  toolCallId: CALL_ID,
};

/**
 * A decision as `decisions:recent-for-conversation` answers one
 * (decisions/src/types.ts `DecisionSchema`): every field, a pending hold of
 * CALL_ID unless `over` says otherwise.
 */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dec_held',
    agentId: 'agt_support',
    ownerUserId: 'usr_mel',
    conversationId: 'conv_mel_support',
    kind: 'action',
    attendance: 'attended',
    status: 'pending',
    call: { id: CALL_ID, name: 'request_capability', input: { capability: 'calendar' } },
    callFingerprint: 'a'.repeat(64),
    ruleId: 'request-capability',
    irreversible: false,
    freshness: null,
    summary: SUMMARY,
    detail: 'It stopped before doing this. Nothing has happened yet.',
    preview: null,
    primaryLabel: 'Yes, go ahead',
    secondaryLabel: 'Show me the details',
    ghostLabel: "No, I'll handle it",
    approvedText: 'Done.',
    dismissedText: 'You declined this. Nothing ran.',
    createdAt: '2026-11-14T12:00:00.000Z',
    expiresAt: '2026-11-15T12:00:00.000Z',
    resolvedAt: null,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    replayedAt: null,
    replayAbandonedAt: null,
    replayError: null,
    deliveryDueAt: null,
    deliveredAt: null,
    approvalScope: 'once',
    consentExpectedRevision: null,
    consentDeliveryState: 'none',
    consentGranted: null,
    consentDeliveryClaimedAt: null,
    routineReleaseAt: null,
    routineAuthorizationId: null,
    routineExecutionFingerprint: null,
    routineOutcome: null,
    routineFailureCode: null,
    routineFailureField: null,
    ...over,
  };
}

/** The same row, holding another call. */
const otherCall = (id: string, over: Record<string, unknown> = {}) =>
  row({ id, call: { id: `toolu_${id}`, name: 'mcp__gmail__send_email', input: {} }, ...over });

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function recordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  return { logger, lines };
}

/** A promise that never settles: a hung call. */
const never = (): Promise<never> => new Promise<never>(() => {});

/**
 * A bus with @ax/decisions' read on it, answering `answer` (by default
 * `{ decisions: rows }`), the way the real one guards it: only the turn's own
 * user and agent may read a conversation's decisions (decisions/src/plugin.ts).
 */
function decisions(o: { rows?: unknown[]; answer?: () => unknown; absent?: boolean } = {}) {
  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const asked: Array<{ ctx: AgentContext; input: unknown }> = [];
  if (o.absent !== true) {
    bus.registerService('decisions:recent-for-conversation', 'fake-decisions', async (ctx, input) => {
      asked.push({ ctx, input });
      const i = input as { userId: unknown; agentId: unknown };
      if (ctx.userId !== i.userId || ctx.agentId !== i.agentId) throw new Error('conversation decision scope mismatch');
      return o.answer !== undefined ? o.answer() : { decisions: o.rows ?? [] };
    });
  }
  const { logger, lines } = recordingLogger();
  const ctx = turnCtx(logger);
  return {
    asked,
    lines,
    ctx,
    find: (q: typeof QUERY = QUERY, log: Logger = logger) =>
      findHeldDecision(bus, ctx, q, TIMEOUT_MS, { installId: INSTALL_ID, logger: log }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── The tests ───────────────────────────────────────────────────────────────

describe("findHeldDecision: the held call's pending decision", () => {
  it('the pending decision whose recorded call is the held call: its id and its summary, as written', async () => {
    const d = decisions({ rows: [otherCall('dec_newer'), row(), otherCall('dec_older')] });
    expect(await d.find()).toEqual({ decisionId: 'dec_held', summary: SUMMARY });
    // Asked once, under the turn's own ctx, for exactly the turn's user, agent and conversation.
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]!.ctx).toBe(d.ctx);
    expect(d.asked[0]!.input).toEqual({ userId: 'usr_mel', agentId: 'agt_support', conversationId: 'conv_mel_support' });
    expect(d.lines).toEqual([]);
  });

  it.each(['executed', 'approved-pending-agent', 'dismissed', 'stale', 'expired', 'failed'])(
    'the call\'s decision is %s, not pending: no decision (nothing is left to answer)',
    async (status) => {
      const d = decisions({ rows: [row({ status })] });
      expect(await d.find()).toBeNull();
      expect(d.lines).toEqual([]);
    },
  );

  it('only other calls are pending: no decision', async () => {
    const d = decisions({ rows: [otherCall('dec_a'), otherCall('dec_b')] });
    expect(await d.find()).toBeNull();
  });

  it('a call answered once and held again: the pending decision, not the answered one', async () => {
    const d = decisions({ rows: [row({ id: 'dec_answered', status: 'dismissed' }), row({ id: 'dec_again' })] });
    expect(await d.find()).toEqual({ decisionId: 'dec_again', summary: SUMMARY });
  });

  it('nothing has been decided in the conversation: no decision', async () => {
    const d = decisions({ rows: [] });
    expect(await d.find()).toBeNull();
    expect(d.lines).toEqual([]);
  });

  it('a held result with no call id names no decision: nothing is asked', async () => {
    const d = decisions({ rows: [row({ call: { id: '', name: 'request_capability', input: {} } })] });
    expect(await d.find({ ...QUERY, toolCallId: '' })).toBeNull();
    expect(d.asked).toEqual([]);
  });

  it('no decisions service (a preset without @ax/decisions): no decision, and nothing logged', async () => {
    const d = decisions({ absent: true });
    expect(await d.find()).toBeNull();
    expect(d.lines).toEqual([]);
  });

  it('junk rows are skipped, never thrown on: the one readable pending row for the call is found', async () => {
    const d = decisions({
      rows: [
        null,
        7,
        'dec_held',
        [],
        {},
        row({ id: 7 }),
        row({ id: '' }),
        row({ id: null }),
        row({ summary: null }),
        row({ summary: 42 }),
        row({ status: undefined }),
        row({ status: 'PENDING' }),
        row({ call: null }),
        row({ call: CALL_ID }),
        row({ call: { id: 7 } }),
        row({ call: { name: 'request_capability' } }),
        row({ id: 'dec_readable' }),
      ],
    });
    expect(await d.find()).toEqual({ decisionId: 'dec_readable', summary: SUMMARY });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'dec_held'],
    ['an array', [row()]],
    ['an object without decisions', {}],
    ['decisions that is not an array', { decisions: row() }],
    ['decisions: null', { decisions: null }],
  ])('an answer that is %s: no decision, logged as unreadable', async (_name, answer) => {
    const d = decisions({ answer: () => answer });
    expect(await d.find()).toBeNull();
    expect(d.lines).toEqual([
      { level: 'warn', msg: 'slack_prompt_failed', fields: { installId: INSTALL_ID, stage: 'lookup', code: 'bad-response' } },
    ]);
  });

  it('the lookup fails: no decision, logged by its code only', async () => {
    const d = decisions({
      answer: () => {
        throw new PluginError({ code: 'store-unavailable', plugin: 'fake-decisions', message: 'db down: mel@canopyworks.com' });
      },
    });
    expect(await d.find()).toBeNull();
    expect(d.lines).toEqual([
      { level: 'warn', msg: 'slack_prompt_failed', fields: { installId: INSTALL_ID, stage: 'lookup', code: 'store-unavailable' } },
    ]);
    expect(JSON.stringify(d.lines)).not.toContain('mel@');
  });

  it('the lookup outlasts its deadline: no decision once the deadline passes, logged as a timeout', async () => {
    vi.useFakeTimers();
    const d = decisions({ answer: never });
    let settled = false;
    let found: unknown = 'not yet';
    void d.find().then((value) => {
      settled = true;
      found = value;
    });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(found).toBeNull();
    expect(d.lines).toEqual([
      { level: 'warn', msg: 'slack_prompt_failed', fields: { installId: INSTALL_ID, stage: 'lookup', code: 'timeout' } },
    ]);
  });

  it('a lookup answered in time leaves no timer behind', async () => {
    vi.useFakeTimers();
    const d = decisions({ rows: [row()] });
    expect(await d.find()).toEqual({ decisionId: 'dec_held', summary: SUMMARY });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never rejects: a failed lookup with a logger that throws is still no decision', async () => {
    const d = decisions({
      answer: () => {
        throw new Error('decisions exploded');
      },
    });
    const fail = (): never => {
      throw new Error('log down');
    };
    const throwing: Logger = { debug: fail, info: fail, warn: fail, error: fail, child: () => throwing };
    await expect(d.find(QUERY, throwing)).resolves.toBeNull();
  });
});
