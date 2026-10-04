import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  createLogger,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// TASK-688 — `agent:interrupt`: Stop cancels the in-flight turn.
//
// The hook queues `{ type: 'interrupt' }` (NOT `cancel`) into the conversation's
// live session inbox. The interesting case is a Stop clicked during a COLD
// SPAWN: `active_req_id` is bound at POST time, so the row names a reqId whose
// user message is not queued yet. The hook must defer the interrupt so it lands
// BEHIND the message (an interrupt ahead of it would be dropped by an idle
// runner, and the turn would then run to completion).

const USER = 'test-user';
const CONV = 'cnv-1';

const TEST_AGENT = {
  id: 'test-agent', ownerId: USER, ownerType: 'user' as const,
  visibility: 'personal' as const, displayName: 'Test',
  allowedTools: ['file.read'], mcpConfigIds: [], model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk', workspaceRef: null,
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}
function newDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface World {
  /** The conversation row the fake `conversations:get` serves. */
  conv: { activeSessionId: string | null; activeReqId: string | null };
  live: Set<string>;
  /** Entries in the order they were APPENDED to an inbox (after any hold). */
  queued: Array<{ sessionId: string; type: string }>;
  /** Count of session:queue-work calls that have STARTED (held or not). */
  attempts: number;
  /** While set, a `user-message` queue-work blocks on it before appending. */
  holdUserMessage: Deferred | null;
  /** Throw this from a queue-work of the given entry type. */
  queueWorkThrows: Partial<Record<string, unknown>>;
  agentResolveThrows: unknown;
}

function makeWorld(): World {
  return {
    conv: { activeSessionId: null, activeReqId: null },
    live: new Set(),
    queued: [],
    attempts: 0,
    holdUserMessage: null,
    queueWorkThrows: {},
    agentResolveThrows: undefined,
  };
}

function makeHandle() {
  let resolveExit!: () => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveExit = () => res({ code: 0, signal: null });
  });
  return {
    kill: async () => { resolveExit(); },
    exited,
  };
}

function servicesFor(world: World, opts: { withConversations?: boolean } = {}): Record<string, ServiceHandler> {
  const withConversations = opts.withConversations ?? true;
  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => {
      if (world.agentResolveThrows !== undefined) throw world.agentResolveThrows;
      return { agent: { ...TEST_AGENT } };
    },
    'session:queue-work': async (_c, input: unknown) => {
      const i = input as { sessionId: string; entry: { type: string } };
      world.attempts += 1;
      if (i.entry.type === 'user-message' && world.holdUserMessage !== null) {
        await world.holdUserMessage.promise;
      }
      const boom = world.queueWorkThrows[i.entry.type];
      if (boom !== undefined) throw boom;
      world.queued.push({ sessionId: i.sessionId, type: i.entry.type });
      return { cursor: world.queued.length };
    },
    'session:terminate': async () => ({}),
    'session:is-alive': async (_c, input: unknown) => ({
      alive: world.live.has((input as { sessionId: string }).sessionId),
    }),
    'sandbox:open-session': async () => ({
      runnerEndpoint: 'unix:///tmp/m.sock',
      handle: makeHandle(),
    }),
    'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
    'proxy:close-session': async () => ({}),
  };
  if (withConversations) {
    // The real store filters by userId then agents:resolve — a foreign or
    // unknown conversation is a PluginError, never a row.
    services['conversations:get'] = async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      if (i.conversationId !== CONV) {
        throw new PluginError({ code: 'not-found', plugin: 'mock', message: 'no such conversation' });
      }
      if (i.userId !== USER) {
        throw new PluginError({ code: 'forbidden', plugin: 'mock', message: 'not your conversation' });
      }
      return {
        conversation: {
          conversationId: i.conversationId,
          userId: i.userId,
          agentId: 'test-agent',
          activeSessionId: world.conv.activeSessionId,
          activeReqId: world.conv.activeReqId,
        },
      };
    };
    services['conversations:bind-session'] = async (_c, input: unknown) => {
      const i = input as { sessionId: string };
      world.conv.activeSessionId = i.sessionId; // the orchestrator's own bind
      world.live.add(i.sessionId);
      return undefined;
    };
  }
  return services;
}

async function harnessFor(world: World, opts: { withConversations?: boolean } = {}) {
  return createTestHarness({
    services: servicesFor(world, opts),
    plugins: [createChatOrchestratorPlugin({
      runnerBinaries: { 'claude-sdk': '/irrelevant' },
      chatTimeoutMs: 5_000,
      keepAlive: true,
      idleWindowMs: 60_000,
      idleGraceMs: 1_000,
    })],
  });
}

function invokeCtx(reqId: string, sessionId = 's-1') {
  return makeAgentContext({
    sessionId, agentId: 'test-agent', userId: USER, conversationId: CONV, reqId,
    logger: createLogger({ reqId, writer: () => undefined }),
  });
}

function interruptCtx() {
  return makeAgentContext({
    sessionId: 'route-ctx', agentId: 'test-agent', userId: USER, conversationId: CONV,
    logger: createLogger({ reqId: 'interrupt-test', writer: () => undefined }),
  });
}

function interrupt(h: { bus: HookBus }, userId = USER, conversationId = CONV) {
  return h.bus.call<{ conversationId: string; userId: string }, { interrupted: boolean }>(
    'agent:interrupt', interruptCtx(), { conversationId, userId },
  );
}

// The runner stamps the originating reqId on chat:turn-end; the IPC server
// restamps ctx.reqId per request, hence the fresh ctx here.
function fireTurnEnd(bus: HookBus, sessionId: string, reqId: string) {
  setImmediate(() => {
    void bus.fire('chat:turn-end',
      makeAgentContext({ sessionId, agentId: 'a', userId: 'u', reqId: 'ipc-fresh',
        logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }) }),
      { reason: 'user-message-wait', reqId });
  });
}

async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function startInvoke(h: { bus: HookBus }, reqId: string) {
  return h.bus.call<unknown, AgentOutcome>(
    'agent:invoke', invokeCtx(reqId), { message: { role: 'user', content: 'hi' } },
  );
}

describe('agent:interrupt — manifest', () => {
  it('is registered by @ax/chat-orchestrator', () => {
    const plugin = createChatOrchestratorPlugin({ runnerBinaries: { 'claude-sdk': '/x' } });
    expect(plugin.manifest.registers).toContain('agent:interrupt');
  });
});

describe('agent:interrupt — plain path (a session is running the turn)', () => {
  it('queues exactly one `interrupt` (never `cancel`) into the ACTIVE session', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-warm', activeReqId: 'req-9' };
    world.live.add('sess-warm');
    world.live.add('sess-other'); // a different live session must not be touched
    const h = await harnessFor(world);

    expect(await interrupt(h)).toEqual({ interrupted: true });
    expect(world.queued).toEqual([{ sessionId: 'sess-warm', type: 'interrupt' }]);
  });

  it('a foreign user gets the PluginError back and NOTHING is queued', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-warm', activeReqId: 'req-9' };
    world.live.add('sess-warm');
    const h = await harnessFor(world);

    await expect(interrupt(h, 'user-2')).rejects.toMatchObject({ code: 'forbidden' });
    expect(world.queued).toEqual([]);
    expect(world.attempts).toBe(0);
  });

  it('an unknown conversation propagates not-found and NOTHING is queued', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-warm', activeReqId: 'req-9' };
    world.live.add('sess-warm');
    const h = await harnessFor(world);

    await expect(interrupt(h, USER, 'cnv-nope')).rejects.toMatchObject({ code: 'not-found' });
    expect(world.queued).toEqual([]);
    expect(world.attempts).toBe(0);
  });

  it('no active req id (nothing in flight) -> false, nothing queued', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-warm', activeReqId: null };
    world.live.add('sess-warm');
    const h = await harnessFor(world);

    expect(await interrupt(h)).toEqual({ interrupted: false });
    expect(world.queued).toEqual([]);
  });

  it('an empty-string active req id is treated as nothing in flight', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-warm', activeReqId: '' };
    world.live.add('sess-warm');
    const h = await harnessFor(world);

    expect(await interrupt(h)).toEqual({ interrupted: false });
    expect(world.queued).toEqual([]);
  });

  it('a dead session -> false, nothing queued', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-stale', activeReqId: 'req-9' };
    // sess-stale is on the row but NOT alive
    const h = await harnessFor(world);

    expect(await interrupt(h)).toEqual({ interrupted: false });
    expect(world.queued).toEqual([]);
  });

  it('no active session on the row -> false', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: null, activeReqId: 'req-9' };
    const h = await harnessFor(world);

    expect(await interrupt(h)).toEqual({ interrupted: false });
    expect(world.queued).toEqual([]);
  });

  it('queue-work losing a race with teardown (unknown-session) -> false, not a throw', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-warm', activeReqId: 'req-9' };
    world.live.add('sess-warm');
    world.queueWorkThrows['interrupt'] = new PluginError({
      code: 'unknown-session', plugin: 'mock', message: 'gone',
    });
    const h = await harnessFor(world);

    expect(await interrupt(h)).toEqual({ interrupted: false });
  });

  it('any other queue-work failure propagates (it must not read as "stopped")', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-warm', activeReqId: 'req-9' };
    world.live.add('sess-warm');
    world.queueWorkThrows['interrupt'] = new PluginError({
      code: 'storage-down', plugin: 'mock', message: 'boom',
    });
    const h = await harnessFor(world);

    await expect(interrupt(h)).rejects.toMatchObject({ code: 'storage-down' });
  });

  it('conversation peers absent -> false (nothing to interrupt without a conversation store)', async () => {
    const world = makeWorld();
    const h = await harnessFor(world, { withConversations: false });

    expect(await interrupt(h)).toEqual({ interrupted: false });
    expect(world.queued).toEqual([]);
  });
});

describe('agent:interrupt — deferred behind the user message (cold spawn / slow queue)', () => {
  it('fresh spawn: a Stop while the user message is still being queued lands AFTER it', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: null, activeReqId: 'req-1' }; // the POST-time bind
    world.holdUserMessage = newDeferred();
    const h = await harnessFor(world);

    const invoke = startInvoke(h, 'req-1');
    await until(() => world.attempts === 1, 'user-message queue-work to start');

    // Stop clicked before the message is in any inbox.
    expect(await interrupt(h)).toEqual({ interrupted: true });
    expect(world.queued).toEqual([]); // nothing may be ahead of the message

    // A second click while still pending is idempotent.
    expect(await interrupt(h)).toEqual({ interrupted: true });
    expect(world.queued).toEqual([]);

    world.holdUserMessage.resolve();
    await until(() => world.queued.length === 2, 'the deferred interrupt to be queued');
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await invoke;

    expect(world.queued.map((q) => q.type)).toEqual(['user-message', 'interrupt']);
    expect(world.queued[1]!.sessionId).toBe(world.queued[0]!.sessionId);
  });

  it('routed into a warm session: same deferral, same ordering', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: null, activeReqId: 'warm-first' };
    const h = await harnessFor(world);
    fireTurnEnd(h.bus, 'sess-warm', 'warm-first');
    await h.bus.call('agent:invoke', invokeCtx('warm-first', 'sess-warm'), { message: { role: 'user', content: 'warm up' } });
    world.conv.activeReqId = 'req-2';
    world.queued.length = 0;
    world.attempts = 0;
    world.holdUserMessage = newDeferred();

    const invoke = startInvoke(h, 'req-2');
    await until(() => world.attempts === 1, 'user-message queue-work to start');

    expect(await interrupt(h)).toEqual({ interrupted: true });
    expect(world.queued).toEqual([]);

    world.holdUserMessage.resolve();
    await until(() => world.queued.length === 2, 'the deferred interrupt to be queued');
    fireTurnEnd(h.bus, 'sess-warm', 'req-2');
    await invoke;

    expect(world.queued).toEqual([
      { sessionId: 'sess-warm', type: 'user-message' },
      { sessionId: 'sess-warm', type: 'interrupt' },
    ]);
  });

  it('a Stop AFTER the message is queued queues exactly one interrupt (not two)', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: null, activeReqId: 'req-1' };
    const h = await harnessFor(world);

    const invoke = startInvoke(h, 'req-1');
    await until(() => world.queued.length === 1, 'the user message to be queued');
    await new Promise<void>((r) => setTimeout(r, 0)); // let the invoke leave its pending window

    expect(await interrupt(h)).toEqual({ interrupted: true });
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await invoke;

    expect(world.queued.map((q) => q.type)).toEqual(['user-message', 'interrupt']);
  });

  it('no Stop -> no interrupt is ever queued', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: null, activeReqId: 'req-1' };
    const h = await harnessFor(world);

    const invoke = startInvoke(h, 'req-1');
    await until(() => world.queued.length === 1, 'the user message to be queued');
    fireTurnEnd(h.bus, 's-1', 'req-1');
    await invoke;

    expect(world.queued.map((q) => q.type)).toEqual(['user-message']);
  });

  it('a deferred Stop whose message never queues is dropped, and does not leak into a reused reqId', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: null, activeReqId: 'req-1' };
    world.holdUserMessage = newDeferred();
    const h = await harnessFor(world);

    const failed = startInvoke(h, 'req-1');
    await until(() => world.attempts === 1, 'user-message queue-work to start');
    expect(await interrupt(h)).toEqual({ interrupted: true });

    // The message fails to queue: the turn is terminated, no interrupt follows.
    world.queueWorkThrows['user-message'] = new Error('inbox unavailable');
    world.holdUserMessage.resolve();
    const outcome = await failed;
    expect(outcome.kind).toBe('terminated');
    expect(world.queued).toEqual([]);

    // Reuse the SAME reqId for a clean invoke: had the stop request leaked in
    // process memory, an interrupt would follow this message.
    world.queueWorkThrows = {};
    world.holdUserMessage = null;
    const second = startInvoke(h, 'req-1');
    await until(() => world.queued.length >= 1, 'the second user message to be queued');
    fireTurnEnd(h.bus, world.queued[0]!.sessionId, 'req-1');
    await second;
    expect(world.queued.map((q) => q.type)).toEqual(['user-message']);
  });

  it('a turn that ends before its message is queued leaves no pending state behind', async () => {
    const world = makeWorld();
    world.conv = { activeSessionId: 'sess-stale', activeReqId: 'req-1' }; // not alive
    world.agentResolveThrows = new PluginError({
      code: 'forbidden', plugin: 'mock', message: 'no access to the agent',
    });
    const h = await harnessFor(world);

    const outcome = await startInvoke(h, 'req-1');
    expect(outcome.kind).toBe('terminated');

    // If the invoke leaked `req-1` as "message still pending" this would be a
    // deferred `true`; it is a plain-path `false` (the session is dead).
    expect(await interrupt(h)).toEqual({ interrupted: false });
    expect(world.queued).toEqual([]);
  });
});
