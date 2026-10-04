import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  STORAGE_LIMIT_BOUNDS,
  StorageHttpError,
  fetchAdminStorage,
  fetchMyStorage,
  fetchUnusedFiles,
  putStorageLimits,
  type AdminStorage,
  type MyStorage,
} from '../storage-api';

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

const MINE: MyStorage = {
  usedBytes: 2_469_606_195,
  limitBytes: 5_368_709_120,
  warnBytes: 4_294_967_296,
  workspaceBytes: 2_000_000_000,
  fileBytes: 469_606_195,
  status: 'ok',
};

const ADMIN: AdminStorage = {
  limits: { limitMb: 1024, warnPercent: 80 },
  defaults: { limitMb: 1024, warnPercent: 80 },
  bounds: {
    limitMb: { min: 64, max: 10_485_760 },
    warnPercent: { min: 1, max: 99 },
  },
  owners: [
    {
      ownerId: 'u1',
      kind: 'person',
      displayName: 'Sam Chen',
      email: 'sam@example.co',
      usedBytes: 900_000_000,
      workspaceBytes: 800_000_000,
      fileBytes: 100_000_000,
      status: 'near-limit',
    },
    {
      ownerId: 'team:t1',
      kind: 'team',
      displayName: null,
      email: null,
      usedBytes: 10,
      workspaceBytes: 10,
      fileBytes: 0,
      status: 'ok',
    },
  ],
  ownerCount: 2,
  totalBytes: 900_000_010,
};

describe('STORAGE_LIMIT_BOUNDS', () => {
  it('mirrors the bounds the server publishes on GET /admin/storage', () => {
    // The form checks against these before it sends. If the server moves its
    // bounds and this does not follow, the form refuses (or lets through) a
    // number the server disagrees with. The fixture above is the contract.
    expect(STORAGE_LIMIT_BOUNDS).toEqual(ADMIN.bounds);
  });
});

describe('fetchMyStorage', () => {
  it('reads GET /settings/storage with the session cookie and returns the body', async () => {
    const { calls } = stubFetch(200, MINE);
    await expect(fetchMyStorage()).resolves.toEqual(MINE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/settings/storage');
    expect(calls[0]!.init.credentials).toBe('include');
    // A read is not a write: it must not claim to be an admin action.
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
  });

  it('throws a StorageHttpError carrying the status and the server code', async () => {
    stubFetch(401, { error: 'unauthenticated' });
    const err = await fetchMyStorage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageHttpError);
    expect((err as StorageHttpError).status).toBe(401);
    expect((err as StorageHttpError).serverError).toBe('unauthenticated');
  });

  it('survives a non-JSON error body and still knows the status', async () => {
    stubFetch(502, '<html>bad gateway</html>');
    const err = (await fetchMyStorage().catch((e: unknown) => e)) as StorageHttpError;
    expect(err).toBeInstanceOf(StorageHttpError);
    expect(err.status).toBe(502);
    expect(err.serverError).toBeUndefined();
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a list', []],
    ['a string where a number belongs', { ...MINE, usedBytes: '12' }],
    ['a missing limit', { ...MINE, limitBytes: undefined }],
    ['a non-finite number', { ...MINE, workspaceBytes: null }],
  ])('refuses a 200 that is not a storage reading: %s', async (_name, body) => {
    stubFetch(200, body);
    const err = (await fetchMyStorage().catch((e: unknown) => e)) as StorageHttpError;
    expect(err).toBeInstanceOf(StorageHttpError);
    expect(err.serverError).toBe('unexpected-response');
  });
});

describe('fetchAdminStorage', () => {
  it('reads GET /admin/storage with the session cookie and returns the body', async () => {
    const { calls } = stubFetch(200, ADMIN);
    await expect(fetchAdminStorage()).resolves.toEqual(ADMIN);
    expect(calls[0]!.url).toBe('/admin/storage');
    expect(calls[0]!.init.credentials).toBe('include');
  });

  it('turns a 403 into a StorageHttpError with the server code', async () => {
    stubFetch(403, { error: 'forbidden' });
    const err = (await fetchAdminStorage().catch((e: unknown) => e)) as StorageHttpError;
    expect(err.status).toBe(403);
    expect(err.serverError).toBe('forbidden');
  });

  it.each([
    ['no owners list', { ...ADMIN, owners: undefined }],
    ['no limits', { ...ADMIN, limits: undefined }],
    ['limits with text where a number belongs', { ...ADMIN, limits: { limitMb: 'a lot', warnPercent: 80 } }],
    ['no total', { ...ADMIN, totalBytes: undefined }],
    ['an owner row that is not a record', { ...ADMIN, owners: [null] }],
    ['an owner row with no id', { ...ADMIN, owners: [{ ...ADMIN.owners[0], ownerId: undefined }] }],
    ['an owner row with text bytes', { ...ADMIN, owners: [{ ...ADMIN.owners[0], usedBytes: 'lots' }] }],
  ])('refuses a 200 that is not a storage report: %s', async (_name, body) => {
    stubFetch(200, body);
    const err = (await fetchAdminStorage().catch((e: unknown) => e)) as StorageHttpError;
    expect(err).toBeInstanceOf(StorageHttpError);
    expect(err.serverError).toBe('unexpected-response');
  });
});

describe('putStorageLimits', () => {
  it('PUTs to /admin/storage/limits with the JSON header, the CSRF header and the cookie', async () => {
    const { calls } = stubFetch(200, { limits: { limitMb: 2048, warnPercent: 80 } });
    const saved = await putStorageLimits({ limitMb: 2048 });
    expect(saved).toEqual({ limitMb: 2048, warnPercent: 80 });
    expect(calls[0]!.url).toBe('/admin/storage/limits');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(headersOf(calls[0]!)['x-requested-with']).toBe('ax-admin');
    expect(headersOf(calls[0]!)['content-type']).toBe('application/json');
  });

  it('sends only the fields it was given, so it never overwrites the one it did not touch', async () => {
    const { calls } = stubFetch(200, { limits: { limitMb: 2048, warnPercent: 80 } });
    await putStorageLimits({ limitMb: 2048 });
    await putStorageLimits({ warnPercent: 90 });
    await putStorageLimits({ limitMb: 512, warnPercent: 70 });
    expect(calls.map((c) => JSON.parse(c.init.body as string))).toEqual([
      { limitMb: 2048 },
      { warnPercent: 90 },
      { limitMb: 512, warnPercent: 70 },
    ]);
  });

  it('does not let an extra property on the input ride along', async () => {
    const { calls } = stubFetch(200, { limits: { limitMb: 2048, warnPercent: 80 } });
    await putStorageLimits({ limitMb: 2048, sneaky: true } as never);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ limitMb: 2048 });
  });

  it.each([
    [400, 'invalid-limits'],
    [400, 'invalid-json'],
    [413, 'body-too-large'],
    [403, 'forbidden'],
    [401, 'unauthenticated'],
  ])('throws StorageHttpError(%i, %s) with the code intact', async (status, code) => {
    stubFetch(status, { error: code });
    const err = (await putStorageLimits({ limitMb: 100 }).catch((e: unknown) => e)) as StorageHttpError;
    expect(err).toBeInstanceOf(StorageHttpError);
    expect(err.status).toBe(status);
    expect(err.serverError).toBe(code);
  });

  it('refuses a 200 with no limits in it rather than reporting a save it cannot show', async () => {
    stubFetch(200, { ok: true });
    const err = (await putStorageLimits({ limitMb: 100 }).catch((e: unknown) => e)) as StorageHttpError;
    expect(err).toBeInstanceOf(StorageHttpError);
    expect(err.serverError).toBe('unexpected-response');
  });
});

/*
  TASK-777. `GET /admin/storage/cleanup` is served by `@ax/blob-gc`, not
  `@ax/disk-quota`, and answers with far more than the tab reads (the settings,
  their defaults and bounds, the per-holder counts). The client keeps only what
  the one line needs, and checks that much.
*/
describe('fetchUnusedFiles', () => {
  const CLEANUP = {
    settings: { mode: 'report', graceMs: 86_400_000, retentionMs: 604_800_000 },
    defaults: { mode: 'report', graceMs: 86_400_000, retentionMs: 604_800_000 },
    bounds: { graceMs: { min: 1, max: 2 }, retentionMs: { min: 1, max: 2 } },
    report: {
      at: '2026-10-04T10:00:00.000Z',
      mode: 'report',
      discovered: 40,
      candidates: 20,
      held: 8,
      wouldRetire: 12,
      wouldRetireBytes: 123_456,
      perHolder: { '@ax/attachments': 3 },
    },
  };

  it('reads GET /admin/storage/cleanup with the session cookie and keeps only what the line needs', async () => {
    const { calls } = stubFetch(200, CLEANUP);
    await expect(fetchUnusedFiles()).resolves.toEqual({
      report: { at: '2026-10-04T10:00:00.000Z', wouldRetire: 12, wouldRetireBytes: 123_456 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/admin/storage/cleanup');
    expect(calls[0]!.init.credentials).toBe('include');
    // A read is not a write: it must not claim to be an admin action.
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
  });

  it('answers with no report before the first complete sweep', async () => {
    stubFetch(200, { ...CLEANUP, report: null });
    await expect(fetchUnusedFiles()).resolves.toEqual({ report: null });
  });

  it('throws a StorageHttpError carrying the status and the server code', async () => {
    stubFetch(403, { error: 'forbidden' });
    const err = (await fetchUnusedFiles().catch((e: unknown) => e)) as StorageHttpError;
    expect(err).toBeInstanceOf(StorageHttpError);
    expect(err.status).toBe(403);
    expect(err.serverError).toBe('forbidden');
  });

  it('survives a non-JSON error body and still knows the status', async () => {
    stubFetch(502, '<html>bad gateway</html>');
    const err = (await fetchUnusedFiles().catch((e: unknown) => e)) as StorageHttpError;
    expect(err).toBeInstanceOf(StorageHttpError);
    expect(err.status).toBe(502);
    expect(err.serverError).toBeUndefined();
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a list', []],
    ['no report key at all', { settings: CLEANUP.settings }],
    ['a report that is not a record', { ...CLEANUP, report: 'later' }],
    ['a report with no count', { ...CLEANUP, report: { ...CLEANUP.report, wouldRetire: undefined } }],
    ['a count that is text', { ...CLEANUP, report: { ...CLEANUP.report, wouldRetire: '12' } }],
    ['a size that is text', { ...CLEANUP, report: { ...CLEANUP.report, wouldRetireBytes: '1 KB' } }],
    ['a size that is null', { ...CLEANUP, report: { ...CLEANUP.report, wouldRetireBytes: null } }],
    ['no time', { ...CLEANUP, report: { ...CLEANUP.report, at: undefined } }],
    ['a time that is a number', { ...CLEANUP, report: { ...CLEANUP.report, at: 1_700_000_000 } }],
  ])('refuses a 200 that is not a cleanup report: %s', async (_name, body) => {
    stubFetch(200, body);
    const err = (await fetchUnusedFiles().catch((e: unknown) => e)) as StorageHttpError;
    expect(err).toBeInstanceOf(StorageHttpError);
    expect(err.serverError).toBe('unexpected-response');
  });
});
