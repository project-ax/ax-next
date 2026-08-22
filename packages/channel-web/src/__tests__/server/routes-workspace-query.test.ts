// @vitest-environment node
/**
 * ONE round trip through a genuinely booted @ax/http-server, for the one thing
 * a handler-level test structurally cannot catch.
 *
 * The tier-A tests in `routes-workspace.test.ts` build the `query` object
 * themselves. That means they agree with whatever spelling the handler reads —
 * including the wrong one. `@ax/http-server` projects the real query string
 * through `query[k.toLowerCase()] = v` (plugin.ts), so a handler reading
 * `req.query.agentId` gets `undefined` FOREVER: `?agentId=a2` would silently
 * serve the unfiltered roster-wide feed under a single agent's heading, and
 * every direct-handler test would still pass.
 *
 * So this file sends a real `?agentId=` in camelCase — exactly what the browser
 * puts on the wire — over a real socket, and asserts the answer is actually
 * scoped. No Postgres: every hook the route touches is a mock service on the
 * bus, which is the same shape `plugin.test.ts` boots with.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { registerWorkspaceRoutes } from '../../server/routes-workspace.js';

const COOKIE_KEY = randomBytes(32);

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

interface FireRowLike {
  id: number;
  agentId: string;
  path: string;
  firedAt: Date;
  triggerSource: 'tick' | 'webhook' | 'manual';
  conversationId: string | null;
  status: 'ok' | 'silenced' | 'error';
  error: string | null;
  renderedPrompt: string | null;
}

function fire(id: number, agentId: string, firedAt: string): FireRowLike {
  return {
    id,
    agentId,
    path: `${agentId}.md`,
    firedAt: new Date(firedAt),
    triggerSource: 'tick',
    conversationId: null,
    status: 'ok',
    error: null,
    renderedPrompt: null,
  };
}

const FIRES: FireRowLike[] = [
  fire(1, 'a1', '2026-08-20T09:00:00.000Z'),
  fire(2, 'a2', '2026-08-20T11:00:00.000Z'),
];

interface ActivityBody {
  events: Array<{ agentId: string; text: string }>;
  nextBefore: string | null;
}

async function boot(): Promise<{ harness: TestHarness; port: number }> {
  const http: HttpServerPlugin = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  // Empty allowedOrigins logs a stderr warn unless the escape hatch is set;
  // pin it to keep test output quiet (same as http-server's own tests).
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const harness = await createTestHarness({
    services: {
      'auth:require-user': async () => ({ user: { id: 'u1', isAdmin: false } }),
      'agents:list-for-user': async () => ({
        agents: [
          { id: 'a1', displayName: 'Inbox' },
          { id: 'a2', displayName: 'Research' },
        ],
      }),
      'agents:resolve': async (_ctx: unknown, input: unknown) => {
        const { agentId } = input as { agentId: string };
        if (agentId !== 'a1' && agentId !== 'a2') {
          throw new PluginError({
            code: 'not-found',
            plugin: 'mock-agents',
            message: 'nope',
          });
        }
        return {
          agent: { id: agentId, displayName: agentId === 'a1' ? 'Inbox' : 'Research' },
        };
      },
      'routines:recent-fires-for-agent': async (_ctx: unknown, input: unknown) => {
        const { agentId } = input as { agentId: string };
        return { fires: FIRES.filter((f) => f.agentId === agentId) };
      },
      'routines:list': async (_ctx: unknown, input: unknown) => {
        const { agentId } = input as { agentId?: string };
        const all = [
          { agentId: 'a1', path: 'a1.md', name: 'Morning digest' },
          { agentId: 'a2', path: 'a2.md', name: 'Paper scan' },
        ];
        return {
          routines: all.filter((r) => agentId === undefined || r.agentId === agentId),
        };
      },
    },
    plugins: [http],
  });
  await registerWorkspaceRoutes(harness.bus, initCtx, { agentWorkspacePreview: true });
  return { harness, port: http.boundPort() };
}

describe('GET /api/workspace/activity over a real socket', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close({ onError: () => {} });
      harness = null;
    }
  });

  it('scopes the feed when the browser sends ?agentId= in camelCase', async () => {
    const booted = await boot();
    harness = booted.harness;

    // camelCase ON PURPOSE. This is the exact string a browser puts on the
    // wire; http-server lowercases the KEY before the handler sees it, and a
    // handler that reads the camelCase spelling would ignore the filter and
    // answer with both agents' fires — a 200 that quietly means something else.
    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/workspace/activity?agentId=a2`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as ActivityBody;
    expect(body.events.map((e) => e.agentId)).toEqual(['a2']);
    expect(body.events.map((e) => e.text)).toEqual(['Paper scan']);
  });

  it('serves every agent when no agentId is given', async () => {
    const booted = await boot();
    harness = booted.harness;

    // The control: without the param the same route is the global feed. Both
    // halves matter — a route that ignored the param would pass the scoped
    // assertion above only by accident if this one returned one row too.
    const r = await fetch(`http://127.0.0.1:${booted.port}/api/workspace/activity`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as ActivityBody;
    expect(body.events.map((e) => e.agentId)).toEqual(['a2', 'a1']);
  });

  it('404s an agentId the caller cannot reach, over the real route', async () => {
    const booted = await boot();
    harness = booted.harness;
    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/workspace/activity?agentId=someone-elses`,
    );
    expect(r.status).toBe(404);
  });
});
