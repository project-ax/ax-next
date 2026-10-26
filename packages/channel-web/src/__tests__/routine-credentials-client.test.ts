import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setDestinationCredential,
  removeDestinationCredential,
  refForDestination,
  routineSecretConfigured,
} from '../lib/credentials';
import { REQUEST_TIMEOUT_MS } from '../lib/http';
import { RoutineApiError } from '../lib/routines';
const target = {
  destination: {
    kind: 'routine-hmac' as const,
    agentId: 'a',
    routineId: 'rtn_opaque',
  },
  expectedRevision: 'rev1',
  scope: { scope: 'agent' as const, ownerId: 'a' },
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('routine credential client', () => {
  it.each(['fetch', 'body'])('bounds a stalled status %s and aborts without reflecting response details', async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal;
      if (stage === 'fetch') return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    });
    let outcome: unknown = 'pending';
    void routineSecretConfigured(target.destination).then(value => { outcome = value; }, error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    expect(outcome).toBeInstanceOf(RoutineApiError);
    expect(outcome).toMatchObject({ status: 0, code: 'unavailable' });
    expect(signal?.aborted).toBe(true);
  });
  it('sends revision-bound set and delete to authenticated own destination with no raw ref', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 204 }));
    await setDestinationCredential({
      ...target,
      slot: { kind: 'api-key' },
      payload: 'secret',
    });
    await removeDestinationCredential(target);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(
      Array(2).fill('/settings/destinations/routine-hmac/credential'),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      ...target,
      destination: target.destination,
      scope: 'agent',
      ownerId: 'a',
      kind: 'api-key',
      payloadB64: 'c2VjcmV0',
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      destination: target.destination,
      expectedRevision: 'rev1',
      scope: 'agent',
      ownerId: 'a',
    });
  });
  it('refuses an arbitrary routine scope before transport and rejects colon IDs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(
      setDestinationCredential({
        ...target,
        scope: { scope: 'global', ownerId: null },
        slot: { kind: 'api-key' },
        payload: 'secret',
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      refForDestination({ ...target.destination, routineId: 'r:a' }),
    ).toThrow();
  });
  it('returns safe typed lifecycle conflicts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'cleanup-pending',
          field: 'trigger.hmac',
          error: 'SECRET',
        }),
        { status: 409 },
      ),
    );
    await expect(removeDestinationCredential(target)).rejects.toMatchObject({
      code: 'cleanup-pending',
      field: 'trigger.hmac',
      status: 409,
    });
  });
});
