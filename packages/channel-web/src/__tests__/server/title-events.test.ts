// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createTitleEventsHandler } from '../../server/title-events.js';
import type { RouteRequest, RouteResponse, RouteStream } from '../../server/sse.js';

// ---------------------------------------------------------------------------
// fakeRes / CapturedResponse — copied verbatim from sse.test.ts
// ---------------------------------------------------------------------------

interface CapturedResponse {
  statusCode?: number;
  jsonBody?: unknown;
  textBody?: string;
  ended: boolean;
  streamWrites: string[];
  streamClosed: boolean;
  /** Synchronously fire a "client closed" event from outside the handler. */
  fireClientClose(): void;
}

function fakeRes(): { res: RouteResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    ended: false,
    streamWrites: [],
    streamClosed: false,
    fireClientClose: () => {},
  };
  let stream: RouteStream | null = null;
  const onCloseHandlers: Array<() => void> = [];
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    header(_n, _v) {
      return res;
    },
    json(v) {
      captured.jsonBody = v;
      captured.ended = true;
    },
    text(s) {
      captured.textBody = s;
      captured.ended = true;
    },
    end() {
      captured.ended = true;
    },
    stream() {
      stream = {
        write(chunk) {
          if (captured.streamClosed) return;
          captured.streamWrites.push(
            typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
          );
        },
        close() {
          captured.streamClosed = true;
          for (const h of onCloseHandlers.splice(0)) h();
        },
        onClose(handler) {
          if (captured.streamClosed) {
            queueMicrotask(handler);
            return;
          }
          onCloseHandlers.push(handler);
        },
      };
      captured.ended = true;
      return stream;
    },
  };
  captured.fireClientClose = () => {
    if (captured.streamClosed) return;
    captured.streamClosed = true;
    for (const h of onCloseHandlers.splice(0)) h();
  };
  return { res, captured };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boot(opts: { authUser?: { id: string; isAdmin: boolean } | null } = {}) {
  const bus = new HookBus();
  const initCtx = makeAgentContext({
    sessionId: 'init', agentId: '@ax/channel-web', userId: 'system',
  });
  const authUser = opts.authUser === undefined ? { id: 'userA', isAdmin: false } : opts.authUser;
  bus.registerService('auth:require-user', 'mock', async () => {
    if (authUser === null) {
      throw new PluginError({
        code: 'unauthenticated', plugin: 'mock',
        hookName: 'auth:require-user', message: 'no auth',
      });
    }
    return { user: authUser };
  });
  const handler = createTitleEventsHandler({ bus, initCtx });
  return { bus, initCtx, handler };
}

const fire = (bus: HookBus, payload: { conversationId: string; userId: string; title: string }) =>
  bus.fire('conversations:title-updated', makeAgentContext({
    sessionId: 's', agentId: 'a', userId: payload.userId,
  }), payload);

const fakeReq = (): RouteRequest => ({
  headers: {},
  body: Buffer.alloc(0),
  cookies: {},
  query: {},
  params: {},
  signedCookie: () => null,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/chat/title-events', () => {
  it('401s when unauthenticated', async () => {
    const { handler } = boot({ authUser: null });
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(captured.statusCode).toBe(401);
    expect(captured.jsonBody).toEqual({ error: 'unauthenticated' });
  });

  it("streams a frame for the caller's own title-updated event", async () => {
    const { bus, handler } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    await fire(bus, { conversationId: 'cnv_1', userId: 'userA', title: 'Hello' });
    expect(captured.streamWrites.join('')).toContain('data: {"conversationId":"cnv_1","title":"Hello"}\n\n');
  });

  it("does NOT stream another user's title event (isolation)", async () => {
    const { bus, handler } = boot(); // authUser userA
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    await fire(bus, { conversationId: 'cnv_2', userId: 'userB', title: 'Secret' });
    expect(captured.streamWrites.join('')).not.toContain('cnv_2');
    expect(captured.streamWrites.join('')).not.toContain('Secret');
  });

  it('unsubscribes on client disconnect', async () => {
    const { bus, handler } = boot();
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    captured.fireClientClose();
    await fire(bus, { conversationId: 'cnv_3', userId: 'userA', title: 'After close' });
    expect(captured.streamWrites.join('')).not.toContain('cnv_3');
  });
});
