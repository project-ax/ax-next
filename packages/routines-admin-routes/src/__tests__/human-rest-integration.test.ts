import { afterEach, describe, expect, it } from 'vitest';
import {
  RoutineDefinitionSchema,
  type RoutineFireView,
  type RoutineView,
} from '@ax/routines-contract';
import {
  createRoutineHarness,
  type RoutineHarness,
} from '../../../routines/src/__tests__/support/routine-harness.js';
import { createRoutinesStore } from '../../../routines/src/store.js';
import { createDestinationHandlers } from '../../../credentials-admin-routes/src/destination-routes.js';
import {
  createRoutinesAdminHandlers,
  createAdminDefaultRoutinesHandlers,
} from '../routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';
const definition = RoutineDefinitionSchema.parse({
  name: 'Daily',
  promptBody: 'Run',
  trigger: {
    kind: 'webhook',
    path: '/daily',
    hmac: { header: 'X-Signature', algorithm: 'sha256' },
  },
});
let h: RoutineHarness;
afterEach(async () => {
  await h?.close();
});
function req(
  body?: unknown,
  params: Record<string, string> = {},
): RouteRequest {
  return {
    headers: {},
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
    body:
      body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
  };
}
function response() {
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(n) {
      status = n;
      return res;
    },
    json(v) {
      body = v;
    },
    text(v) {
      body = v;
    },
    end() {},
  };
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}
describe('human REST through registered DB services and real agent ACL', () => {
  it('uses the authenticated person for CRUD on a team agent and hides unauthorized personal agents', async () => {
    h = await createRoutineHarness({ authenticatedUserId: 'admin' });
    const routes = createRoutinesAdminHandlers({ bus: h.bus });
    const created = response();
    await routes.create(
      req({ requestId: 'c', definition }, { agentId: h.teamAgentId }),
      created.res,
    );
    expect(created.status).toBe(201);
    const row = (created.body as { routine: RoutineView }).routine;
    expect(row.permissions.edit).toBe(true);
    expect((await createRoutinesStore(h.db).findOne(row))?.ownerUserId).toBe(
      'admin',
    );
    const denied = response();
    await routes.list(req(undefined, { agentId: h.agentId }), denied.res);
    expect(denied.status).toBe(404);
    const params = { agentId: h.teamAgentId, routineId: row.routineId };
    const edited = response();
    await routes.update(
      req(
        {
          requestId: 'e',
          expectedRevision: row.revision,
          patch: { name: 'Edited' },
        },
        params,
      ),
      edited.res,
    );
    expect(edited.status).toBe(200);
    const stale = response();
    await routes.update(
      req(
        {
          requestId: 'stale',
          expectedRevision: row.revision,
          patch: { name: 'Stale' },
        },
        params,
      ),
      stale.res,
    );
    expect(stale.status).toBe(409);
    const removed = response();
    await routes.destroy(
      req(
        {
          requestId: 'd',
          expectedRevision: (edited.body as { routine: RoutineView }).routine
            .revision,
        },
        params,
      ),
      removed.res,
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true, cleanupPending: true });
  });
  it('routes secret sets through joined credential settlement before concurrent HMAC removal', async () => {
    h = await createRoutineHarness({
      authenticatedUserId: 'admin',
      credentialTimeoutMs: 10,
    });
    const row = await h.bus.call<unknown, RoutineView>(
      'routines:create',
      h.teamAdmin,
      { agentId: h.teamAgentId, requestId: 'c', definition },
    );
    const routes = createRoutinesAdminHandlers({ bus: h.bus });
    const credentials = createDestinationHandlers({ bus: h.bus });
    const gate = h.holdCredentialSet();
    const target = {
      destination: {
        kind: 'routine-hmac',
        agentId: row.agentId,
        routineId: row.routineId,
      },
      scope: 'agent',
      ownerId: row.agentId,
      expectedRevision: row.revision,
    };
    const saved = response();
    const saving = credentials.create(
      req(
        { ...target, kind: 'api-key', payloadB64: 'c2VjcmV0' },
        { destinationKind: 'routine-hmac' },
      ),
      saved.res,
    );
    await gate.started;
    let settled = false;
    const removed = response();
    const removing = routes
      .update(
        req(
          {
            requestId: 'remove-hmac',
            expectedRevision: row.revision,
            patch: { trigger: { kind: 'interval', every: '1h' } },
          },
          { agentId: row.agentId, routineId: row.routineId },
        ),
        removed.res,
      )
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    expect(h.credentialCalls).toEqual([]);
    gate.release();
    await saving;
    await removing;
    expect(saved.status).toBe(503);
    expect(removed.status).toBe(200);
    expect(h.credentialCalls.map((c) => c.operation)).toEqual([
      'set',
      'delete',
    ]);
    expect(
      h.credentialCalls.every(
        (c) => c.ref === `routine:${row.agentId}:${row.routineId}:hmac`,
      ),
    ).toBe(true);
    const stale = response();
    await credentials.destroy(
      req(target, { destinationKind: 'routine-hmac' }),
      stale.res,
    );
    expect(stale.status).toBe(409);
    expect(h.credentialCalls).toHaveLength(2);
  });
  it('keeps secret forms fenced during failed cleanup and after deletion, and has no default destination', async () => {
    h = await createRoutineHarness({ authenticatedUserId: 'admin' });
    const routes = createRoutinesAdminHandlers({ bus: h.bus });
    const credentials = createDestinationHandlers({ bus: h.bus });
    const row = await h.bus.call<unknown, RoutineView>(
      'routines:create',
      h.teamAdmin,
      { agentId: h.teamAgentId, requestId: 'c', definition },
    );
    h.failNextCredentialDelete();
    const update = response();
    await routes.update(
      req(
        {
          requestId: 'remove',
          expectedRevision: row.revision,
          patch: { trigger: { kind: 'interval', every: '1h' } },
        },
        { agentId: row.agentId, routineId: row.routineId },
      ),
      update.res,
    );
    expect(update.status).toBe(200);
    const changed = (update.body as { routine: RoutineView }).routine;
    const target = {
      destination: {
        kind: 'routine-hmac',
        agentId: row.agentId,
        routineId: row.routineId,
      },
      scope: 'agent',
      ownerId: row.agentId,
      expectedRevision: changed.revision,
    };
    const pending = response();
    await credentials.destroy(
      req(target, { destinationKind: 'routine-hmac' }),
      pending.res,
    );
    expect(pending.status).toBe(409);
    expect(pending.body).toMatchObject({ code: 'cleanup-pending' });
    await h.drainCleanup();
    const removed = response();
    await routes.destroy(
      req(
        { requestId: 'delete', expectedRevision: changed.revision },
        { agentId: row.agentId, routineId: row.routineId },
      ),
      removed.res,
    );
    expect(removed.status).toBe(200);
    const deleted = response();
    await credentials.destroy(
      req(target, { destinationKind: 'routine-hmac' }),
      deleted.res,
    );
    expect(deleted.status).toBe(404);
    const catalog = createAdminDefaultRoutinesHandlers({ bus: h.bus });
    const { enabled: _enabled, ...defaultDefinition } =
      RoutineDefinitionSchema.parse({
        ...definition,
        trigger: { kind: 'interval', every: '1h' },
      });
    const created = response();
    await catalog.create(req(defaultDefinition), created.res);
    expect(created.status).toBe(201);
    const defaultId = (created.body as { defaultRoutineId: string })
      .defaultRoutineId;
    const invalid = response();
    await credentials.destroy(
      req(
        {
          ...target,
          destination: {
            ...target.destination,
            routineId: `default:${defaultId}`,
          },
        },
        { destinationKind: 'routine-hmac' },
      ),
      invalid.res,
    );
    expect(invalid.status).toBe(400);
  });
  it("serves a team task's state and its runs' reports only to the task's owner", async () => {
    // TASK-907: the routes serve the routines services' answers as they are, so
    // the services decide. The member's browser gets the routine, not its state.
    h = await createRoutineHarness({ authenticatedUserId: 'member' });
    const task = await h.bus.call<unknown, RoutineView>(
      'routines:create',
      h.owner,
      {
        agentId: h.teamAgentId,
        requestId: 'task',
        definition: RoutineDefinitionSchema.parse({
          name: 'Support queue',
          promptBody: 'Keep the support queue empty.',
          trigger: { kind: 'interval', every: '15m' },
          kind: 'stay-on-top',
          goodWhen: 'No ticket waits longer than an hour.',
        }),
      },
    );
    const report = {
      status: 'needs-you',
      update: 'Two tickets wait on a refund rule.',
      ask: 'Can refunds over $50 go out without you?',
    } as const;
    const notes = 'Order 1234 waits on a refund.';
    // One check-in of the owner's task reports, the way routines:report records it.
    const store = createRoutinesStore(h.db);
    const run = await store.acceptDispatch({
      agentId: task.agentId,
      routineId: task.routineId,
      expectedRevision: task.revision,
      actorUserId: 'owner',
      source: 'manual',
      requestId: 'run',
      now: new Date(),
    });
    const dispatchId = run!.accepted.dispatchId;
    await store.bindDispatchConversation({
      dispatchId,
      conversationId: 'check-in',
    });
    expect(
      await store.recordReport({
        agentId: task.agentId,
        dispatchId,
        conversationId: 'check-in',
        actorUserId: 'owner',
        report,
        notes,
        now: new Date(),
      }),
    ).toBe('recorded');
    expect(
      await store.finishDispatch({
        dispatchId,
        outcome: {
          status: 'ok',
          conversationId: 'check-in',
          error: null,
          renderedPrompt: null,
          warning: null,
        },
      }),
    ).toBe(true);
    const routes = createRoutinesAdminHandlers({ bus: h.bus });
    const params = { agentId: task.agentId, routineId: task.routineId };
    const listed = response();
    await routes.list(req(undefined, { agentId: task.agentId }), listed.res);
    const got = response();
    await routes.get(req(undefined, params), got.res);
    const fires = response();
    await routes.fires(req(undefined, params), fires.res);
    expect([listed.status, got.status, fires.status]).toEqual([200, 200, 200]);
    expect(
      (listed.body as { routines: RoutineView[] }).routines.map((view) => [
        view.routineId,
        view.task,
      ]),
    ).toEqual([[task.routineId, null]]);
    expect((got.body as { routine: RoutineView }).routine).toMatchObject({
      routineId: task.routineId,
      kind: 'stay-on-top',
      task: null,
    });
    expect(
      (fires.body as { fires: RoutineFireView[] }).fires.map(
        (fire) => fire.report,
      ),
    ).toEqual([null]);
    const served = JSON.stringify([listed.body, got.body, fires.body]);
    for (const text of [notes, report.update, report.ask])
      expect(served).not.toContain(text);
    // The owner's own reads have all of it.
    expect(
      (await h.bus.call<unknown, RoutineView>('routines:get', h.owner, params))
        .task,
    ).toEqual({
      ...report,
      agentNotes: notes,
      reportedAt: expect.any(String),
    });
    expect(
      (
        await h.bus.call<unknown, { fires: RoutineFireView[] }>(
          'routines:recent-fires',
          h.owner,
          params,
        )
      ).fires.map((fire) => fire.report),
    ).toEqual([report]);
  });
  it('does not disclose a team receiver token to a member who can view the agent', async () => {
    h = await createRoutineHarness({ authenticatedUserId: 'member' });
    const r = response();
    await createRoutinesAdminHandlers({ bus: h.bus }).receiver(
      req(undefined, { agentId: h.teamAgentId }),
      r.res,
    );
    expect(r.status).toBe(404);
    expect(r.body).not.toHaveProperty('url');
  });
});
