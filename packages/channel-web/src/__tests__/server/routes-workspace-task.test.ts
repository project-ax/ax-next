// @vitest-environment node
/**
 * The task page's routes: `GET /api/workspace/tasks/:agentId/:routineId`, one
 * task's own page, and `DELETE …/notes`, which clears the agent's notes on it
 * (TASK-910); `POST …/replies`, the task's owner writing to their agent
 * about it (TASK-931); and `POST …/steps`, the task's owner changing its steps
 * (TASK-949).
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
 */
import { describe, expect, it } from 'vitest';
import {
  HookBus,
  PluginError,
  SafeToolError,
  makeAgentContext,
  type AgentContext,
} from '@ax/core';
import {
  ROUTINE_AGENT_NOTES_MAX_CHARS,
  ROUTINE_REPLY_MAX_CHARS,
  ROUTINE_REPORT_ASK_MAX_CHARS,
  ROUTINE_REPORT_UPDATE_MAX_CHARS,
  ROUTINE_STEP_TEXT_MAX_CHARS,
  RoutineClearNotesOutputSchema,
  RoutineGetInputSchema,
  RoutineGetOutputSchema,
  RoutineRecentFiresOutputSchema,
  RoutineRecentRepliesInputSchema,
  RoutineRecentRepliesOutputSchema,
  RoutineReplyInputSchema,
  RoutineReplyOutputSchema,
  RoutineSetStepsInputSchema,
  RoutineSetStepsOutputSchema,
  type RoutineFireView,
  type RoutineReplyOutput,
  type RoutineReplyView,
  type RoutineReportStatus,
  type RoutineSetStepsOutput,
} from '@ax/routines-contract';
import {
  ACTIVITY_DETAIL_MAX_CHARS,
  makeWorkspaceHandlers,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import type { TaskDetail, TaskStepsResponse } from '../../lib/workspace-types.js';
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
  /**
   * True: `routines:get`, `routines:recent-fires` and (TASK-949)
   * `routines:set-steps` are registered without `returns`, so their answers
   * reach the route unparsed (TASK-913's shape).
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

function setup(over: Partial<World> = {}) {
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
    unvalidated: false,
    viewMiss: null,
    viewPatch: null,
    ...over,
  };
  const bus = new HookBus();
  const resolveCalls: Array<{ agentId: string; userId: string }> = [];
  const getCalls: Array<Call<unknown>> = [];
  const firesCalls: Array<Call<unknown>> = [];
  const clearCalls: Array<Call<unknown>> = [];
  const repliesCalls: Array<Call<unknown>> = [];
  const replyCalls: Array<Call<unknown>> = [];
  const stepsCalls: Array<Call<unknown>> = [];
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

  const handlers = makeWorkspaceHandlers({ bus, initCtx });
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
  return {
    detail,
    clear,
    reply,
    steps,
    resolveCalls,
    getCalls,
    firesCalls,
    clearCalls,
    repliesCalls,
    replyCalls,
    stepsCalls,
    order,
    lastWritten: () => last,
  };
}

/** A reply as the box sends it (TASK-931). */
const SENT = { text: 'Refunds under $100 are fine.', requestId: 'req-1' };

/** A step change as the task page sends it (TASK-949). */
const ADD = { op: 'add', text: 'Ask Dana to review billing' } as const;
const CHANGE = { requestId: 'req-1', ops: [ADD] };

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
        reportedAt: '2026-10-22T14:58:00.000Z',
      },
      steps: [],
      noRecentUpdate: null,
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

  it('404s a repeat routine, and reads none of its history or replies', async () => {
    const { detail, firesCalls, repliesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', kind: 'repeat', goodWhen: null })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
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

  it('404s that owner’s task until it first reports, as the Tasks page leaves it out (TASK-909’s rule)', async () => {
    const { detail, firesCalls, repliesCalls } = setup({
      viewer: 'bob',
      agents: TEAM_AGENTS,
      managers: { team: ['alice'] },
      rows: [stored({ agentId: 'team', routineId: 'tD', ownerUserId: 'bob' })],
    });
    const captured = await detail({ agentId: 'team', routineId: 'tD' });
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
    expect(repliesCalls).toEqual([]);
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
    expect([...(errors[1] ?? '')].length).toBe(ACTIVITY_DETAIL_MAX_CHARS);
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
