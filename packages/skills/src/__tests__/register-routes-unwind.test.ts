import { describe, it, expect } from 'vitest';
import { makeAgentContext, type HookBus } from '@ax/core';
import { registerAdminSkillsRoutes } from '../admin-routes.js';
import { registerSettingsSkillsRoutes } from '../settings-routes.js';

// ---------------------------------------------------------------------------
// Partial-registration unwind for the route registrars (TASK-58).
//
// registerAdminSkillsRoutes + registerSettingsSkillsRoutes register their
// routes one-by-one against `http:register-route`. If a LATER route fails to
// register (e.g. a duplicate path on re-init), the already-registered routes
// must be unwound (their `unregister` called) before the error is rethrown —
// otherwise the function throws before returning the unregister handles and
// the plugin-level catch can't reach them, leaking the live routes.
//
// This mirrors the equivalent test in catalog-routes.test.ts. Pure unit: a
// fakeBus whose 2nd `http:register-route` call throws, so no postgres
// testcontainer is needed.
// ---------------------------------------------------------------------------

/**
 * A fakeBus whose Nth `http:register-route` call throws. Every earlier call
 * returns an `unregister` that records the route path it tore down.
 */
function makeFailingBus(failOnCall: number): {
  bus: HookBus;
  unregistered: string[];
} {
  const unregistered: string[] = [];
  let calls = 0;
  const bus = {
    call: async (_hook: string, _ctx: unknown, route: { path: string }) => {
      calls += 1;
      if (calls === failOnCall) throw new Error('duplicate route');
      return { unregister: () => unregistered.push(route.path) };
    },
  } as unknown as HookBus;
  return { bus, unregistered };
}

const ctx = makeAgentContext({
  sessionId: 's',
  agentId: '@ax/skills',
  userId: 'admin',
});

describe('registerAdminSkillsRoutes partial-registration unwind', () => {
  it('unwinds already-registered routes if a later one fails', async () => {
    const { bus, unregistered } = makeFailingBus(2);

    await expect(registerAdminSkillsRoutes(bus, ctx)).rejects.toThrow(
      'duplicate route',
    );
    // The first route registered before the failure must have been torn down.
    expect(unregistered).toEqual(['/admin/skills']);
  });
});

describe('registerSettingsSkillsRoutes partial-registration unwind', () => {
  it('unwinds already-registered routes if a later one fails', async () => {
    const { bus, unregistered } = makeFailingBus(2);

    await expect(registerSettingsSkillsRoutes(bus, ctx)).rejects.toThrow(
      'duplicate route',
    );
    // The first route registered before the failure must have been torn down.
    expect(unregistered).toEqual(['/settings/skills']);
  });
});
