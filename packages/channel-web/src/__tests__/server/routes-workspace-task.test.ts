// @vitest-environment node
/**
 * The task page's routes: `GET /api/workspace/tasks/:agentId/:routineId`, one
 * task's own page, and `DELETE …/notes`, which clears the agent's notes on it
 * (TASK-910); `POST …/replies`, the task's owner writing to their agent
 * about it (TASK-931); `POST …/steps`, the task's owner changing its steps
 * (TASK-949); `PUT …/finish-by`, the owner setting or removing a
 * "get-done" task's finish date (TASK-951); `POST …/complete` and
 * `POST …/reopen`, Mark done, and Not yet or Reopen with a reply (TASK-950);
 * and `POST …/duplicate`, the owner copying their task, paused (TASK-953).
 *
 * `routines:get` here is the real view producer, not a literal. Each view is
 * made by @ax/routines' own `routineView` and parsed on the bus through
 * `RoutineGetOutputSchema`, as in production. That pins the page's ownership
 * rule (TASK-909's `isOwnTask`, reused) against the services' `taskView` and
 * `routinePermissions`: if either changes, these tests fail instead of the
 * page quietly showing someone else's task. `routines:recent-fires` answers
 * literal fire views, parsed through `RoutineRecentFiresOutputSchema`, and
 * `routines:recent-replies` literal reply views, parsed through
 * `RoutineRecentRepliesOutputSchema`. `routines:reply` checks its input with
 * the contract's own `RoutineReplyInputSchema` first, as the service does, so
 * a text the reply rule refuses is a real `validation` refusal and a key the
 * route forwards that the service doesn't take fails the request.
 * `routines:set-steps` does the same with `RoutineSetStepsInputSchema`, and
 * its answer is parsed through `RoutineSetStepsOutputSchema`.
 * `routines:set-finish-by` checks its input with `RoutineSetFinishByInputSchema`
 * the same way, so a date the contract's rule refuses is a real `validation`
 * refusal too.
 * `routines:complete` and `routines:reopen` check theirs the same way, with
 * `RoutineCompleteInputSchema` and `RoutineReopenInputSchema`.
 * `routines:duplicate` checks its input with `RoutineDuplicateInputSchema`
 * first, and its answer is parsed through `RoutineDuplicateOutputSchema`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  PluginError,
  SafeToolError,
  makeAgentContext,
  type AgentContext,
} from '@ax/core';
import {
  ROUTINE_AGENT_NOTES_MAX_CHARS,
  ROUTINE_OPAQUE_STRING_MAX_CHARS,
  ROUTINE_REPLY_MAX_CHARS,
  ROUTINE_REPORT_ASK_MAX_CHARS,
  ROUTINE_REPORT_UPDATE_MAX_CHARS,
  ROUTINE_STEP_TEXT_MAX_CHARS,
  RoutineClearNotesOutputSchema,
  RoutineCompleteInputSchema,
  RoutineCompleteOutputSchema,
  RoutineDuplicateInputSchema,
  RoutineDuplicateOutputSchema,
  RoutineGetInputSchema,
  RoutineGetOutputSchema,
  RoutineRecentFiresOutputSchema,
  RoutineRecentRepliesInputSchema,
  RoutineRecentRepliesOutputSchema,
  RoutineReopenInputSchema,
  RoutineReopenOutputSchema,
  RoutineReplyInputSchema,
  RoutineReplyOutputSchema,
  RoutineSetFinishByInputSchema,
  RoutineSetFinishByOutputSchema,
  RoutineSetStepsInputSchema,
  RoutineSetStepsOutputSchema,
  type RoutineCompleteOutput,
  type RoutineDuplicateOutput,
  type RoutineFireView,
  type RoutineReopenOutput,
  type RoutineReplyOutput,
  type RoutineReplyView,
  type RoutineReportStatus,
  type RoutineSetStepsOutput,
} from '@ax/routines-contract';
import {
  TASK_ERROR_MAX_CHARS,
  makeWorkspaceHandlers,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import type {
  TaskDetail,
  TaskDuplicateResponse,
  TaskFinishByResponse,
  TaskStepsResponse,
} from '../../lib/workspace-types.js';
import { parseRoutineInput, routineView } from '../../../../routines/src/services.js';
import type { StoredRoutine } from '../../../../routines/src/types.js';
import { routineFixture } from '../../components/routines/__tests__/routine-fixture.js';

/** A request; a `Buffer` body is sent as those bytes, anything else as JSON. */
function mkReq(
  params: Record<string, string> = {},
  body?: unknown,
): RouteRequest {
  return {
    headers: {},
    body:
      body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body), 'utf-8'),
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

type StoredTask = NonNullable<StoredRoutine['task']>;

/** A stored task: a stay-on-top routine owned by alice that has never reported. */
function stored(over: Partial<StoredRoutine>): StoredRoutine {
  return {
    ...routineFixture,
    steps: [],
    kind: 'stay-on-top',
    goodWhen: 'No ticket waits longer than an hour.',
    ownerUserId: 'alice',
    definitionId: null,
    definitionUpdatedAt: null,
    nextRunAt: null,
    lastRunAt: null,
    task: null,
    noRecentUpdate: null,
    finishBy: null,
    finishByTimeZone: null,
    done: null,
    ...over,
  };
}

/** A stored report. */
function report(status: RoutineReportStatus, over: Partial<StoredTask> = {}): StoredTask {
  return {
    status,
    update: 'Queue is empty.',
    ask: 'Want me to draft a reply?',
    agentNotes: 'Acme is an enterprise customer.',
    reportedAt: new Date('2026-10-22T09:58:00.000Z'),
    reading: null,
    doneClaimed: false,
    ...over,
  };
}

/**
 * One check-in, as `routines:recent-fires` shows it. The fields the page never
 * draws carry markers no response may contain. Its conversation is drawn, as
 * See what it did (TASK-911).
 */
function fire(over: Partial<RoutineFireView> = {}): RoutineFireView {
  return {
    agentId: 'a1',
    routineId: 't1',
    firedAt: '2026-10-22T09:57:00.000Z',
    triggerSource: 'tick',
    conversationId: 'CONVERSATION-ID',
    status: 'ok',
    error: null,
    renderedPrompt: 'PROMPT-TEXT',
    warning: 'WARNING-TEXT',
    report: null,
    ...over,
  };
}

interface World {
  viewer: string | null;
  /** Each agent, and the users `agents:resolve` lets reach it. */
  agents: Record<string, { displayName: string; users: string[] }>;
  rows: StoredRoutine[];
  /** Per agent, the users `agents:can-manage-routines` says yes to. */
  managers: Record<string, string[]>;
  /** What `routines:recent-fires` answers, newest first. */
  fires: RoutineFireView[];
  /** Service hooks this deployment doesn't have. */
  absent: Set<string>;
  /** Set: `routines:get` throws this. */
  getFailure: Error | null;
  /** Set: `routines:recent-fires` throws this. */
  firesFailure: Error | null;
  /** Set: `routines:clear-notes` throws this. */
  clearFailure: Error | null;
  /** What `routines:recent-replies` answers, newest first (TASK-931). */
  replies: RoutineReplyView[];
  /** Set: `routines:recent-replies` throws this. */
  repliesFailure: Error | null;
  /** What `routines:reply` answers when it takes a reply. */
  replyAnswer: RoutineReplyOutput;
  /** Set: `routines:reply` throws this, after its input check. */
  replyFailure: Error | null;
  /** What `routines:set-steps` answers when it takes a change (TASK-949). */
  stepsAnswer: RoutineSetStepsOutput;
  /** Set: `routines:set-steps` throws this, after its input check. */
  stepsFailure: Error | null;
  /** Set: `routines:set-finish-by` throws this, after its input check (TASK-951). */
  finishByFailure: Error | null;
  /** What `routines:complete` answers when it marks the task done (TASK-950). */
  completeAnswer: RoutineCompleteOutput;
  /** Set: `routines:complete` throws this, after its input check. */
  completeFailure: Error | null;
  /** What `routines:reopen` answers when it takes Not yet or Reopen (TASK-950). */
  reopenAnswer: RoutineReopenOutput;
  /** Set: `routines:reopen` throws this, after its input check. */
  reopenFailure: Error | null;
  /** What `routines:duplicate` answers when it makes a copy (TASK-953). */
  duplicateAnswer: RoutineDuplicateOutput;
  /** Set: `routines:duplicate` throws this, after its input check. */
  duplicateFailure: Error | null;
  /**
   * True: `routines:get`, `routines:recent-fires`, (TASK-949)
   * `routines:set-steps` and (TASK-953) `routines:duplicate` are registered
   * without `returns`, so their answers reach the route unparsed (TASK-913's
   * shape).
   */
  unvalidated: boolean;
  /** Set, with `unvalidated`: the view's `noRecentUpdate` is replaced by this (a shape the schema would refuse). */
  viewMiss: { value: unknown } | null;
  /** Set, with `unvalidated`: merged into the view (TASK-948: a kind or steps the schema would refuse). */
  viewPatch: Record<string, unknown> | null;
}

interface Call<I> {
  userId: string;
  agentId: string;
  input: I;
}

type Key = { agentId: string; routineId: string };
const KEY: Key = { agentId: 'a1', routineId: 't1' };

/** `now`: the handlers' clock (TASK-951's days left); the system clock when left out. */
function setup(over: Partial<World> & { now?: () => Date } = {}) {
  const { now, ...worldOver } = over;
  const world: World = {
    viewer: 'alice',
    agents: { a1: { displayName: 'Caveman', users: ['alice'] } },
    rows: [],
    managers: { a1: ['alice'] },
    fires: [],
    absent: new Set(),
    getFailure: null,
    firesFailure: null,
    clearFailure: null,
    replies: [],
    repliesFailure: null,
    replyAnswer: { replyId: 'REPLY-ID-0', checkIn: 'started' },
    replyFailure: null,
    stepsAnswer: { steps: [], skipped: 0 },
    stepsFailure: null,
    finishByFailure: null,
    completeAnswer: { done: true },
    completeFailure: null,
    reopenAnswer: { replyId: 'REPLY-ID-1', checkIn: 'started' },
    reopenFailure: null,
    duplicateAnswer: { routineId: 'COPY-ID-1' },
    duplicateFailure: null,
    unvalidated: false,
    viewMiss: null,
    viewPatch: null,
    ...worldOver,
  };
  const bus = new HookBus();
  const resolveCalls: Array<{ agentId: string; userId: string }> = [];
  const getCalls: Array<Call<unknown>> = [];
  const firesCalls: Array<Call<unknown>> = [];
  const clearCalls: Array<Call<unknown>> = [];
  const repliesCalls: Array<Call<unknown>> = [];
  const replyCalls: Array<Call<unknown>> = [];
  const stepsCalls: Array<Call<unknown>> = [];
  const finishByCalls: Array<Call<unknown>> = [];
  const completeCalls: Array<Call<unknown>> = [];
  const reopenCalls: Array<Call<unknown>> = [];
  const duplicateCalls: Array<Call<unknown>> = [];
  /** Every routines hook asked, in the order it was asked. */
  const order: string[] = [];

  bus.registerService('auth:require-user', 'auth', async () => {
    if (world.viewer === null) {
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
    }
    return { user: { id: world.viewer, isAdmin: false } };
  });
  bus.registerService(
    'agents:resolve',
    'agents',
    async (_ctx: AgentContext, input: { agentId: string; userId: string }) => {
      resolveCalls.push(input);
      const agent = world.agents[input.agentId];
      if (agent === undefined || !agent.users.includes(input.userId)) {
        throw new PluginError({ code: 'not-found', plugin: 'agents', message: 'no such agent' });
      }
      return { agent: { id: input.agentId, displayName: agent.displayName } };
    },
  );
  if (!world.absent.has('routines:get')) {
    bus.registerService(
      'routines:get',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        getCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        order.push('routines:get');
        if (world.getFailure !== null) throw world.getFailure;
        // The service's own input check: an id that can't exist is `validation`.
        const input = parseRoutineInput(RoutineGetInputSchema, raw);
        const row = world.rows.find(
          (r) => r.agentId === input.agentId && r.routineId === input.routineId,
        );
        if (row === undefined) throw new SafeToolError('not-found', 'routineId');
        const allowed = world.managers[input.agentId]?.includes(ctx.userId) ?? false;
        const view = routineView(row, ctx.userId, allowed);
        const missed = world.viewMiss === null ? view : { ...view, noRecentUpdate: world.viewMiss.value as typeof view.noRecentUpdate };
        return world.viewPatch === null ? missed : { ...missed, ...world.viewPatch };
      },
      world.unvalidated ? undefined : { returns: RoutineGetOutputSchema },
    );
  }
  if (!world.absent.has('routines:recent-fires')) {
    bus.registerService(
      'routines:recent-fires',
      'routines',
      async (ctx: AgentContext, input: unknown) => {
        firesCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input });
        order.push('routines:recent-fires');
        if (world.firesFailure !== null) throw world.firesFailure;
        return { fires: world.fires };
      },
      world.unvalidated ? undefined : { returns: RoutineRecentFiresOutputSchema },
    );
  }
  if (!world.absent.has('routines:recent-replies')) {
    bus.registerService(
      'routines:recent-replies',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        repliesCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        order.push('routines:recent-replies');
        parseRoutineInput(RoutineRecentRepliesInputSchema, raw);
        if (world.repliesFailure !== null) throw world.repliesFailure;
        return { replies: world.replies };
      },
      { returns: RoutineRecentRepliesOutputSchema },
    );
  }
  if (!world.absent.has('routines:reply')) {
    bus.registerService(
      'routines:reply',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        replyCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        order.push('routines:reply');
        // The service's own input check, before anything else: the contract's
        // reply rule refuses the text as `validation`, and so does a key the
        // service doesn't take.
        parseRoutineInput(RoutineReplyInputSchema, raw);
        if (world.replyFailure !== null) throw world.replyFailure;
        return world.replyAnswer;
      },
      { returns: RoutineReplyOutputSchema },
    );
  }
  if (!world.absent.has('routines:set-steps')) {
    bus.registerService(
      'routines:set-steps',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        stepsCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        order.push('routines:set-steps');
        // The service's own input check, before anything else (TASK-949): the
        // contract refuses a change it doesn't take as `validation`, its
        // text's rule included, and so does a key the service doesn't take.
        parseRoutineInput(RoutineSetStepsInputSchema, raw);
        if (world.stepsFailure !== null) throw world.stepsFailure;
        return world.stepsAnswer;
      },
      world.unvalidated ? undefined : { returns: RoutineSetStepsOutputSchema },
    );
  }
  if (!world.absent.has('routines:complete')) {
    bus.registerService(
      'routines:complete',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        completeCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        order.push('routines:complete');
        // The service's own input check, before anything else (TASK-950).
        parseRoutineInput(RoutineCompleteInputSchema, raw);
        if (world.completeFailure !== null) throw world.completeFailure;
        return world.completeAnswer;
      },
      { returns: RoutineCompleteOutputSchema },
    );
  }
  if (!world.absent.has('routines:reopen')) {
    bus.registerService(
      'routines:reopen',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        reopenCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        order.push('routines:reopen');
        // As for a reply: the contract's reply rule refuses the text as
        // `validation` before anything else (TASK-950).
        parseRoutineInput(RoutineReopenInputSchema, raw);
        if (world.reopenFailure !== null) throw world.reopenFailure;
        return world.reopenAnswer;
      },
      { returns: RoutineReopenOutputSchema },
    );
  }
  if (!world.absent.has('routines:clear-notes')) {
    bus.registerService(
      'routines:clear-notes',
      'routines',
      async (ctx: AgentContext, input: unknown) => {
        clearCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input });
        if (world.clearFailure !== null) throw world.clearFailure;
        return { cleared: true };
      },
      { returns: RoutineClearNotesOutputSchema },
    );
  }
  if (!world.absent.has('routines:set-finish-by')) {
    bus.registerService(
      'routines:set-finish-by',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        finishByCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        order.push('routines:set-finish-by');
        // The service's own input check, before anything else: the contract's
        // rule refuses a date no calendar has as `validation`, and so does a
        // key the service doesn't take.
        const input = parseRoutineInput(RoutineSetFinishByInputSchema, raw);
        if (world.finishByFailure !== null) throw world.finishByFailure;
        // What the store saved (TASK-955): a zone only beside a date.
        return {
          finishBy: input.finishBy,
          finishByTimeZone: input.finishBy === null ? null : (input.finishByTimeZone ?? null),
        };
      },
      { returns: RoutineSetFinishByOutputSchema },
    );
  }
  if (!world.absent.has('routines:duplicate')) {
    bus.registerService(
      'routines:duplicate',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        duplicateCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        order.push('routines:duplicate');
        // The service's own input check, before anything else (TASK-953): a
        // request id the contract refuses is `validation`, and so is a key
        // the service doesn't take.
        parseRoutineInput(RoutineDuplicateInputSchema, raw);
        if (world.duplicateFailure !== null) throw world.duplicateFailure;
        return world.duplicateAnswer;
      },
      world.unvalidated ? undefined : { returns: RoutineDuplicateOutputSchema },
    );
  }

  // Spread in only when set: the deps' `now` is optional, and
  // exactOptionalPropertyTypes refuses an explicit undefined.
  const handlers = makeWorkspaceHandlers({ bus, initCtx, ...(now === undefined ? {} : { now }) });
  /** What the last request wrote, kept even when the handler throws. */
  let last: CapturedRes | null = null;
  async function detail(params: Record<string, string> = KEY): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.taskDetail(mkReq(params), res);
    return captured;
  }
  async function clear(params: Record<string, string> = KEY): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.clearTaskNotes(mkReq(params), res);
    return captured;
  }
  async function reply(
    params: Record<string, string> = KEY,
    body: unknown = SENT,
  ): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.taskReply(mkReq(params, body), res);
    return captured;
  }
  async function steps(
    params: Record<string, string> = KEY,
    body: unknown = CHANGE,
  ): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.taskSteps(mkReq(params, body), res);
    return captured;
  }
  async function finishBy(
    params: Record<string, string> = KEY,
    body: unknown = SET,
  ): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.setTaskFinishBy(mkReq(params, body), res);
    return captured;
  }
  async function complete(
    params: Record<string, string> = KEY,
    body: unknown = PRESS,
  ): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.completeTask(mkReq(params, body), res);
    return captured;
  }
  async function reopen(
    params: Record<string, string> = KEY,
    body: unknown = NOT_YET,
  ): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.reopenTask(mkReq(params, body), res);
    return captured;
  }
  async function duplicate(
    params: Record<string, string> = KEY,
    body: unknown = { requestId: 'req-1' },
  ): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.taskDuplicate(mkReq(params, body), res);
    return captured;
  }
  return {
    detail,
    clear,
    reply,
    steps,
    finishBy,
    complete,
    reopen,
    duplicate,
    resolveCalls,
    getCalls,
    firesCalls,
    clearCalls,
    repliesCalls,
    replyCalls,
    stepsCalls,
    finishByCalls,
    completeCalls,
    reopenCalls,
    duplicateCalls,
    order,
    lastWritten: () => last,
  };
}

/** A reply as the box sends it (TASK-931). */
const SENT = { text: 'Refunds under $100 are fine.', requestId: 'req-1' };

/** A step change as the task page sends it (TASK-949). */
const ADD = { op: 'add', text: 'Ask Dana to review billing' } as const;
const CHANGE = { requestId: 'req-1', ops: [ADD] };
/** A finish date as the task page sends it (TASK-951). */
const SET = { finishBy: '2026-11-14' };

/** Mark done's press as the page sends it (TASK-950). */
const PRESS = { requestId: 'req-1' };

/** Not yet, or Reopen, as the page sends it (TASK-950): a reply's body. */
const NOT_YET = { text: 'The billing page still needs a review.', requestId: 'req-2' };

/**
 * A "get-done" task of alice's on a1 whose latest report claims it is
 * finished (TASK-950). It has reported, so it is hers whether or not she still
 * manages the agent's tasks (`isOwnTask`).
 */
function claimed(over: Partial<StoredRoutine> = {}): StoredRoutine {
  return stored({
    agentId: 'a1',
    routineId: 't1',
    kind: 'get-done',
    task: report('needs-you', { doneClaimed: true }),
    ...over,
  });
}

/** That task once alice marked it done (TASK-950): off, its claim gone, its completion hers. */
function markedDone(over: Partial<StoredRoutine> = {}): StoredRoutine {
  return claimed({
    enabled: false,
    task: report('needs-you'),
    done: { at: new Date('2026-10-23T10:00:00.000Z'), byUserId: 'alice' },
    ...over,
  });
}

function bodyOf(captured: CapturedRes): TaskDetail {
  return captured.body as TaskDetail;
}

/** A team agent alice and bob can both reach. */
const TEAM_AGENTS: World['agents'] = { team: { displayName: 'Support', users: ['alice', 'bob'] } };

describe('GET /api/workspace/tasks/:agentId/:routineId (TASK-910)', () => {
  it('answers the task’s latest update, brief, notes and updates', async () => {
    const { detail } = setup({
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          revision: 'rev-7',
          activeHours: { start: '09:00', end: '18:00', tz: 'America/New_York' },
          // 11:57 AM in New York: inside the window, so the view keeps it as stored.
          nextRunAt: new Date('2026-10-22T15:57:00.000Z'),
          task: report('needs-you', {
            update: 'Two tickets have waited over an hour.',
            ask: 'Want me to draft replies to both?',
            agentNotes: 'Acme is an enterprise customer.\nReply within the hour.',
            reportedAt: new Date('2026-10-22T14:58:00.000Z'),
          }),
        }),
      ],
      fires: [
        fire({
          firedAt: '2026-10-22T14:57:00.000Z',
          triggerSource: 'manual',
          report: {
            status: 'needs-you',
            update: 'Two tickets have waited over an hour.',
            ask: 'HISTORY-ASK Want me to draft replies?',
            reading: null,
          },
        }),
        fire({
          firedAt: '2026-10-22T13:57:00.000Z',
          status: 'error',
          error: 'The check-in ran out of time.',
        }),
      ],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({
      agentName: 'Caveman',
      name: 'Project check-in',
      kind: 'stay-on-top',
      enabled: true,
      revision: 'rev-7',
      permissions: { fire: true, stop: true, edit: true },
      schedule: 'every hour, 9:00 AM to 6:00 PM (America/New_York)',
      nextCheckAt: '2026-10-22T15:57:00.000Z',
      brief: {
        promptBody: 'Review updates.\nKeep the newlines.',
        goodWhen: 'No ticket waits longer than an hour.',
      },
      task: {
        status: 'needs-you',
        update: 'Two tickets have waited over an hour.',
        ask: 'Want me to draft replies to both?',
        agentNotes: 'Acme is an enterprise customer.\nReply within the hour.',
        reading: null,
        doneClaimed: false,
        reportedAt: '2026-10-22T14:58:00.000Z',
      },
      steps: [],
      finishBy: null,
      noRecentUpdate: null,
      doneAt: null,
      updates: [
        {
          firedAt: '2026-10-22T14:57:00.000Z',
          status: 'ok',
          error: null,
          report: { status: 'needs-you', update: 'Two tickets have waited over an hour.', reading: null },
          conversationId: 'CONVERSATION-ID',
        },
        {
          firedAt: '2026-10-22T13:57:00.000Z',
          status: 'error',
          error: 'The check-in ran out of time.',
          report: null,
          conversationId: 'CONVERSATION-ID',
        },
      ],
      replies: [],
    } satisfies TaskDetail);
    // Spelled out, though the strict match above already says it: nothing the
    // page doesn't draw crosses the wire.
    const wire = JSON.stringify(captured.body);
    for (const marker of [
      'PROMPT-TEXT',
      'WARNING-TEXT',
      'HISTORY-ASK',
      'manual',
      'manageSecret',
    ]) {
      expect(wire).not.toContain(marker);
    }
  });

  it('a get-done task’s page carries its kind and its steps, in order, fenced, each with its id and whether the agent added it (TASK-948)', async () => {
    const { detail } = setup({
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          kind: 'get-done',
          steps: [
            { id: 'saaaaaa', text: 'Export   every\tarticle', done: true, addedBy: 'agent' },
            { id: 'sbbbbbb', text: 'Ask Dana to review billing', done: false, addedBy: 'person' },
            { id: 'scccccc', text: 'x'.repeat(250), done: false, addedBy: 'agent' },
            { id: 'sdddddd', text: '\u202E', done: false, addedBy: 'agent' },
          ],
        }),
      ],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    const body = bodyOf(captured);
    expect(body.kind).toBe('get-done');
    expect(body.steps).toStrictEqual([
      { id: 'saaaaaa', text: 'Export every article', done: true, byAgent: true },
      { id: 'sbbbbbb', text: 'Ask Dana to review billing', done: false, byAgent: false },
      // A stored step past the writer's cap (TASK-913) shows at least what a check-in reads: 200 characters, then "…".
      { id: 'scccccc', text: `${'x'.repeat(200)}…`, done: false, byAgent: true },
      { id: 'sdddddd', text: null, done: false, byAgent: true },
    ]);
  });

  it('reads a kind it doesn’t know as stay-on-top, with no steps (TASK-948)', async () => {
    // A view the schema didn't parse (TASK-913's shape), from a later routines plugin.
    const { detail } = setup({
      unvalidated: true,
      viewPatch: {
        kind: 'later-kind',
        steps: [{ id: 's1', text: 'Export every article', done: true, addedBy: 'agent' }],
      },
      rows: [stored({ agentId: 'a1', routineId: 't1' })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).kind).toBe('stay-on-top');
    expect(bodyOf(captured).steps).toStrictEqual([]);
  });

  it('labels a step whose author it doesn’t know as the agent’s, and leaves out what isn’t a whole step (TASK-948)', async () => {
    // The label is how a person spots text that isn't theirs, so only a step
    // the host says a person wrote reads as one.
    const { detail } = setup({
      unvalidated: true,
      viewPatch: {
        steps: [
          { id: 's1', text: 'Export every article', done: false, addedBy: 'later-author' },
          { id: 's2', text: 'Ask Dana to review billing', done: true, addedBy: 'person' },
          { id: 7, text: 'An id that isn’t one', done: false, addedBy: 'agent' },
          { id: 's3', text: 'No author', done: false },
        ],
      },
      rows: [stored({ agentId: 'a1', routineId: 't1', kind: 'get-done' })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).steps).toStrictEqual([
      { id: 's1', text: 'Export every article', done: false, byAgent: true },
      { id: 's2', text: 'Ask Dana to review billing', done: true, byAgent: false },
    ]);
  });

  it('each update names its check-in’s conversation, and one that recorded none says so', async () => {
    const { detail } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1' })],
      fires: [
        fire({ conversationId: 'c-2' }),
        fire({ conversationId: null, status: 'error', error: 'boom' }),
      ],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    const body = captured.body as TaskDetail;
    expect(body.updates.map((u) => u.conversationId)).toEqual(['c-2', null]);
  });

  it('answers a task that hasn’t reported yet with no report and no updates', async () => {
    const { detail } = setup({ rows: [stored({ agentId: 'a1', routineId: 't1' })] });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).task).toBeNull();
    expect(bodyOf(captured).updates).toEqual([]);
  });

  it('asks for the newest 50 check-ins, as the caller', async () => {
    const { detail, getCalls, firesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(getCalls).toEqual([{ userId: 'alice', agentId: 'a1', input: KEY }]);
    expect(firesCalls).toEqual([
      { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', routineId: 't1', limit: 50 } },
    ]);
  });

  it('opens an owned repeat with its history but no task reports or replies (PR4)', async () => {
    const { detail, firesCalls, repliesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', kind: 'repeat', goodWhen: null })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({ kind: 'repeat', task: null, steps: [], replies: [], repeat: { active: null, waiting: null } });
    expect(firesCalls).toHaveLength(1);
    expect(repliesCalls).toEqual([]);
  });

  it.each([
    ['who manages the agent’s tasks', ['alice', 'bob']],
    ['who doesn’t manage the agent’s tasks', ['bob']],
  ])(
    '404s someone else’s task on a team agent, to a viewer %s, and nothing of it is in the body',
    async (_who, managers) => {
      const { detail, firesCalls, repliesCalls } = setup({
        agents: TEAM_AGENTS,
        managers: { team: managers },
        rows: [
          stored({
            agentId: 'team',
            routineId: 'tB',
            name: 'BOB-TASK',
            ownerUserId: 'bob',
            task: report('off-track', {
              update: 'BOB-UPDATE',
              ask: 'BOB-ASK',
              agentNotes: 'BOB-NOTES',
            }),
          }),
        ],
        fires: [
          fire({
            agentId: 'team',
            routineId: 'tB',
            report: { status: 'off-track', update: 'BOB-UPDATE', ask: null, reading: null },
          }),
        ],
      });
      const captured = await detail({ agentId: 'team', routineId: 'tB' });
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'task-not-found' });
      expect(firesCalls).toEqual([]);
      expect(repliesCalls).toEqual([]);
      const wire = JSON.stringify(captured.body);
      for (const marker of ['BOB-TASK', 'BOB-UPDATE', 'BOB-ASK', 'BOB-NOTES']) {
        expect(wire).not.toContain(marker);
      }
    },
  );

  it('shows a reported task to an owner who can no longer manage the agent’s tasks, with every action off', async () => {
    const { detail } = setup({
      viewer: 'bob',
      agents: TEAM_AGENTS,
      managers: { team: ['alice'] },
      rows: [
        stored({ agentId: 'team', routineId: 'tB', ownerUserId: 'bob', task: report('off-track') }),
      ],
    });
    const captured = await detail({ agentId: 'team', routineId: 'tB' });
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).permissions).toEqual({ fire: false, stop: false, edit: false });
    expect(bodyOf(captured).task?.status).toBe('off-track');
  });

  it('opens a never-reported task for its owner without inferring ownership from fire permission', async () => {
    const { detail, firesCalls, repliesCalls } = setup({
      viewer: 'bob',
      agents: TEAM_AGENTS,
      managers: { team: ['alice'] },
      rows: [stored({ agentId: 'team', routineId: 'tD', ownerUserId: 'bob' })],
    });
    const captured = await detail({ agentId: 'team', routineId: 'tD' });
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).task).toBeNull();
    expect(bodyOf(captured).permissions).toEqual({ fire: false, stop: false, edit: false });
    expect(firesCalls).toHaveLength(1);
    expect(repliesCalls).toHaveLength(1);
  });

  it('404s an agent the caller can’t reach, and reads nothing of it', async () => {
    const { detail, resolveCalls, getCalls, firesCalls, repliesCalls } = setup({
      viewer: 'bob',
      managers: { a1: ['alice', 'bob'] },
      rows: [
        stored({ agentId: 'a1', routineId: 't1', ownerUserId: 'bob', task: report('on-track') }),
      ],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'bob' }]);
    expect(getCalls).toEqual([]);
    expect(firesCalls).toEqual([]);
    expect(repliesCalls).toEqual([]);
  });

  it('404s a routine that isn’t there', async () => {
    const { detail, firesCalls, repliesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't2', task: report('on-track') })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
    expect(repliesCalls).toEqual([]);
  });

  it('404s an id that can’t name a task', async () => {
    // Longer than any opaque id: the service refuses it as `validation`.
    const { detail, getCalls, firesCalls, repliesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
    });
    const captured = await detail({ agentId: 'a1', routineId: 'r'.repeat(300) });
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(getCalls).toHaveLength(1);
    expect(firesCalls).toEqual([]);
    expect(repliesCalls).toEqual([]);
  });

  it.each([
    ['a SafeToolError forbidden', new SafeToolError('forbidden', 'input')],
    ['a SafeToolError not-found', new SafeToolError('not-found', 'routineId')],
    ['a PluginError forbidden', new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' })],
    ['a PluginError not-found', new PluginError({ code: 'not-found', plugin: 'agents', message: 'gone' })],
  ])('404s when routines:get refuses with %s, and reads no history or replies', async (_kind, failure) => {
    const { detail, firesCalls, repliesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      getFailure: failure,
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
    expect(repliesCalls).toEqual([]);
  });

  it.each([
    ['an unavailable service', new SafeToolError('unavailable', 'input'), 'temporarily unavailable'],
    ['any other failure', new Error('connection terminated'), 'connection terminated'],
  ])('fails the page when routines:get fails with %s, rather than calling it missing', async (_kind, failure, message) => {
    const { detail, firesCalls, lastWritten } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      getFailure: failure,
    });
    await expect(detail()).rejects.toThrow(message);
    expect(lastWritten()?.statusCode).not.toBe(404);
    expect(lastWritten()?.body).toBeUndefined();
    expect(firesCalls).toEqual([]);
  });

  it('fences what the agent wrote', async () => {
    const { detail } = setup({
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          task: report('off-track', {
            update: 'first\nsecond',
            ask: 'y'.repeat(600),
            agentNotes: 'line one\nline two \u202E reversed',
          }),
        }),
        stored({
          agentId: 'a1',
          routineId: 't2',
          task: report('off-track', { update: 'x'.repeat(600) }),
        }),
      ],
      fires: [
        fire({ report: { status: 'off-track', update: 'third\nfourth', ask: null, reading: null } }),
        fire({
          firedAt: '2026-10-22T08:57:00.000Z',
          report: { status: 'off-track', update: 'z'.repeat(600), ask: null, reading: null },
        }),
      ],
    });
    const t1 = bodyOf(await detail());
    expect(t1.task?.update).toBe('first second');
    const ask = t1.task?.ask ?? '';
    expect([...ask].length).toBe(ROUTINE_REPORT_ASK_MAX_CHARS);
    expect(ask.endsWith('…')).toBe(true);
    // Lines kept, and a hidden character spelled out where it was, visibly.
    expect(t1.task?.agentNotes).toBe('line one\nline two \\u202e reversed');
    expect(t1.updates[0]?.report?.update).toBe('third fourth');
    const longFromHistory = t1.updates[1]?.report?.update ?? '';
    expect([...longFromHistory].length).toBe(ROUTINE_REPORT_UPDATE_MAX_CHARS);
    expect(longFromHistory.endsWith('…')).toBe(true);

    const t2 = bodyOf(await detail({ agentId: 'a1', routineId: 't2' }));
    const long = t2.task?.update ?? '';
    expect([...long].length).toBe(ROUTINE_REPORT_UPDATE_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('shows every note a check-in can read, even one made of hidden characters', async () => {
    // The check-in message reads the notes' first 2,000 UTF-16 units. Each one
    // here is a character the fence spells out as six, and all of them show.
    const { detail } = setup({
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          task: report('needs-you', { agentNotes: '\u202E'.repeat(ROUTINE_AGENT_NOTES_MAX_CHARS) }),
        }),
      ],
    });
    const notes = bodyOf(await detail()).task?.agentNotes ?? '';
    expect(notes.length).toBe(12_000);
    expect(notes).toBe('\\u202e'.repeat(ROUTINE_AGENT_NOTES_MAX_CHARS));
  });

  it('keeps a failed check-in’s reason to one line, and gives a run that finished none', async () => {
    const { detail } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      fires: [
        fire({ firedAt: '2026-10-22T09:57:00.000Z', status: 'error', error: 'The provider said:\nslow down' }),
        fire({ firedAt: '2026-10-22T08:57:00.000Z', status: 'error', error: 'e'.repeat(300) }),
        fire({ firedAt: '2026-10-22T07:57:00.000Z', status: 'error', error: null }),
        fire({ firedAt: '2026-10-22T06:57:00.000Z', status: 'ok', error: 'STALE-ERROR' }),
        fire({ firedAt: '2026-10-22T05:57:00.000Z', status: 'silenced', error: 'STALE-ERROR' }),
      ],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    const errors = bodyOf(captured).updates.map((u) => u.error);
    expect(errors[0]).toBe('The provider said: slow down');
    expect([...(errors[1] ?? '')].length).toBe(TASK_ERROR_MAX_CHARS);
    expect(errors[1]?.endsWith('…')).toBe(true);
    expect(errors.slice(2)).toEqual([null, null, null]);
    expect(JSON.stringify(captured.body)).not.toContain('STALE-ERROR');
  });

  it('a failed history read fails the page', async () => {
    // "We don't know" must not render as "no updates yet" (design H7).
    const { detail, firesCalls, lastWritten } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      firesFailure: new Error('pool exhausted'),
    });
    await expect(detail()).rejects.toThrow('pool exhausted');
    expect(firesCalls).toHaveLength(1);
    expect(lastWritten()?.statusCode).not.toBe(200);
    expect(lastWritten()?.body).toBeUndefined();
  });

  it('carries the owner’s replies, fenced, newest first, with byYou and nothing else (TASK-931)', async () => {
    const { detail } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      replies: [
        {
          replyId: 'REPLY-ID-1',
          authorUserId: 'alice',
          text: 'Line one.\nLine two.',
          sentAt: '2026-10-22T15:00:00.000Z',
        },
        {
          // Someone else's. routines:recent-replies never answers one (it reads only the
          // current owner's own replies), but the route still says so rather than "You".
          replyId: 'REPLY-ID-2',
          authorUserId: 'carol',
          text: `x${String.fromCodePoint(0x202e)}y`,
          sentAt: '2026-10-22T14:00:00.000Z',
        },
        {
          // Stored text isn't re-checked (TASK-913): nothing legible survives the fence.
          replyId: 'REPLY-ID-3',
          authorUserId: 'alice',
          text: '   ',
          sentAt: '2026-10-22T13:00:00.000Z',
        },
      ],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).replies).toStrictEqual([
      { sentAt: '2026-10-22T15:00:00.000Z', text: 'Line one.\nLine two.', byYou: true },
      // The hidden character spelled out where it was, visibly.
      {
        sentAt: '2026-10-22T14:00:00.000Z',
        text: `x${String.fromCharCode(0x5c)}u202ey`,
        byYou: false,
      },
      { sentAt: '2026-10-22T13:00:00.000Z', text: null, byYou: true },
    ]);
    // Who wrote a reply and its id never leave the host (TASK-931 decisions row 13).
    const wire = JSON.stringify(captured.body);
    for (const marker of ['authorUserId', 'carol', 'REPLY-ID', 'replyId']) {
      expect(wire).not.toContain(marker);
    }
  });

  it('shows the whole of every reply a check-in can read, hidden characters and line breaks included', async () => {
    // A check-in reads a reply's first 2,000 UTF-16 units. A hidden character
    // costs six code points once spelled out, and every line break one line.
    const hidden = String.fromCodePoint(0x202e).repeat(ROUTINE_REPLY_MAX_CHARS);
    const lines = `${'\n'.repeat(ROUTINE_REPLY_MAX_CHARS - 1)}z`;
    const { detail } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      replies: [
        { replyId: 'r1', authorUserId: 'alice', text: hidden, sentAt: '2026-10-22T15:00:00.000Z' },
        { replyId: 'r2', authorUserId: 'alice', text: lines, sentAt: '2026-10-22T14:00:00.000Z' },
      ],
    });
    const [first, second] = bodyOf(await detail()).replies;
    expect(first?.text?.length).toBe(12_000);
    expect(first?.text).toBe(`${String.fromCharCode(0x5c)}u202e`.repeat(ROUTINE_REPLY_MAX_CHARS));
    expect(second?.text).toBe(lines);
  });

  it('asks for the newest 50 replies, as the caller, after the check-ins', async () => {
    const { detail, repliesCalls, order } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(repliesCalls).toEqual([
      { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', routineId: 't1', limit: 50 } },
    ]);
    expect(order).toEqual(['routines:get', 'routines:recent-fires', 'routines:recent-replies']);
  });

  it('without routines:recent-replies the page has no replies', async () => {
    const { detail } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      absent: new Set(['routines:recent-replies']),
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).replies).toEqual([]);
  });

  it('a failed replies read fails the page', async () => {
    // "We don't know" must not render as "no replies" (TASK-910 decisions row 11).
    const { detail, repliesCalls, lastWritten } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      repliesFailure: new Error('replica lag'),
    });
    await expect(detail()).rejects.toThrow('replica lag');
    expect(repliesCalls).toHaveLength(1);
    expect(lastWritten()?.statusCode).not.toBe(200);
    expect(lastWritten()?.body).toBeUndefined();
  });

  it('401s without a session, and reads nothing', async () => {
    const { detail, resolveCalls, getCalls, firesCalls } = setup({
      viewer: null,
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
    expect(firesCalls).toEqual([]);
  });

  it.each([
    ['a blank routine id', { agentId: 'a1', routineId: '  ' }],
    ['a blank agent id', { agentId: ' ', routineId: 't1' }],
    ['no ids at all', {}],
  ])('400s %s, and reads nothing', async (_what, params: Record<string, string>) => {
    const { detail, resolveCalls, getCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
    });
    const captured = await detail(params);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-task-id' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
  });

  it.each([
    [
      'without routines at all',
      [
        'routines:get',
        'routines:recent-fires',
        'routines:clear-notes',
        'routines:recent-replies',
        'routines:reply',
        'routines:set-steps',
        'routines:set-finish-by',
        'routines:complete',
        'routines:reopen',
        'routines:duplicate',
      ],
    ],
    ['without routines:get', ['routines:get']],
    ['without routines:recent-fires', ['routines:recent-fires']],
  ])('404s in a deployment %s, and reads nothing', async (_what, absent) => {
    const { detail, getCalls, firesCalls, repliesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      absent: new Set(absent),
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(getCalls).toEqual([]);
    expect(firesCalls).toEqual([]);
    expect(repliesCalls).toEqual([]);
  });
});

describe('GET /api/workspace/tasks/:agentId/:routineId, missed check-ins (TASK-930)', () => {
  const miss = (over: Partial<NonNullable<StoredRoutine['noRecentUpdate']>> = {}) => ({
    inARow: 3,
    reason: 'no-report' as const,
    at: new Date('2026-10-22T11:00:00.000Z'),
    autoPausedAt: null,
    ...over,
  });
  const noRecentUpdateOf = (c: CapturedRes) => (c.body as TaskDetail).noRecentUpdate;

  it('carries the missed check-ins to the owner, the time as an instant', async () => {
    const { detail } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', noRecentUpdate: miss() })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(noRecentUpdateOf(captured)).toStrictEqual({
      inARow: 3,
      reason: 'no-report',
      at: '2026-10-22T11:00:00.000Z',
      autoPaused: false,
    });
  });

  it('says autoPaused for a task ax paused', async () => {
    const { detail } = setup({
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          enabled: false,
          noRecentUpdate: miss({ inARow: 5, autoPausedAt: new Date('2026-10-22T11:05:00.000Z') }),
        }),
      ],
    });
    expect(noRecentUpdateOf(await detail())).toMatchObject({ inARow: 5, autoPaused: true });
  });

  it('reads a reason the page doesn’t know as failed, field by field', async () => {
    const { detail } = setup({
      unvalidated: true,
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          noRecentUpdate: miss({ reason: 'SOMETHING-NEW' as never }),
        }),
      ],
    });
    expect(noRecentUpdateOf(await detail())).toStrictEqual({
      inARow: 3,
      reason: 'failed',
      at: '2026-10-22T11:00:00.000Z',
      autoPaused: false,
    });
  });

  it.each([
    ['no missed-check-in field at all', undefined],
    ['a zero count', { inARow: 0, reason: 'failed', at: '2026-10-22T11:00:00.000Z', autoPaused: false }],
    ['a time that is not a string', { inARow: 2, reason: 'failed', at: 42, autoPaused: false }],
  ])('reads a view with %s as no miss, not a crash', async (_name, value) => {
    const { detail } = setup({
      unvalidated: true,
      viewMiss: { value },
      rows: [stored({ agentId: 'a1', routineId: 't1' })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(noRecentUpdateOf(captured)).toBeNull();
  });
});

describe("GET /api/workspace/tasks/:agentId/:routineId, the agent's reading (TASK-952)", () => {
  /** A check-in that ended with a report which sent this reading. */
  const firedWith = (firedAt: string, reading: NonNullable<RoutineFireView['report']>['reading']) =>
    fire({ firedAt, report: { status: 'on-track', update: 'Queue is empty.', ask: null, reading } });

  it('carries the reading on the page and on each update, its label fenced to one line of 40 characters', async () => {
    // Stored text isn't re-checked against the writer's rules (TASK-913), and
    // the view schemas check only types, so the route is where a label is fenced.
    const { detail } = setup({
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          task: report('on-track', {
            reading: { value: 3, label: `Open${String.fromCharCode(0x0a)}tickets` },
          }),
        }),
      ],
      fires: [
        firedWith('2026-10-22T09:57:00.000Z', { value: 3, label: 'Open tickets' }),
        firedWith('2026-10-22T08:57:00.000Z', { value: 5, label: 'x'.repeat(50) }),
        firedWith('2026-10-22T07:57:00.000Z', {
          value: 0,
          label: `Open${String.fromCodePoint(0x202e)}tickets`,
        }),
        firedWith('2026-10-22T06:57:00.000Z', {
          value: 9,
          label: String.fromCodePoint(0x200b).repeat(3),
        }),
        firedWith('2026-10-22T05:57:00.000Z', { value: -1.5, label: '<img src=x onerror=alert(1)>' }),
        firedWith('2026-10-22T04:57:00.000Z', null),
      ],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    const body = bodyOf(captured);
    expect(body.task?.reading).toStrictEqual({ label: 'Open tickets', value: 3 });
    expect(body.updates.map((u) => u.report?.reading)).toStrictEqual([
      { label: 'Open tickets', value: 3 },
      { label: `${'x'.repeat(39)}…`, value: 5 },
      { label: 'Open tickets', value: 0 },
      // Nothing legible is left to say what was counted, so no reading crosses.
      null,
      // Markup is only text: it crosses as written, and the page draws it as text.
      { label: '<img src=x onerror=alert(1)>', value: -1.5 },
      null,
    ]);
    // A reading that didn't cross leaves its report alone.
    expect(body.updates[3]?.report?.update).toBe('Queue is empty.');
  });

  it.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['an infinity', Number.POSITIVE_INFINITY],
    ['a number written as text', '3'],
  ])('drops a reading whose value is %s, on the page and on its update, and keeps both reports', async (_what, value) => {
    // Views the schemas didn't parse reach the route as they are (TASK-913's shape).
    const reading = { value: value as number, label: 'Open tickets' };
    const { detail } = setup({
      unvalidated: true,
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track', { reading }) })],
      fires: [firedWith('2026-10-22T09:57:00.000Z', reading)],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    const body = bodyOf(captured);
    expect(body.task?.update).toBe('Queue is empty.');
    expect(body.task?.reading).toBeNull();
    expect(body.updates[0]?.report?.update).toBe('Queue is empty.');
    expect(body.updates[0]?.report?.reading).toBeNull();
  });
});

/** A get-done task of alice's that checks in on Los Angeles time, to be finished by 14 November (TASK-951). */
function laTask(over: Partial<StoredRoutine> = {}): StoredRoutine {
  return stored({
    agentId: 'a1',
    routineId: 't1',
    kind: 'get-done',
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/Los_Angeles' },
    finishBy: '2026-11-14',
    ...over,
  });
}

/** 18:00 on 4 November in Los Angeles, when it is already the 5th in UTC (TASK-951). */
const LA_EVENING = (): Date => new Date('2026-11-05T02:00:00.000Z');

describe('GET /api/workspace/tasks/:agentId/:routineId, the finish date (TASK-951)', () => {
  it("a get-done task's page carries its finish date and the days left in the task's own time zone (TASK-951)", async () => {
    const { detail } = setup({ rows: [laTask()], now: LA_EVENING });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    // Still the 4th in Los Angeles: 10 days. UTC, already on the 5th, would count 9.
    expect(bodyOf(captured).finishBy).toStrictEqual({ date: '2026-11-14', daysLeft: 10 });
  });

  it('a get-done task without a finish date has none on its page', async () => {
    const { detail } = setup({ rows: [laTask({ finishBy: null })], now: LA_EVENING });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).finishBy).toBeNull();
  });

  it('a stay-on-top task’s page shows no finish date, even when its view carries one', async () => {
    // A view the schema didn't parse (TASK-913's shape). routines' own view
    // already leaves a stay-on-top task's date out, so this pins the route's
    // own kind gate.
    const { detail } = setup({
      unvalidated: true,
      viewPatch: { finishBy: '2026-11-14' },
      rows: [stored({ agentId: 'a1', routineId: 't1' })],
      now: LA_EVENING,
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).finishBy).toBeNull();
  });

  it.each<[string, unknown]>([
    ['a month no calendar has', '2026-13-45'],
    ['a day its month doesn’t have', '2026-02-30'],
    ['a date in words', 'Nov 14'],
    ['a number', 14],
  ])('a finish date the contract refuses reaches the page as none (%s)', async (_what, finishBy) => {
    // Views the schema didn't parse (TASK-913's shape). Intl throws on a day no
    // calendar has, so a page drawing one would crash; it answers as no date.
    const { detail } = setup({
      unvalidated: true,
      viewPatch: { finishBy },
      rows: [laTask()],
      now: LA_EVENING,
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).finishBy).toBeNull();
  });

  it('a finish date on a task whose time zone this host doesn’t know reads as none, and the page still answers', async () => {
    // A view the schema didn't parse (TASK-913's shape). A parsed view's zone
    // was checked on this runtime; counting in an unknown one would throw.
    const { detail } = setup({
      unvalidated: true,
      viewPatch: { schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Olympus_Mons' } },
      rows: [laTask()],
      now: LA_EVENING,
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).finishBy).toBeNull();
  });
});

/**
 * TASK-955's boundary: Sunday 25 October, set from Los Angeles, on a task with
 * no zone of its own, read at 01:00 UTC on the 26th: 18:00 that Sunday in Los
 * Angeles, when UTC's calendar is already on Monday.
 */
const zonelessLaTask = (): StoredRoutine =>
  laTask({
    schedule: { kind: 'interval', every: '1h' },
    finishBy: '2026-10-25',
    finishByTimeZone: 'America/Los_Angeles',
  });
const AT_BOUNDARY = (): Date => new Date('2026-10-26T01:00:00.000Z');
/** A task with no zone of its own and no date yet, so no zone stored either: the PUT's (TASK-955). */
const undatedZonelessTask = (): StoredRoutine =>
  laTask({ schedule: { kind: 'interval', every: '1h' }, finishBy: null });

/** The warn lines the PUT route writes about a zone the browser sent that it couldn't use (TASK-955). */
function zoneWarnings(warn: { mock: { calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.filter(([event]) => event === 'workspace_finish_by_zone_unusable');
}

describe('GET /api/workspace/tasks/:agentId/:routineId, the zone a finish date was set from (TASK-955)', () => {
  it('at the boundary, a zoneless task’s page counts on the calendar its date was set from, as the brief and the row do (TASK-955)', async () => {
    const { detail } = setup({ rows: [zonelessLaTask()], now: AT_BOUNDARY });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    // Due today. UTC's calendar, already on Monday, would count a day past.
    expect(bodyOf(captured).finishBy).toStrictEqual({ date: '2026-10-25', daysLeft: 0 });
  });

  it.each<[string, unknown]>([
    ['a zone no calendar has', 'Mars/Olympus_Mons'],
    ['a number', 5],
  ])('a stored zone the contract refuses counts on UTC rather than hiding the date (%s) (TASK-955)', async (_what, value) => {
    // A view the schema didn't parse (TASK-913's shape). Counting in a zone
    // Intl doesn't know would throw; the zone is only the fallback, so the date
    // still shows, counted on UTC's calendar.
    const { detail } = setup({
      unvalidated: true,
      viewPatch: { finishByTimeZone: value },
      rows: [zonelessLaTask()],
      now: AT_BOUNDARY,
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).finishBy).toStrictEqual({ date: '2026-10-25', daysLeft: -1 });
  });
});

describe('GET /api/workspace/tasks/:agentId/:routineId, the page carries doneAt and the claim (TASK-950)', () => {
  it('a claimed get-done task carries its claim, and isn’t done', async () => {
    const { detail } = setup({ rows: [claimed()] });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).task?.doneClaimed).toBe(true);
    expect(bodyOf(captured).doneAt).toBeNull();
  });

  it('a Done task carries when it was marked done, and never who marked it', async () => {
    // The routines view never names the completer, so the route's own mapping is what's tested:
    // a view the schema didn't parse (TASK-913's shape) that does name one.
    const { detail } = setup({
      unvalidated: true,
      viewPatch: { done: { at: '2026-10-23T10:00:00.000Z', byUserId: 'alice' } },
      rows: [markedDone()],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).doneAt).toBe('2026-10-23T10:00:00.000Z');
    expect(bodyOf(captured).task?.doneClaimed).toBe(false);
    expect(JSON.stringify(captured.body)).not.toContain('byUserId');
    expect(Object.keys(bodyOf(captured))).not.toContain('done');
  });

  it.each<[string, unknown]>([
    ['not an object', 'nope'],
    ['an object without a time', {}],
    ['a time that isn’t text', { at: 7 }],
    ['missing', undefined],
  ])('reads a done that is %s as not done, not a crash', async (_what, done) => {
    // A view the schema didn't parse (TASK-913's shape).
    const { detail } = setup({ unvalidated: true, viewPatch: { done }, rows: [markedDone()] });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).doneAt).toBeNull();
  });

  it('reads a task of any kind but get-done as not done, whatever its view says', async () => {
    // routines sends `done` only for a get-done task; a view the schema didn't parse can still
    // carry one. Only a get-done task is ever Done, here as on the reopen route.
    const { detail } = setup({
      unvalidated: true,
      viewPatch: { done: { at: '2026-10-23T10:00:00.000Z' } },
      rows: [stored({ agentId: 'a1', routineId: 't1', enabled: false, task: report('on-track') })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).kind).toBe('stay-on-top');
    expect(bodyOf(captured).doneAt).toBeNull();
  });

  it('reads anything but a literal true as no claim', async () => {
    const { detail } = setup({
      unvalidated: true,
      viewPatch: {
        task: {
          status: 'needs-you',
          update: 'Every article is exported.',
          ask: null,
          reading: null,
          doneClaimed: 'yes',
          reportedAt: '2026-10-22T09:58:00.000Z',
          agentNotes: null,
        },
      },
      rows: [claimed()],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).task?.doneClaimed).toBe(false);
  });
});

describe('DELETE /api/workspace/tasks/:agentId/:routineId/notes (TASK-910)', () => {
  it('clears the notes as the caller', async () => {
    const { clear, clearCalls } = setup();
    const captured = await clear();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ cleared: true });
    expect(clearCalls).toEqual([{ userId: 'alice', agentId: 'a1', input: KEY }]);
  });

  it.each([
    ['forbidden', new SafeToolError('forbidden', 'input')],
    ['not-found', new SafeToolError('not-found', 'routineId')],
  ])('404s when the service refuses (%s)', async (_code, failure) => {
    const { clear, clearCalls } = setup({ clearFailure: failure });
    const captured = await clear();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(clearCalls).toHaveLength(1);
  });

  it('fails the request on any other failure, rather than saying it cleared', async () => {
    const { clear, lastWritten } = setup({ clearFailure: new Error('connection terminated') });
    await expect(clear()).rejects.toThrow('connection terminated');
    expect(lastWritten()?.statusCode).not.toBe(200);
    expect(lastWritten()?.body).toBeUndefined();
  });

  it('404s an agent the caller can’t reach, without asking to clear', async () => {
    const { clear, clearCalls } = setup({ viewer: 'bob' });
    const captured = await clear();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(clearCalls).toEqual([]);
  });

  it('503s without routines:clear-notes', async () => {
    const { clear } = setup({ absent: new Set(['routines:clear-notes']) });
    const captured = await clear();
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'task-notes-unavailable' });
  });

  it('401s without a session', async () => {
    const { clear, resolveCalls, clearCalls } = setup({ viewer: null });
    const captured = await clear();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(clearCalls).toEqual([]);
  });

  it('400s a blank id, without asking to clear', async () => {
    const { clear, clearCalls } = setup();
    const captured = await clear({ agentId: 'a1', routineId: ' ' });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-task-id' });
    expect(clearCalls).toEqual([]);
  });
});

describe('POST /api/workspace/tasks/:agentId/:routineId/replies (TASK-931)', () => {
  it('sends the reply as the caller and answers what it did about a check-in', async () => {
    const { reply, replyCalls } = setup();
    // The address names the task. Nothing else in the body rides along.
    const captured = await reply(KEY, { ...SENT, agentId: 'zzz', admin: true });
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ checkIn: 'started' });
    expect(replyCalls).toStrictEqual([
      {
        userId: 'alice',
        agentId: 'a1',
        input: {
          agentId: 'a1',
          routineId: 't1',
          requestId: 'req-1',
          text: 'Refunds under $100 are fine.',
        },
      },
    ]);
  });

  it.each(['paused', 'not-allowed', 'replayed'] as const)(
    'answers %s when that is what the service did',
    async (checkIn) => {
      const { reply } = setup({ replyAnswer: { replyId: 'REPLY-ID-0', checkIn } });
      const captured = await reply();
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toStrictEqual({ checkIn });
    },
  );

  it.each<[string, Buffer]>([
    ['an unparseable body', Buffer.from('{"text": "Refunds', 'utf-8')],
    ['no body at all', Buffer.alloc(0)],
  ])('400s %s as invalid-json, and asks no one', async (_what, raw) => {
    const { reply, resolveCalls, replyCalls } = setup();
    const captured = await reply(KEY, raw);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-json' });
    expect(resolveCalls).toEqual([]);
    expect(replyCalls).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a list', []],
    ['null', null],
    ['an empty object', {}],
    ['text that isn’t text', { text: 3, requestId: 'r' }],
    ['no request id', { text: 'hi' }],
    ['an empty request id', { text: 'hi', requestId: '' }],
    ['a request id that isn’t text', { text: 'hi', requestId: 7 }],
  ])('400s a body that is %s as invalid-body, and asks no one', async (_what, body) => {
    const { reply, resolveCalls, replyCalls } = setup();
    const captured = await reply(KEY, body);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-body' });
    expect(resolveCalls).toEqual([]);
    expect(replyCalls).toEqual([]);
  });

  it.each<[string, string]>([
    ['a blank reply', '   '],
    ['a reply over 2,000 characters', 'x'.repeat(ROUTINE_REPLY_MAX_CHARS + 1)],
    ['a reply with an invisible character', `a${String.fromCodePoint(0x200b)}b`],
  ])('400s text the service refuses (%s) as reply-invalid', async (_what, text) => {
    const { reply, replyCalls } = setup();
    const captured = await reply(KEY, { text, requestId: 'req-1' });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'reply-invalid' });
    expect(replyCalls).toHaveLength(1);
  });

  it.each([
    ['a SafeToolError forbidden', new SafeToolError('forbidden', 'input')],
    ['a SafeToolError not-found', new SafeToolError('not-found', 'routineId')],
    ['a PluginError not-found', new PluginError({ code: 'not-found', plugin: 'agents', message: 'gone' })],
  ])('404s when the service refuses with %s', async (_kind, failure) => {
    const { reply, replyCalls } = setup({ replyFailure: failure });
    const captured = await reply();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(replyCalls).toHaveLength(1);
  });

  it('404s an agent the caller can’t reach, without asking to reply', async () => {
    const { reply, resolveCalls, replyCalls } = setup({ viewer: 'mallory' });
    const captured = await reply();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'mallory' }]);
    expect(replyCalls).toEqual([]);
  });

  it('503s without routines:reply, before reading the agent', async () => {
    const { reply, resolveCalls } = setup({ absent: new Set(['routines:reply']) });
    const captured = await reply();
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'task-replies-unavailable' });
    expect(resolveCalls).toEqual([]);
  });

  it('401s without a session, and asks no one', async () => {
    const { reply, resolveCalls, replyCalls } = setup({ viewer: null });
    const captured = await reply();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(replyCalls).toEqual([]);
  });

  it('400s a blank id, and asks no one', async () => {
    const { reply, resolveCalls, replyCalls } = setup();
    const captured = await reply({ agentId: 'a1', routineId: ' ' });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-task-id' });
    expect(resolveCalls).toEqual([]);
    expect(replyCalls).toEqual([]);
  });

  it.each([
    ['an unavailable service', new SafeToolError('unavailable', 'input'), 'temporarily unavailable'],
    ['any other failure', new Error('database down'), 'database down'],
  ])(
    'fails the request when the service fails with %s, rather than saying it was sent',
    async (_kind, failure, message) => {
      const { reply, replyCalls, lastWritten } = setup({ replyFailure: failure });
      await expect(reply()).rejects.toThrow(message);
      expect(replyCalls).toHaveLength(1);
      expect(lastWritten()?.statusCode).not.toBe(200);
      expect(lastWritten()?.body).toBeUndefined();
    },
  );
});

describe('POST /api/workspace/tasks/:agentId/:routineId/steps (TASK-949)', () => {
  it('401s without a session, and reads nothing', async () => {
    const { steps, resolveCalls, stepsCalls } = setup({ viewer: null });
    const captured = await steps();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(stepsCalls).toEqual([]);
  });

  it('400s a missing id, and reads nothing', async () => {
    const { steps, resolveCalls, stepsCalls } = setup();
    const captured = await steps({ agentId: 'a1', routineId: ' ' });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-task-id' });
    expect(resolveCalls).toEqual([]);
    expect(stepsCalls).toEqual([]);
  });

  it.each<[string, Buffer]>([
    ['an unparseable body', Buffer.from('{"requestId": "req-1", "ops": [', 'utf-8')],
    ['no body at all', Buffer.alloc(0)],
  ])('400s %s as invalid-json, and reads nothing', async (_what, raw) => {
    const { steps, resolveCalls, stepsCalls } = setup();
    const captured = await steps(KEY, raw);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-json' });
    expect(resolveCalls).toEqual([]);
    expect(stepsCalls).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a list', []],
    ['null', null],
    ['no request id', { ops: [] }],
    ['an empty request id', { requestId: '', ops: [] }],
    ['a request id that isn’t text', { requestId: 7, ops: [ADD] }],
    ['changes that aren’t a list', { requestId: 'q', ops: 'add' }],
  ])(
    '400s a body that is %s as invalid-body, before the hook or the agent is read',
    async (_what, body) => {
      const { steps, resolveCalls, stepsCalls } = setup();
      const captured = await steps(KEY, body);
      expect(captured.statusCode).toBe(400);
      expect(captured.body).toEqual({ error: 'invalid-body' });
      expect(resolveCalls).toEqual([]);
      expect(stepsCalls).toEqual([]);
    },
  );

  it('503s without routines:set-steps, before reading the agent', async () => {
    const { steps, resolveCalls } = setup({ absent: new Set(['routines:set-steps']) });
    const captured = await steps();
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'task-steps-unavailable' });
    expect(resolveCalls).toEqual([]);
  });

  it('404s someone agents:resolve refuses, and never calls the hook', async () => {
    const { steps, resolveCalls, stepsCalls } = setup({ viewer: 'mallory' });
    const captured = await steps();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'mallory' }]);
    expect(stepsCalls).toEqual([]);
  });

  it.each([
    ['a task that isn’t get-done, or isn’t there', new SafeToolError('not-found', 'routineId')],
    ['someone else’s task', new SafeToolError('forbidden', 'input')],
    // TASK-950: the service's refusal of a Done task's steps, the same `forbidden`, so it reads as the page's own
    // 404 and the page reads the task again (TaskSteps' onRefused). A mapping pin only: this row is the one above,
    // and passes whichever refusal the service throws. That a Done task's steps ARE refused `forbidden` is the
    // store's and the service's to prove (set-steps-store.test.ts, the routines services tests).
    ['a Done task’s steps', new SafeToolError('forbidden', 'input')],
    ['an agent it can no longer reach', new PluginError({ code: 'not-found', plugin: 'agents', message: 'gone' })],
  ])('404s %s as task-not-found', async (_what, failure) => {
    const { steps, stepsCalls } = setup({ stepsFailure: failure });
    const captured = await steps();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(stepsCalls).toHaveLength(1);
  });

  it.each<[string, unknown[]]>([
    ['no changes at all', []],
    ['a blank step', [{ op: 'add', text: '   ' }]],
    ['a step with an invisible character', [{ op: 'add', text: `a${String.fromCodePoint(0x200b)}b` }]],
    ['a step over 200 characters', [{ op: 'add', text: 'x'.repeat(ROUTINE_STEP_TEXT_MAX_CHARS + 1) }]],
    ['a change it doesn’t know', [{ op: 'rename' }]],
    ['a change that says who added the step', [{ ...ADD, addedBy: 'person' }]],
  ])('400s %s as steps-invalid: the contract refuses it', async (_what, ops) => {
    const { steps, stepsCalls } = setup();
    const captured = await steps(KEY, { requestId: 'req-1', ops });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'steps-invalid' });
    expect(stepsCalls).toHaveLength(1);
  });

  it.each([
    [
      'a request id already used for another change',
      new SafeToolError('request-conflict', 'requestId'),
      'This request ID was used for different input.',
    ],
    ['any other failure', new Error('boom'), 'boom'],
  ])(
    'fails the request when the service fails with %s, rather than answering any steps',
    async (_kind, failure, message) => {
      const { steps, stepsCalls, lastWritten } = setup({ stepsFailure: failure });
      await expect(steps()).rejects.toThrow(message);
      expect(stepsCalls).toHaveLength(1);
      expect(lastWritten()?.statusCode).not.toBe(200);
      expect(lastWritten()?.body).toBeUndefined();
    },
  );

  it('calls the hook as the caller, with the address’s ids and only the request id and the changes', async () => {
    const { steps, resolveCalls, stepsCalls, order } = setup();
    // The address names the task. Nothing else in the body rides along.
    const captured = await steps(KEY, { requestId: 'q', ops: [ADD], agentId: 'other', extra: 1 });
    expect(captured.statusCode).toBe(200);
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'alice' }]);
    expect(stepsCalls).toStrictEqual([
      {
        userId: 'alice',
        agentId: 'a1',
        input: { agentId: 'a1', routineId: 't1', requestId: 'q', ops: [ADD] },
      },
    ]);
    // It reads nothing first: the service decides ownership under the row lock.
    expect(order).toEqual(['routines:set-steps']);
  });

  it('answers each step as the task page draws it, and the count', async () => {
    // Agent-written text past the writer's cap (TASK-913: stored text isn't
    // re-checked), with a run of spaces and markup in it.
    const long = `<img src=x>${' '.repeat(4)}${'x'.repeat(285)}`;
    const answered: RoutineSetStepsOutput['steps'] = [
      { id: 'sbbbbbb', text: 'Ask Dana to review billing', done: false, addedBy: 'person' },
      { id: 'saaaaaa', text: long, done: true, addedBy: 'agent' },
    ];
    const { steps, detail } = setup({
      stepsAnswer: { steps: answered, skipped: 2 },
      rows: [stored({ agentId: 'a1', routineId: 't1', kind: 'get-done', steps: answered })],
    });
    const changed = await steps();
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toStrictEqual({
      steps: [
        { id: 'sbbbbbb', text: 'Ask Dana to review billing', done: false, byAgent: false },
        // One line, and at least what a check-in reads: 200 characters, then "…". Markup is only text.
        { id: 'saaaaaa', text: `<img src=x> ${'x'.repeat(188)}…`, done: true, byAgent: true },
      ],
      skipped: 2,
    } satisfies TaskStepsResponse);
    // One builder for both: the page's own read draws the same steps the same way.
    const read = await detail();
    expect(read.statusCode).toBe(200);
    expect((changed.body as TaskStepsResponse).steps).toStrictEqual(bodyOf(read).steps);
  });

  it('leaves out an answered step it can’t read, rather than failing the change', async () => {
    // An answer the bus didn't parse (TASK-913's shape) is read as leniently as a view.
    const { steps } = setup({
      unvalidated: true,
      stepsAnswer: {
        steps: [
          { id: 's1', text: 'Ask Dana to review billing', done: false, addedBy: 'person' },
          { id: 7, text: 'An id that isn’t one', done: false, addedBy: 'agent' },
          { id: 's3', text: 'No author', done: false },
          'not a step',
        ] as unknown as RoutineSetStepsOutput['steps'],
        skipped: 1,
      },
    });
    const captured = await steps();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({
      steps: [{ id: 's1', text: 'Ask Dana to review billing', done: false, byAgent: false }],
      skipped: 1,
    });
  });
});

describe('PUT /api/workspace/tasks/:agentId/:routineId/finish-by (TASK-951)', () => {
  it('sets the date as the caller, and answers it with the days left in the task’s own time zone', async () => {
    const { finishBy, finishByCalls, order } = setup({
      rows: [laTask({ finishBy: null })],
      now: LA_EVENING,
    });
    // The address names the task. Nothing else in the body rides along.
    const captured = await finishBy(KEY, { finishBy: '2026-11-14', extra: 1 });
    expect(captured.statusCode).toBe(200);
    // Still the 4th in Los Angeles: 10 days. UTC, already on the 5th, would count 9.
    expect(captured.body).toStrictEqual({
      finishBy: { date: '2026-11-14', daysLeft: 10 },
    } satisfies TaskFinishByResponse);
    expect(finishByCalls).toStrictEqual([
      {
        userId: 'alice',
        agentId: 'a1',
        input: { agentId: 'a1', routineId: 't1', finishBy: '2026-11-14' },
      },
    ]);
    // The task is read first: its time zone counts the days, and its 404s are the page's.
    expect(order).toEqual(['routines:get', 'routines:set-finish-by']);
  });

  it('answers the date the service saved even when the view read before it was not get-done', async () => {
    // The service saves only on a get-done task, under its row lock, so its success proves the
    // kind. The view read first can be older than that lock, and the kind can change in between,
    // so the answer must not be gated on it.
    const { finishBy } = setup({
      rows: [laTask({ kind: 'stay-on-top', finishBy: null })],
      now: LA_EVENING,
    });
    const captured = await finishBy(KEY, { finishBy: '2026-11-14' });
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({
      finishBy: { date: '2026-11-14', daysLeft: 10 },
    } satisfies TaskFinishByResponse);
  });

  it('answers the days left in the zone the service saved, not the one the page read before (TASK-955)', async () => {
    // The view read first holds Los Angeles. This body sends no zone, so the
    // service saves none, and the answer counts on UTC's calendar, as the next
    // read will.
    const { finishBy, finishByCalls } = setup({ rows: [zonelessLaTask()], now: AT_BOUNDARY });
    const captured = await finishBy(KEY, { finishBy: '2026-10-25' });
    expect(captured.statusCode).toBe(200);
    expect(finishByCalls).toHaveLength(1);
    expect(captured.body).toStrictEqual({
      finishBy: { date: '2026-10-25', daysLeft: -1 },
    } satisfies TaskFinishByResponse);
  });

  it('sends the zone the browser named with the date, and answers the days left on that calendar (TASK-955)', async () => {
    const warn = vi.spyOn(initCtx.logger, 'warn').mockImplementation(() => {});
    try {
      const { finishBy, finishByCalls } = setup({ rows: [undatedZonelessTask()], now: AT_BOUNDARY });
      const captured = await finishBy(KEY, { finishBy: '2026-10-25', timeZone: 'America/Los_Angeles' });
      expect(captured.statusCode).toBe(200);
      expect(finishByCalls.map((call) => call.input)).toStrictEqual([
        { agentId: 'a1', routineId: 't1', finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' },
      ]);
      // Due today on the calendar it was set from. UTC's, already on Monday, would count a day past.
      expect(captured.body).toStrictEqual({
        finishBy: { date: '2026-10-25', daysLeft: 0 },
      } satisfies TaskFinishByResponse);
      expect(zoneWarnings(warn)).toStrictEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ['no zone', { finishBy: '2026-10-25' }],
    ['a null zone', { finishBy: '2026-10-25', timeZone: null }],
  ])('a body with %s sends none, and the answer counts on UTC’s calendar (TASK-955)', async (_what, body) => {
    const warn = vi.spyOn(initCtx.logger, 'warn').mockImplementation(() => {});
    try {
      const { finishBy, finishByCalls } = setup({ rows: [undatedZonelessTask()], now: AT_BOUNDARY });
      const captured = await finishBy(KEY, body);
      expect(captured.statusCode).toBe(200);
      // No `finishByTimeZone` key at all, not a null one.
      expect(finishByCalls.map((call) => call.input)).toStrictEqual([
        { agentId: 'a1', routineId: 't1', finishBy: '2026-10-25' },
      ]);
      expect(captured.body).toStrictEqual({
        finishBy: { date: '2026-10-25', daysLeft: -1 },
      } satisfies TaskFinishByResponse);
      expect(zoneWarnings(warn)).toStrictEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a zone this host can’t count in saves the date without it, counted on UTC, and says so in ids only (TASK-955)', async () => {
    // The browser's time-zone data can know a zone this host's doesn't. The
    // person never typed it, so it doesn't cost them their date.
    const warn = vi.spyOn(initCtx.logger, 'warn').mockImplementation(() => {});
    try {
      const { finishBy, finishByCalls } = setup({ rows: [undatedZonelessTask()], now: AT_BOUNDARY });
      const captured = await finishBy(KEY, { finishBy: '2026-10-25', timeZone: 'Mars/Olympus_Mons' });
      expect(captured.statusCode).toBe(200);
      expect(finishByCalls.map((call) => call.input)).toStrictEqual([
        { agentId: 'a1', routineId: 't1', finishBy: '2026-10-25' },
      ]);
      expect(captured.body).toStrictEqual({
        finishBy: { date: '2026-10-25', daysLeft: -1 },
      } satisfies TaskFinishByResponse);
      expect(zoneWarnings(warn)).toStrictEqual([
        ['workspace_finish_by_zone_unusable', { agentId: 'a1', routineId: 't1' }],
      ]);
      // Ids only: never the zone, never the date.
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Mars');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('2026-10-25');
    } finally {
      warn.mockRestore();
    }
  });

  it.each<[string, Partial<World>, Key]>([
    ['someone who can’t reach the agent', { viewer: 'mallory', rows: [undatedZonelessTask()] }, KEY],
    [
      'a teammate, on someone else’s task',
      {
        agents: TEAM_AGENTS,
        managers: { team: ['alice', 'bob'] },
        rows: [laTask({ agentId: 'team', routineId: 'tB', ownerUserId: 'bob' })],
      },
      { agentId: 'team', routineId: 'tB' },
    ],
  ])('a zone this host can’t count in, sent by %s, is the page’s 404 and leaves no warn line (TASK-955)', async (_what, world, key) => {
    // The zone is looked at only once the task is the caller's own, so the line
    // always names a task whose owner's browser sent it.
    const warn = vi.spyOn(initCtx.logger, 'warn').mockImplementation(() => {});
    try {
      const { finishBy, finishByCalls } = setup(world);
      const captured = await finishBy(key, { finishBy: '2026-10-25', timeZone: 'Mars/Olympus_Mons' });
      expect(captured.statusCode).toBe(404);
      expect(finishByCalls).toEqual([]);
      expect(zoneWarnings(warn)).toStrictEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it.each<[string, unknown]>([
    ['a number', 5],
    ['an object', { tz: 'UTC' }],
  ])('a timeZone that is %s, not text, is a bad body, and nothing is asked (TASK-955)', async (_what, timeZone) => {
    const { finishBy, resolveCalls, order } = setup({ rows: [undatedZonelessTask()], now: AT_BOUNDARY });
    const captured = await finishBy(KEY, { finishBy: '2026-10-25', timeZone });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'finish-by-body-invalid' });
    expect(resolveCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it('removes the date, and answers none', async () => {
    const { finishBy, finishByCalls } = setup({ rows: [laTask()], now: LA_EVENING });
    const captured = await finishBy(KEY, { finishBy: null });
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ finishBy: null } satisfies TaskFinishByResponse);
    expect(finishByCalls).toStrictEqual([
      { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', routineId: 't1', finishBy: null } },
    ]);
  });

  it('401s without a session, and asks no one', async () => {
    const { finishBy, resolveCalls, order } = setup({ viewer: null, rows: [laTask()] });
    const captured = await finishBy();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it.each([
    ['a blank routine id', { agentId: 'a1', routineId: '  ' }],
    ['a blank agent id', { agentId: ' ', routineId: 't1' }],
    ['no ids at all', {}],
  ])('400s %s, and asks no one', async (_what, params: Record<string, string>) => {
    const { finishBy, resolveCalls, order } = setup({ rows: [laTask()] });
    const captured = await finishBy(params);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-task-id' });
    expect(resolveCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['not JSON', Buffer.from('not json', 'utf-8')],
    ['no body at all', Buffer.alloc(0)],
    ['an empty object', {}],
    ['a date that isn’t text', { finishBy: 14 }],
    ['a list', []],
    ['null', null],
  ])('400s a body that is %s as finish-by-body-invalid, and asks no one', async (_what, body) => {
    const { finishBy, resolveCalls, order } = setup({ rows: [laTask()] });
    const captured = await finishBy(KEY, body);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'finish-by-body-invalid' });
    expect(resolveCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it('503s without routines:set-finish-by, and reads nothing', async () => {
    const { finishBy, resolveCalls, order } = setup({
      rows: [laTask()],
      absent: new Set(['routines:set-finish-by']),
    });
    const captured = await finishBy();
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'task-finish-by-unavailable' });
    expect(resolveCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it('404s an agent the caller can’t reach, and reads or sets nothing', async () => {
    const { finishBy, resolveCalls, order } = setup({ viewer: 'mallory', rows: [laTask()] });
    const captured = await finishBy();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'mallory' }]);
    expect(order).toEqual([]);
  });

  it.each<[string, Partial<World>, Key]>([
    [
      'someone else’s task on a team agent',
      {
        agents: TEAM_AGENTS,
        managers: { team: ['alice', 'bob'] },
        rows: [laTask({ agentId: 'team', routineId: 'tB', ownerUserId: 'bob' })],
      },
      { agentId: 'team', routineId: 'tB' },
    ],
    [
      'a repeat routine',
      { rows: [stored({ agentId: 'a1', routineId: 't1', kind: 'repeat', goodWhen: null })] },
      KEY,
    ],
    ['a routine that isn’t there', { rows: [] }, KEY],
  ])('404s %s as task-not-found, and never asks to set a date', async (_what, world, key) => {
    const { finishBy, finishByCalls } = setup(world);
    const captured = await finishBy(key);
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(finishByCalls).toEqual([]);
  });

  it.each([
    ['not-found (a task that isn’t get-done)', new SafeToolError('not-found', 'routineId')],
    ['forbidden', new SafeToolError('forbidden', 'input')],
  ])('404s when the service refuses with %s', async (_what, failure) => {
    const { finishBy, finishByCalls } = setup({ rows: [laTask()], finishByFailure: failure });
    const captured = await finishBy();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(finishByCalls).toHaveLength(1);
  });

  it('400s a date the contract’s rule refuses as finish-by-invalid', async () => {
    // The route checks only that the date is text. The service's input check,
    // the contract's rule, refuses a day no calendar has.
    const { finishBy, finishByCalls } = setup({ rows: [laTask()] });
    const captured = await finishBy(KEY, { finishBy: '2026-02-30' });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'finish-by-invalid' });
    expect(finishByCalls).toHaveLength(1);
  });

  it.each([
    ['an unavailable service', new SafeToolError('unavailable', 'input'), 'temporarily unavailable'],
    ['any other failure', new Error('db down'), 'db down'],
  ])(
    'fails the request when the service fails with %s, rather than calling the task missing',
    async (_what, failure, message) => {
      // "We don't know" must not read as "not found" (TASK-910 decisions row 11).
      const { finishBy, finishByCalls, lastWritten } = setup({
        rows: [laTask()],
        finishByFailure: failure,
      });
      await expect(finishBy()).rejects.toThrow(message);
      expect(finishByCalls).toHaveLength(1);
      expect(lastWritten()?.statusCode).not.toBe(200);
      expect(lastWritten()?.body).toBeUndefined();
    },
  );
});

describe('POST /api/workspace/tasks/:agentId/:routineId/complete (TASK-950)', () => {
  it('reads the task, then marks it done as the caller, and answers done', async () => {
    const { complete, completeCalls, order } = setup({ rows: [claimed()] });
    // The address names the task. Nothing else in the body rides along.
    const captured = await complete(KEY, { ...PRESS, agentId: 'zzz', admin: true });
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ done: true });
    expect(completeCalls).toStrictEqual([
      {
        userId: 'alice',
        agentId: 'a1',
        input: { agentId: 'a1', routineId: 't1', requestId: 'req-1' },
      },
    ]);
    expect(order).toEqual(['routines:get', 'routines:complete']);
  });

  it('403s an owner who no longer manages the agent’s tasks, without asking to mark it done', async () => {
    // Her task has reported, so it is still hers (`isOwnTask`): only an owner
    // may learn she can't.
    const { complete, completeCalls } = setup({ managers: { a1: [] }, rows: [claimed()] });
    const captured = await complete();
    expect(captured.statusCode).toBe(403);
    expect(captured.body).toEqual({ error: 'task-done-not-allowed' });
    expect(completeCalls).toEqual([]);
  });

  it.each([
    ['who manages the agent’s tasks', ['alice']],
    ['who doesn’t manage the agent’s tasks', []],
  ])(
    '404s a task of any other kind to its owner %s, never 403, and never asks',
    async (_who, managers) => {
      // Only a get-done task can be marked done: the store's own refusal of any other kind is a 404.
      const { complete, completeCalls } = setup({
        managers: { a1: managers },
        rows: [claimed({ kind: 'stay-on-top', task: report('needs-you') })],
      });
      const captured = await complete();
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'task-not-found' });
      expect(completeCalls).toEqual([]);
    },
  );

  it('403s when the service refuses it as forbidden (edit taken away since the read)', async () => {
    const { complete, completeCalls } = setup({
      rows: [claimed()],
      completeFailure: new SafeToolError('forbidden', 'input'),
    });
    const captured = await complete();
    expect(captured.statusCode).toBe(403);
    expect(captured.body).toEqual({ error: 'task-done-not-allowed' });
    expect(completeCalls).toHaveLength(1);
  });

  it.each([
    ['who manages the agent’s tasks', ['alice', 'bob']],
    ['who doesn’t manage the agent’s tasks', ['bob']],
  ])(
    '404s someone else’s task on a team agent, never 403, to a teammate %s, and never asks',
    async (_who, managers) => {
      const { complete, completeCalls } = setup({
        agents: TEAM_AGENTS,
        managers: { team: managers },
        rows: [claimed({ agentId: 'team', routineId: 'tB', ownerUserId: 'bob' })],
      });
      const captured = await complete({ agentId: 'team', routineId: 'tB' });
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'task-not-found' });
      expect(completeCalls).toEqual([]);
    },
  );

  it('404s an agent the caller can’t reach, and reads nothing of it', async () => {
    const { complete, resolveCalls, getCalls, completeCalls } = setup({
      viewer: 'mallory',
      rows: [claimed()],
    });
    const captured = await complete();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'mallory' }]);
    expect(getCalls).toEqual([]);
    expect(completeCalls).toEqual([]);
  });

  it.each([
    ['a SafeToolError not-found', new SafeToolError('not-found', 'routineId')],
    ['a PluginError not-found', new PluginError({ code: 'not-found', plugin: 'agents', message: 'gone' })],
    // Only the service's own forbidden is a 403: the agent refusing the caller makes them a stranger.
    ['a PluginError forbidden', new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' })],
  ])('404s when the service refuses with %s', async (_kind, failure) => {
    const { complete, completeCalls } = setup({ rows: [claimed()], completeFailure: failure });
    const captured = await complete();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(completeCalls).toHaveLength(1);
  });

  it('503s without routines:complete, before reading anything', async () => {
    const { complete, resolveCalls, getCalls } = setup({
      rows: [claimed()],
      absent: new Set(['routines:complete']),
    });
    const captured = await complete();
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'task-complete-unavailable' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
  });

  it.each([
    ['routines:get'],
    ['routines:recent-fires'],
  ])('404s task-not-found without %s, like the task page, and asks no one to mark it done', async (hook) => {
    const { complete, resolveCalls, getCalls, completeCalls } = setup({
      rows: [claimed()],
      absent: new Set([hook]),
    });
    const captured = await complete();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
    expect(completeCalls).toEqual([]);
  });

  it.each<[string, Buffer]>([
    ['an unparseable body', Buffer.from('{"requestId": "req', 'utf-8')],
    ['no body at all', Buffer.alloc(0)],
  ])('400s %s as invalid-json, and asks no one', async (_what, raw) => {
    const { complete, resolveCalls, completeCalls } = setup({ rows: [claimed()] });
    const captured = await complete(KEY, raw);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-json' });
    expect(resolveCalls).toEqual([]);
    expect(completeCalls).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['an empty object', {}],
    ['an empty request id', { requestId: '' }],
    ['a request id that isn’t text', { requestId: 7 }],
    ['null', null],
  ])('400s a body that is %s as invalid-body, and asks no one', async (_what, body) => {
    const { complete, resolveCalls, completeCalls } = setup({ rows: [claimed()] });
    const captured = await complete(KEY, body);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-body' });
    expect(resolveCalls).toEqual([]);
    expect(completeCalls).toEqual([]);
  });

  // The body reader takes any non-empty text; the contract's own rule (its length cap) is the service's. A
  // `validation` refusal is the body as sent, so it answers 400 like the other task routes, not a read's 404.
  it('400s a request id the service refuses as invalid-body, after asking', async () => {
    const { complete, completeCalls } = setup({ rows: [claimed()] });
    const captured = await complete(KEY, { requestId: 'r'.repeat(ROUTINE_OPAQUE_STRING_MAX_CHARS + 1) });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-body' });
    expect(completeCalls).toHaveLength(1);
  });

  it('401s without a session, and asks no one', async () => {
    const { complete, resolveCalls, getCalls, completeCalls } = setup({
      viewer: null,
      rows: [claimed()],
    });
    const captured = await complete();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
    expect(completeCalls).toEqual([]);
  });

  it('400s a blank id, and asks no one', async () => {
    const { complete, resolveCalls, completeCalls } = setup({ rows: [claimed()] });
    const captured = await complete({ agentId: 'a1', routineId: ' ' });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-task-id' });
    expect(resolveCalls).toEqual([]);
    expect(completeCalls).toEqual([]);
  });

  it.each([
    ['an unavailable service', new SafeToolError('unavailable', 'input'), 'temporarily unavailable'],
    ['any other failure', new Error('db down'), 'db down'],
  ])(
    'fails the request when the service fails with %s, rather than saying it is done',
    async (_kind, failure, message) => {
      const { complete, completeCalls, lastWritten } = setup({
        rows: [claimed()],
        completeFailure: failure,
      });
      await expect(complete()).rejects.toThrow(message);
      expect(completeCalls).toHaveLength(1);
      expect(lastWritten()?.statusCode).not.toBe(200);
      expect(lastWritten()?.body).toBeUndefined();
    },
  );
});

describe('POST /api/workspace/tasks/:agentId/:routineId/reopen (TASK-950)', () => {
  it('reads the task, then sends Not yet as the caller, and answers what it did about a check-in', async () => {
    const { reopen, reopenCalls, order } = setup({ rows: [claimed()] });
    // The address names the task. Nothing else in the body rides along.
    const captured = await reopen(KEY, { ...NOT_YET, agentId: 'zzz', admin: true });
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ checkIn: 'started' });
    expect(reopenCalls).toStrictEqual([
      {
        userId: 'alice',
        agentId: 'a1',
        input: {
          agentId: 'a1',
          routineId: 't1',
          requestId: 'req-2',
          text: 'The billing page still needs a review.',
        },
      },
    ]);
    expect(order).toEqual(['routines:get', 'routines:reopen']);
  });

  it.each(['started', 'paused', 'not-allowed', 'replayed'] as const)(
    'answers %s when that is what the service did',
    async (checkIn) => {
      const { reopen } = setup({
        rows: [claimed()],
        reopenAnswer: { replyId: 'REPLY-ID-1', checkIn },
      });
      const captured = await reopen();
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toStrictEqual({ checkIn });
    },
  );

  it('reopens a Done task for an owner who manages the agent’s tasks', async () => {
    const { reopen, reopenCalls } = setup({ rows: [markedDone()] });
    const captured = await reopen();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ checkIn: 'started' });
    expect(reopenCalls).toHaveLength(1);
  });

  it('403s Reopen on a Done task for an owner who no longer manages the agent’s tasks, without asking', async () => {
    const { reopen, reopenCalls } = setup({ managers: { a1: [] }, rows: [markedDone()] });
    const captured = await reopen();
    expect(captured.statusCode).toBe(403);
    expect(captured.body).toEqual({ error: 'task-done-not-allowed' });
    expect(reopenCalls).toEqual([]);
  });

  it.each([
    ['who manages the agent’s tasks', ['alice']],
    ['who doesn’t manage the agent’s tasks', []],
  ])(
    '404s a task of any other kind to its owner %s, even one whose view reads as Done, and never asks',
    async (_who, managers) => {
      // A view the schema didn't parse (TASK-913's shape) can carry a completion on any kind; the
      // store refuses every kind but get-done as not-found, so the route answers that first.
      const { reopen, reopenCalls } = setup({
        managers: { a1: managers },
        unvalidated: true,
        viewPatch: { kind: 'stay-on-top' },
        rows: [markedDone()],
      });
      const captured = await reopen();
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'task-not-found' });
      expect(reopenCalls).toEqual([]);
    },
  );

  it('sends Not yet on a claimed task that still runs for an owner without edit: it needs only ownership, like a reply', async () => {
    const { reopen, reopenCalls } = setup({
      managers: { a1: [] },
      rows: [claimed()],
      reopenAnswer: { replyId: 'REPLY-ID-1', checkIn: 'not-allowed' },
    });
    const captured = await reopen();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ checkIn: 'not-allowed' });
    expect(reopenCalls).toHaveLength(1);
  });

  it('403s when the service refuses it as forbidden, deciding again under the row lock', async () => {
    const { reopen, reopenCalls } = setup({
      rows: [claimed()],
      reopenFailure: new SafeToolError('forbidden', 'input'),
    });
    const captured = await reopen();
    expect(captured.statusCode).toBe(403);
    expect(captured.body).toEqual({ error: 'task-done-not-allowed' });
    expect(reopenCalls).toHaveLength(1);
  });

  it.each<[string, string]>([
    ['a blank reply', '   '],
    ['a reply over 2,000 characters', 'x'.repeat(ROUTINE_REPLY_MAX_CHARS + 1)],
  ])('400s text the service refuses (%s) as reply-invalid', async (_what, text) => {
    const { reopen, reopenCalls } = setup({ rows: [claimed()] });
    const captured = await reopen(KEY, { text, requestId: 'req-2' });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'reply-invalid' });
    expect(reopenCalls).toHaveLength(1);
  });

  it.each([
    ['who manages the agent’s tasks', ['alice', 'bob']],
    ['who doesn’t manage the agent’s tasks', ['bob']],
  ])(
    '404s someone else’s Done task on a team agent, never 403, to a teammate %s, and never asks',
    async (_who, managers) => {
      const { reopen, reopenCalls } = setup({
        agents: TEAM_AGENTS,
        managers: { team: managers },
        rows: [
          markedDone({
            agentId: 'team',
            routineId: 'tB',
            ownerUserId: 'bob',
            done: { at: new Date('2026-10-23T10:00:00.000Z'), byUserId: 'bob' },
          }),
        ],
      });
      const captured = await reopen({ agentId: 'team', routineId: 'tB' });
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'task-not-found' });
      expect(reopenCalls).toEqual([]);
    },
  );

  it('404s an agent the caller can’t reach, and reads nothing of it', async () => {
    const { reopen, resolveCalls, getCalls, reopenCalls } = setup({
      viewer: 'mallory',
      rows: [markedDone()],
    });
    const captured = await reopen();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'mallory' }]);
    expect(getCalls).toEqual([]);
    expect(reopenCalls).toEqual([]);
  });

  it.each([
    ['a SafeToolError not-found', new SafeToolError('not-found', 'routineId')],
    ['a PluginError not-found', new PluginError({ code: 'not-found', plugin: 'agents', message: 'gone' })],
    ['a PluginError forbidden', new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' })],
  ])('404s when the service refuses with %s', async (_kind, failure) => {
    const { reopen, reopenCalls } = setup({ rows: [claimed()], reopenFailure: failure });
    const captured = await reopen();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(reopenCalls).toHaveLength(1);
  });

  it('503s without routines:reopen, before reading anything', async () => {
    const { reopen, resolveCalls, getCalls } = setup({
      rows: [claimed()],
      absent: new Set(['routines:reopen']),
    });
    const captured = await reopen();
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'task-reopen-unavailable' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
  });

  it.each([
    ['routines:get'],
    ['routines:recent-fires'],
  ])('404s task-not-found without %s, like the task page, and asks no one to send it', async (hook) => {
    const { reopen, resolveCalls, getCalls, reopenCalls } = setup({
      rows: [claimed()],
      absent: new Set([hook]),
    });
    const captured = await reopen();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
    expect(reopenCalls).toEqual([]);
  });

  it.each<[string, Buffer]>([
    ['an unparseable body', Buffer.from('{"text": "The billing', 'utf-8')],
    ['no body at all', Buffer.alloc(0)],
  ])('400s %s as invalid-json, and asks no one', async (_what, raw) => {
    const { reopen, resolveCalls, reopenCalls } = setup({ rows: [claimed()] });
    const captured = await reopen(KEY, raw);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-json' });
    expect(resolveCalls).toEqual([]);
    expect(reopenCalls).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['an empty object', {}],
    ['text that isn’t text', { text: 3, requestId: 'r' }],
    ['no request id', { text: 'hi' }],
    ['an empty request id', { text: 'hi', requestId: '' }],
    ['a request id that isn’t text', { text: 'hi', requestId: 7 }],
  ])('400s a body that is %s as invalid-body, and asks no one', async (_what, body) => {
    const { reopen, resolveCalls, reopenCalls } = setup({ rows: [claimed()] });
    const captured = await reopen(KEY, body);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-body' });
    expect(resolveCalls).toEqual([]);
    expect(reopenCalls).toEqual([]);
  });

  it('401s without a session, and asks no one', async () => {
    const { reopen, resolveCalls, getCalls, reopenCalls } = setup({
      viewer: null,
      rows: [claimed()],
    });
    const captured = await reopen();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
    expect(reopenCalls).toEqual([]);
  });

  it('400s a blank id, and asks no one', async () => {
    const { reopen, resolveCalls, reopenCalls } = setup({ rows: [claimed()] });
    const captured = await reopen({ agentId: ' ', routineId: 't1' });
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-task-id' });
    expect(resolveCalls).toEqual([]);
    expect(reopenCalls).toEqual([]);
  });

  it.each([
    ['an unavailable service', new SafeToolError('unavailable', 'input'), 'temporarily unavailable'],
    ['any other failure', new Error('db down'), 'db down'],
  ])(
    'fails the request when the service fails with %s, rather than saying it was sent',
    async (_kind, failure, message) => {
      const { reopen, reopenCalls, lastWritten } = setup({
        rows: [claimed()],
        reopenFailure: failure,
      });
      await expect(reopen()).rejects.toThrow(message);
      expect(reopenCalls).toHaveLength(1);
      expect(lastWritten()?.statusCode).not.toBe(200);
      expect(lastWritten()?.body).toBeUndefined();
    },
  );
});

describe('POST /api/workspace/tasks/:agentId/:routineId/duplicate (TASK-953)', () => {
  /**
   * A stay-on-top task alice owns, at the request's address. The route reads
   * it (`ownTaskOr404`) before the hook is asked, so every test that gets past
   * the 503 check needs one.
   */
  const MINE: Partial<World> = { rows: [stored({ agentId: 'a1', routineId: 't1' })] };

  it('401s without a session, and reads nothing', async () => {
    const { duplicate, resolveCalls, duplicateCalls, order } = setup({ ...MINE, viewer: null });
    const captured = await duplicate();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(duplicateCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it.each([
    ['a blank routine id', { agentId: 'a1', routineId: '  ' }],
    ['a blank agent id', { agentId: ' ', routineId: 't1' }],
    ['no ids at all', {}],
  ])('400s %s, and reads nothing', async (_what, params: Record<string, string>) => {
    const { duplicate, resolveCalls, order } = setup(MINE);
    const captured = await duplicate(params);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'missing-task-id' });
    expect(resolveCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it.each<[string, Buffer]>([
    ['an unparseable body', Buffer.from('{"requestId": "req-1"', 'utf-8')],
    ['no body at all', Buffer.alloc(0)],
  ])('400s %s as invalid-json, and reads nothing', async (_what, raw) => {
    const { duplicate, resolveCalls, order } = setup(MINE);
    const captured = await duplicate(KEY, raw);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-json' });
    expect(resolveCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a list', []],
    ['null', null],
    ['no request id', {}],
    ['an empty request id', { requestId: '' }],
    ['a request id that isn’t text', { requestId: 7 }],
  ])('400s a body that is %s as invalid-body, before the agent is read', async (_what, body) => {
    const { duplicate, resolveCalls, duplicateCalls, order } = setup(MINE);
    const captured = await duplicate(KEY, body);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'invalid-body' });
    expect(resolveCalls).toEqual([]);
    expect(duplicateCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it('503s without routines:duplicate, before reading the agent', async () => {
    const { duplicate, resolveCalls, order } = setup({
      ...MINE,
      absent: new Set(['routines:duplicate']),
    });
    const captured = await duplicate();
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'task-duplicate-unavailable' });
    expect(resolveCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it('404s someone agents:resolve refuses, and never calls the hook', async () => {
    const { duplicate, resolveCalls, duplicateCalls, order } = setup({ ...MINE, viewer: 'mallory' });
    const captured = await duplicate();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'mallory' }]);
    expect(duplicateCalls).toEqual([]);
    expect(order).toEqual([]);
  });

  it.each<[string, Partial<World>, Key]>([
    [
      'a task bob owns on a team agent, to a teammate who doesn’t manage its tasks',
      {
        agents: TEAM_AGENTS,
        managers: { team: ['bob'] },
        rows: [stored({ agentId: 'team', routineId: 't1', ownerUserId: 'bob' })],
      },
      { agentId: 'team', routineId: 't1' },
    ],
    [
      'the same task, to a teammate who does',
      {
        agents: TEAM_AGENTS,
        managers: { team: ['alice', 'bob'] },
        rows: [stored({ agentId: 'team', routineId: 't1', ownerUserId: 'bob' })],
      },
      { agentId: 'team', routineId: 't1' },
    ],
    [
      'a repeat routine alice owns',
      { rows: [stored({ agentId: 'a1', routineId: 't1', kind: 'repeat', goodWhen: null })] },
      KEY,
    ],
    ['a routine that isn’t there', { rows: [] }, KEY],
  ])('404s %s as task-not-found, before the hook is asked', async (_what, world, key) => {
    const { duplicate, duplicateCalls, order } = setup(world);
    const captured = await duplicate(key);
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(duplicateCalls).toEqual([]);
    expect(order).toEqual(['routines:get']);
  });

  it('copies the caller’s own task: 200 with the copy’s id alone, and the hook gets only the address’s ids and the request id', async () => {
    const { duplicate, resolveCalls, duplicateCalls, order } = setup(MINE);
    // The address names the task. Nothing else in the body rides along: not
    // another task's ids, and not a name for the copy, which the host decides.
    const captured = await duplicate(KEY, {
      requestId: 'q',
      agentId: 'other',
      routineId: 'other',
      name: 'Mine',
    });
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ routineId: 'COPY-ID-1' } satisfies TaskDuplicateResponse);
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'alice' }]);
    expect(duplicateCalls).toStrictEqual([
      {
        userId: 'alice',
        agentId: 'a1',
        input: { agentId: 'a1', routineId: 't1', requestId: 'q' },
      },
    ]);
    // The task is read first, as its page reads it, so its 404s are the page's.
    expect(order).toEqual(['routines:get', 'routines:duplicate']);
  });

  it('403s when the service says the owner may not, as task-duplicate-not-allowed', async () => {
    const { duplicate, duplicateCalls } = setup({
      ...MINE,
      duplicateFailure: new SafeToolError('forbidden', 'input'),
    });
    const captured = await duplicate();
    expect(captured.statusCode).toBe(403);
    expect(captured.body).toEqual({ error: 'task-duplicate-not-allowed' });
    expect(duplicateCalls).toHaveLength(1);
  });

  it.each<[string, Partial<World>, unknown]>([
    [
      'a copy today’s rules refuse',
      { duplicateFailure: new SafeToolError('validation', 'promptBody') },
      { requestId: 'req-1' },
    ],
    ['a request id the contract refuses', {}, { requestId: 'x'.repeat(257) }],
  ])('400s %s as duplicate-invalid', async (_what, world, body) => {
    const { duplicate, duplicateCalls } = setup({ ...MINE, ...world });
    const captured = await duplicate(KEY, body);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error: 'duplicate-invalid' });
    expect(duplicateCalls).toHaveLength(1);
  });

  it.each([
    ['a task that went meanwhile', new SafeToolError('not-found', 'routineId')],
    ['an agent it can no longer reach', new PluginError({ code: 'not-found', plugin: 'agents', message: 'gone' })],
  ])('404s %s as task-not-found', async (_what, failure) => {
    const { duplicate, duplicateCalls } = setup({ ...MINE, duplicateFailure: failure });
    const captured = await duplicate();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(duplicateCalls).toHaveLength(1);
  });

  it.each([
    [
      'a request id already used on another task',
      new SafeToolError('request-conflict', 'requestId'),
      'This request ID was used for different input.',
    ],
    ['an unavailable service', new SafeToolError('unavailable', 'input'), 'temporarily unavailable'],
    ['any other failure', new Error('boom'), 'boom'],
  ])(
    'fails the request when the service fails with %s, rather than answering a copy',
    async (_what, failure, message) => {
      const { duplicate, duplicateCalls, lastWritten } = setup({
        ...MINE,
        duplicateFailure: failure,
      });
      await expect(duplicate()).rejects.toThrow(message);
      expect(duplicateCalls).toHaveLength(1);
      expect(lastWritten()?.statusCode).not.toBe(200);
      expect(lastWritten()?.body).toBeUndefined();
    },
  );

  it('answers the copy’s id alone, whatever else the hook says', async () => {
    // An answer the bus didn't parse (TASK-913's shape): only the id crosses.
    const { duplicate } = setup({
      ...MINE,
      unvalidated: true,
      duplicateAnswer: {
        routineId: 'COPY-ID-1',
        name: 'Copy of Zero open tickets',
      } as unknown as RoutineDuplicateOutput,
    });
    const captured = await duplicate();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({ routineId: 'COPY-ID-1' });
  });
});
