import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { registerRoutinesAdminRoutes } from '../../../routines-admin-routes/src/routes.js';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';

let h: RoutineHarness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

async function receiverAccess(agentId: string) {
  // Exercise real route registration, routing and HTTP serialization, not just a handler call.
  await registerRoutinesAdminRoutes(h.bus, h.owner);
  const listening = captureExpectedStderr(message => message.startsWith('[ax/http-server] listening on http://127.0.0.1:'));
  const server = createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: Buffer.alloc(32, 1), allowedOrigins: ['http://localhost'] });
  const http = await createTestHarness({ plugins: [server] });
  try {
    for (const route of h.routes) await http.bus.call('http:register-route', http.ctx(), route);
    const calls = vi.spyOn(h.bus, 'call');
    const joined = vi.spyOn(h.bus, 'callJoined');
    const response = await fetch(`http://127.0.0.1:${server.boundPort()}/settings/routines/${encodeURIComponent(agentId)}/receiver-access`);
    const body: unknown = await response.json();
    const hookNames = [...calls.mock.calls, ...joined.mock.calls].map(([name]) => name);
    expect(hookNames).not.toContain('agents:ensure-webhook-token');
    expect(hookNames.some(name => name.startsWith('credentials:'))).toBe(false);
    return { status: response.status, body, hookNames };
  } finally {
    await http.close();
    listening.restore();
  }
}

describe('receiver access through HTTP and the real agents permission producer', () => {
  // Authentication and team-membership data are fixture services; agents' permission
  // implementation, its store, route auth/registration and HTTP transport are real.
  it.each([
    ['personal owner', 'owner', 'personal', true],
    ['team administrator without workspace admin rights', 'team-admin', 'team', true],
    ['workspace administrator', 'admin', 'team', true],
    ['ordinary teammate', 'member', 'team', false],
  ] as const)('%s receives only the existing agent receiver capability', async (_label, userId, agent, allowed) => {
    h = await createRoutineHarness({ authenticatedUserId: userId });
    const result = await receiverAccess(agent === 'personal' ? h.agentId : h.teamAgentId);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ allowed });
    expect(result.hookNames).toContain('agents:can-manage-connectors');
  });

  it('resolves viewer access before revealing a personal agent capability', async () => {
    h = await createRoutineHarness({ authenticatedUserId: 'member' });
    const result = await receiverAccess(h.agentId);
    expect(result.status).toBe(404);
    expect(result.hookNames).not.toContain('agents:can-manage-connectors');
    expect(result.body).not.toEqual({ allowed: false });
  });

  it('keeps a real membership lookup outage distinct from a denial', async () => {
    h = await createRoutineHarness({ authenticatedUserId: 'member' });
    h.setTeamFailure('outage');
    const result = await receiverAccess(h.teamAgentId);
    expect(result.status).toBe(503);
    expect(result.body).not.toEqual({ allowed: false });
  });
});
