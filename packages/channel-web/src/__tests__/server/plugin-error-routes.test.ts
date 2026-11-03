// @vitest-environment node
/**
 * TASK-1028 — how the channel-web routes answer a failed ACL / ownership
 * lookup (`conversations:get`, `conversations:get-by-req-id`, `agents:resolve`).
 *
 * `HookBus.call` wraps whatever a service throws that is not a PluginError as
 * `PluginError{code:'unknown', cause}` (the message carries the original text,
 * e.g. a DB error). These catches used to map EVERY PluginError to 404 / 403,
 * so a store crash read as "not found" and left no log line. Now only the
 * caller codes (`not-found` / `forbidden`) map to 4xx; everything else is a
 * logged 500 with a generic body that never echoes the error text.
 *
 * Docker-free: the hooks are stubbed on a bare HookBus, the handler factories
 * are called with fake req/res objects, and the structured log is read off a
 * `process.stdout.write` spy (the default logger writes JSON lines there).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createChatRouteHandlers, type RouteRequest } from '../../server/routes-chat';
import { createSseHandler, type RouteResponse } from '../../server/sse';
import { createChunkBuffer } from '../../server/chunk-buffer';
import { createMemoryEventsHandler } from '../../server/memory-events';
import { makeConnectionsHandlers } from '../../server/routes-connections';

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET_DETAIL = 'pg: relation x violates constraint at 10.0.0.7:5432';

const initCtx = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

function fakeReq(body: unknown, params: Record<string, string>): RouteRequest {
  return {
    headers: {},
    body: Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8'),
    cookies: {},
    query: {},
    params,
    signedCookie() {
      return null;
    },
  };
}

interface Captured {
  status?: number;
  json?: unknown;
}

/** The SSE RouteResponse is a superset of the chat one, so this serves every site. */
function fakeRes(): { res: RouteResponse; captured: Captured } {
  const captured: Captured = {};
  const res: RouteResponse = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v: unknown) {
      captured.json = v;
    },
    text() {},
    end() {},
    stream() {
      throw new Error('the stream must not open on a refused lookup');
    },
  };
  return { res, captured };
}

function captureStdout(): () => Array<Record<string, unknown>> {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('{"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
}

type Thrower = () => never;

/** A bus where every hook the routes reach succeeds, except those overridden. */
function makeBus(overrides: Record<string, Thrower>): HookBus {
  const bus = new HookBus();
  const ok: Record<string, () => Promise<unknown>> = {
    'auth:require-user': async () => ({ user: { id: 'userA', isAdmin: false } }),
    'conversations:get': async () => ({
      conversation: {
        conversationId: 'cnv1',
        userId: 'userA',
        agentId: 'agt_test',
        title: null,
        activeSessionId: null,
        activeReqId: null,
        createdAt: 't',
        updatedAt: 't',
      },
      turns: [],
    }),
    'conversations:get-by-req-id': async () => ({
      conversationId: 'cnv1',
      agentId: 'agt_test',
      userId: 'userA',
      activeReqId: 'r-test',
    }),
    'agents:resolve': async () => ({ agent: { id: 'agt_test', skillAttachments: [] } }),
  };
  for (const [hook, impl] of Object.entries(ok)) {
    const thrower = overrides[hook];
    bus.registerService(
      hook,
      'mock',
      thrower === undefined
        ? impl
        : async () => {
            thrower();
          },
    );
  }
  return bus;
}

interface Site {
  /** Test label. */
  name: string;
  /** The hook whose failure the site is about. */
  hook: string;
  /** The structured-log event the site writes on a host fault. */
  event: string;
  /** Run the route with `hook` throwing. */
  run: (bus: HookBus) => Promise<Captured>;
  /** What each caller code maps to. */
  codes: Record<'not-found' | 'forbidden', { status: number; body: unknown }>;
}

const NOT_FOUND_CONV = { status: 404, body: { error: 'conversation-not-found' } };

const SITES: Site[] = [
  {
    name: 'postPermissionDecision / conversations:get',
    hook: 'conversations:get',
    event: 'chat_permission_decision_lookup_failed',
    run: async (bus) => {
      const h = createChatRouteHandlers({ bus, initCtx });
      const { res, captured } = fakeRes();
      await h.postPermissionDecision(fakeReq({ conversationId: 'cnv1', skillId: 'gh' }, {}), res);
      return captured;
    },
    codes: { 'not-found': NOT_FOUND_CONV, forbidden: NOT_FOUND_CONV },
  },
  {
    name: 'postPermissionDecision / agents:resolve',
    hook: 'agents:resolve',
    event: 'chat_permission_decision_agent_resolve_failed',
    run: async (bus) => {
      const h = createChatRouteHandlers({ bus, initCtx });
      const { res, captured } = fakeRes();
      await h.postPermissionDecision(fakeReq({ conversationId: 'cnv1', skillId: 'gh' }, {}), res);
      return captured;
    },
    codes: {
      'not-found': { status: 404, body: { error: 'agent-not-found' } },
      forbidden: { status: 403, body: { error: 'forbidden' } },
    },
  },
  {
    name: 'postApproveAuthoredSkill / agents:resolve',
    hook: 'agents:resolve',
    event: 'chat_approve_authored_skill_agent_resolve_failed',
    run: async (bus) => {
      const h = createChatRouteHandlers({ bus, initCtx });
      const { res, captured } = fakeRes();
      await h.postApproveAuthoredSkill(fakeReq({ agentId: 'agt_test', skillId: 'gh' }, {}), res);
      return captured;
    },
    codes: {
      'not-found': { status: 404, body: { error: 'agent-not-found' } },
      forbidden: { status: 403, body: { error: 'forbidden' } },
    },
  },
  {
    name: 'SSE stream / conversations:get-by-req-id',
    hook: 'conversations:get-by-req-id',
    event: 'chat_sse_conversation_lookup_failed',
    run: async (bus) => {
      const handle = createSseHandler({ bus, initCtx, buffer: createChunkBuffer() });
      const { res, captured } = fakeRes();
      await handle(fakeReq(undefined, { reqId: 'r-test' }), res);
      return captured;
    },
    // J9: not-found and forbidden collapse to the same 404.
    codes: {
      'not-found': { status: 404, body: { error: 'not-found' } },
      forbidden: { status: 404, body: { error: 'not-found' } },
    },
  },
  {
    name: 'SSE stream / agents:resolve',
    hook: 'agents:resolve',
    event: 'chat_sse_agent_resolve_failed',
    run: async (bus) => {
      const handle = createSseHandler({ bus, initCtx, buffer: createChunkBuffer() });
      const { res, captured } = fakeRes();
      await handle(fakeReq(undefined, { reqId: 'r-test' }), res);
      return captured;
    },
    codes: {
      'not-found': { status: 404, body: { error: 'not-found' } },
      forbidden: { status: 404, body: { error: 'not-found' } },
    },
  },
  {
    name: 'memory-events / agents:resolve',
    hook: 'agents:resolve',
    event: 'memory_events_agent_resolve_failed',
    run: async (bus) => {
      const handle = createMemoryEventsHandler({ bus, initCtx });
      const { res, captured } = fakeRes();
      await handle(fakeReq(undefined, { id: 'cnv1' }), res);
      return captured;
    },
    codes: { 'not-found': NOT_FOUND_CONV, forbidden: NOT_FOUND_CONV },
  },
  {
    name: 'connections GET / agents:resolve (resolveAgentOr404)',
    hook: 'agents:resolve',
    event: 'connections_agent_resolve_failed',
    run: async (bus) => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = fakeRes();
      await h.get(fakeReq(undefined, { agentId: 'agt_test' }), res);
      return captured;
    },
    codes: {
      'not-found': { status: 404, body: { error: 'agent-not-found' } },
      forbidden: { status: 404, body: { error: 'agent-not-found' } },
    },
  },
];

describe('ACL / ownership lookup failures (TASK-1028)', () => {
  describe.each(SITES)('$name', (site) => {
    // Against the unfixed code every one of these got the caller-code mapping
    // (404 / 403) for the wrapped error, and no log line was written.
    it('a store crash (bus-wrapped as unknown) is a logged 500 that does not echo the text', async () => {
      const logs = captureStdout();
      const bus = makeBus({
        [site.hook]: () => {
          throw new Error(SECRET_DETAIL);
        },
      });
      const out = await site.run(bus);

      expect(out.status).toBe(500);
      expect(out.json).toEqual({ error: 'internal' });
      expect(JSON.stringify(out.json)).not.toContain('10.0.0.7');

      const line = logs().find((e) => e.msg === site.event);
      expect(line).toBeDefined();
      expect(line!.level).toBe('error');
      expect(line!.hook).toBe(site.hook);
      const err = line!.err as { code?: string; cause?: { message?: string } };
      expect(err.code).toBe('unknown');
      expect(err.cause?.message).toContain('10.0.0.7');
    });

    it('a PluginError with a non-caller code (internal) is also a logged 500', async () => {
      const logs = captureStdout();
      const bus = makeBus({
        [site.hook]: () => {
          throw new PluginError({ code: 'internal', plugin: 'mock', message: SECRET_DETAIL });
        },
      });
      const out = await site.run(bus);

      expect(out.status).toBe(500);
      expect(out.json).toEqual({ error: 'internal' });
      expect(JSON.stringify(out.json)).not.toContain('10.0.0.7');
      expect(logs().some((e) => e.msg === site.event)).toBe(true);
    });

    it.each(['not-found', 'forbidden'] as const)(
      'caller code %s keeps its mapping and writes no error log',
      async (code) => {
        const logs = captureStdout();
        const bus = makeBus({
          [site.hook]: () => {
            throw new PluginError({ code, plugin: 'mock', message: SECRET_DETAIL });
          },
        });
        const out = await site.run(bus);

        expect(out.status).toBe(site.codes[code].status);
        expect(out.json).toEqual(site.codes[code].body);
        expect(logs().some((e) => e.msg === site.event)).toBe(false);
      },
    );
  });
});
