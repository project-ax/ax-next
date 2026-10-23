// @vitest-environment node
/**
 * The task page's two routes (TASK-910): `GET
 * /api/workspace/tasks/:agentId/:routineId`, one task's own page, and `DELETE
 * …/notes`, which clears the agent's notes on it.
 *
 * `routines:get` here is the real view producer, not a literal. Each view is
 * made by @ax/routines' own `routineView` and parsed on the bus through
 * `RoutineGetOutputSchema`, as in production. That pins the page's ownership
 * rule (TASK-909's `isOwnTask`, reused) against the services' `taskView` and
 * `routinePermissions`: if either changes, these tests fail instead of the
 * page quietly showing someone else's task. `routines:recent-fires` answers
 * literal fire views, parsed through `RoutineRecentFiresOutputSchema`.
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
  ROUTINE_REPORT_ASK_MAX_CHARS,
  ROUTINE_REPORT_UPDATE_MAX_CHARS,
  RoutineClearNotesOutputSchema,
  RoutineGetInputSchema,
  RoutineGetOutputSchema,
  RoutineRecentFiresOutputSchema,
  type RoutineFireView,
  type RoutineReportStatus,
} from '@ax/routines-contract';
import {
  ACTIVITY_DETAIL_MAX_CHARS,
  makeWorkspaceHandlers,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import type { TaskDetail } from '../../lib/workspace-types.js';
import { parseRoutineInput, routineView } from '../../../../routines/src/services.js';
import type { StoredRoutine } from '../../../../routines/src/types.js';
import { routineFixture } from '../../components/routines/__tests__/routine-fixture.js';

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

type StoredTask = NonNullable<StoredRoutine['task']>;

/** A stored task: a stay-on-top routine owned by alice that has never reported. */
function stored(over: Partial<StoredRoutine>): StoredRoutine {
  return {
    ...routineFixture,
    kind: 'stay-on-top',
    goodWhen: 'No ticket waits longer than an hour.',
    ownerUserId: 'alice',
    definitionId: null,
    definitionUpdatedAt: null,
    nextRunAt: null,
    lastRunAt: null,
    task: null,
    noRecentUpdate: null,
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
  /** True: `routines:get` is registered without `returns`, so a view reaches the route unparsed (TASK-913's shape). */
  unvalidated: boolean;
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
    unvalidated: false,
    ...over,
  };
  const bus = new HookBus();
  const resolveCalls: Array<{ agentId: string; userId: string }> = [];
  const getCalls: Array<Call<unknown>> = [];
  const firesCalls: Array<Call<unknown>> = [];
  const clearCalls: Array<Call<unknown>> = [];

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
        if (world.getFailure !== null) throw world.getFailure;
        // The service's own input check: an id that can't exist is `validation`.
        const input = parseRoutineInput(RoutineGetInputSchema, raw);
        const row = world.rows.find(
          (r) => r.agentId === input.agentId && r.routineId === input.routineId,
        );
        if (row === undefined) throw new SafeToolError('not-found', 'routineId');
        const allowed = world.managers[input.agentId]?.includes(ctx.userId) ?? false;
        return routineView(row, ctx.userId, allowed);
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
        if (world.firesFailure !== null) throw world.firesFailure;
        return { fires: world.fires };
      },
      { returns: RoutineRecentFiresOutputSchema },
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
  return {
    detail,
    clear,
    resolveCalls,
    getCalls,
    firesCalls,
    clearCalls,
    lastWritten: () => last,
  };
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
        reportedAt: '2026-10-22T14:58:00.000Z',
      },
      noRecentUpdate: null,
      updates: [
        {
          firedAt: '2026-10-22T14:57:00.000Z',
          status: 'ok',
          error: null,
          report: { status: 'needs-you', update: 'Two tickets have waited over an hour.' },
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

  it('404s a repeat routine, and reads none of its history', async () => {
    const { detail, firesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', kind: 'repeat', goodWhen: null })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
  });

  it.each([
    ['who manages the agent’s tasks', ['alice', 'bob']],
    ['who doesn’t manage the agent’s tasks', ['bob']],
  ])(
    '404s someone else’s task on a team agent, to a viewer %s, and nothing of it is in the body',
    async (_who, managers) => {
      const { detail, firesCalls } = setup({
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
            report: { status: 'off-track', update: 'BOB-UPDATE', ask: null },
          }),
        ],
      });
      const captured = await detail({ agentId: 'team', routineId: 'tB' });
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'task-not-found' });
      expect(firesCalls).toEqual([]);
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
    const { detail, firesCalls } = setup({
      viewer: 'bob',
      agents: TEAM_AGENTS,
      managers: { team: ['alice'] },
      rows: [stored({ agentId: 'team', routineId: 'tD', ownerUserId: 'bob' })],
    });
    const captured = await detail({ agentId: 'team', routineId: 'tD' });
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
  });

  it('404s an agent the caller can’t reach, and reads nothing of it', async () => {
    const { detail, resolveCalls, getCalls, firesCalls } = setup({
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
  });

  it('404s a routine that isn’t there', async () => {
    const { detail, firesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't2', task: report('on-track') })],
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
  });

  it('404s an id that can’t name a task', async () => {
    // Longer than any opaque id: the service refuses it as `validation`.
    const { detail, getCalls, firesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
    });
    const captured = await detail({ agentId: 'a1', routineId: 'r'.repeat(300) });
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(getCalls).toHaveLength(1);
    expect(firesCalls).toEqual([]);
  });

  it.each([
    ['a SafeToolError forbidden', new SafeToolError('forbidden', 'input')],
    ['a SafeToolError not-found', new SafeToolError('not-found', 'routineId')],
    ['a PluginError forbidden', new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' })],
    ['a PluginError not-found', new PluginError({ code: 'not-found', plugin: 'agents', message: 'gone' })],
  ])('404s when routines:get refuses with %s, and reads no history', async (_kind, failure) => {
    const { detail, firesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      getFailure: failure,
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
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
        fire({ report: { status: 'off-track', update: 'third\nfourth', ask: null } }),
        fire({
          firedAt: '2026-10-22T08:57:00.000Z',
          report: { status: 'off-track', update: 'z'.repeat(600), ask: null },
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
    ['without routines at all', ['routines:get', 'routines:recent-fires', 'routines:clear-notes']],
    ['without routines:get', ['routines:get']],
    ['without routines:recent-fires', ['routines:recent-fires']],
  ])('404s in a deployment %s, and reads nothing', async (_what, absent) => {
    const { detail, getCalls, firesCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
      absent: new Set(absent),
    });
    const captured = await detail();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(getCalls).toEqual([]);
    expect(firesCalls).toEqual([]);
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
