import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HookBus } from '@ax/core';
import { RoutineDeleteInputSchema, RoutineUpdateInputSchema } from '@ax/routines-contract';
import { createRoutinesAdminHandlers } from '../../../routines-admin-routes/dist/routes.js';
import type { RouteRequest, RouteResponse } from '../../../routines-admin-routes/dist/shared.js';
import { routineView } from '../../../routines/src/services.js';
import type { StoredRoutine } from '../../../routines/src/types.js';
import { routineFixture } from '../components/routines/__tests__/routine-fixture';
import { RoutinesList } from '../components/routines/RoutinesList';

// Real producer projection, HTTP handlers, client serialization, and list composition.
// The store effect is bounded to this fixture; PostgreSQL ACL tests cover persistence.
afterEach(() => vi.unstubAllGlobals());
it('a stop-only manager emits validated disable/delete requests through the actual HTTP producer', async () => {
  const bus = new HookBus();
  let row: StoredRoutine = { ...routineFixture, ownerUserId: 'creator', definitionId: null, definitionUpdatedAt: null, nextRunAt: null, lastRunAt: null, task: null };
  let removed = false;
  const view = () => routineView(row, 'manager', true);
  expect(routineView({ ...row, definitionId: 'default-heartbeat-2026-05-19' }, 'creator', true).permissions).toEqual({ edit: false, stop: false, fire: true, manageSecret: false });
  expect(view().permissions).toEqual({ edit: false, stop: true, fire: false, manageSecret: false });
  bus.registerService('auth:require-user', 'test', async () => ({ user: { id: 'manager' } }));
  bus.registerService('agents:resolve', 'test', async () => ({ agent: { id: 'a' } }));
  bus.registerService('routines:list', 'test', async () => ({ routines: removed ? [] : [view()] }));
  bus.registerService('routines:recent-fires', 'test', async () => ({ fires: [] }));
  const update = vi.fn(async (ctx, input) => {
    expect(ctx.userId).toBe('manager');
    const patch = RoutineUpdateInputSchema.parse(input);
    expect(patch).toMatchObject({ agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, patch: { enabled: false } });
    expect(patch.requestId).toEqual(expect.any(String));
    row = { ...row, enabled: false, revision: 'disabled-revision' };
    return view();
  });
  const destroy = vi.fn(async (ctx, input) => {
    expect(ctx.userId).toBe('manager');
    expect(RoutineDeleteInputSchema.parse(input)).toMatchObject({ agentId: 'a', routineId: row.routineId, expectedRevision: 'disabled-revision', requestId: expect.any(String) });
    removed = true;
    return { deleted: true, cleanupPending: false };
  });
  bus.registerService('routines:update', 'test', update);
  bus.registerService('routines:delete', 'test', destroy);
  const handlers = createRoutinesAdminHandlers({ bus });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, 'http://fixture');
    const req: RouteRequest = { headers: {}, cookies: {}, signedCookie: () => null, params: { agentId: 'a', routineId: row.routineId }, query: Object.fromEntries(url.searchParams), body: Buffer.from(typeof init.body === 'string' ? init.body : '') };
    let status = 200;
    let output: unknown;
    const res: RouteResponse = { status(n) { status = n; return res; }, json(value) { output = value; }, text() {}, end() {} };
    const handler = init.method === 'PATCH' ? handlers.update : init.method === 'DELETE' ? handlers.destroy : url.pathname.endsWith('/fires') ? handlers.fires : handlers.list;
    await handler(req, res);
    return new Response(JSON.stringify(output), { status, headers: { 'Content-Type': 'application/json' } });
  }));
  render(<RoutinesList agentId="a" agentName="Caveman" onFired={vi.fn()} />);
  await screen.findByText(row.name);
  expect(screen.queryByRole('button', { name: `Edit ${row.name}` })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked());
  expect(screen.getByRole('switch')).toBeDisabled();
  expect(update).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('switch'));
  expect(update).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: `Recent runs for ${row.name}` }));
  expect(screen.queryByRole('button', { name: 'Fire now' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete routine' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  await screen.findByText('No routines yet');
});
