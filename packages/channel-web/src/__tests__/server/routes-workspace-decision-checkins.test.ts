// @vitest-environment node
/**
 * Today names the task an approval was held in (TASK-932).
 *
 * An OPEN, unattended row held during one of the caller's own task check-ins
 * carries `checkIn: { routineId, taskName }`: on the list, and on the single
 * read or an answer that leaves the row open (the undo answer). A resolved
 * row's answers (approve, dismiss, the undo poll's re-reads) carry null and ask
 * routines nothing (TASK-933): `useDecisionQueue` keeps the label the row
 * already had. The routes ask `routines:tasks-for-conversations` once per
 * agent, as the caller, after the ACL, about open, unattended rows only, and in
 * batches of at most `ROUTINE_CHECKIN_LOOKUP_MAX_IDS`. The task name is fenced
 * to one line.
 *
 * It is a label, never an authorization. When the lookup fails, is absent or
 * is slow, the row carries `checkIn: null` and the queue answers anyway. The
 * list waits at most `DECISION_CHECKINS_LIST_DEADLINE_MS`, and one row at most
 * `DECISION_CHECKIN_ROW_DEADLINE_MS`. Approving is unchanged.
 *
 * `routines:tasks-for-conversations` here is a stub. It answers only for its
 * caller's own check-ins (the service's rule), checks its input with the
 * contract's schema through @ax/routines' own `parseRoutineInput`, and its
 * answer is checked against the contract's output schema on the bus, as in
 * production. So a batch the service would refuse fails here too.
 */
import { describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import {
  ROUTINE_CHECKIN_LOOKUP_MAX_IDS,
  RoutineTasksForConversationsInputSchema,
  RoutineTasksForConversationsOutputSchema,
} from '@ax/routines-contract';
import {
  DECISION_CHECKINS_LIST_DEADLINE_MS,
  DECISION_CHECKIN_ROW_DEADLINE_MS,
  makeWorkspaceHandlers,
  toWireDecision,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import type { Decision, DecisionCheckIn } from '../../lib/workspace-types.js';
import { parseRoutineInput } from '../../../../routines/src/services.js';

function mkReq(
  params: Record<string, string> = {},
  body?: unknown,
): RouteRequest {
  return {
    headers: {},
    body:
      body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf-8'),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(_s: string) {
      /* unused */
    },
    end() {
      /* unused */
    },
  };
  return { res, captured };
}

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

/**
 * The plugin-side row, as `decisions:list` and `decisions:get` hand it over:
 * the FULL row, `call` and all, the same shape `routes-workspace.test.ts` uses.
 */
interface StoredDecisionLike {
  id: string;
  agentId: string;
  ownerUserId: string;
  conversationId: string;
  kind: 'action' | 'grant';
  attendance: 'attended' | 'unattended';
  status: string;
  call: { id: string; name: string; input: unknown };
  callFingerprint: string;
  ruleId: string | null;
  irreversible: boolean;
  freshness: { kind: string; value: string; label: string } | null;
  summary: string;
  detail: string;
  preview: { meta: string; body: string } | null;
  primaryLabel: string;
  secondaryLabel: string;
  ghostLabel: string;
  approvedText: string;
  dismissedText: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  staleReason: string | null;
  consumedAt: string | null;
  replayDueAt: string | null;
  replayClaimedAt: string | null;
  replayedAt: string | null;
  replayError: string | null;
}

/**
 * One of alice's decisions. `gmail_send`, so projecting it reads nothing about
 * routine eligibility, and the only routines read is the label's.
 */
function row(over: Partial<StoredDecisionLike> & { id: string }): StoredDecisionLike {
  return {
    agentId: 'a1',
    ownerUserId: 'alice',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'attended',
    status: 'pending',
    call: { id: 'tu1', name: 'gmail_send', input: { body: 'the drafted reply' } },
    callFingerprint: 'sha256:abcdef',
    ruleId: 'rule-outward-email',
    irreversible: false,
    freshness: null,
    summary: 'Send your reply to Priya',
    detail: 'It drafted a reply about the Thursday slot.',
    preview: null,
    primaryLabel: 'Send it',
    secondaryLabel: 'Open the conversation',
    ghostLabel: "Don't send",
    approvedText: 'You approved this — the reply went out.',
    dismissedText: 'You turned this down. Nothing was sent.',
    createdAt: '2026-08-21T10:00:00.000Z',
    expiresAt: '2026-08-22T10:00:00.000Z',
    resolvedAt: null,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    replayedAt: null,
    replayError: null,
    ...over,
  };
}

/** Casts the fixture to whatever `toWireDecision` declares it takes. */
const stored = (d: StoredDecisionLike): Parameters<typeof toWireDecision>[0] =>
  d as unknown as Parameters<typeof toWireDecision>[0];

/** One instant, reused, so the resolution stubs never disagree about "when". */
const RESOLVED_AT = '2026-10-23T11:00:00.000Z';

/** A check-in routines knows: its task's id and name, and whose task it is. */
interface KnownCheckIn {
  routineId: string;
  name: string;
  owner: string;
}

/** alice's support task, as routines knows it and as the wire names it. */
const SUPPORT_TASK: KnownCheckIn = { routineId: 't1', name: 'Zero open support tickets', owner: 'alice' };
const SUPPORT: DecisionCheckIn = { routineId: 't1', taskName: 'Zero open support tickets' };
const INBOX_TASK: KnownCheckIn = { routineId: 't2', name: 'Inbox zero', owner: 'alice' };
const INBOX: DecisionCheckIn = { routineId: 't2', taskName: 'Inbox zero' };

/** A lookup that answers only when the test says so: `reject` ends it with a failure. */
interface Deferred {
  promise: Promise<never>;
  reject: (err: Error) => void;
}
function deferred(): Deferred {
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<never>((_resolve, rej) => {
    reject = rej;
  });
  // Handled here as well, so a hang no route reached can't end as an unhandled rejection.
  promise.catch(() => {});
  return { promise, reject };
}

interface World {
  viewer: string;
  /** Each agent, and the users `agents:resolve` lets reach it. */
  reach: Record<string, string[]>;
  rows: StoredDecisionLike[];
  /** By agent, then conversation: the check-ins routines knows. */
  checkIns: Record<string, Record<string, KnownCheckIn>>;
  /** Agents whose lookup throws this. */
  failures: Map<string, Error>;
  /** Agents whose lookup waits on this until the test rejects it. */
  hang: Map<string, Deferred>;
  /** False is a deployment without `routines:tasks-for-conversations`. */
  lookup: boolean;
  /** What an approve leaves the row as: `stale` is the freshness guard turning it down. */
  approveStatus: 'executed' | 'stale';
}

interface LookupCall {
  userId: string;
  agentId: string;
  input: { agentId: string; conversationIds: string[] };
}

type DecisionRoute = 'decisions' | 'decision' | 'approveDecision' | 'dismissDecision' | 'undoDecision';

function setup(over: Partial<World> = {}) {
  const world: World = {
    viewer: 'alice',
    reach: { a1: ['alice'], a2: ['alice'] },
    rows: [],
    checkIns: {},
    failures: new Map(),
    hang: new Map(),
    lookup: true,
    approveStatus: 'executed',
    ...over,
  };
  const bus = new HookBus();
  const lookups: LookupCall[] = [];
  const approveCalls: unknown[] = [];
  const byId = (decisionId: string): StoredDecisionLike => {
    const d = world.rows.find((r) => r.id === decisionId);
    if (d === undefined) throw new Error(`no row ${decisionId}`);
    return d;
  };

  bus.registerService('auth:require-user', 'auth', async () => ({
    user: { id: world.viewer, isAdmin: false },
  }));
  bus.registerService(
    'agents:resolve',
    'agents',
    async (_ctx: AgentContext, input: { agentId: string; userId: string }) => {
      if (!(world.reach[input.agentId] ?? []).includes(input.userId)) {
        throw new PluginError({ code: 'not-found', plugin: 'agents', message: 'no such agent' });
      }
      return { agent: { id: input.agentId, displayName: input.agentId } };
    },
  );
  bus.registerService(
    'decisions:list',
    'decisions',
    async (_ctx: AgentContext, input: { userId: string; agentId?: string }) => ({
      decisions: world.rows.filter(
        (d) =>
          d.ownerUserId === input.userId &&
          (input.agentId === undefined || d.agentId === input.agentId),
      ),
    }),
  );
  bus.registerService(
    'decisions:get',
    'decisions',
    async (_ctx: AgentContext, input: { decisionId: string; userId: string }) => {
      const d = world.rows.find((r) => r.id === input.decisionId);
      // Owner-scoped, like the plugin: another person's row is null, never a throw.
      return { decision: d !== undefined && d.ownerUserId === input.userId ? d : null };
    },
  );
  bus.registerService(
    'decisions:approve',
    'decisions',
    async (_ctx: AgentContext, input: { decisionId: string; userId: string }) => {
      approveCalls.push(input);
      return {
        decision:
          world.approveStatus === 'stale'
            ? { ...byId(input.decisionId), status: 'stale' }
            : { ...byId(input.decisionId), status: 'executed', resolvedAt: RESOLVED_AT },
        executed: world.approveStatus === 'executed',
        path: 'host-replays',
        error: null,
        pendingUntil: null,
        streamReqId: null,
      };
    },
  );
  bus.registerService(
    'decisions:dismiss',
    'decisions',
    async (_ctx: AgentContext, input: { decisionId: string; userId: string }) => ({
      decision: { ...byId(input.decisionId), status: 'dismissed', resolvedAt: RESOLVED_AT },
    }),
  );
  bus.registerService(
    'decisions:undo',
    'decisions',
    async (_ctx: AgentContext, input: { decisionId: string; userId: string }) => ({
      decision: { ...byId(input.decisionId), status: 'pending', resolvedAt: null },
      undone: true,
    }),
  );
  if (world.lookup) {
    bus.registerService(
      'routines:tasks-for-conversations',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        lookups.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw as LookupCall['input'] });
        // The service's own input check: a batch it would refuse fails here too.
        const input = parseRoutineInput(RoutineTasksForConversationsInputSchema, raw);
        const hang = world.hang.get(input.agentId);
        if (hang !== undefined) await hang.promise;
        const failure = world.failures.get(input.agentId);
        if (failure !== undefined) throw failure;
        const known = world.checkIns[input.agentId] ?? {};
        // Only the caller's own check-ins. Anything else is simply absent.
        return {
          checkIns: input.conversationIds.flatMap((conversationId) => {
            const c = known[conversationId];
            return c !== undefined && c.owner === ctx.userId
              ? [{ conversationId, routineId: c.routineId, name: c.name }]
              : [];
          }),
        };
      },
      { returns: RoutineTasksForConversationsOutputSchema },
    );
  }

  const handlers = makeWorkspaceHandlers({ bus, initCtx });
  async function run(route: DecisionRoute, params: Record<string, string> = {}): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    await handlers[route](mkReq(params), res);
    return captured;
  }
  return { run, lookups, approveCalls };
}

/** The list's answer: each row's `checkIn`, by decision id. */
function checkInsById(captured: CapturedRes): Record<string, DecisionCheckIn | null> {
  const body = captured.body as { decisions: Decision[] };
  return Object.fromEntries(body.decisions.map((d) => [d.id, d.checkIn]));
}

/** One row's answer: the single read's, or an approve, dismiss or undo answer's. */
function decisionOf(captured: CapturedRes): Decision {
  return (captured.body as { decision: Decision }).decision;
}

describe("Today's decision rows name the check-in they were held in (TASK-932)", () => {
  it("names the task on an unattended row held in one of the caller's check-ins", async () => {
    const { run, lookups } = setup({
      rows: [row({ id: 'd1', conversationId: 'c-checkin', attendance: 'unattended' })],
      checkIns: { a1: { 'c-checkin': SUPPORT_TASK } },
    });
    const captured = await run('decisions');
    expect(captured.statusCode).toBe(200);
    expect(checkInsById(captured)).toStrictEqual({ d1: SUPPORT });
    expect(lookups).toStrictEqual([
      { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', conversationIds: ['c-checkin'] } },
    ]);
  });

  it('fences the task name to one line, and names an unreadable one "Untitled task"', async () => {
    const { run } = setup({
      rows: [
        row({ id: 'd-bidi', conversationId: 'c-bidi', attendance: 'unattended' }),
        row({ id: 'd-blank', conversationId: 'c-blank', attendance: 'unattended' }),
      ],
      checkIns: {
        a1: {
          // A right-to-left override and a line break, both flattened to spaces.
          'c-bidi': { routineId: 't1', name: 'Zero\u202Eopen\n  support tickets', owner: 'alice' },
          // A lone zero-width space: nothing legible survives the fence.
          'c-blank': { routineId: 't2', name: '\u200B', owner: 'alice' },
        },
      },
    });
    const captured = await run('decisions');
    expect(captured.statusCode).toBe(200);
    expect(checkInsById(captured)).toStrictEqual({
      'd-bidi': { routineId: 't1', taskName: 'Zero open support tickets' },
      'd-blank': { routineId: 't2', taskName: 'Untitled task' },
    });
  });

  it("carries null on an attended row, a repeat routine's row and another person's task", async () => {
    const { run, lookups } = setup({
      rows: [
        row({ id: 'd-chat', conversationId: 'c-chat', attendance: 'attended' }),
        // A repeat routine's run: routines knows no task for it.
        row({ id: 'd-repeat', conversationId: 'c-repeat', attendance: 'unattended' }),
        row({ id: 'd-theirs', conversationId: 'c-theirs', attendance: 'unattended' }),
      ],
      checkIns: {
        a1: {
          // Named if anyone asked, so the test shows an attended row is never asked about.
          'c-chat': { routineId: 't-chat', name: 'Chat task', owner: 'alice' },
          // Bob's task on an agent alice can reach: not hers to see.
          'c-theirs': { routineId: 't-bob', name: "Bob's queue", owner: 'bob' },
        },
      },
    });
    const captured = await run('decisions');
    expect(captured.statusCode).toBe(200);
    expect(checkInsById(captured)).toStrictEqual({ 'd-chat': null, 'd-repeat': null, 'd-theirs': null });
    expect(lookups.flatMap((l) => l.input.conversationIds)).not.toContain('c-chat');
    expect(lookups.every((l) => l.userId === 'alice')).toBe(true);
  });

  it("asks once per agent, only about unattended rows' conversations, without repeats or ids no check-in can have", async () => {
    const { run, lookups } = setup({
      rows: [
        row({ id: 'd1', agentId: 'a1', conversationId: 'c1', attendance: 'unattended' }),
        row({ id: 'd2', agentId: 'a1', conversationId: 'c1', attendance: 'unattended' }),
        row({ id: 'd3', agentId: 'a2', conversationId: 'c2', attendance: 'unattended' }),
        // A hold outside any conversation: @ax/decisions stores '' and calls it unattended.
        row({ id: 'd4', agentId: 'a1', conversationId: '', attendance: 'unattended' }),
        row({ id: 'd5', agentId: 'a1', conversationId: 'c-chat', attendance: 'attended' }),
      ],
      checkIns: { a1: { c1: SUPPORT_TASK }, a2: { c2: INBOX_TASK } },
    });
    const captured = await run('decisions');
    expect(captured.statusCode).toBe(200);
    const byAgent = [...lookups].sort((x, y) => x.agentId.localeCompare(y.agentId));
    expect(byAgent).toStrictEqual([
      { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', conversationIds: ['c1'] } },
      { userId: 'alice', agentId: 'a2', input: { agentId: 'a2', conversationIds: ['c2'] } },
    ]);
    expect(checkInsById(captured)).toStrictEqual({
      d1: SUPPORT,
      d2: SUPPORT,
      d3: INBOX,
      d4: null,
      d5: null,
    });
  });

  it("asks nothing about an agent the caller can't reach", async () => {
    const { run, lookups } = setup({
      reach: { a1: ['alice'], a3: ['bob'] },
      rows: [
        row({ id: 'd1', agentId: 'a1', conversationId: 'c-checkin', attendance: 'unattended' }),
        row({ id: 'd3', agentId: 'a3', conversationId: 'c3', attendance: 'unattended' }),
      ],
      checkIns: {
        a1: { 'c-checkin': SUPPORT_TASK },
        a3: { c3: { routineId: 't3', name: 'Unshared since', owner: 'alice' } },
      },
    });
    const captured = await run('decisions');
    expect(captured.statusCode).toBe(200);
    // The a3 row is left out of the list, as it was before TASK-932.
    expect(checkInsById(captured)).toStrictEqual({ d1: SUPPORT });
    expect(lookups.map((l) => [l.agentId, l.input.agentId])).toStrictEqual([['a1', 'a1']]);
  });

  it('asks in batches of at most 200', async () => {
    const count = ROUTINE_CHECKIN_LOOKUP_MAX_IDS + 1;
    const ids = Array.from({ length: count }, (_, i) => `c${i}`);
    const last = ids[count - 1]!;
    const { run, lookups } = setup({
      rows: ids.map((conversationId, i) =>
        row({ id: `d${i}`, conversationId, attendance: 'unattended' }),
      ),
      checkIns: {
        // One check-in in each batch, so both answers reach the list.
        a1: {
          c0: { routineId: 't-first', name: 'First', owner: 'alice' },
          [last]: { routineId: 't-last', name: 'Last', owner: 'alice' },
        },
      },
    });
    const captured = await run('decisions');
    expect(captured.statusCode).toBe(200);
    expect(lookups.map((l) => l.input.conversationIds.length)).toStrictEqual([
      ROUTINE_CHECKIN_LOOKUP_MAX_IDS,
      1,
    ]);
    expect(lookups.every((l) => l.agentId === 'a1' && l.input.agentId === 'a1')).toBe(true);
    // Every id once: the batches together are exactly the list's conversations.
    expect(lookups.flatMap((l) => l.input.conversationIds).sort()).toStrictEqual([...ids].sort());
    const labels = checkInsById(captured);
    expect(labels['d0']).toStrictEqual({ routineId: 't-first', taskName: 'First' });
    expect(labels[`d${count - 1}`]).toStrictEqual({ routineId: 't-last', taskName: 'Last' });
  });

  it("still answers 200 when one agent's lookup fails: that agent's rows carry null, and it logs", async () => {
    const warn = vi.spyOn(initCtx.logger, 'warn');
    try {
      const { run } = setup({
        rows: [
          row({ id: 'd1', agentId: 'a1', conversationId: 'c-checkin', attendance: 'unattended' }),
          row({ id: 'd2', agentId: 'a2', conversationId: 'c2', attendance: 'unattended' }),
        ],
        checkIns: { a1: { 'c-checkin': SUPPORT_TASK }, a2: { c2: INBOX_TASK } },
        failures: new Map([['a1', new Error('connection terminated unexpectedly')]]),
      });
      const captured = await run('decisions');
      expect(captured.statusCode).toBe(200);
      expect(checkInsById(captured)).toStrictEqual({ d1: null, d2: INBOX });
      expect(warn).toHaveBeenCalledWith('workspace_decision_tasks_failed', {
        agentId: 'a1',
        error: expect.stringContaining('connection terminated'),
      });
      // It failed at once, so it is not a late failure.
      expect(warn).not.toHaveBeenCalledWith('workspace_decision_tasks_late_failed', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it("still answers when a lookup doesn't come back in time, and logs why when it finally fails", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(initCtx.logger, 'warn');
    try {
      const hang = deferred();
      const { run } = setup({
        rows: [
          row({ id: 'd1', agentId: 'a1', conversationId: 'c-checkin', attendance: 'unattended' }),
          row({ id: 'd2', agentId: 'a2', conversationId: 'c2', attendance: 'unattended' }),
        ],
        checkIns: { a1: { 'c-checkin': SUPPORT_TASK }, a2: { c2: INBOX_TASK } },
        hang: new Map([['a1', hang]]),
      });
      let done = false;
      const pending = run('decisions').then((c) => {
        done = true;
        return c;
      });
      await vi.advanceTimersByTimeAsync(DECISION_CHECKINS_LIST_DEADLINE_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const captured = await pending;
      expect(captured.statusCode).toBe(200);
      // Only the late agent's rows lose their label.
      expect(checkInsById(captured)).toStrictEqual({ d1: null, d2: INBOX });
      expect(warn).toHaveBeenCalledWith('workspace_decision_tasks_failed', {
        agentId: 'a1',
        error: expect.stringContaining(`did not answer within ${DECISION_CHECKINS_LIST_DEADLINE_MS}ms`),
      });
      expect(warn).not.toHaveBeenCalledWith('workspace_decision_tasks_late_failed', expect.anything());

      hang.reject(new Error('pool exhausted after a long wait'));
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith('workspace_decision_tasks_late_failed', {
        agentId: 'a1',
        error: expect.stringContaining('pool exhausted'),
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('an answer waits at most a second for its label', async () => {
    // Shorter than the list's, so this test can't pass on the list's deadline.
    expect(DECISION_CHECKIN_ROW_DEADLINE_MS).toBeLessThan(DECISION_CHECKINS_LIST_DEADLINE_MS);
    vi.useFakeTimers();
    const warn = vi.spyOn(initCtx.logger, 'warn');
    try {
      const { run } = setup({
        rows: [row({ id: 'd1', conversationId: 'c-checkin', attendance: 'unattended' })],
        checkIns: { a1: { 'c-checkin': SUPPORT_TASK } },
        hang: new Map([['a1', deferred()]]),
      });
      let done = false;
      // The undo answer reopens the row, so it asks (TASK-933: a resolved row's answers never wait).
      const pending = run('undoDecision', { decisionId: 'd1' }).then((c) => {
        done = true;
        return c;
      });
      await vi.advanceTimersByTimeAsync(DECISION_CHECKIN_ROW_DEADLINE_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      const captured = await pending;
      expect(captured.statusCode).toBe(200);
      expect(decisionOf(captured).status).toBe('pending');
      expect(decisionOf(captured).checkIn).toBeNull();
      expect(warn).toHaveBeenCalledWith('workspace_decision_tasks_failed', {
        agentId: 'a1',
        error: expect.stringContaining(`did not answer within ${DECISION_CHECKIN_ROW_DEADLINE_MS}ms`),
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('without routines:tasks-for-conversations every row carries null', async () => {
    const warn = vi.spyOn(initCtx.logger, 'warn');
    try {
      const { run } = setup({
        lookup: false,
        rows: [
          row({ id: 'd1', conversationId: 'c-checkin', attendance: 'unattended' }),
          row({ id: 'd2', conversationId: 'c-chat', attendance: 'attended' }),
        ],
        checkIns: { a1: { 'c-checkin': SUPPORT_TASK } },
      });
      const captured = await run('decisions');
      expect(captured.statusCode).toBe(200);
      expect(checkInsById(captured)).toStrictEqual({ d1: null, d2: null });
      const single = await run('decision', { decisionId: 'd1' });
      expect(single.statusCode).toBe(200);
      expect(decisionOf(single).checkIn).toBeNull();
      // Nothing failed: there was nothing to ask.
      const lines = warn.mock.calls.filter(([event]) =>
        String(event).startsWith('workspace_decision_tasks'),
      );
      expect(lines).toStrictEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("an open row's single read and the undo answer carry its checkIn; a resolved row's answers carry none and ask routines nothing (TASK-933)", async () => {
    const { run, lookups } = setup({
      rows: [
        row({ id: 'd1', conversationId: 'c-checkin', attendance: 'unattended' }),
        row({ id: 'd-chat', conversationId: 'c-chat', attendance: 'attended' }),
      ],
      checkIns: { a1: { 'c-checkin': SUPPORT_TASK } },
    });
    expect(checkInsById(await run('decisions'))).toStrictEqual({ d1: SUPPORT, 'd-chat': null });

    // d1 is pending, and the undo answer reopens it: both answer an open row.
    for (const route of ['decision', 'undoDecision'] as const) {
      lookups.length = 0;
      const captured = await run(route, { decisionId: 'd1' });
      expect(captured.statusCode, route).toBe(200);
      expect(decisionOf(captured).status, route).toBe('pending');
      expect(decisionOf(captured).checkIn, route).toStrictEqual(SUPPORT);
      // Labelled by the list's own rule: asked once, as the caller, about this row's conversation.
      expect(lookups, route).toStrictEqual([
        { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', conversationIds: ['c-checkin'] } },
      ]);
    }

    // The approve and dismiss answers resolve it. A receipt needs no label (the queue keeps the one it had).
    for (const [route, status] of [['approveDecision', 'executed'], ['dismissDecision', 'dismissed']] as const) {
      lookups.length = 0;
      const captured = await run(route, { decisionId: 'd1' });
      expect(captured.statusCode, route).toBe(200);
      expect(decisionOf(captured).status, route).toBe(status);
      expect(decisionOf(captured).checkIn, route).toBeNull();
      expect(lookups, route).toStrictEqual([]);
    }

    lookups.length = 0;
    const attended = await run('decision', { decisionId: 'd-chat' });
    expect(attended.statusCode).toBe(200);
    expect(decisionOf(attended).checkIn).toBeNull();
    expect(lookups).toStrictEqual([]);
  });

  it("the undo poll's read of a resolved row asks routines nothing (TASK-933)", async () => {
    // Its own setup: the `decisions:list` stub answers every stored row, resolved or not.
    const { run, lookups } = setup({
      rows: [
        row({
          id: 'd-done',
          conversationId: 'c-checkin',
          attendance: 'unattended',
          status: 'executed',
          resolvedAt: RESOLVED_AT,
        }),
      ],
      checkIns: { a1: { 'c-checkin': SUPPORT_TASK } },
    });
    const captured = await run('decision', { decisionId: 'd-done' });
    expect(captured.statusCode).toBe(200);
    expect(decisionOf(captured).status).toBe('executed');
    expect(decisionOf(captured).checkIn).toBeNull();
    expect(lookups).toStrictEqual([]);
  });

  it('an approve the freshness guard turns stale still asks, once, and carries the label (TASK-933)', async () => {
    const { run, lookups } = setup({
      rows: [row({ id: 'd1', conversationId: 'c-checkin', attendance: 'unattended' })],
      checkIns: { a1: { 'c-checkin': SUPPORT_TASK } },
      approveStatus: 'stale',
    });
    const captured = await run('approveDecision', { decisionId: 'd1' });
    expect(captured.statusCode).toBe(200);
    // Stale is still a question: unlike a receipt, the answer names the task.
    expect(decisionOf(captured).status).toBe('stale');
    expect(decisionOf(captured).checkIn).toStrictEqual(SUPPORT);
    expect(lookups).toStrictEqual([
      { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', conversationIds: ['c-checkin'] } },
    ]);
  });

  it('an answer whose lookup fails still answers, with checkIn null', async () => {
    const warn = vi.spyOn(initCtx.logger, 'warn');
    try {
      const { run, approveCalls, lookups } = setup({
        rows: [row({ id: 'd1', conversationId: 'c-checkin', attendance: 'unattended' })],
        checkIns: { a1: { 'c-checkin': SUPPORT_TASK } },
        failures: new Map([['a1', new Error('connection terminated unexpectedly')]]),
      });
      // The undo answer reopens the row, so it asks; the failure costs only the label.
      const undone = await run('undoDecision', { decisionId: 'd1' });
      expect(undone.statusCode).toBe(200);
      expect(decisionOf(undone).status).toBe('pending');
      expect(decisionOf(undone).checkIn).toBeNull();
      expect(lookups).toHaveLength(1);

      // The stub records a lookup before it honours the failure, so start the count again.
      lookups.length = 0;
      const captured = await run('approveDecision', { decisionId: 'd1' });
      expect(captured.statusCode).toBe(200);
      expect(decisionOf(captured).status).toBe('executed');
      expect(decisionOf(captured).checkIn).toBeNull();
      // Approving is unchanged: the bus input is exactly what it was before TASK-932.
      expect(approveCalls).toStrictEqual([
        { decisionId: 'd1', userId: 'alice', continuationReqId: expect.any(String) },
      ]);
      // A resolved row's answer asks nothing (TASK-933), so a failing routines read can't slow it.
      expect(lookups).toStrictEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('toWireDecision names the task only on an open, unattended row', () => {
    const unattended = stored(row({ id: 'd1', conversationId: 'c-checkin', attendance: 'unattended' }));
    const attended = stored(row({ id: 'd2', conversationId: 'c-checkin', attendance: 'attended' }));
    const resolved = stored(
      row({ id: 'd3', conversationId: 'c-checkin', attendance: 'unattended', status: 'executed', resolvedAt: RESOLVED_AT }),
    );
    // Stale is still a question (the freshness guard reopened it), so it keeps its label.
    const stale = stored(row({ id: 'd4', conversationId: 'c-checkin', attendance: 'unattended', status: 'stale' }));
    const source = { routineId: 't1', name: 'Zero open support tickets' };
    expect(toWireDecision(unattended, false, source).checkIn).toStrictEqual(SUPPORT);
    expect(toWireDecision(attended, false, source).checkIn).toBeNull();
    expect(toWireDecision(unattended).checkIn).toBeNull();
    // A receipt carries no label, even when handed one (TASK-933).
    expect(toWireDecision(resolved, false, source).checkIn).toBeNull();
    expect(toWireDecision(stale, false, source).checkIn).toStrictEqual(SUPPORT);
  });
});
