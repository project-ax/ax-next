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
//     the row names the ended session (its `clearBySessionId`);
//   - user skill attachments a grant writes and the next spawn reads, and one
//     authored draft that starts `pending`;
//   - an optional hold on one reqId's bind, so a turn can be parked between
//     its routing decision and its bind.
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
  opts: { holdBind?: { reqId: string; release: Promise<void> } } = {},
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
  const entered = {
    bind: new Promise<void>((resolve) => {
      resolveEnteredBind = resolve;
    }),
  };

  // reqIds whose user message reached `session:queue-work`, and who waits on one.
  const queuedReqIds = new Set<string>();
  const queuedWaiters = new Map<string, Array<() => void>>();

  // Every ctx this harness makes logs into the one shared `logs`.
  function ctxFor(sessionId: string, reqId: string): AgentContext {
    return makeAgentContext({
      sessionId,
      agentId: 'test-agent',
      userId: 'test-user',
      conversationId: 'conv-1',
      reqId,
      logger: createLogger({
        reqId,
        writer: (line) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      }),
    });
  }

  // Each spawn gets its own trivial handle (kill resolves exited).
  function makeHandle() {
    let resolveExit!: () => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
      resolveExit = () => res({ code: 0, signal: null });
    });
    return { kill: async () => { resolveExit(); }, exited };
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
    'session:terminate': async (_c, input: unknown) => {
      const sid = (input as { sessionId: string }).sessionId;
      counters.terminates.push(sid);
      live.delete(sid);
      // @ax/conversations' clearBySessionId: a row bound to the ended session
      // loses both its session and its request.
      if (conv.activeSessionId === sid) {
        conv.activeSessionId = null;
        conv.activeReqId = null;
      }
      return {};
    },
    'session:is-alive': async (_c, input: unknown) => ({
      alive: live.has((input as { sessionId: string }).sessionId),
    }),
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      return {
        conversation: {
          conversationId: i.conversationId,
          userId: i.userId,
          agentId: 'test-agent',
          activeSessionId: conv.activeSessionId,
          activeReqId: conv.activeReqId,
        },
      };
    },
    'conversations:bind-session': async (_c, input: unknown) => {
      const i = input as { sessionId: string; reqId: string };
      if (opts.holdBind !== undefined && opts.holdBind.reqId === i.reqId) {
        resolveEnteredBind();
        await opts.holdBind.release;
      }
      conv.activeSessionId = i.sessionId; // the row write
      conv.activeReqId = i.reqId;
      live.add(i.sessionId); // and the session is alive
      return undefined;
    },
    'sandbox:open-session': async (_c, input: unknown) => {
      counters.opens += 1;
      counters.openInputs.push(input as OpenInput);
      return { runnerEndpoint: 'unix:///tmp/m.sock', handle: makeHandle() };
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
  // mints a fresh sessionId and reqId for it).
  let grants = 0;
  const grantInput = (skillId: string) => ({
    conversationId: 'conv-1',
    userId: 'test-user',
    agentId: 'test-agent',
    skillId,
  });
  function grant(skillId: string): Promise<unknown> {
    grants += 1;
    return h.bus.call(
      'agent:apply-capability-grant',
      ctxFor(`grant-route-${grants}`, `grant-${grants}`),
      grantInput(skillId),
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
    expect(logs.find((l) => l.msg === 'skill_grant_restart_deferred')).toMatchObject({
      sessionId: 's-1',
    });
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
});
