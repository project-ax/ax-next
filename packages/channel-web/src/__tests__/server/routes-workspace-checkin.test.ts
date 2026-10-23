// @vitest-environment node
/**
 * One check-in's transcript (TASK-911): `GET
 * /api/workspace/tasks/:agentId/:routineId/checkins/:conversationId`, read-only,
 * for its task's owner only.
 *
 * The route runs the task page's order (`ownTaskOr404`, shared with
 * `taskDetail`), then checks the conversation is one of the task's newest 200
 * check-ins, and only then reads it. So `routines:get` here is the real view
 * producer, as in `routes-workspace-task.test.ts`: each view is made by
 * @ax/routines' own `routineView` and parsed on the bus through
 * `RoutineGetOutputSchema`, which pins the ownership rule against the
 * services' `taskView` and `routinePermissions`. `routines:recent-fires`
 * parses its input as the service does and answers the world's fire views for
 * the task asked about, newest first and at most `limit`. `conversations:get`
 * mirrors its producer: an unknown id and another person's conversation are
 * both `not-found`.
 *
 * Most tests here are about what is READ as much as what is answered. A
 * check-in's address that names something else the caller owns (their own
 * chat, another task's check-in) must never become a way to read it.
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
  RoutineGetInputSchema,
  RoutineGetOutputSchema,
  RoutineRecentFiresInputSchema,
  RoutineRecentFiresOutputSchema,
  type RoutineFireView,
  type RoutineReportStatus,
} from '@ax/routines-contract';
import { makeWorkspaceHandlers } from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import type { TaskCheckin } from '../../lib/workspace-types.js';
import { parseRoutineInput, routineView } from '../../../../routines/src/services.js';
import type { StoredRoutine } from '../../../../routines/src/types.js';
import { routineFixture } from '../../components/routines/__tests__/routine-fixture.js';

function mkReq(params: Record<string, string> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
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
 * One check-in of task t1 on a1, as `routines:recent-fires` shows it. The
 * fields a check-in's page never draws carry markers no response may contain.
 */
function fire(over: Partial<RoutineFireView> = {}): RoutineFireView {
  return {
    agentId: 'a1',
    routineId: 't1',
    firedAt: '2026-10-22T09:57:00.000Z',
    triggerSource: 'tick',
    conversationId: 'c1',
    status: 'ok',
    error: null,
    renderedPrompt: 'PROMPT-TEXT',
    warning: 'WARNING-TEXT',
    report: null,
    ...over,
  };
}

/** One stored turn, as `conversations:get` answers it. */
interface TurnFixture {
  turnId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'tool';
  contentBlocks: Array<Record<string, unknown>>;
  createdAt: string;
}

/** One stored conversation. */
interface ConversationFixture {
  userId: string;
  agentId: string;
  turns: TurnFixture[];
  displayEvents?: Array<Record<string, unknown>>;
  /**
   * Set: `conversations:get` answers it to anyone, as a producer that drifted
   * would. The route must still refuse it to anyone but its owner.
   */
  answersAnyone?: boolean;
}

/**
 * A check-in's conversation, as a per-fire run leaves it: the check-in message
 * the host sent the agent (quoting the agent's own notes), then what the agent
 * thought, said and ran.
 */
function checkInTurns(): TurnFixture[] {
  return [
    {
      turnId: 'turn-1',
      turnIndex: 0,
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'Scheduled check-in.\n\n> NOTES-TEXT' }],
      createdAt: '2026-10-22T09:57:01.000Z',
    },
    {
      turnId: 'turn-2',
      turnIndex: 1,
      role: 'assistant',
      contentBlocks: [
        { type: 'thinking', thinking: 'SCRATCHPAD-TEXT' },
        { type: 'text', text: 'Checking the queue.' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'pnpm test' } },
      ],
      createdAt: '2026-10-22T09:57:02.000Z',
    },
    {
      turnId: 'turn-3',
      turnIndex: 2,
      role: 'tool',
      contentBlocks: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: [{ type: 'text', text: 'TOOL-OUTPUT all green' }],
        },
      ],
      createdAt: '2026-10-22T09:57:03.000Z',
    },
    {
      turnId: 'turn-4',
      turnIndex: 3,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'Queue is empty.' }],
      createdAt: '2026-10-22T09:57:04.000Z',
    },
  ];
}

/** One assistant turn saying `text`: enough to tell a transcript apart. */
function saying(text: string): TurnFixture[] {
  return [
    {
      turnId: 'turn-x',
      turnIndex: 0,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text }],
      createdAt: '2026-10-22T09:57:02.000Z',
    },
  ];
}

/**
 * The plugin-side decision row, as `decisions:list` hands it over: the FULL
 * row, as in `routes-workspace.test.ts`'s approval tests, so a projection
 * that forgot to drop a field would show.
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

/** A still-open decision alice's check-in c1 raised: unattended, as a routine run's is. */
function decision(over: Partial<StoredDecisionLike> & { id: string }): StoredDecisionLike {
  return {
    agentId: 'a1',
    ownerUserId: 'alice',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'unattended',
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
    createdAt: '2026-10-22T09:57:03.000Z',
    expiresAt: '2026-10-23T09:57:03.000Z',
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

interface World {
  viewer: string | null;
  /** Each agent, and the users `agents:resolve` lets reach it. */
  agents: Record<string, { displayName: string; users: string[] }>;
  rows: StoredRoutine[];
  /** Per agent, the users `agents:can-manage-routines` says yes to. */
  managers: Record<string, string[]>;
  /** Every task's check-ins, newest first. `routines:recent-fires` answers one task's. */
  fires: RoutineFireView[];
  /** Per conversation id, what `conversations:get` holds. */
  conversations: Record<string, ConversationFixture>;
  /** `null`: no `decisions:list` service in this deployment. Otherwise its rows. */
  decisions: StoredDecisionLike[] | null;
  /** Service hooks this deployment doesn't have. */
  absent: Set<string>;
  /** Set: `routines:recent-fires` throws this. */
  firesFailure: Error | null;
  /** Set: `conversations:get` throws this. */
  convFailure: Error | null;
  /**
   * Set: a `memory:recall-receipts` service answering this for any conversation.
   * `null`: the deployment has none, as in every other test here.
   */
  recallReceipts: unknown;
}

interface Call<I> {
  userId: string;
  agentId: string;
  input: I;
}

const PARAMS = { agentId: 'a1', routineId: 't1', conversationId: 'c1' };

function setup(over: Partial<World> = {}) {
  const world: World = {
    viewer: 'alice',
    agents: { a1: { displayName: 'Caveman', users: ['alice'] } },
    rows: [stored({ agentId: 'a1', routineId: 't1', task: report('on-track') })],
    managers: { a1: ['alice'] },
    fires: [fire()],
    conversations: { c1: { userId: 'alice', agentId: 'a1', turns: checkInTurns() } },
    decisions: null,
    absent: new Set(),
    firesFailure: null,
    convFailure: null,
    recallReceipts: null,
    ...over,
  };
  const bus = new HookBus();
  const resolveCalls: Array<{ agentId: string; userId: string }> = [];
  const getCalls: Array<Call<unknown>> = [];
  const firesCalls: Array<Call<unknown>> = [];
  const convCalls: Array<{ conversationId: string; userId: string }> = [];
  const decisionsCalls: unknown[] = [];

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
        const input = parseRoutineInput(RoutineGetInputSchema, raw);
        const row = world.rows.find(
          (r) => r.agentId === input.agentId && r.routineId === input.routineId,
        );
        if (row === undefined) throw new SafeToolError('not-found', 'routineId');
        const allowed = world.managers[input.agentId]?.includes(ctx.userId) ?? false;
        return routineView(row, ctx.userId, allowed);
      },
      { returns: RoutineGetOutputSchema },
    );
  }
  if (!world.absent.has('routines:recent-fires')) {
    bus.registerService(
      'routines:recent-fires',
      'routines',
      async (ctx: AgentContext, raw: unknown) => {
        firesCalls.push({ userId: ctx.userId, agentId: ctx.agentId, input: raw });
        if (world.firesFailure !== null) throw world.firesFailure;
        // The service's own input check: a limit past 200 is refused.
        const input = parseRoutineInput(RoutineRecentFiresInputSchema, raw);
        return {
          fires: world.fires
            .filter((f) => f.agentId === input.agentId && f.routineId === input.routineId)
            .slice(0, input.limit ?? 20),
        };
      },
      { returns: RoutineRecentFiresOutputSchema },
    );
  }
  bus.registerService('conversations:get', 'conversations', async (_ctx, raw: unknown) => {
    const input = raw as { conversationId: string; userId: string };
    convCalls.push({ conversationId: input.conversationId, userId: input.userId });
    if (world.convFailure !== null) throw world.convFailure;
    const conv = world.conversations[input.conversationId];
    // Owner-only, like the producer: "not yours" and "not there" are one answer.
    if (conv === undefined || (conv.userId !== input.userId && conv.answersAnyone !== true)) {
      throw new PluginError({
        code: 'not-found',
        plugin: 'conversations',
        hookName: 'conversations:get',
        message: `conversation '${input.conversationId}' not found`,
      });
    }
    return {
      conversation: {
        conversationId: input.conversationId,
        userId: conv.userId,
        agentId: conv.agentId,
        title: null,
        activeSessionId: null,
        createdAt: '2026-10-22T09:57:00.000Z',
      },
      turns: conv.turns,
      displayEvents: conv.displayEvents ?? [],
    };
  });
  if (world.decisions !== null) {
    const rows = world.decisions;
    bus.registerService('decisions:list', 'decisions', async (_ctx, raw: unknown) => {
      decisionsCalls.push(raw);
      const { userId, agentId } = raw as { userId: string; agentId?: string };
      return {
        decisions: rows.filter(
          (d) => d.ownerUserId === userId && (agentId === undefined || d.agentId === agentId),
        ),
      };
    });
  }

  if (world.recallReceipts !== null) {
    const reply = world.recallReceipts;
    bus.registerService('memory:recall-receipts', 'memory', async () => reply);
  }

  const handlers = makeWorkspaceHandlers({ bus, initCtx });
  /** What the last request wrote, kept even when the handler throws. */
  let last: CapturedRes | null = null;
  async function checkin(params: Record<string, string> = PARAMS): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    last = captured;
    await handlers.taskCheckin(mkReq(params), res);
    return captured;
  }
  return {
    checkin,
    resolveCalls,
    getCalls,
    firesCalls,
    convCalls,
    decisionsCalls,
    lastWritten: () => last,
  };
}

function bodyOf(captured: CapturedRes): TaskCheckin {
  return captured.body as TaskCheckin;
}

/** A team agent alice and bob can both reach. */
const TEAM_AGENTS: World['agents'] = { team: { displayName: 'Support', users: ['alice', 'bob'] } };

describe('GET /api/workspace/tasks/:agentId/:routineId/checkins/:conversationId (TASK-911)', () => {
  it('shows a check-in’s transcript: what the agent said and the tools it ran', async () => {
    const { checkin } = setup({
      fires: [
        fire({
          conversationId: 'c1',
          triggerSource: 'tick',
          status: 'ok',
          report: { status: 'on-track', update: 'Queue is empty.', ask: 'HISTORY-ASK' },
        }),
      ],
    });
    const captured = await checkin();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toStrictEqual({
      taskName: 'Project check-in',
      agentName: 'Caveman',
      checkIn: {
        firedAt: '2026-10-22T09:57:00.000Z',
        status: 'ok',
        error: null,
        report: { status: 'on-track', update: 'Queue is empty.' },
        conversationId: 'c1',
      },
      triggerSource: 'tick',
      thread: [
        {
          kind: 'steps',
          id: 'turn-2',
          text: 'Checking the queue.',
          at: '2026-10-22T09:57:02.000Z',
          stepsLabel: '1 step',
          steps: [{ text: 'Bash: pnpm test', status: 'done' }],
        },
        { kind: 'agent', id: 'turn-4', text: 'Queue is empty.', at: '2026-10-22T09:57:04.000Z' },
      ],
      decisions: { status: 'unavailable' },
    } satisfies TaskCheckin);
    // Spelled out, though the strict match above already says it: the run's
    // ask, its stored prompt and warning, and the tool's raw output never
    // cross. A step is the tool and what it ran on, never what came back.
    const wire = JSON.stringify(captured.body);
    for (const marker of ['HISTORY-ASK', 'PROMPT-TEXT', 'WARNING-TEXT', 'TOOL-OUTPUT']) {
      expect(wire).not.toContain(marker);
    }
  });

  it('never draws the check-in message the host sent, as if the person had said it', async () => {
    const { checkin } = setup();
    const captured = await checkin();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).thread.filter((m) => m.kind === 'user')).toEqual([]);
    expect(JSON.stringify(captured.body)).not.toContain('NOTES-TEXT');
  });

  it('keeps the model’s scratchpad off the wire', async () => {
    const { checkin } = setup();
    const captured = await checkin();
    expect(captured.statusCode).toBe(200);
    expect(JSON.stringify(captured.body)).not.toContain('SCRATCHPAD-TEXT');
  });

  /*
    A negative-space guard. The client draws a memory chip under any row that
    carries `memoryUsed`, and the chip offers to change what the agent
    remembers. A read-only page has no business offering that, so no row of a
    check-in's transcript may carry the field.

    The world supplies what the agent view's `withMemoryUsed` needs to attach
    one: a `memory:recall-receipts` service whose receipt falls after the
    check-in message (a person-style turn, which opens an exchange) and names
    a valid statement. Without a receipt there, a route that did call it would
    still add nothing, and this test would pass for nothing.
  */
  it('keeps memory chips off a check-in’s transcript', async () => {
    const { checkin } = setup({
      recallReceipts: {
        visibility: 'personal',
        receipts: [
          {
            at: '2026-10-22T09:57:05.000Z',
            statements: [
              {
                id: 's1',
                about: 'Acme',
                relation: 'is',
                value: 'an enterprise customer',
                when: '2026-10-01',
              },
            ],
          },
        ],
      },
    });
    const captured = await checkin();
    expect(captured.statusCode).toBe(200);
    const { thread } = bodyOf(captured);
    // Rows that could carry a chip: the agent's words and its tool steps.
    expect(thread.filter((m) => m.kind === 'agent' || m.kind === 'steps').length).toBeGreaterThan(0);
    for (const row of thread) {
      expect('memoryUsed' in row).toBe(false);
    }
    expect(JSON.stringify(captured.body)).not.toContain('enterprise customer');
  });

  it('reads the task’s newest 200 check-ins and the conversation, both as the caller', async () => {
    const { checkin, getCalls, firesCalls, convCalls } = setup();
    const captured = await checkin();
    expect(captured.statusCode).toBe(200);
    expect(getCalls).toEqual([
      { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', routineId: 't1' } },
    ]);
    expect(firesCalls).toEqual([
      { userId: 'alice', agentId: 'a1', input: { agentId: 'a1', routineId: 't1', limit: 200 } },
    ]);
    expect(convCalls).toEqual([{ conversationId: 'c1', userId: 'alice' }]);
  });

  it('404s a check-in older than the newest 200, without reading it', async () => {
    // The Updates thread shows 50, so every link it draws resolves; one this
    // old needs a lookup routines doesn't offer yet (TASK-911 decisions row 9).
    const fires = Array.from({ length: 201 }, (_, i) =>
      fire({
        firedAt: new Date(Date.parse('2026-10-22T09:57:00.000Z') - i * 3_600_000).toISOString(),
        conversationId: `c-${i}`,
      }),
    );
    const { checkin, convCalls } = setup({
      fires,
      conversations: { 'c-200': { userId: 'alice', agentId: 'a1', turns: saying('OLD-TEXT') } },
    });
    const captured = await checkin({ agentId: 'a1', routineId: 't1', conversationId: 'c-200' });
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'checkin-not-found' });
    expect(convCalls).toEqual([]);
  });

  it('404s a conversation several runs shared, without reading it', async () => {
    // A routine that ran as a shared-conversation repeat before it became a
    // task keeps those runs in one conversation. No one check-in owns it, so
    // the page would label every run's transcript with one run's report.
    const { checkin, convCalls } = setup({
      fires: [
        fire({ firedAt: '2026-10-22T09:57:00.000Z', conversationId: 'c-own' }),
        fire({ firedAt: '2026-10-21T09:57:00.000Z', conversationId: 'c-shared' }),
        fire({ firedAt: '2026-10-20T09:57:00.000Z', conversationId: 'c-shared' }),
      ],
      conversations: {
        'c-own': { userId: 'alice', agentId: 'a1', turns: checkInTurns() },
        'c-shared': { userId: 'alice', agentId: 'a1', turns: saying('SHARED-TEXT') },
      },
    });
    const captured = await checkin({ agentId: 'a1', routineId: 't1', conversationId: 'c-shared' });
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'checkin-not-found' });
    expect(convCalls).toEqual([]);
    const own = await checkin({ agentId: 'a1', routineId: 't1', conversationId: 'c-own' });
    expect(own.statusCode).toBe(200);
  });

  it('404s another task’s check-in on the same agent, without reading it', async () => {
    const { checkin, firesCalls, convCalls } = setup({
      rows: [
        stored({ agentId: 'a1', routineId: 't1', task: report('on-track') }),
        stored({ agentId: 'a1', routineId: 't2', task: report('on-track') }),
      ],
      fires: [
        fire({ routineId: 't1', conversationId: 'c1' }),
        fire({ routineId: 't2', conversationId: 'c-t2' }),
      ],
      conversations: {
        c1: { userId: 'alice', agentId: 'a1', turns: checkInTurns() },
        'c-t2': { userId: 'alice', agentId: 'a1', turns: saying('T2-TEXT') },
      },
    });
    const captured = await checkin({ agentId: 'a1', routineId: 't1', conversationId: 'c-t2' });
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'checkin-not-found' });
    expect(firesCalls).toHaveLength(1);
    expect(convCalls).toEqual([]);
  });

  it('404s the caller’s own chat with the same agent, without reading it', async () => {
    const { checkin, convCalls } = setup({
      conversations: {
        c1: { userId: 'alice', agentId: 'a1', turns: checkInTurns() },
        'chat-1': { userId: 'alice', agentId: 'a1', turns: saying('CHAT-TEXT') },
      },
    });
    const chat = await checkin({ agentId: 'a1', routineId: 't1', conversationId: 'chat-1' });
    expect(chat.statusCode).toBe(404);
    expect(chat.body).toEqual({ error: 'checkin-not-found' });
    expect(convCalls).toEqual([]);
    // The answer doesn't say whether the conversation exists: an id nobody
    // has gets the same one.
    const nobodys = await checkin({ agentId: 'a1', routineId: 't1', conversationId: 'no-such' });
    expect(nobodys).toEqual(chat);
    expect(convCalls).toEqual([]);
  });

  it.each([
    ['who manages the agent’s tasks', ['alice', 'bob']],
    ['who doesn’t manage the agent’s tasks', ['bob']],
  ])(
    '404s someone else’s task on a team agent, to a viewer %s, and reads neither its check-ins nor the conversation',
    async (_who, managers) => {
      const { checkin, firesCalls, convCalls } = setup({
        agents: TEAM_AGENTS,
        managers: { team: managers },
        rows: [
          stored({
            agentId: 'team',
            routineId: 'tB',
            name: 'BOB-TASK',
            ownerUserId: 'bob',
            task: report('off-track', { update: 'BOB-UPDATE', agentNotes: 'BOB-NOTES' }),
          }),
        ],
        fires: [
          fire({
            agentId: 'team',
            routineId: 'tB',
            conversationId: 'c-bob',
            report: { status: 'off-track', update: 'BOB-UPDATE', ask: null },
          }),
        ],
        conversations: {
          'c-bob': { userId: 'bob', agentId: 'team', turns: saying('BOB-TRANSCRIPT') },
        },
      });
      const captured = await checkin({ agentId: 'team', routineId: 'tB', conversationId: 'c-bob' });
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'task-not-found' });
      expect(firesCalls).toEqual([]);
      expect(convCalls).toEqual([]);
      expect(JSON.stringify(captured.body)).not.toContain('BOB-');
    },
  );

  it('404s a repeat routine, and reads neither', async () => {
    const { checkin, firesCalls, convCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't1', kind: 'repeat', goodWhen: null })],
    });
    const captured = await checkin();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
    expect(convCalls).toEqual([]);
  });

  it('404s a task that isn’t there, and reads neither', async () => {
    const { checkin, firesCalls, convCalls } = setup({
      rows: [stored({ agentId: 'a1', routineId: 't2', task: report('on-track') })],
    });
    const captured = await checkin();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(firesCalls).toEqual([]);
    expect(convCalls).toEqual([]);
  });

  it('404s an agent the caller can’t reach, reading nothing', async () => {
    const { checkin, resolveCalls, getCalls, firesCalls, convCalls } = setup({ viewer: 'bob' });
    const captured = await checkin();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'bob' }]);
    expect(getCalls).toEqual([]);
    expect(firesCalls).toEqual([]);
    expect(convCalls).toEqual([]);
  });

  it.each([
    [
      'an earlier owner’s, which conversations:get refuses',
      { userId: 'carol', agentId: 'a1', turns: saying('CAROL-TEXT') },
      null,
    ],
    [
      'another person’s, answered anyway by a conversations:get that drifted',
      { userId: 'carol', agentId: 'a1', turns: saying('CAROL-TEXT'), answersAnyone: true },
      null,
    ],
    [
      'another agent’s',
      { userId: 'alice', agentId: 'a2', turns: saying('A2-TEXT') },
      null,
    ],
    [
      'one conversations:get calls forbidden',
      { userId: 'alice', agentId: 'a1', turns: saying('FORBIDDEN-TEXT') },
      new PluginError({ code: 'forbidden', plugin: 'conversations', message: 'no' }),
    ],
  ])(
    '404s a check-in whose conversation isn’t the caller’s, or isn’t this agent’s: %s',
    async (_what, conversation: ConversationFixture, convFailure) => {
      const { checkin, convCalls } = setup({
        conversations: { c1: conversation },
        convFailure,
      });
      const captured = await checkin();
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'checkin-not-found' });
      expect(convCalls).toEqual([{ conversationId: 'c1', userId: 'alice' }]);
      expect(JSON.stringify(captured.body)).not.toContain('-TEXT');
    },
  );

  it('a transcript or a history that can’t be read fails the request', async () => {
    // "We don't know" must not render as "there's nothing here" (design H7).
    const conv = setup({ convFailure: new Error('db down') });
    await expect(conv.checkin()).rejects.toThrow('db down');
    expect(conv.lastWritten()?.body).toBeUndefined();

    const history = setup({ firesFailure: new Error('pool exhausted') });
    await expect(history.checkin()).rejects.toThrow('pool exhausted');
    expect(history.lastWritten()?.body).toBeUndefined();
    expect(history.convCalls).toEqual([]);
  });

  it('shows an approval the check-in is still waiting on, and only that one', async () => {
    const { checkin, decisionsCalls } = setup({
      decisions: [
        decision({ id: 'd1', conversationId: 'c1' }),
        decision({ id: 'd2', conversationId: 'c-other', summary: 'D2-SUMMARY' }),
      ],
    });
    const captured = await checkin();
    expect(captured.statusCode).toBe(200);
    const body = bodyOf(captured);
    expect(body.thread.at(-1)).toEqual({ kind: 'approval', id: 'decision-d1', decisionId: 'd1' });
    expect(body.thread.filter((m) => m.kind === 'approval')).toHaveLength(1);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('decision-d2');
    // A pointer, not a copy: the row itself is the queue's.
    for (const marker of ['D2-SUMMARY', 'Send your reply to Priya', 'the drafted reply']) {
      expect(wire).not.toContain(marker);
    }
    expect(body.decisions).toEqual({ status: 'ok' });
    expect(decisionsCalls).toEqual([{ userId: 'alice', agentId: 'a1' }]);
  });

  it('fences the report it ended with, and a failed check-in’s reason', async () => {
    const { checkin } = setup({
      fires: [
        fire({
          firedAt: '2026-10-22T10:57:00.000Z',
          conversationId: 'c2',
          status: 'error',
          error: 'line one\nline two',
        }),
        fire({
          conversationId: 'c1',
          report: { status: 'off-track', update: 'first\nsecond', ask: null },
        }),
      ],
      conversations: {
        c1: { userId: 'alice', agentId: 'a1', turns: checkInTurns() },
        c2: { userId: 'alice', agentId: 'a1', turns: saying('It broke.') },
      },
    });
    const reported = bodyOf(await checkin());
    expect(reported.checkIn.conversationId).toBe('c1');
    expect(reported.checkIn.report).toEqual({ status: 'off-track', update: 'first second' });
    const failed = bodyOf(await checkin({ agentId: 'a1', routineId: 't1', conversationId: 'c2' }));
    expect(failed.checkIn.conversationId).toBe('c2');
    expect(failed.checkIn.status).toBe('error');
    expect(failed.checkIn.error).toBe('line one line two');
  });

  it.each(['tick', 'manual', 'webhook'] as const)('says what started it: %s', async (source) => {
    const { checkin } = setup({ fires: [fire({ triggerSource: source })] });
    const captured = await checkin();
    expect(captured.statusCode).toBe(200);
    expect(bodyOf(captured).triggerSource).toBe(source);
  });

  it('401s without a session, and reads nothing', async () => {
    const { checkin, resolveCalls, getCalls, firesCalls, convCalls } = setup({ viewer: null });
    const captured = await checkin();
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
    expect(firesCalls).toEqual([]);
    expect(convCalls).toEqual([]);
  });

  it.each([
    ['an empty check-in id', { agentId: 'a1', routineId: 't1', conversationId: '  ' }, 'missing-checkin-id'],
    ['no check-in id at all', { agentId: 'a1', routineId: 't1' }, 'missing-checkin-id'],
    ['a blank task id', { agentId: 'a1', routineId: ' ', conversationId: 'c1' }, 'missing-task-id'],
  ])('400s %s, and calls nothing past auth:require-user', async (_what, params: Record<string, string>, error) => {
    const { checkin, resolveCalls, getCalls, firesCalls, convCalls, decisionsCalls } = setup({
      decisions: [decision({ id: 'd1' })],
    });
    const captured = await checkin(params);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ error });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
    expect(firesCalls).toEqual([]);
    expect(convCalls).toEqual([]);
    expect(decisionsCalls).toEqual([]);
  });

  it.each([
    ['without routines at all', ['routines:get', 'routines:recent-fires']],
    ['without routines:get', ['routines:get']],
    ['without routines:recent-fires', ['routines:recent-fires']],
  ])('404s in a deployment %s, and reads nothing', async (_what, absent) => {
    const { checkin, resolveCalls, getCalls, firesCalls, convCalls } = setup({
      absent: new Set(absent),
    });
    const captured = await checkin();
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ error: 'task-not-found' });
    expect(resolveCalls).toEqual([]);
    expect(getCalls).toEqual([]);
    expect(firesCalls).toEqual([]);
    expect(convCalls).toEqual([]);
  });
});
