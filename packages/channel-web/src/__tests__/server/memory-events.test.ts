// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { createMemoryEventsHandler } from '../../server/memory-events';
import type { RouteRequest, RouteResponse, RouteStream } from '../../server/sse';

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id/memory-events (TASK-626). Same unit
// boundary as sse.test.ts: the handler factory, called with a fake req and a
// fake res that captures status, JSON bodies, and stream writes.
// ---------------------------------------------------------------------------

interface Captured {
  statusCode?: number;
  jsonBody?: unknown;
  streamWrites: string[];
  streamClosed: boolean;
  contentType?: string | undefined;
  fireClientClose(): void;
}

function fakeRes(): { res: RouteResponse; captured: Captured } {
  const captured: Captured = {
    streamWrites: [],
    streamClosed: false,
    fireClientClose: () => {},
  };
  const onClose: Array<() => void> = [];
  const res: RouteResponse = {
    status(n) {
      captured.statusCode = n;
      return res;
    },
    header() {
      return res;
    },
    json(v) {
      captured.jsonBody = v;
    },
    text() {},
    end() {},
    stream(opts) {
      captured.contentType = opts?.contentType;
      const stream: RouteStream = {
        write(chunk) {
          if (captured.streamClosed) return;
          captured.streamWrites.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        },
        close() {
          captured.streamClosed = true;
          for (const h of onClose.splice(0)) h();
        },
        onClose(h) {
          onClose.push(h);
        },
      };
      return stream;
    },
  };
  captured.fireClientClose = () => {
    if (captured.streamClosed) return;
    captured.streamClosed = true;
    for (const h of onClose.splice(0)) h();
  };
  return { res, captured };
}

function fakeReq(conversationId = 'cnv_1'): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params: { id: conversationId },
    signedCookie: () => null,
  };
}

interface BootOpts {
  authUser?: { id: string; isAdmin: boolean } | null;
  /** conversations:get outcome: a conversation, or a PluginError code to throw. */
  conversation?: { conversationId: string; agentId: string; userId: string } | 'not-found' | 'forbidden';
  agentResolveAllow?: boolean;
  /** Register memory:status? Defaults to true. */
  memory?: boolean;
  /** Runs inside memory:status; its result is the reply. */
  status?: (ctx: AgentContext, input: unknown, bus: HookBus) => Promise<unknown>;
}

function boot(opts: BootOpts = {}) {
  const bus = new HookBus();
  const initCtx = makeAgentContext({
    sessionId: 'init',
    agentId: '@ax/channel-web',
    userId: 'system',
  });
  const authUser = opts.authUser === undefined ? { id: 'userA', isAdmin: false } : opts.authUser;
  const conversation =
    opts.conversation ?? { conversationId: 'cnv_1', agentId: 'agt_1', userId: 'userA' };

  bus.registerService('auth:require-user', 'mock-auth', async () => {
    if (authUser === null) {
      throw new PluginError({ code: 'unauthenticated', plugin: 'mock-auth', message: 'no' });
    }
    return { user: authUser };
  });
  const convCalls: unknown[] = [];
  bus.registerService('conversations:get', 'mock-conv', async (_ctx, input) => {
    convCalls.push(input);
    if (typeof conversation === 'string') {
      throw new PluginError({ code: conversation, plugin: 'mock-conv', message: conversation });
    }
    return { conversation, turns: [] };
  });
  const resolveCalls: unknown[] = [];
  bus.registerService('agents:resolve', 'mock-agents', async (_ctx, input) => {
    resolveCalls.push(input);
    if (opts.agentResolveAllow === false) {
      throw new PluginError({ code: 'forbidden', plugin: 'mock-agents', message: 'no' });
    }
    return { agent: { id: 'agt_1', visibility: 'personal' } };
  });
  const statusCalls: Array<{ agentId: string; userId: string | undefined; input: unknown }> = [];
  if (opts.memory !== false) {
    bus.registerService('memory:status', 'mock-memory', async (ctx, input) => {
      statusCalls.push({ agentId: ctx.agentId, userId: ctx.userId, input });
      if (opts.status !== undefined) return opts.status(ctx, input, bus);
      return { extraction: 'ok', conversation: { state: 'idle' } };
    });
  }
  const handler = createMemoryEventsHandler({ bus, initCtx });
  const activity = (payload: unknown) => bus.fire('memory:conversation-activity', initCtx, payload);
  return { bus, handler, convCalls, resolveCalls, statusCalls, activity };
}

function frames(captured: Captured): unknown[] {
  return captured.streamWrites
    .filter((w) => w.startsWith('data: '))
    .map((w) => JSON.parse(w.slice('data: '.length).trim()));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('memory-events handler', () => {
  it('401s an unauthenticated caller', async () => {
    const { handler, convCalls } = boot({ authUser: null });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(captured.statusCode).toBe(401);
    expect(captured.jsonBody).toEqual({ error: 'unauthenticated' });
    expect(convCalls).toEqual([]);
  });

  it.each(['not-found', 'forbidden'] as const)(
    '404s (never 403) a conversation that is %s',
    async (code) => {
      const { handler, statusCalls } = boot({ conversation: code });
      const { res, captured } = fakeRes();
      await handler(fakeReq(), res);
      expect(captured.statusCode).toBe(404);
      expect(captured.jsonBody).toEqual({ error: 'conversation-not-found' });
      expect(captured.streamWrites).toEqual([]);
      expect(statusCalls).toEqual([]);
    },
  );

  it('looks the conversation up for the authenticated user', async () => {
    const { handler, convCalls, resolveCalls } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq('cnv_1'), res);
    expect(convCalls).toEqual([{ conversationId: 'cnv_1', userId: 'userA' }]);
    expect(resolveCalls).toEqual([{ agentId: 'agt_1', userId: 'userA' }]);
    captured.fireClientClose();
  });

  it('404s when the conversation agent no longer resolves for the user', async () => {
    const { handler, statusCalls } = boot({ agentResolveAllow: false });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(captured.statusCode).toBe(404);
    expect(captured.jsonBody).toEqual({ error: 'conversation-not-found' });
    expect(statusCalls).toEqual([]);
  });

  it('503s memory-unavailable when memory:status is not registered', async () => {
    const { handler } = boot({ memory: false });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(captured.statusCode).toBe(503);
    expect(captured.jsonBody).toEqual({ error: 'memory-unavailable' });
    expect(captured.streamWrites).toEqual([]);
  });

  it('opens an event stream and reads memory:status on the agent ctx', async () => {
    const { handler, statusCalls } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.contentType).toBe('text/event-stream; charset=utf-8');
    expect(statusCalls).toEqual([
      { agentId: 'agt_1', userId: 'userA', input: { conversationId: 'cnv_1' } },
    ]);
    captured.fireClientClose();
  });

  it.each([
    [{ extraction: 'ok', conversation: { state: 'idle' } }, { extraction: 'ok', conversation: 'idle' }],
    [
      { extraction: 'ok', conversation: { state: 'extracting' } },
      { extraction: 'ok', conversation: 'extracting' },
    ],
    [
      { extraction: 'paused', reason: 'missing-credential', conversation: { state: 'failed' } },
      { extraction: 'paused', conversation: 'failed' },
    ],
    // Unknown / missing fields read as the quiet default.
    [{ extraction: 'exploded', conversation: { state: 'on-fire' } }, { extraction: 'ok', conversation: 'idle' }],
    [{}, { extraction: 'ok', conversation: 'idle' }],
    [null, { extraction: 'ok', conversation: 'idle' }],
  ])('writes the snapshot frame for %j', async (reply, expected) => {
    const { handler } = boot({ status: async () => reply });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(frames(captured)).toEqual([{ memoryStatus: expected }]);
    captured.fireClientClose();
  });

  it('writes readFailed and keeps the stream open when memory:status throws', async () => {
    const { handler, activity } = boot({
      status: async () => {
        throw new Error('store down');
      },
    });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(frames(captured)).toEqual([{ memoryStatus: { readFailed: true } }]);
    expect(captured.streamClosed).toBe(false);
    await activity({ conversationId: 'cnv_1', userId: 'userA', state: 'extracting' });
    expect(frames(captured)[1]).toEqual({ memoryActivity: { state: 'extracting' } });
    captured.fireClientClose();
  });

  it('delivers activity for this conversation and user', async () => {
    const { handler, activity } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    await activity({ conversationId: 'cnv_1', userId: 'userA', state: 'extracting' });
    await activity({
      conversationId: 'cnv_1',
      userId: 'userA',
      state: 'recorded',
      statementIds: ['s1', 's2'],
    });
    expect(frames(captured).slice(1)).toEqual([
      { memoryActivity: { state: 'extracting' } },
      { memoryActivity: { state: 'recorded', statementIds: ['s1', 's2'] } },
    ]);
    captured.fireClientClose();
  });

  it('never carries kind or seq fields, nor any extra payload field', async () => {
    const { handler, activity } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    await activity({
      conversationId: 'cnv_1',
      userId: 'userA',
      state: 'recorded',
      statementIds: ['s1'],
      kind: 'text',
      seq: 9,
      text: 'the user likes tea',
    });
    const f = frames(captured);
    expect(f[1]).toEqual({ memoryActivity: { state: 'recorded', statementIds: ['s1'] } });
    for (const w of captured.streamWrites) {
      expect(w).not.toMatch(/"kind"|"seq"|tea/);
    }
    captured.fireClientClose();
  });

  it('TASK-645: re-reads memory:status after a live idle ending, so a cleared pause reaches the rail', async () => {
    // Paused at connect; the key is then stored and a pass resolves but
    // records nothing (`idle`). `idle` alone says nothing about the pause —
    // the fresh status frame is what tells the client it is over.
    let paused = true;
    const { handler, activity, statusCalls } = boot({
      status: async () =>
        paused
          ? { extraction: 'paused', reason: 'missing-credential', conversation: { state: 'idle' } }
          : { extraction: 'ok', conversation: { state: 'idle' } },
    });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    paused = false;
    await activity({ conversationId: 'cnv_1', userId: 'userA', state: 'idle' });
    expect(frames(captured)).toEqual([
      { memoryStatus: { extraction: 'paused', conversation: 'idle' } },
      { memoryActivity: { state: 'idle' } },
      { memoryStatus: { extraction: 'ok', conversation: 'idle' } },
    ]);
    // Same ctx shape as the snapshot read: this agent, this caller.
    expect(statusCalls.at(-1)).toMatchObject({
      agentId: 'agt_1',
      userId: 'userA',
      input: { conversationId: 'cnv_1' },
    });
    captured.fireClientClose();
  });

  it('re-reads after failed too, but not after extracting, recorded or paused', async () => {
    const { handler, activity, statusCalls } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(statusCalls).toHaveLength(1);
    for (const state of ['extracting', 'recorded', 'paused']) {
      await activity({ conversationId: 'cnv_1', userId: 'userA', state, statementIds: [] });
    }
    expect(statusCalls).toHaveLength(1);
    await activity({ conversationId: 'cnv_1', userId: 'userA', state: 'failed' });
    expect(statusCalls).toHaveLength(2);
    expect(frames(captured).at(-1)).toEqual({ memoryStatus: { extraction: 'ok', conversation: 'idle' } });
    captured.fireClientClose();
  });

  it('a failed re-read writes nothing and keeps the stream open', async () => {
    let calls = 0;
    const { handler, activity } = boot({
      status: async () => {
        calls += 1;
        if (calls > 1) throw new Error('status down');
        return { extraction: 'paused', conversation: { state: 'idle' } };
      },
    });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    await activity({ conversationId: 'cnv_1', userId: 'userA', state: 'idle' });
    expect(frames(captured)).toEqual([
      { memoryStatus: { extraction: 'paused', conversation: 'idle' } },
      { memoryActivity: { state: 'idle' } },
    ]);
    expect(captured.streamClosed).toBe(false);
    captured.fireClientClose();
  });

  it('does not deliver activity for another conversation or another user', async () => {
    const { handler, activity } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    await activity({ conversationId: 'cnv_2', userId: 'userA', state: 'extracting' });
    await activity({ conversationId: 'cnv_1', userId: 'userB', state: 'extracting' });
    await activity({ conversationId: 'cnv_1', state: 'extracting' });
    expect(frames(captured)).toHaveLength(1);
    captured.fireClientClose();
  });

  it('drops an unknown state', async () => {
    const { handler, activity } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    await activity({ conversationId: 'cnv_1', userId: 'userA', state: 'thinking-hard' });
    await activity({ conversationId: 'cnv_1', userId: 'userA' });
    expect(frames(captured)).toHaveLength(1);
    captured.fireClientClose();
  });

  it.each(['extracting', 'idle', 'failed', 'paused'] as const)(
    'passes %s through without statementIds',
    async (state) => {
      const { handler, activity } = boot();
      const { res, captured } = fakeRes();
      await handler(fakeReq(), res);
      await activity({ conversationId: 'cnv_1', userId: 'userA', state, statementIds: ['s1'] });
      expect(frames(captured)[1]).toEqual({ memoryActivity: { state } });
      captured.fireClientClose();
    },
  );

  it('filters non-string statementIds and caps them at 200', async () => {
    const { handler, activity } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    const ids = Array.from({ length: 250 }, (_, i) => `s${i}`);
    await activity({
      conversationId: 'cnv_1',
      userId: 'userA',
      state: 'recorded',
      statementIds: [1, null, { id: 'x' }, ...ids],
    });
    const f = frames(captured)[1] as { memoryActivity: { statementIds: string[] } };
    expect(f.memoryActivity.statementIds).toHaveLength(200);
    expect(f.memoryActivity.statementIds[0]).toBe('s0');
    expect(f.memoryActivity.statementIds.every((s) => typeof s === 'string')).toBe(true);

    await activity({
      conversationId: 'cnv_1',
      userId: 'userA',
      state: 'recorded',
      statementIds: 'not-an-array',
    });
    expect(frames(captured)[2]).toEqual({ memoryActivity: { state: 'recorded', statementIds: [] } });
    captured.fireClientClose();
  });

  it('unsubscribes on client close — activity after close writes nothing', async () => {
    const { handler, activity, bus } = boot();
    const subSpy = vi.spyOn(bus, 'subscribe');
    const unsubSpy = vi.spyOn(bus, 'unsubscribe');
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    captured.fireClientClose();
    captured.fireClientClose();
    const before = captured.streamWrites.length;
    await activity({ conversationId: 'cnv_1', userId: 'userA', state: 'extracting' });
    expect(captured.streamWrites.length).toBe(before);
    const key = subSpy.mock.calls[0]?.[1];
    expect(subSpy.mock.calls[0]?.[0]).toBe('memory:conversation-activity');
    expect(unsubSpy.mock.calls).toEqual([['memory:conversation-activity', key]]);
  });

  it('gives each connection its own subscription', async () => {
    const { handler, activity } = boot();
    const a = fakeRes();
    const b = fakeRes();
    await handler(fakeReq(), a.res);
    await handler(fakeReq(), b.res);
    a.captured.fireClientClose();
    await activity({ conversationId: 'cnv_1', userId: 'userA', state: 'extracting' });
    expect(frames(b.captured)[1]).toEqual({ memoryActivity: { state: 'extracting' } });
    expect(frames(a.captured)).toHaveLength(1);
    b.captured.fireClientClose();
  });

  it('subscribes BEFORE reading the snapshot — activity fired during the read is delivered AFTER it', async () => {
    // The status read can capture `extracting` just before the pass ends and
    // fires `recorded`. Written in arrival order, the stale snapshot would
    // land last and leave the client showing "extracting" forever; the
    // snapshot goes first and every event the read raced is replayed on top.
    const { handler } = boot({
      status: async (_ctx, _input, bus) => {
        await bus.fire('memory:conversation-activity', makeAgentContext({
          sessionId: 's',
          agentId: 'a',
          userId: 'u',
        }), { conversationId: 'cnv_1', userId: 'userA', state: 'recorded', statementIds: ['f1'] });
        return { extraction: 'ok', conversation: { state: 'extracting' } };
      },
    });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(frames(captured)).toEqual([
      { memoryStatus: { extraction: 'ok', conversation: 'extracting' } },
      { memoryActivity: { state: 'recorded', statementIds: ['f1'] } },
    ]);
    captured.fireClientClose();
  });

  it('replays activity the read raced after a readFailed snapshot too', async () => {
    const { handler } = boot({
      status: async (_ctx, _input, bus) => {
        await bus.fire('memory:conversation-activity', makeAgentContext({
          sessionId: 's',
          agentId: 'a',
          userId: 'u',
        }), { conversationId: 'cnv_1', userId: 'userA', state: 'failed' });
        throw new Error('status down');
      },
    });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(frames(captured)).toEqual([
      { memoryStatus: { readFailed: true } },
      { memoryActivity: { state: 'failed' } },
    ]);
    captured.fireClientClose();
  });

  it('writes no snapshot when the client closed during the status read', async () => {
    let close: () => void = () => {};
    const { handler } = boot({
      status: async () => {
        close();
        return { extraction: 'ok' };
      },
    });
    const { res, captured } = fakeRes();
    close = captured.fireClientClose;
    await handler(fakeReq(), res);
    expect(frames(captured)).toEqual([]);
  });

  it('sends a keepalive comment every 25s and stops after close', async () => {
    vi.useFakeTimers();
    const { handler } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    vi.advanceTimersByTime(25_000);
    expect(captured.streamWrites.filter((w) => w === ':\n\n')).toHaveLength(1);
    captured.fireClientClose();
    vi.advanceTimersByTime(50_000);
    expect(captured.streamWrites.filter((w) => w === ':\n\n')).toHaveLength(1);
  });
});
