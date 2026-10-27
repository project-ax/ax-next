import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { REQUEST_TIMEOUT_MS } from '../lib/http';
import { routineApi, RoutineApiError } from '../lib/routines';
const definition = RoutineDefinitionSchema.parse({
  name: 'Daily',
  promptBody: 'Run',
  trigger: { kind: 'interval', every: '1h' },
});
const routine = {
  ...definition,
  agentId: 'a',
  routineId: 'r',
  revision: 'rev',
  origin: 'authored',
  defaultRoutineId: null,
  nextRunAt: null,
  lastRunAt: '2026-10-09T00:00:00.000Z',
  lastStatus: 'ok',
  lastError: null,
  lastWarning: null,
  permissions: { edit: true, stop: true, fire: true, manageSecret: true },
};
afterEach(() => vi.restoreAllMocks());
describe('structured routine client', () => {
  it('uses collection and item IDs, preserves request/revision input, keeps ISO dates', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ routine }), { status: 200 }),
      );
    const value = await routineApi.update({
      agentId: 'a',
      routineId: 'r',
      requestId: 'retry-stable',
      expectedRevision: 'rev',
      patch: { silenceToken: null },
    });
    expect(value.lastRunAt).toBe('2026-10-09T00:00:00.000Z');
    expect(fetch).toHaveBeenCalledWith(
      '/settings/routines/a/r',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        body: JSON.stringify({
          requestId: 'retry-stable',
          expectedRevision: 'rev',
          patch: { silenceToken: null },
        }),
      }),
    );
  });
  it('sends structured create and bounded fire/delete requests with no markdown transport', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ routine }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true, cleanupPending: false }), {
          status: 200,
        }),
      );
    await routineApi.create({ agentId: 'a', requestId: 'c', definition });
    const input = {
      agentId: 'a',
      routineId: 'r',
      requestId: 'f',
      expectedRevision: 'rev',
    };
    await routineApi.fireNow(input);
    await routineApi.remove({ ...input, requestId: 'd' });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ requestId: 'c', definition }),
    );
    expect(fetch.mock.calls[1]?.[0]).toBe('/settings/routines/a/r/fire');
    expect(fetch.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });
  it('returns typed errors and ignores arbitrary message/code/field text', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'revision-conflict',
            field: 'expectedRevision',
            error: 'SECRET',
          }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'SECRET', field: 'SECRET', error: 'SECRET' }),
          { status: 500 },
        ),
      );
    await expect(
      routineApi.get({ agentId: 'a', routineId: 'r' }),
    ).rejects.toMatchObject({
      code: 'revision-conflict',
      field: 'expectedRevision',
      status: 409,
    });
    const failure = routineApi.get({ agentId: 'a', routineId: 'r' });
    await expect(failure).rejects.toBeInstanceOf(RoutineApiError);
    await expect(failure).rejects.toMatchObject({
      code: 'unavailable',
      status: 500,
      message: expect.not.stringContaining('SECRET'),
    });
    await expect(failure).rejects.toHaveProperty('field', undefined);
  });
  it('preserves the closed active-days error field without server text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'invalid', field: 'activeHours.days', error: 'SECRET' }), { status: 400 }));
    await expect(routineApi.get({ agentId: 'a', routineId: 'r' })).rejects.toMatchObject({ field: 'activeHours.days', message: expect.not.stringContaining('SECRET') });
  });
  it('scopes list, history, consent and receiver calls, returning only receiver prefix', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ routines: [routine] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ fires: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: false, revision: 'c' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: '/webhooks/token' }), {
          status: 200,
        }),
      );
    expect((await routineApi.list('a'))[0]?.lastRunAt).toBe(routine.lastRunAt);
    await routineApi.recentFires({ agentId: 'a', routineId: 'r', limit: 20 });
    await routineApi.getConsent('a');
    expect(await routineApi.getReceiver('a')).toEqual({
      url: '/webhooks/token',
    });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/settings/routines/a',
      '/settings/routines/a/r/fires?limit=20',
      '/settings/routines/a/consent',
      '/settings/routines/a/receiver',
    ]);
  });
});
describe('a routine request that never answers (TASK-937)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const method of ['getReceiverAccess', 'getReceiver'] as const) {
    for (const stalled of ['fetch', 'body'] as const) {
      it(`${method} bounds a stalled ${stalled} and aborts at the shared deadline`, async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => stalled === 'fetch'
          ? new Promise<Response>(() => {})
          : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
        const result = routineApi[method]('agent / with spaces');
        const settled = vi.fn();
        result.then(settled, settled);
        const assertion = expect(result).rejects.toMatchObject({ name: 'RoutineApiError', status: 0 });
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await assertion;
        expect((fetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
        expect(fetch.mock.calls[0]![0]).toBe(`/settings/routines/agent%20%2F%20with%20spaces/${method === 'getReceiverAccess' ? 'receiver-access' : 'receiver'}`);
      });
    }
  }

  it('fails at the deadline as RoutineApiError(0), its fetch aborted', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>(() => {}));
    const result = routineApi.fireNow({
      agentId: 'a',
      routineId: 'r',
      expectedRevision: 'rev',
      requestId: 'press-1',
    });
    const settled = vi.fn();
    result.then(settled, settled);
    const assertion = expect(result).rejects.toMatchObject({
      name: 'RoutineApiError',
      status: 0,
    });

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await expect(result).rejects.toBeInstanceOf(RoutineApiError);
    expect((fetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  });
});
