// @vitest-environment node
/**
 * What `registerWorkspaceRoutes` mounts, with nothing but a bus to go on.
 *
 * There used to be an `agentWorkspace` flag here: most `/api/workspace/*`
 * routes mounted only when it was on, and `GET /api/features` echoed it so the
 * SPA could ask. TASK-360 retired both — the workspace is the only web
 * interface now, so "off" meant "no UI at all". These tests pin the new shape
 * so a partial revert is loud:
 *
 * - called with NO options, the whole surface mounts (there is nothing left to
 *   switch it on with);
 * - `/api/features` is gone, and so is the handler behind it.
 *
 * A stub bus, not a booted server, because the question is "what got
 * registered" rather than "what does it answer" — a real router can only be
 * asked about paths somebody already thought to name.
 */
import { describe, expect, it } from 'vitest';
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import {
  makeWorkspaceHandlers,
  registerWorkspaceRoutes,
} from '../../server/routes-workspace.js';

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

interface Registered {
  method: string;
  path: string;
}

function stubBus(seen: Registered[]): HookBus {
  return {
    async call(hook: string, _ctx: AgentContext, payload: unknown) {
      if (hook !== 'http:register-route') {
        throw new Error(`unexpected hook during registration: ${hook}`);
      }
      const route = payload as Registered;
      seen.push({ method: route.method, path: route.path });
      return { unregister: () => {} };
    },
    hasService: () => false,
  } as unknown as HookBus;
}

/** Every route `registerWorkspaceRoutes` hands to `http:register-route`. */
async function registeredRoutes(): Promise<Registered[]> {
  const seen: Registered[] = [];
  // No options at all: no flag exists to pass, and none is needed.
  await registerWorkspaceRoutes(stubBus(seen), initCtx);
  return seen;
}

describe('registerWorkspaceRoutes (no flag)', () => {
  it('mounts the whole workspace surface with no options passed', async () => {
    const routes = (await registeredRoutes()).map((r) => `${r.method} ${r.path}`);
    expect(routes).toContain('GET /api/workspace/state');
    expect(routes).toContain('GET /api/workspace/activity');
    expect(routes).toContain('GET /api/workspace/agents/:agentId');
    expect(routes).toContain('POST /api/workspace/route');
    expect(routes).toContain('GET /api/workspace/grants');
  });

  it('mounts the whole decisions collection', async () => {
    const decisions = (await registeredRoutes())
      .filter((r) => r.path.startsWith('/api/workspace/decisions'))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(decisions).toEqual([
      'GET /api/workspace/decisions',
      'GET /api/workspace/decisions/:decisionId',
      'POST /api/workspace/decisions/:decisionId/approve',
      'POST /api/workspace/decisions/:decisionId/dismiss',
      'POST /api/workspace/decisions/:decisionId/undo',
    ]);
  });

  it('no longer registers GET /api/features', async () => {
    const paths = (await registeredRoutes()).map((r) => r.path);
    expect(paths).not.toContain('/api/features');
    // Nothing else outside /api/workspace/* either — this module owns that
    // prefix and nothing more.
    expect(paths.filter((p) => !p.startsWith('/api/workspace/'))).toEqual([]);
  });

  it('has no features handler left to wire back up', () => {
    const handlers = makeWorkspaceHandlers({ bus: stubBus([]), initCtx });
    expect(Object.keys(handlers)).not.toContain('features');
  });
});
