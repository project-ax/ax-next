// @vitest-environment node
/**
 * The decision routes and the preview flag must stay independent.
 *
 * TASK-261 moved the list, approve, dismiss and undo routes out of
 * `registerWorkspaceRoutes`' `if (agentWorkspacePreview)` block, joining the
 * single-row re-read TASK-259 had already put there — so the whole
 * `/api/workspace/decisions*` collection now mounts unconditionally. Because a
 * call held for approval reaches the DEFAULT `/` chat surface whether or not
 * a deployment turned the workspace preview on. Gating the routes gated only
 * the remedy: the agent said it was waiting for an answer and every button
 * that could give one 404'd.
 *
 * `plugin.test.ts` proves the routes we know about today answer with the flag
 * off. This file guards the thing that test cannot see: the NEXT decision
 * route somebody adds.
 *
 * The invariant is a set equality — the `/api/workspace/decisions*` routes
 * registered with the flag ON are exactly the ones registered with it OFF.
 * Nothing about it enumerates today's set, so the NEXT route dropped into the
 * gated block fails here with its own path in the message, instead of shipping
 * as a silent 404 on the only surface that needs it. That is not hypothetical:
 * TASK-259's `GET /api/workspace/decisions/:decisionId` is reached from `/`
 * through the same `useDecisionQueue` `/workspace` uses, and a 404 there is
 * invisible — the poll is silent by design, so Undo would simply linger on a
 * call that had already gone out.
 *
 * A stub bus, not a booted server, precisely BECAUSE the question is "what
 * got registered" rather than "what does it answer" — a real router can only
 * be asked about paths somebody already thought to name.
 */
import { describe, expect, it } from 'vitest';
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { registerWorkspaceRoutes } from '../../server/routes-workspace.js';

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

interface Registered {
  method: string;
  path: string;
}

/**
 * Collect every route `registerWorkspaceRoutes` hands to `http:register-route`.
 *
 * The handlers are closures that only touch the bus when a request arrives, so
 * registration needs nothing from it but a place to put the route.
 */
async function registeredRoutes(agentWorkspacePreview: boolean): Promise<Registered[]> {
  const seen: Registered[] = [];
  const bus = {
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

  await registerWorkspaceRoutes(bus, initCtx, { agentWorkspacePreview });
  return seen;
}

/** Every registered route that lives under the decisions collection. */
function decisionRoutes(routes: Registered[]): string[] {
  return routes
    .filter((r) => r.path.startsWith('/api/workspace/decisions'))
    .map((r) => `${r.method} ${r.path}`)
    .sort();
}

describe('the decisions collection vs the workspace preview flag', () => {
  it('registers the same decision routes whether the preview is on or off', async () => {
    const on = decisionRoutes(await registeredRoutes(true));
    const off = decisionRoutes(await registeredRoutes(false));

    // Set equality, deliberately not a hard-coded list: this is what catches a
    // route added to the gated block later. If this fails, the paths in `on`
    // that are missing from `off` are the ones to move up into the
    // always-mounted array in `registerWorkspaceRoutes`.
    expect(off).toEqual(on);
  });

  it('mounts a non-empty decisions collection with the preview off', async () => {
    // Guards the degenerate pass: two empty arrays are also "equal", and would
    // mean the whole collection had vanished rather than been ungated.
    const off = decisionRoutes(await registeredRoutes(false));
    // Five today. Tight rather than loose on purpose: a route dropped from
    // BOTH branches would satisfy the set-equality above and a `>= 4` floor,
    // and quietly shrink the collection. `plugin.test.ts` pins each path's verb
    // and reachability; this pins that none of them went missing.
    expect(off.length).toBeGreaterThanOrEqual(5);
    expect(off).toContain('GET /api/workspace/decisions');
  });

  it('still gates the rest of the workspace surface', async () => {
    // The other half of the bargain. Ungating the decisions collection must not
    // have quietly ungated everything else — an unmounted route is the cheapest
    // capability minimisation there is (invariant 5).
    const off = (await registeredRoutes(false)).map((r) => r.path);
    expect(off).toContain('/api/features');
    expect(off).not.toContain('/api/workspace/state');
    expect(off).not.toContain('/api/workspace/activity');
    expect(off).not.toContain('/api/workspace/agents/:agentId');
    expect(off).not.toContain('/api/workspace/route');
  });
});
