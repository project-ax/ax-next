// @vitest-environment node
/**
 * GET /api/workspace/tasks (TASK-909): every task the caller owns, across the
 * agents they can see, for the Tasks page.
 *
 * `routines:list` here is the real view producer, not a literal. Each view is
 * made by @ax/routines' own `routineView` and parsed on the bus through
 * `RoutineListOutputSchema`, as in production. That pins the route's ownership
 * rule (`task !== null || permissions.fire`, decisions row 2) against the
 * services' `taskView` and `routinePermissions`: if either changes, these
 * tests fail instead of the page quietly showing someone else's tasks.
 */
import { describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import {
  ROUTINE_REPORT_ASK_MAX_CHARS,
  ROUTINE_REPORT_UPDATE_MAX_CHARS,
  RoutineListOutputSchema,
  RoutineViewSchema,
  type RoutineReportStatus,
} from '@ax/routines-contract';
import {
  TASKS_AGENT_READ_DEADLINE_MS,
  makeWorkspaceHandlers,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import type { TasksResponse } from '../../lib/workspace-types.js';
import { groupTasks, todayTaskReason, todayTasks } from '../../lib/task-groups.js';
import { routineView } from '../../../../routines/src/services.js';
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

/**
 * A stored report. The agent notes carry a marker no response may contain; the
 * ask's marker crosses since TASK-933 (Today draws the ask).
 */
function report(status: RoutineReportStatus, over: Partial<StoredTask> = {}): StoredTask {
  return {
    status,
    update: 'Queue is empty.',
    ask: 'ASK-TEXT want me to draft a reply?',
    agentNotes: 'NOTES-TEXT Acme is an enterprise customer.',
    reportedAt: new Date('2026-10-22T09:58:00.000Z'),
    ...over,
  };
}

interface RosterAgent {
  id: string;
  displayName: string;
}

interface World {
  viewer: string | null;
  rosters: Record<string, RosterAgent[]>;
  rows: StoredRoutine[];
  /** Per agent, the users `agents:can-manage-routines` says yes to. */
  managers: Record<string, string[]>;
  failures: Map<string, Error>;
  /** Agents whose `routines:list` answers a beat late, so answers land out of roster order. */
  slow: Set<string>;
  /** Agents whose `routines:list` never answers. */
  hang: Set<string>;
  /** Agents whose `routines:list` fails this long after it was asked. */
  lateFailure: Map<string, number>;
  /** False is a deployment without @ax/routines: no `routines:list` at all. */
  routines: boolean;
  /** Set: `agents:list-for-user` throws this. */
  rosterFailure: Error | null;
  /** True: `routines:list` is registered without `returns`, so a view reaches the route unparsed (TASK-913's shape). */
  unvalidated: boolean;
  /** Set, with `unvalidated`: every view's `noRecentUpdate` is replaced by this (a shape the schema would refuse). */
  viewMiss: { value: unknown } | null;
}

interface ListCall {
  userId: string;
  agentId: string;
  input: { agentId: string };
}

function setup(over: Partial<World> = {}) {
  const world: World = {
    viewer: 'alice',
    rosters: {
      alice: [
        { id: 'a1', displayName: 'Caveman' },
        { id: 'a2', displayName: 'Juniper' },
      ],
    },
    rows: [],
    managers: { a1: ['alice'], a2: ['alice'] },
    failures: new Map(),
    slow: new Set(),
    hang: new Set(),
    lateFailure: new Map(),
    routines: true,
    rosterFailure: null,
    unvalidated: false,
    viewMiss: null,
    ...over,
  };
  const bus = new HookBus();
  const rosterCalls: string[] = [];
  const listCalls: ListCall[] = [];

  bus.registerService('auth:require-user', 'auth', async () => {
    if (world.viewer === null) {
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
    }
    return { user: { id: world.viewer, isAdmin: false } };
  });
  bus.registerService(
    'agents:list-for-user',
    'agents',
    async (_ctx: AgentContext, input: { userId: string; teamIds?: string[] }) => {
      rosterCalls.push(input.userId);
      if (world.rosterFailure !== null) throw world.rosterFailure;
      return { agents: world.rosters[input.userId] ?? [] };
    },
  );
  if (world.routines) {
    bus.registerService(
      'routines:list',
      'routines',
      async (ctx: AgentContext, input: { agentId: string }) => {
        listCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input });
        if (world.hang.has(input.agentId)) {
          await new Promise(() => {});
        }
        const lateMs = world.lateFailure.get(input.agentId);
        if (lateMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, lateMs));
          throw new Error('pool exhausted after a long wait');
        }
        if (world.slow.has(input.agentId)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const failure = world.failures.get(input.agentId);
        if (failure !== undefined) throw failure;
        const allowed = world.managers[input.agentId]?.includes(ctx.userId) ?? false;
        return {
          routines: world.rows
            .filter((r) => r.agentId === input.agentId)
            .map((r) => {
              const view = routineView(r, ctx.userId, allowed);
              return world.viewMiss === null ? view : { ...view, noRecentUpdate: world.viewMiss.value as typeof view.noRecentUpdate };
            }),
        };
      },
      world.unvalidated ? undefined : { returns: RoutineListOutputSchema },
    );
  }

  const handlers = makeWorkspaceHandlers({ bus, initCtx });
  /** What the last request wrote, kept even when the handler throws. */
  let last: CapturedRes | null = null;
  async function get(req: RouteRequest = mkReq()): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.tasks(req, res);
    return captured;
  }
  return { get, rosterCalls, listCalls, lastWritten: () => last };
}

function bodyOf(captured: CapturedRes): TasksResponse {
  return captured.body as TasksResponse;
}

function routineIds(captured: CapturedRes): string[] {
  return bodyOf(captured).tasks.map((t) => t.routineId);
}

/** A team agent alice and bob can both see, where only alice may manage routines. */
const TEAM_ROSTER: RosterAgent[] = [{ id: 'team-a', displayName: 'Support' }];
const TEAM_ROWS: StoredRoutine[] = [
  stored({ agentId: 'team-a', routineId: 'tA', ownerUserId: 'alice', task: report('on-track') }),
  stored({
    agentId: 'team-a',
    routineId: 'tB',
    ownerUserId: 'bob',
    task: report('off-track', { update: 'BOB-UPDATE', ask: 'BOB-ASK' }),
  }),
  stored({ agentId: 'team-a', routineId: 'tC', ownerUserId: 'alice' }),
  stored({ agentId: 'team-a', routineId: 'tD', ownerUserId: 'bob' }),
];

describe('GET /api/workspace/tasks (TASK-909)', () => {
  it('lists only tasks, across two agents, in roster order', async () => {
    const { get } = setup({
      rows: [
        stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') }),
        stored({ agentId: 'a1', routineId: 'r1', kind: 'repeat', goodWhen: null }),
        stored({ agentId: 'a2', routineId: 't2' }),
      ],
      // a1 answers last: the list follows the roster, not whichever agent answered first.
      slow: new Set(['a1']),
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    const body = bodyOf(captured);
    expect(body.tasks.map((t) => [t.agentId, t.routineId])).toEqual([
      ['a1', 't1'],
      ['a2', 't2'],
    ]);
    expect(body.unavailableAgents).toEqual([]);
  });

  it("answers a task that has not reported with task: null, and a report with status, update, ask and reportedAt, never the agent's notes (TASK-933)", async () => {
    const { get } = setup({
      rows: [
        stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') }),
        stored({ agentId: 'a2', routineId: 't2' }),
      ],
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    const body = bodyOf(captured);
    const t1 = body.tasks.find((t) => t.routineId === 't1');
    const t2 = body.tasks.find((t) => t.routineId === 't2');
    expect(t2?.task).toBeNull();
    expect(t1).toEqual({
      agentId: 'a1',
      agentName: 'Caveman',
      routineId: 't1',
      name: 'Project check-in',
      enabled: true,
      task: {
        status: 'needs-you',
        update: 'Queue is empty.',
        ask: 'ASK-TEXT want me to draft a reply?',
        reportedAt: '2026-10-22T09:58:00.000Z',
      },
      noRecentUpdate: null,
    });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('NOTES-TEXT');
  });

  it('returns the other agents when one agent cannot be read, and names the one it could not', async () => {
    const { get } = setup({
      rows: [
        stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') }),
        stored({ agentId: 'a2', routineId: 't2' }),
      ],
      failures: new Map([['a2', new Error('connection terminated unexpectedly')]]),
    });
    const warn = vi.spyOn(initCtx.logger, 'warn');
    try {
      const captured = await get();
      expect(captured.statusCode).toBe(200);
      expect(routineIds(captured)).toEqual(['t1']);
      expect(bodyOf(captured).unavailableAgents).toEqual([
        { agentId: 'a2', agentName: 'Juniper' },
      ]);
      expect(warn).toHaveBeenCalledWith('workspace_tasks_read_failed', {
        agentId: 'a2',
        error: expect.stringContaining('connection terminated'),
      });
      // It failed at once, so it is not a late failure.
      expect(warn).not.toHaveBeenCalledWith('workspace_tasks_late_read_failed', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('counts a refusal for one agent as that agent being unavailable', async () => {
    // decisions row 7: a forbidden or not-found from the per-agent read is a
    // race against the roster, and costs one "couldn't load" line.
    const { get } = setup({
      rows: [
        stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') }),
        stored({ agentId: 'a2', routineId: 't2' }),
      ],
      failures: new Map([
        ['a2', new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' })],
      ]),
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(routineIds(captured)).toEqual(['t1']);
    expect(bodyOf(captured).unavailableAgents).toEqual([
      { agentId: 'a2', agentName: 'Juniper' },
    ]);
  });

  it('never reads an agent the caller cannot see, and reads each agent as the caller', async () => {
    const { get, listCalls } = setup({
      rosters: {
        alice: [
          { id: 'a1', displayName: 'Caveman' },
          { id: 'a2', displayName: 'Juniper' },
        ],
        bob: [{ id: 'a3', displayName: 'Quill' }],
      },
      managers: { a1: ['alice'], a2: ['alice'], a3: ['bob'] },
      rows: [
        stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') }),
        stored({ agentId: 'a2', routineId: 't2' }),
        stored({
          agentId: 'a3',
          routineId: 't3',
          name: 'QUILL-TASK',
          ownerUserId: 'bob',
          task: report('off-track', { update: 'QUILL-UPDATE' }),
        }),
      ],
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(routineIds(captured)).toEqual(['t1', 't2']);
    expect(listCalls.map((c) => c.input.agentId)).toEqual(['a1', 'a2']);
    expect(listCalls.some((c) => c.input.agentId === 'a3')).toBe(false);
    for (const call of listCalls) {
      expect(call.userId).toBe('alice');
      expect(call.agentId).toBe(call.input.agentId);
    }
    const wire = JSON.stringify(captured.body);
    for (const marker of ['a3', 'Quill', 'QUILL-TASK', 'QUILL-UPDATE']) {
      expect(wire).not.toContain(marker);
    }
  });

  it('on a team agent, lists only the tasks the caller owns', async () => {
    const { get } = setup({
      rosters: { alice: TEAM_ROSTER, bob: TEAM_ROSTER },
      managers: { 'team-a': ['alice'] },
      rows: TEAM_ROWS.filter((r) => r.routineId !== 'tD'),
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(routineIds(captured)).toEqual(['tA', 'tC']);
    const wire = JSON.stringify(captured.body);
    expect(wire).not.toContain('BOB-UPDATE');
    // TASK-933: the ask crosses now, and only to its task's owner.
    expect(wire).not.toContain('BOB-ASK');
  });

  it('lists a reported task whose owner can no longer manage routines, but not a never-reported one (decisions row 2)', async () => {
    // bob owns tB (reported) and tD (never reported) on a team agent where he
    // may not manage routines. The view has no owner field: tB shows because
    // its report is shown only to its owner; tD has neither a report nor
    // `fire`, so it is left out until its first report. An accepted gap.
    const { get } = setup({
      viewer: 'bob',
      rosters: { alice: TEAM_ROSTER, bob: TEAM_ROSTER },
      managers: { 'team-a': ['alice'] },
      rows: TEAM_ROWS,
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(routineIds(captured)).toEqual(['tB']);
  });

  it('caps a stored update to one line of 500 characters', async () => {
    // Stored rows aren't re-checked against the writer's rules (TASK-913), and
    // the view schema has no cap, so the route is where the cap holds.
    const { get } = setup({
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          task: report('on-track', { update: 'x'.repeat(600) }),
        }),
        stored({
          agentId: 'a2',
          routineId: 't2',
          task: report('on-track', { update: 'first line\nsecond line' }),
        }),
      ],
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    const tasks = bodyOf(captured).tasks;
    const long = tasks.find((t) => t.routineId === 't1')?.task?.update ?? '';
    expect([...long].length).toBe(ROUTINE_REPORT_UPDATE_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(tasks.find((t) => t.routineId === 't2')?.task?.update).toBe('first line second line');
  });

  it("fences the ask to one line, caps it at the writer's limit, and sends a blank one as null (TASK-933)", async () => {
    // The same boundary as the update: stored rows aren't re-checked (TASK-913),
    // the view schema has no cap, and the writer allows an ask several lines long.
    const { get } = setup({
      rows: [
        stored({
          agentId: 'a1',
          routineId: 't1',
          task: report('needs-you', { ask: 'y'.repeat(600) }),
        }),
        stored({
          agentId: 'a2',
          routineId: 't2',
          task: report('needs-you', { ask: 'first line\nsecond line' }),
        }),
        stored({
          agentId: 'a1',
          routineId: 't3',
          task: report('needs-you', { ask: '   ' }),
        }),
      ],
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    const tasks = bodyOf(captured).tasks;
    const long = tasks.find((t) => t.routineId === 't1')?.task?.ask ?? '';
    expect([...long].length).toBe(ROUTINE_REPORT_ASK_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(tasks.find((t) => t.routineId === 't2')?.task?.ask).toBe('first line second line');
    const blank = tasks.find((t) => t.routineId === 't3');
    expect(blank?.task).not.toBeNull();
    expect(blank?.task?.ask).toBeNull();
  });

  it('fences a task name to one line, and calls a blank one Untitled task', async () => {
    // A task's name can't hide characters or break lines past the view schema,
    // but it can still be padded, or all spaces.
    const { get } = setup({
      rows: [
        stored({ agentId: 'a1', routineId: 't1', name: '  Weekly   invoices  ' }),
        stored({ agentId: 'a2', routineId: 't2', name: '   ' }),
      ],
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).tasks.map((t) => t.name)).toEqual([
      'Weekly invoices',
      'Untitled task',
    ]);
  });

  it('see it on Tasks: a check-in\'s report puts its task under its group (PR 1 canary)', async () => {
    const row = stored({
      agentId: 'a1',
      routineId: 't1',
      task: report('off-track', { update: 'Two invoices are three days old.' }),
    });
    expect(RoutineViewSchema.safeParse(routineView(row, 'alice', true)).success).toBe(true);
    const { get } = setup({ rows: [row, stored({ agentId: 'a2', routineId: 't2' })] });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    const offTrack = groupTasks(bodyOf(captured).tasks).groups.find(
      (g) => g.group === 'off-track',
    );
    expect(offTrack?.rows[0]).toMatchObject({
      routineId: 't1',
      task: { update: 'Two invoices are three days old.' },
    });
  });

  it("see it on Today: a check-in's needs-you report puts its task on Today with its ask (PR 2 canary, TASK-933)", async () => {
    const { get } = setup({
      rows: [
        stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') }),
        stored({ agentId: 'a2', routineId: 't2', task: report('on-track') }),
      ],
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    const onToday = todayTasks(bodyOf(captured).tasks);
    expect(onToday).toHaveLength(1);
    expect(onToday[0]).toMatchObject({
      routineId: 't1',
      task: { ask: 'ASK-TEXT want me to draft a reply?' },
    });
    expect(todayTaskReason(onToday[0]!)).toBe('asks');
  });

  it('see it on Tasks: missed check-ins group a task, and three escalate it (TASK-930)', async () => {
    const miss = (inARow: number) => ({
      inARow,
      reason: 'no-report' as const,
      at: new Date('2026-10-22T11:00:00.000Z'),
      autoPausedAt: null,
    });
    const one = stored({ agentId: 'a1', routineId: 't1', noRecentUpdate: miss(1) });
    const three = stored({ agentId: 'a2', routineId: 't2', noRecentUpdate: miss(3) });
    expect(RoutineViewSchema.safeParse(routineView(one, 'alice', true)).success).toBe(true);
    const { get } = setup({ rows: [one, three] });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    const { groups } = groupTasks(bodyOf(captured).tasks);
    const ids = (g: string) =>
      groups.find((x) => x.group === g)?.rows.map((r) => r.routineId);
    expect(ids('no-recent-update')).toEqual(['t1']);
    expect(ids('needs-you')).toEqual(['t2']);
  });

  it('401s without a session and reads nothing', async () => {
    const { get, rosterCalls, listCalls } = setup({
      viewer: null,
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') })],
    });
    const captured = await get();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(rosterCalls).toEqual([]);
    expect(listCalls).toEqual([]);
  });

  it('answers an empty list when this deployment has no routines', async () => {
    const { get } = setup({ routines: false });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ tasks: [], unavailableAgents: [] });
  });

  it('takes no agent or routine from the request', async () => {
    const { get, listCalls } = setup({
      rosters: {
        alice: [
          { id: 'a1', displayName: 'Caveman' },
          { id: 'a2', displayName: 'Juniper' },
        ],
        bob: [{ id: 'a3', displayName: 'Quill' }],
      },
      managers: { a1: ['alice'], a2: ['alice'], a3: ['bob'] },
      rows: [
        stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') }),
        stored({ agentId: 'a2', routineId: 't2' }),
        stored({ agentId: 'a3', routineId: 'x', ownerUserId: 'bob', task: report('on-track') }),
      ],
    });
    const bare = await get();
    const scoped = await get({
      ...mkReq({ agentId: 'a3' }),
      query: { agentid: 'a3', routineid: 'x' },
    });
    expect(bare.statusCode).toBe(200);
    expect(routineIds(bare)).toEqual(['t1', 't2']);
    expect(scoped.statusCode).toBe(200);
    expect(scoped.body).toEqual(bare.body);
    expect(listCalls.some((c) => c.input.agentId === 'a3' || c.agentId === 'a3')).toBe(false);
  });

  it('fails the route, rather than answering an empty list, when the roster cannot be read', async () => {
    // An empty 200 here would tell the page "No tasks yet" during an agents-store outage.
    const { get, listCalls, lastWritten } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') })],
      rosterFailure: new Error('agents store is down'),
    });
    await expect(get()).rejects.toThrow('agents store is down');
    expect(lastWritten()?.statusCode).not.toBe(200);
    expect(lastWritten()?.body).toBeUndefined();
    expect(listCalls).toEqual([]);
  });

  it('answers an empty list without reading the roster when this deployment has no routines', async () => {
    const { get, rosterCalls } = setup({
      routines: false,
      rosterFailure: new Error('agents store is down'),
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ tasks: [], unavailableAgents: [] });
    expect(rosterCalls).toEqual([]);
  });

  it('names an agent that does not answer in time, and lists the rest', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(initCtx.logger, 'warn');
    try {
      const { get } = setup({
        rows: [
          stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') }),
          stored({ agentId: 'a2', routineId: 't2' }),
        ],
        hang: new Set(['a2']),
      });
      let done = false;
      const pending = get().then((c) => {
        done = true;
        return c;
      });
      await vi.advanceTimersByTimeAsync(TASKS_AGENT_READ_DEADLINE_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const captured = await pending;
      expect(captured.statusCode).toBe(200);
      expect(routineIds(captured)).toEqual(['t1']);
      expect(bodyOf(captured).unavailableAgents).toEqual([
        { agentId: 'a2', agentName: 'Juniper' },
      ]);
      expect(warn).toHaveBeenCalledWith('workspace_tasks_read_failed', {
        agentId: 'a2',
        error: expect.stringContaining('did not answer'),
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('still logs why an agent failed when it fails after the page gave up on it', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(initCtx.logger, 'warn');
    try {
      const { get } = setup({
        rows: [stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') })],
        lateFailure: new Map([['a2', TASKS_AGENT_READ_DEADLINE_MS + 2_000]]),
      });
      const pending = get();
      await vi.advanceTimersByTimeAsync(TASKS_AGENT_READ_DEADLINE_MS);
      const captured = await pending;
      expect(bodyOf(captured).unavailableAgents).toEqual([
        { agentId: 'a2', agentName: 'Juniper' },
      ]);
      expect(warn).not.toHaveBeenCalledWith('workspace_tasks_late_read_failed', expect.anything());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(warn).toHaveBeenCalledWith('workspace_tasks_late_read_failed', {
        agentId: 'a2',
        error: expect.stringContaining('pool exhausted'),
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('answers 503 when no agent could be read, so the page does not call it a partial list', async () => {
    const { get } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', task: report('needs-you') })],
      failures: new Map([
        ['a1', new Error('connection terminated unexpectedly')],
        ['a2', new Error('connection terminated unexpectedly')],
      ]),
    });
    const captured = await get();
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'tasks-read-failed' });
  });

  it('answers an empty list for a person with no agents', async () => {
    const { get, listCalls } = setup({ rosters: {} });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ tasks: [], unavailableAgents: [] });
    expect(listCalls).toEqual([]);
  });

  it('keeps a paused task, marked not enabled', async () => {
    const { get } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', enabled: false, task: report('needs-you') })],
    });
    const captured = await get();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).tasks).toEqual([
      expect.objectContaining({ routineId: 't1', enabled: false }),
    ]);
  });

  describe('noRecentUpdate (TASK-930)', () => {
    const miss = (over: Partial<NonNullable<StoredRoutine['noRecentUpdate']>> = {}) => ({
      inARow: 2,
      reason: 'brief-too-long' as const,
      at: new Date('2026-10-22T11:00:00.000Z'),
      autoPausedAt: null,
      ...over,
    });

    it('carries a task’s missed check-ins as the page draws them, with the time as an instant', async () => {
      const { get } = setup({
        rows: [stored({ agentId: 'a1', routineId: 't1', noRecentUpdate: miss() })],
      });
      const captured = await get();
      expect(captured.statusCode).toBe(200);
      expect(bodyOf(captured).tasks[0]?.noRecentUpdate).toStrictEqual({
        inARow: 2,
        reason: 'brief-too-long',
        at: '2026-10-22T11:00:00.000Z',
        autoPaused: false,
      });
    });

    it('says autoPaused when ax paused the task, and not for a task that never missed', async () => {
      const { get } = setup({
        rows: [
          stored({
            agentId: 'a1',
            routineId: 't1',
            enabled: false,
            noRecentUpdate: miss({ inARow: 5, autoPausedAt: new Date('2026-10-22T11:05:00.000Z') }),
          }),
          stored({ agentId: 'a2', routineId: 't2', task: report('on-track') }),
        ],
      });
      const tasks = bodyOf(await get()).tasks;
      expect(tasks.find((t) => t.routineId === 't1')?.noRecentUpdate).toMatchObject({
        inARow: 5,
        autoPaused: true,
      });
      expect(tasks.find((t) => t.routineId === 't2')?.noRecentUpdate).toBeNull();
    });

    it('reads a reason the page doesn’t know as failed, field by field', async () => {
      const { get } = setup({
        unvalidated: true,
        rows: [
          stored({
            agentId: 'a1',
            routineId: 't1',
            noRecentUpdate: miss({ reason: 'SOMETHING-NEW' as never }),
          }),
        ],
      });
      const wire = bodyOf(await get()).tasks[0]?.noRecentUpdate;
      expect(wire).toStrictEqual({
        inARow: 2,
        reason: 'failed',
        at: '2026-10-22T11:00:00.000Z',
        autoPaused: false,
      });
    });

    const wireMiss = {
      inARow: 2,
      reason: 'no-report',
      at: '2026-10-22T11:00:00.000Z',
      autoPaused: false,
    };

    it.each([
      ['no missed-check-in field at all', undefined],
      ['a missed-check-in value that is not an object', 'oops'],
      ['a zero count', { ...wireMiss, inARow: 0 }],
      ['a fractional count', { ...wireMiss, inARow: 1.5 }],
      ['a non-numeric count', { ...wireMiss, inARow: 'two' }],
      ['a missing count', { ...wireMiss, inARow: undefined }],
      ['a time that is not a string', { ...wireMiss, at: 42 }],
      ['a missing time', { ...wireMiss, at: undefined }],
    ])('reads a view with %s as no miss, not a crash', async (_name, value) => {
      const { get } = setup({
        unvalidated: true,
        viewMiss: { value },
        rows: [stored({ agentId: 'a1', routineId: 't1' })],
      });
      const captured = await get();
      expect(captured.statusCode).toBe(200);
      expect(bodyOf(captured).tasks[0]?.noRecentUpdate).toBeNull();
    });

    it('reads anything but a literal true as not auto-paused', async () => {
      const { get } = setup({
        unvalidated: true,
        viewMiss: { value: { ...wireMiss, autoPaused: 'yes' } },
        rows: [stored({ agentId: 'a1', routineId: 't1' })],
      });
      expect(bodyOf(await get()).tasks[0]?.noRecentUpdate).toStrictEqual({
        inARow: 2,
        reason: 'no-report',
        at: '2026-10-22T11:00:00.000Z',
        autoPaused: false,
      });
    });
  });
});
