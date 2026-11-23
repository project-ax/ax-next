import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import {
  createAdminAgentRouteHandlers,
  registerAdminAgentRoutes,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';

// ---------------------------------------------------------------------------
// GET /admin/agents/tools (TASK-1214) — the names the agent form's tool picker
// offers: the host catalog's names (`tool:list`) plus the runner built-ins.
//
// The rule these tests pin: a catalog read that could not happen, or did not
// come back whole, is a 503 — never an empty list. The form drops saved names
// the catalog lacks, so an empty list from a failed read would delete every
// host tool an agent has.
//
// No Docker: the handler touches the bus only, never the store.
// ---------------------------------------------------------------------------

const BUILTINS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

function mkRes(): { res: RouteResponse; statusOf: () => number; bodyOf: () => unknown } {
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(n: number) {
      status = n;
      return res;
    },
    json(v: unknown) {
      body = v;
    },
    text(s: string) {
      body = s;
    },
    end() {},
  };
  return { res, statusOf: () => status, bodyOf: () => body };
}

const req: RouteRequest = {
  headers: {},
  body: Buffer.alloc(0),
  cookies: {},
  query: {},
  params: {},
  signedCookie: () => null,
};

function handlersFor(bus: HookBus) {
  return createAdminAgentRouteHandlers({
    store: { countByModel: async () => [] } as never,
    bus,
    boot: {} as never,
  });
}

/** A bus whose `auth:require-user` answers a signed-in, non-admin user. */
function signedInBus(): HookBus {
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'test', async () => ({
    user: { id: 'u1', isAdmin: false },
  }));
  return bus;
}

/** A host-tool descriptor as `tool:list` returns it. */
function descriptor(name: unknown): Record<string, unknown> {
  return { name, inputSchema: {}, executesIn: 'host' };
}

/**
 * Register a `tool:list` stub with NO `returns` schema, so malformed entries
 * reach the route the way a future catalog without the dispatcher's schema
 * would hand them over.
 */
function stubCatalog(bus: HookBus, reply: () => unknown) {
  const toolList = vi.fn(async () => reply());
  bus.registerService('tool:list', 'test', toolList);
  return toolList;
}

/** Run `fn` with stdout captured; returns the non-empty lines written. */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.flatMap((c) => c.split('\n')).filter((l) => l.length > 0);
}

function failureLogs(lines: string[]): Array<{ level: string; error: unknown }> {
  return lines
    .filter((l) => l.includes('agents_admin_list_tools_failed'))
    .map((l) => JSON.parse(l) as { level: string; error: unknown });
}

describe('GET /admin/agents/tools', () => {
  it('registers GET /admin/agents/tools', async () => {
    const bus = new HookBus();
    const routes: Array<{ method: string; path: string }> = [];
    bus.registerService<{ method: string; path: string }, { unregister: () => void }>(
      'http:register-route',
      'test',
      async (_ctx, input) => {
        routes.push({ method: input.method, path: input.path });
        return { unregister: () => {} };
      },
    );
    await registerAdminAgentRoutes(
      bus,
      makeAgentContext({ sessionId: 'init', agentId: 'test', userId: 'test' }),
      {} as never,
      {} as never,
    );
    expect(routes).toContainEqual({ method: 'GET', path: '/admin/agents/tools' });
  });

  it('anonymous -> 401 and the catalog is never read', async () => {
    const bus = new HookBus();
    bus.registerService('auth:require-user', 'test', async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no cookie' });
    });
    const toolList = stubCatalog(bus, () => ({ tools: [descriptor('routine_list')] }));
    const { res, statusOf, bodyOf } = mkRes();
    await handlersFor(bus).listTools(req, res);
    expect(statusOf()).toBe(401);
    expect(bodyOf()).toEqual({ error: 'unauthenticated' });
    expect(toolList).not.toHaveBeenCalled();
  });

  it('a signed-in non-admin gets the catalog names in catalog order plus the six built-ins', async () => {
    const bus = signedInBus();
    stubCatalog(bus, () => ({
      tools: [descriptor('routine_list'), descriptor('routine_create'), descriptor('memory_note')],
    }));
    const { res, statusOf, bodyOf } = mkRes();
    await handlersFor(bus).listTools(req, res);
    expect(statusOf()).toBe(200);
    expect(bodyOf()).toEqual({
      tools: ['routine_list', 'routine_create', 'memory_note'],
      builtins: BUILTINS,
    });
  });

  it('drops mcp.-namespaced, malformed and duplicate names', async () => {
    const bus = signedInBus();
    stubCatalog(bus, () => ({
      tools: [
        descriptor('routine_list'),
        // Scoped by mcpConfigIds, never by allowedTools — and the middle
        // segment is a per-tenant config id.
        descriptor('mcp.cfg-1.search'),
        descriptor('has space'),
        descriptor(''),
        descriptor(42),
        null,
        descriptor('routine_list'),
        descriptor('x'.repeat(65)),
        descriptor('web_search'),
      ],
    }));
    const { res, statusOf, bodyOf } = mkRes();
    await handlersFor(bus).listTools(req, res);
    expect(statusOf()).toBe(200);
    expect((bodyOf() as { tools: unknown }).tools).toEqual(['routine_list', 'web_search']);
  });

  it('no tool catalog in this deployment -> 503, never an empty list', async () => {
    const bus = signedInBus();
    const { res, statusOf, bodyOf } = mkRes();
    await handlersFor(bus).listTools(req, res);
    expect(statusOf()).toBe(503);
    expect(bodyOf()).toEqual({ error: 'tool-catalog-unavailable' });
  });

  it('a catalog read that throws -> 503 without echoing it, and logs it', async () => {
    const bus = signedInBus();
    stubCatalog(bus, () => {
      throw new Error('catalog exploded at 10.0.0.7');
    });
    const { res, statusOf, bodyOf } = mkRes();
    const lines = await captureStdout(() => handlersFor(bus).listTools(req, res));
    expect(statusOf()).toBe(503);
    expect(bodyOf()).toEqual({ error: 'tool-catalog-unavailable' });
    expect(JSON.stringify(bodyOf())).not.toContain('exploded');
    const logged = failureLogs(lines);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe('warn');
    // The detail goes to the operator's log, not to the client.
    expect(String(logged[0]!.error)).toContain('exploded');
  });

  it('a reply without a tools array -> 503, not an empty catalog', async () => {
    const bus = signedInBus();
    stubCatalog(bus, () => ({}));
    const { res, statusOf, bodyOf } = mkRes();
    const lines = await captureStdout(() => handlersFor(bus).listTools(req, res));
    expect(statusOf()).toBe(503);
    expect(bodyOf()).toEqual({ error: 'tool-catalog-unavailable' });
    expect(failureLogs(lines)).toHaveLength(1);
  });
});
