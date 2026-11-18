import { afterEach, describe, it, expect } from 'vitest';
import {
  makeAgentContext,
  createLogger,
  type AgentContext,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-1127 — a skill grant (`agent:apply-capability-grant`, and
// `agent:apply-authored-capability-grant` given a conversation) must never end
// the conversation's session under a turn that is still running there. It ends
// the session at once only when it's idle; otherwise it marks it, the running
// turn finishes, and the next turn restarts the session with the skill.
//
// A keepAlive harness modeled on orchestrator.test.ts's makeKeepaliveHarness,
// plus what a running-turn test needs:
//   - one conversation row ('conv-1') whose `activeReqId` is bound by
//     `conversations:bind-session` and compare-cleared at turn end, as
//     @ax/conversations does; `session:terminate` clears both row fields when
//     the row names the ended session (its `clearBySessionId`). Any other
//     conversation id reads as another of the same person's conversations,
//     with no session;
//   - a `session:terminate` service that, its work done, fires the
//     `session:terminate` event, as @ax/session-postgres and
//     @ax/session-inmemory do. The orchestrator subscribes to it
//     (`onSessionTerminate`): a turn still waiting on the session gets
//     `sandbox-terminated`, so a test sees a turn cut off under it;
//   - an optional failure of the first `session:terminate`, thrown before it
//     changes anything (the store's write failed): the session stays alive
//     and the row still names it;
//   - a session that is alive from its `sandbox:open-session` on (the
//     providers call `session:create` inside the open), with a runner a test
//     can make exit (`exitRunner`), as one does once its session is ended;
//   - user skill attachments a grant writes and the next spawn reads, and one
//     authored draft that starts `pending`;
//   - an optional hold on one reqId's bind, so a turn can be parked between
//     its routing decision (or its sandbox open) and its bind;
//   - an optional hold on the first sandbox open, so a cold-spawning turn can
//     be parked after it read its skills and before its session is up;
//   - an optional hold on a grant's first row read, AFTER the read: it answers
//     with the row as it was when read, so a turn can end while the grant is
//     still looking;
//   - an optional failure of every grant's row read, as a store hiccup would.
// Turn ends are fired by hand (`endTurn`), so a test decides when a turn is
// still running.
// ---------------------------------------------------------------------------

// Mirrors @ax/agents' AgentRecord shape, as orchestrator.test.ts does.
const TEST_AGENT = {
  id: 'test-agent',
  ownerId: 'test-user',
  ownerType: 'user' as const,
  visibility: 'personal' as const,
  displayName: 'Test',
  allowedTools: ['file.read'],
  mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk',
};

/** The part of a `sandbox:open-session` input these tests read. */
interface OpenInput {
  sessionId: string;
  installedSkills?: Array<{ id: string }>;
}

function installedIds(i: OpenInput): string[] {
  return (i.installedSkills ?? []).map((s) => s.id);
}

const harnesses: TestHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close({ onError: () => {} });
});

async function makeHarness(
  opts: {
    holdBind?: { reqId: string; release: Promise<void> };
    holdFirstOpen?: Promise<void>;
    holdGrantLookup?: Promise<void>;
    failFirstTerminate?: boolean;
    failGrantLookup?: boolean;
  } = {},
) {
  const conv: { activeSessionId: string | null; activeReqId: string | null } = {
    activeSessionId: null,
    activeReqId: null,
  };
  const live = new Set<string>();
  const counters = {
    opens: 0,
    terminates: [] as string[],
    openInputs: [] as OpenInput[],
  };
  const turnErrors: Array<{ reqId: string; reason: string }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const attached: string[] = [];
  let draftStatus: 'pending' | 'active' = 'pending';

  let resolveEnteredBind!: () => void;
  let resolveEnteredOpen!: () => void;
  let resolveEnteredGrantLookup!: () => void;
  const entered = {
    bind: new Promise<void>((resolve) => {
      resolveEnteredBind = resolve;
    }),
    open: new Promise<void>((resolve) => {
      resolveEnteredOpen = resolve;
    }),
    grantLookup: new Promise<void>((resolve) => {
      resolveEnteredGrantLookup = resolve;
    }),
  };
  let grantLookupHeld = false;
  let terminateFailed = false;

  // reqIds whose user message reached `session:queue-work`, and who waits on one.
  const queuedReqIds = new Set<string>();
  const queuedWaiters = new Map<string, Array<() => void>>();

  // The harness's bus, bound right after it is created, before any test step.
  const bound: { bus?: TestHarness['bus'] } = {};

  // Every ctx this harness makes logs into the one shared `logs`.
  function ctxFor(
    sessionId: string,
    reqId: string,
    conversationId = 'conv-1',
    userId = 'test-user',
  ): AgentContext {
    return makeAgentContext({
      sessionId,
      agentId: 'test-agent',
      userId,
      conversationId,
      reqId,
      logger: createLogger({
        reqId,
        writer: (line) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      }),
    });
  }

  // Each spawn gets its own trivial handle (kill resolves exited), kept by
  // session id so a test can make that runner exit.
  const runnerExits = new Map<string, () => void>();
  function makeHandle(sessionId: string) {
    let resolveExit!: () => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
      resolveExit = () => res({ code: 0, signal: null });
    });
    runnerExits.set(sessionId, resolveExit);
    return { kill: async () => { resolveExit(); }, exited };
  }
  function exitRunner(sessionId: string): void {
    const exit = runnerExits.get(sessionId);
    if (exit === undefined) throw new Error(`no runner was opened for ${sessionId}`);
    exit();
  }

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
    'session:queue-work': async (_c, input: unknown) => {
      const i = input as { sessionId: string; entry: { type: string; reqId?: string } };
      if (i.entry.type === 'user-message' && i.entry.reqId !== undefined) {
        queuedReqIds.add(i.entry.reqId);
        for (const wake of queuedWaiters.get(i.entry.reqId) ?? []) wake();
        queuedWaiters.delete(i.entry.reqId);
      }
      return { cursor: 0 };
    },
    'session:terminate': async (c, input: unknown) => {
      const sid = (input as { sessionId: string }).sessionId;
      if (opts.failFirstTerminate === true && !terminateFailed) {
        terminateFailed = true;
        throw new Error('session store unavailable');
      }
      counters.terminates.push(sid);
      live.delete(sid);
      // @ax/conversations' clearBySessionId: a row bound to the ended session
      // loses both its session and its request.
      if (conv.activeSessionId === sid) {
        conv.activeSessionId = null;
        conv.activeReqId = null;
      }
      // Then the store broadcasts the teardown on the same caller ctx.
      if (bound.bus === undefined) throw new Error('harness bus is not bound yet');
      await bound.bus.fire('session:terminate', c, { sessionId: sid });
      return {};
    },
    'session:is-alive': async (_c, input: unknown) => ({
      alive: live.has((input as { sessionId: string }).sessionId),
    }),
    'conversations:get': async (c, input: unknown) => {
      if (opts.failGrantLookup === true && c.reqId.startsWith('grant-')) {
        throw new Error('conversation store unavailable');
      }
      const i = input as { conversationId: string; userId: string };
      const own = i.conversationId === 'conv-1';
      const conversation = {
        conversationId: i.conversationId,
        userId: i.userId,
        agentId: 'test-agent',
        activeSessionId: own ? conv.activeSessionId : null,
        activeReqId: own ? conv.activeReqId : null,
      };
      // A grant's first read can be held after it ran (see `grant` below for
      // the grant's reqIds): it answers with the row read above.
      if (opts.holdGrantLookup !== undefined && c.reqId.startsWith('grant-') && !grantLookupHeld) {
        grantLookupHeld = true;
        resolveEnteredGrantLookup();
        await opts.holdGrantLookup;
      }
      return { conversation };
    },
    'conversations:bind-session': async (_c, input: unknown) => {
      const i = input as { sessionId: string; reqId: string };
      if (opts.holdBind !== undefined && opts.holdBind.reqId === i.reqId) {
        resolveEnteredBind();
        await opts.holdBind.release;
      }
      conv.activeSessionId = i.sessionId; // the row write
      conv.activeReqId = i.reqId;
      return undefined;
    },
    'sandbox:open-session': async (_c, input: unknown) => {
      const i = input as OpenInput;
      counters.opens += 1;
      counters.openInputs.push(i);
      live.add(i.sessionId); // session:create, inside the open
      const handle = makeHandle(i.sessionId);
      // The first open can be held. By now the turn has read its skills and
      // registered its waiter. Its session isn't up (warm) until the open
      // returns, and its bind (the row write) comes after that.
      if (opts.holdFirstOpen !== undefined && counters.opens === 1) {
        resolveEnteredOpen();
        await opts.holdFirstOpen;
      }
      return { runnerEndpoint: 'unix:///tmp/m.sock', handle };
    },
    'proxy:open-session': async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:1',
      caCertPem: 'CA',
      envMap: {},
      proxyAuthToken: 'a'.repeat(32),
    }),
    'proxy:close-session': async () => ({}),
    'skills:attach-for-user': async (_c, input: unknown) => {
      const { skillId } = input as { skillId: string };
      const created = !attached.includes(skillId);
      if (created) attached.push(skillId);
      return { created };
    },
    'skills:list-user-attachments': async () => ({
      attachments: attached.map((skillId) => ({ skillId, credentialBindings: {} })),
    }),
    'skills:resolve': async (_c, input: unknown) => {
      const { skillIds } = input as { skillIds: string[] };
      return {
        skills: skillIds.map((id) => ({
          id,
          manifestYaml: `name: ${id}\n`,
          bodyMd: 'b',
          connectors: [],
        })),
      };
    },
    'agents:resolve-authored-skills': async () => ({
      skills: [
        {
          id: 'my-draft',
          description: 'd',
          connectors: [],
          bodyMd: 'b',
          manifestYaml: 'name: my-draft\n',
          files: [],
          status: draftStatus,
        },
      ],
    }),
    'skills:authored-activate': async () => {
      draftStatus = 'active';
      return { activated: true };
    },
  };

  const h = await createTestHarness({
    services,
    plugins: [
      createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' },
        chatTimeoutMs: 5_000,
        keepAlive: true,
        idleWindowMs: 60_000,
        idleGraceMs: 1_000,
      }),
    ],
  });
  harnesses.push(h);
  bound.bus = h.bus;
  h.bus.subscribe('chat:turn-error', 'obs', async (_ctx, p: unknown) => {
    turnErrors.push(p as { reqId: string; reason: string });
    return undefined;
  });

  function invoke(sessionId: string, reqId: string): Promise<AgentOutcome> {
    return h.bus.call<unknown, AgentOutcome>('agent:invoke', ctxFor(sessionId, reqId), {
      message: { role: 'user', content: 'hi' },
    });
  }

  function queued(reqId: string): Promise<void> {
    if (queuedReqIds.has(reqId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      queuedWaiters.set(reqId, [...(queuedWaiters.get(reqId) ?? []), resolve]);
    });
  }

  // The runner's turn end. @ax/conversations compare-clears the row's bound
  // request first; the IPC server stamps a fresh reqId on the event's ctx.
  let turnEnds = 0;
  async function endTurn(sessionId: string, reqId: string): Promise<void> {
    if (conv.activeReqId === reqId) conv.activeReqId = null;
    turnEnds += 1;
    await h.bus.fire('chat:turn-end', ctxFor(sessionId, `ipc-turn-end-${turnEnds}`), {
      reason: 'user-message-wait',
      reqId,
    });
  }

  function endTurnSoon(sessionId: string, reqId: string): void {
    setImmediate(() => {
      void endTurn(sessionId, reqId);
    });
  }

  // A grant comes from a channel's route, on a ctx of its own (channel-web
  // mints a fresh sessionId and reqId for it), as the person granting: both
  // channels pass that person's id in the ctx and the input alike.
  let grants = 0;
  const grantInput = (skillId: string, conversationId = 'conv-1', userId = 'test-user') => ({
    conversationId,
    userId,
    agentId: 'test-agent',
    skillId,
  });
  function grant(skillId: string, conversationId = 'conv-1', userId = 'test-user'): Promise<unknown> {
    grants += 1;
    return h.bus.call(
      'agent:apply-capability-grant',
      ctxFor(`grant-route-${grants}`, `grant-${grants}`, conversationId, userId),
      grantInput(skillId, conversationId, userId),
    );
  }
  function grantAuthored(skillId: string): Promise<unknown> {
    grants += 1;
    return h.bus.call(
      'agent:apply-authored-capability-grant',
      ctxFor(`grant-route-${grants}`, `grant-${grants}`),
      grantInput(skillId),
    );
  }

  return {
    h,
    conv,
    counters,
    turnErrors,
    logs,
    entered,
    invoke,
    queued,
    endTurn,
    endTurnSoon,
    exitRunner,
    grant,
    grantAuthored,
  };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

// Turn 1 spawns 's-1' fresh and ends. Afterwards 's-1' is warm, the row names
// it, and its binding is cleared: the session is idle.
async function prelude(x: Harness): Promise<void> {
  x.endTurnSoon('s-1', 'req-1');
  await x.invoke('s-1', 'req-1');
  expect(x.counters.opens).toBe(1);
  expect(x.conv).toEqual({ activeSessionId: 's-1', activeReqId: null });
}

describe('TASK-1127: a skill grant never ends a turn that is running', () => {
  it('a grant during a running turn lets it finish; the next turn restarts with the skill', async () => {
    const x = await makeHarness();
    const { counters, logs, turnErrors } = x;
    await prelude(x);

    const t2 = x.invoke('s-2', 'req-2'); // routed into s-1
    await x.queued('req-2'); // in s-1's inbox: running
    expect(await x.grant('notes')).toEqual({ attached: true });
    expect(turnErrors).toEqual([]); // the running turn wasn't told its sandbox ended
    expect(counters.terminates).toEqual([]);
    await x.endTurn('s-1', 'req-2');
    expect(await t2).toEqual({ kind: 'complete', messages: [] });
    expect(turnErrors).toEqual([]);

    x.endTurnSoon('s-3', 'req-3');
    await x.invoke('s-3', 'req-3');
    expect(counters.terminates).toEqual(['s-1']);
    expect(counters.opens).toBe(2);
    expect(installedIds(counters.openInputs[0]!)).not.toContain('notes');
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
    // One grant, one trace: the turn it marked under doesn't mark again as it ends.
    expect(logs.filter((l) => l.msg === 'skill_grant_restart_deferred')).toEqual([
      expect.objectContaining({ sessionId: 's-1' }),
    ]);
    expect(logs.find((l) => l.msg === 'stale_session_respawn')).toMatchObject({
      sessionId: 's-1',
      reason: 'skills-changed',
    });

    // One grant, one restart: the next turn routes into the new session.
    x.endTurnSoon('s-3', 'req-4');
    await x.invoke('s-4', 'req-4');
    expect(counters.opens).toBe(2);
  });

  it('a grant on an idle session ends it at once, as before', async () => {
    const x = await makeHarness();
    const { counters, logs } = x;
    await prelude(x);

    expect(await x.grant('notes')).toEqual({ attached: true });
    expect(counters.terminates).toEqual(['s-1']);
    expect(logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toBeUndefined();

    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(counters.opens).toBe(2);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  });

  it.each([
    ['catalog', 'notes', 'apply_capability_grant_retire_failed', { attached: true }],
    ['authored', 'my-draft', 'authored_grant_retire_failed', { applied: true, respawned: true }],
  ] as const)(
    'the %s grant: when ending the idle session fails, it marks it instead, and the next turn restarts with the skill',
    async (kind, skillId, failedLog, expected) => {
      const x = await makeHarness({ failFirstTerminate: true });
      const { counters, logs } = x;
      await prelude(x);

      expect(await (kind === 'catalog' ? x.grant(skillId) : x.grantAuthored(skillId))).toEqual(
        expected,
      );
      expect(logs.find((l) => l.msg === failedLog)).toBeDefined();
      expect(counters.terminates).toEqual([]); // s-1 is still alive, and the row names it

      x.endTurnSoon('s-2', 'req-2');
      await x.invoke('s-2', 'req-2');
      expect(counters.terminates).toEqual(['s-1']);
      expect(counters.opens).toBe(2);
      expect(installedIds(counters.openInputs[1]!)).toContain(skillId);
    },
  );

  it('a turn routed to the session but not yet bound to the conversation counts as running', async () => {
    let releaseBind!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    const x = await makeHarness({ holdBind: { reqId: 'req-2', release } });
    const { counters } = x;
    await prelude(x);

    const t2 = x.invoke('s-2', 'req-2');
    await x.entered.bind; // routed to s-1: no waiter, no binding yet
    await x.grant('notes');
    expect(counters.terminates).toEqual([]);
    releaseBind();
    await x.queued('req-2');
    await x.endTurn('s-1', 'req-2');
    expect(await t2).toEqual({ kind: 'complete', messages: [] });

    x.endTurnSoon('s-3', 'req-3');
    await x.invoke('s-3', 'req-3');
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  });

  it('a request bound to the conversation without an agent:invoke (a decision continuation) counts as running', async () => {
    const x = await makeHarness();
    const { counters } = x;
    await prelude(x);

    x.conv.activeReqId = 'cont-1'; // channel-web binds a continuation at approve time
    await x.grant('notes');
    expect(counters.terminates).toEqual([]);
    await x.endTurn('s-1', 'cont-1'); // the continuation ends

    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  });

  it('the authored grant marks a busy session too, and reports that it will restart', async () => {
    const x = await makeHarness();
    const { counters } = x;
    await prelude(x);

    const t2 = x.invoke('s-2', 'req-2'); // routed into s-1
    await x.queued('req-2'); // in s-1's inbox: running
    expect(await x.grantAuthored('my-draft')).toEqual({ applied: true, respawned: true });
    expect(counters.terminates).toEqual([]);
    await x.endTurn('s-1', 'req-2');
    expect(await t2).toEqual({ kind: 'complete', messages: [] });

    x.endTurnSoon('s-3', 'req-3');
    await x.invoke('s-3', 'req-3');
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[0]!)).not.toContain('my-draft');
    expect(installedIds(counters.openInputs[1]!)).toContain('my-draft');
  });

  it('a grant while the turn is still starting its sandbox: the turn finishes, the next one restarts with the skill', async () => {
    let releaseOpen!: () => void;
    const holdFirstOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const x = await makeHarness({ holdFirstOpen });
    const { counters, logs, turnErrors } = x;

    const t1 = x.invoke('s-1', 'req-1');
    await x.entered.open; // skills read, sandbox opening
    expect(x.conv).toEqual({ activeSessionId: null, activeReqId: null }); // the row names no session
    expect(await x.grant('notes')).toEqual({ attached: true });
    expect(counters.terminates).toEqual([]);
    releaseOpen();
    await x.queued('req-1');
    await x.endTurn('s-1', 'req-1');
    expect(await t1).toEqual({ kind: 'complete', messages: [] });
    expect(turnErrors).toEqual([]);
    expect(installedIds(counters.openInputs[0]!)).not.toContain('notes'); // read before the attach

    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(counters.opens).toBe(2);
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
    expect(logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toMatchObject({
      sessionId: 's-1',
    });
  });

  it('a cold-spawning turn that ends while the grant is still reading the row restarts at the next turn too', async () => {
    let releaseOpen!: () => void;
    const holdFirstOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let releaseLookup!: () => void;
    const holdGrantLookup = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const x = await makeHarness({ holdFirstOpen, holdGrantLookup });
    const { counters } = x;

    const t1 = x.invoke('s-1', 'req-1');
    await x.entered.open; // skills read, sandbox opening
    const g = x.grant('notes');
    await x.entered.grantLookup; // the grant read the row: no session yet
    releaseOpen();
    await x.queued('req-1');
    await x.endTurn('s-1', 'req-1');
    expect(await t1).toEqual({ kind: 'complete', messages: [] }); // over before the grant looks
    releaseLookup();
    expect(await g).toEqual({ attached: true });
    expect(counters.terminates).toEqual([]);

    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(counters.opens).toBe(2);
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  });

  it('the authored grant during a cold spawn reports that the session will restart, and the next turn has the draft', async () => {
    let releaseOpen!: () => void;
    const holdFirstOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const x = await makeHarness({ holdFirstOpen });
    const { counters } = x;

    const t1 = x.invoke('s-1', 'req-1');
    await x.entered.open; // skills read, sandbox opening, the row names no session
    expect(await x.grantAuthored('my-draft')).toEqual({ applied: true, respawned: true });
    expect(counters.terminates).toEqual([]);
    releaseOpen();
    await x.queued('req-1');
    await x.endTurn('s-1', 'req-1');
    expect(await t1).toEqual({ kind: 'complete', messages: [] });

    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(counters.opens).toBe(2);
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[0]!)).not.toContain('my-draft');
    expect(installedIds(counters.openInputs[1]!)).toContain('my-draft');
  });

  it("a grant flags only its own conversation's turns: a cold spawn in another one is left alone", async () => {
    let releaseOpen!: () => void;
    const holdFirstOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const x = await makeHarness({ holdFirstOpen });
    const { counters } = x;

    const t1 = x.invoke('s-1', 'req-1'); // in conv-1
    await x.entered.open; // skills read, sandbox opening
    expect(await x.grant('notes', 'conv-2')).toEqual({ attached: true });
    releaseOpen();
    await x.queued('req-1');
    await x.endTurn('s-1', 'req-1');
    expect(await t1).toEqual({ kind: 'complete', messages: [] });

    x.endTurnSoon('s-1', 'req-2');
    await x.invoke('s-2', 'req-2'); // conv-1's next turn: routed into s-1
    expect(counters.opens).toBe(1);
    expect(counters.terminates).toEqual([]);
  });

  it("a grant during a cold spawn, then the web's re-POST routed in as soon as the sandbox is up: it restarts the session with the skill", async () => {
    let releaseOpen!: () => void;
    const holdFirstOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let releaseBind!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    const x = await makeHarness({ holdFirstOpen, holdBind: { reqId: 'req-1', release } });
    const { counters, logs, turnErrors } = x;

    // channel-web binds the row at POST, to the session the turn will open.
    x.conv.activeSessionId = 's-1';
    x.conv.activeReqId = 'req-1';
    const t1 = x.invoke('s-1', 'req-1');
    await x.entered.open; // skills read, sandbox opening
    expect(await x.grant('notes')).toEqual({ attached: true });
    expect(counters.terminates).toEqual([]);
    releaseOpen();
    await x.entered.bind; // s-1 is up; the turn's own bind hasn't landed

    // Connect's re-POST, routed while s-1 still runs the first turn.
    x.endTurnSoon('s-2', 'req-2');
    expect(await x.invoke('s-2', 'req-2')).toEqual({ kind: 'complete', messages: [] });
    expect(counters.opens).toBe(2);
    expect(installedIds(counters.openInputs[0]!)).not.toContain('notes');
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
    expect(counters.terminates).toEqual(['s-1']);
    expect(logs.find((l) => l.msg === 'stale_session_respawn')).toMatchObject({
      sessionId: 's-1',
      reason: 'skills-changed',
    });
    // Superseded, as a busy routed session is.
    expect(turnErrors).toEqual([{ reqId: 'req-1', reason: 'sandbox-terminated' }]);

    // s-1's runner exits once its session is ended, and the first turn with it.
    releaseBind();
    await x.queued('req-1');
    x.exitRunner('s-1');
    expect(await t1).toMatchObject({ kind: 'terminated' });
  });

  it("a grant that can't read the conversation while a routed turn runs: that turn marks its session as it ends", async () => {
    const x = await makeHarness({ failGrantLookup: true });
    const { counters, logs } = x;
    await prelude(x);

    const t2 = x.invoke('s-2', 'req-2'); // routed into s-1
    await x.queued('req-2'); // running
    expect(await x.grantAuthored('my-draft')).toEqual({ applied: true, respawned: true });
    expect(logs.find((l) => l.msg === 'active_session_lookup_failed')).toBeDefined();
    expect(counters.terminates).toEqual([]);
    await x.endTurn('s-1', 'req-2');
    expect(await t2).toEqual({ kind: 'complete', messages: [] });

    x.endTurnSoon('s-3', 'req-3');
    await x.invoke('s-3', 'req-3');
    expect(counters.opens).toBe(2);
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[1]!)).toContain('my-draft');
  });

  it("a grant that can't read the conversation while a cold-spawned turn runs: that turn marks its session as it ends", async () => {
    const x = await makeHarness({ failGrantLookup: true });
    const { counters } = x;

    const t1 = x.invoke('s-1', 'req-1'); // opens s-1
    await x.queued('req-1'); // s-1 up and bound: running
    expect(await x.grant('notes')).toEqual({ attached: true });
    expect(counters.terminates).toEqual([]);
    await x.endTurn('s-1', 'req-1');
    expect(await t1).toEqual({ kind: 'complete', messages: [] });

    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(counters.opens).toBe(2);
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  });

  it("a session's restart mark goes with the session, even when no turn is waiting on it", async () => {
    const x = await makeHarness();
    const { counters, logs } = x;
    await prelude(x);

    const t2 = x.invoke('s-2', 'req-2'); // routed into s-1
    await x.queued('req-2'); // running: the grant marks s-1
    await x.grant('notes');
    expect(logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toMatchObject({
      sessionId: 's-1',
    });
    await x.endTurn('s-1', 'req-2');
    expect(await t2).toEqual({ kind: 'complete', messages: [] });

    // Idle now, s-1 goes before another turn arrives, as when the idle reaper
    // ends it: its sandbox terminates the session and the store broadcasts
    // it. No waiter is registered on s-1 any more. Only the broadcast is fired
    // here, so the harness still reports s-1 alive and the next turn's
    // routing reads its mark: a mark that outlived the broadcast retires s-1
    // as `skills-changed`.
    await x.h.bus.fire('session:terminate', x.h.ctx({ sessionId: 's-1' }), { sessionId: 's-1' });

    x.endTurnSoon('s-1', 'req-3');
    await x.invoke('s-3', 'req-3');
    expect(logs.find((l) => l.msg === 'stale_session_respawn')).toBeUndefined();
    expect(counters.opens).toBe(1);
  });

  // TASK-1150 — the grant's row read is the one that tells an idle session
  // from a busy one. When it fails, the grant marks the warm sessions this
  // host opened for that conversation and that person: a mark never cuts a
  // turn, and the next turn restarts the session with the skill. Before, with
  // no turn in flight, it did nothing, and the next turn ran without the skill.
  it.each([
    ['catalog', 'notes', { attached: true }],
    ['authored', 'my-draft', { applied: true, respawned: true }],
  ] as const)(
    "G1: the %s grant can't read the conversation while its session is idle: it marks it, and the next turn restarts with the skill",
    async (kind, skillId, expected) => {
      const x = await makeHarness({ failGrantLookup: true });
      const { counters, logs } = x;
      await prelude(x);

      expect(await (kind === 'catalog' ? x.grant(skillId) : x.grantAuthored(skillId))).toEqual(
        expected,
      );
      expect(logs.find((l) => l.msg === 'active_session_lookup_failed')).toBeDefined();
      expect(counters.terminates).toEqual([]);
      expect(logs.filter((l) => l.msg === 'skill_grant_restart_deferred')).toEqual([
        expect.objectContaining({ sessionId: 's-1' }),
      ]);

      x.endTurnSoon('s-2', 'req-2');
      await x.invoke('s-2', 'req-2');
      expect(counters.terminates).toEqual(['s-1']);
      expect(counters.opens).toBe(2);
      expect(installedIds(counters.openInputs[1]!)).toContain(skillId);
      expect(logs.find((l) => l.msg === 'stale_session_respawn')).toMatchObject({
        sessionId: 's-1',
        reason: 'skills-changed',
      });
    },
  );

  it.each([
    ['another conversation', 'conv-2', 'test-user'],
    ['another person', 'conv-1', 'someone-else'],
  ] as const)(
    "G2: a grant that can't read the row marks only its own person's sessions of its own conversation: %s",
    async (_name, conversationId, userId) => {
      const x = await makeHarness({ failGrantLookup: true });
      const { counters, logs } = x;
      await prelude(x);

      expect(await x.grant('notes', conversationId, userId)).toEqual({ attached: true });
      expect(logs.find((l) => l.msg === 'active_session_lookup_failed')).toBeDefined();
      expect(logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toBeUndefined();

      x.endTurnSoon('s-1', 'req-2');
      await x.invoke('s-2', 'req-2'); // conv-1's next turn: routed into s-1
      expect(counters.opens).toBe(1);
      expect(counters.terminates).toEqual([]);
    },
  );

  it('G3: a grant while a cold-spawned session is up but its turn is not bound yet (a Slack turn): the turn marks it as it ends', async () => {
    let releaseBind!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    const x = await makeHarness({ holdBind: { reqId: 'req-1', release } });
    const { counters, logs, turnErrors } = x;

    // Slack binds nothing at POST: the row starts empty.
    const t1 = x.invoke('s-1', 'req-1');
    await x.entered.bind; // s-1 is up (warm); the row doesn't name it yet
    expect(x.conv).toEqual({ activeSessionId: null, activeReqId: null });
    expect(await x.grant('notes')).toEqual({ attached: true });
    expect(counters.terminates).toEqual([]);
    expect(logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toBeUndefined();
    releaseBind();
    await x.queued('req-1');
    await x.endTurn('s-1', 'req-1');
    expect(await t1).toEqual({ kind: 'complete', messages: [] });
    expect(turnErrors).toEqual([]);

    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(counters.terminates).toEqual(['s-1']);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  });

  it("G4: a grant that can't read the row, on a session already marked: it still reports the restart, and marks it only once", async () => {
    const x = await makeHarness({ failGrantLookup: true });
    const { counters, logs } = x;
    await prelude(x);

    expect(await x.grant('notes')).toEqual({ attached: true }); // marks s-1
    expect(await x.grantAuthored('my-draft')).toEqual({ applied: true, respawned: true });
    expect(logs.filter((l) => l.msg === 'skill_grant_restart_deferred')).toEqual([
      expect.objectContaining({ sessionId: 's-1' }),
    ]);

    x.endTurnSoon('s-2', 'req-2');
    await x.invoke('s-2', 'req-2');
    expect(counters.terminates).toEqual(['s-1']);
    expect(counters.opens).toBe(2);
    expect(installedIds(counters.openInputs[1]!)).toEqual(
      expect.arrayContaining(['notes', 'my-draft']),
    );
  });

  it("G5: a grant that can't read the row while a turn is still on its way in: that turn finds the session marked and restarts it with the skill", async () => {
    const x = await makeHarness({ failGrantLookup: true });
    const { counters, logs } = x;
    await prelude(x);

    // Turn 2 is held at chat:start: in flight for the conversation (so the
    // grant flags it), not routed yet.
    let releaseStart!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let enteredStart!: () => void;
    const atStart = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    x.h.bus.subscribe('chat:start', 'test-hold', async (ctx: AgentContext) => {
      if (ctx.reqId === 'req-2') {
        enteredStart();
        await held;
      }
      return undefined;
    });

    const t2 = x.invoke('s-2', 'req-2');
    await atStart;
    expect(await x.grant('notes')).toEqual({ attached: true });
    expect(logs.filter((l) => l.msg === 'skill_grant_restart_deferred')).toEqual([
      expect.objectContaining({ sessionId: 's-1' }),
    ]);
    releaseStart();
    await x.queued('req-2');
    await x.endTurn('s-2', 'req-2');
    expect(await t2).toEqual({ kind: 'complete', messages: [] });
    expect(counters.terminates).toEqual(['s-1']);
    expect(counters.opens).toBe(2);
    expect(installedIds(counters.openInputs[1]!)).toContain('notes');
  });
});
