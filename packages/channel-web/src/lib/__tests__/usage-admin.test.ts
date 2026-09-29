import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchUsage,
  putUsageLimits,
  suspendUser,
  resumeUser,
  UsageHttpError,
  type UsageReport,
} from '../usage-admin';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Captured {
  url: string;
  init: RequestInit;
}

/** Stub `fetch` with one canned response and hand back what it was called with. */
function stubFetch(status: number, body: unknown): { calls: Captured[] } {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return Promise.resolve(new Response(text, { status }));
    }),
  );
  return { calls };
}

function headersOf(call: Captured): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

const REPORT: UsageReport = {
  windowHours: 24,
  truncated: false,
  limits: { dailySpendUsd: 5, turnsPerHour: 60, assumedTurnCostUsd: 0.25 },
  totals: { turns: 3, spendUsd: 1.5, users: 1 },
  users: [
    {
      userId: 'u1',
      displayName: 'Sam',
      email: 'sam@example.co',
      turnsLastHour: 1,
      turnsLast24h: 3,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      spendUsd: 1.5,
      status: 'ok',
      suspended: null,
    },
  ],
};

describe('fetchUsage', () => {
  it('GETs /admin/usage with the auth cookie and returns the parsed report', async () => {
    const { calls } = stubFetch(200, REPORT);
    await expect(fetchUsage()).resolves.toEqual(REPORT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/admin/usage');
    expect(calls[0]?.init.credentials).toBe('include');
    // A read is not a mutation: no method override, no CSRF header needed.
    expect(calls[0]?.init.method ?? 'GET').toBe('GET');
  });

  it('throws a UsageHttpError carrying the status and the server error string', async () => {
    stubFetch(403, { error: 'forbidden' });
    const err = await fetchUsage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageHttpError);
    expect((err as UsageHttpError).status).toBe(403);
    expect((err as UsageHttpError).serverError).toBe('forbidden');
    expect((err as UsageHttpError).message).toBe('forbidden');
  });

  it('falls back to a status-only message when the error body is not JSON', async () => {
    stubFetch(502, '<html>bad gateway</html>');
    const err = await fetchUsage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageHttpError);
    expect((err as UsageHttpError).status).toBe(502);
    expect((err as UsageHttpError).serverError).toBeUndefined();
    expect((err as UsageHttpError).message).toBe('usage request failed: 502');
  });

  it('refuses a 200 whose body is not a usage report (a proxy answering with something else)', async () => {
    stubFetch(200, { providers: [], agents: [] });
    const err = await fetchUsage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageHttpError);
    expect((err as UsageHttpError).serverError).toBe('unexpected-response');
  });
});

describe('putUsageLimits', () => {
  it('PUTs the two limits with the CSRF header and credentials, and returns the saved limits', async () => {
    const saved = { dailySpendUsd: 12.5, turnsPerHour: 90, assumedTurnCostUsd: 0.25 };
    const { calls } = stubFetch(200, { limits: saved });

    await expect(
      putUsageLimits({ dailySpendUsd: 12.5, turnsPerHour: 90 }),
    ).resolves.toEqual(saved);

    const call = calls[0]!;
    expect(call.url).toBe('/admin/usage/limits');
    expect(call.init.method).toBe('PUT');
    expect(call.init.credentials).toBe('include');
    expect(headersOf(call)['x-requested-with']).toBe('ax-admin');
    expect(headersOf(call)['content-type']).toBe('application/json');
    // The operator never edits the assumed turn cost from here, so it is not sent.
    expect(JSON.parse(call.init.body as string)).toEqual({
      dailySpendUsd: 12.5,
      turnsPerHour: 90,
    });
  });

  it('maps invalid-limits to a UsageHttpError with the server error string', async () => {
    stubFetch(400, { error: 'invalid-limits' });
    const err = await putUsageLimits({ dailySpendUsd: 0, turnsPerHour: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageHttpError);
    expect((err as UsageHttpError).status).toBe(400);
    expect((err as UsageHttpError).serverError).toBe('invalid-limits');
  });
});

describe('suspendUser', () => {
  const suspended = { at: '2026-09-29T10:00:00.000Z', by: 'admin-1', note: 'looping' };

  it('PUTs /admin/usage/users/:id/suspension with the note and returns the result', async () => {
    const { calls } = stubFetch(200, { suspended, interrupted: 2 });

    await expect(suspendUser('u1', 'looping')).resolves.toEqual({
      suspended,
      interrupted: 2,
    });

    const call = calls[0]!;
    expect(call.url).toBe('/admin/usage/users/u1/suspension');
    expect(call.init.method).toBe('PUT');
    expect(call.init.credentials).toBe('include');
    expect(headersOf(call)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse(call.init.body as string)).toEqual({ note: 'looping' });
  });

  it('sends an empty object, not an empty note, when there is no reason', async () => {
    const { calls } = stubFetch(200, {
      suspended: { ...suspended, note: null },
      interrupted: 0,
    });
    await suspendUser('u1', '   ');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({});
    await suspendUser('u1');
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({});
  });

  it('trims the note', async () => {
    const { calls } = stubFetch(200, { suspended, interrupted: 0 });
    await suspendUser('u1', '  looping  ');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ note: 'looping' });
  });

  it('encodes the user id so it cannot escape its path segment', async () => {
    const { calls } = stubFetch(200, { suspended, interrupted: 0 });
    await suspendUser('a/b c?d#e', undefined);
    expect(calls[0]?.url).toBe('/admin/usage/users/a%2Fb%20c%3Fd%23e/suspension');
  });

  it('maps cannot-suspend-self to a UsageHttpError', async () => {
    stubFetch(400, { error: 'cannot-suspend-self' });
    const err = await suspendUser('me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageHttpError);
    expect((err as UsageHttpError).serverError).toBe('cannot-suspend-self');
  });
});

describe('resumeUser', () => {
  it('DELETEs /admin/usage/users/:id/suspension with the CSRF header and credentials', async () => {
    const { calls } = stubFetch(200, { suspended: null });

    await expect(resumeUser('u 1')).resolves.toBeUndefined();

    const call = calls[0]!;
    expect(call.url).toBe('/admin/usage/users/u%201/suspension');
    expect(call.init.method).toBe('DELETE');
    expect(call.init.credentials).toBe('include');
    expect(headersOf(call)['x-requested-with']).toBe('ax-admin');
  });

  it('throws a UsageHttpError on failure', async () => {
    stubFetch(401, { error: 'unauthenticated' });
    const err = await resumeUser('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageHttpError);
    expect((err as UsageHttpError).status).toBe(401);
  });
});
