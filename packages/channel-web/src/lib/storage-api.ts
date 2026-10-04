/**
 * Storage wire client (TASK-690, TASK-777). Four routes, in two plugins.
 *
 * `@ax/disk-quota`:
 *
 *   GET /settings/storage         the signed-in person's own usage (anyone)
 *   GET /admin/storage            the two limits and the biggest owners (admin)
 *   PUT /admin/storage/limits     change the two limits (admin)
 *
 * `@ax/blob-gc` (report-only: nothing is removed yet):
 *
 *   GET /admin/storage/cleanup    how many files nobody uses any more, and how
 *                                 much room they take (admin). The body also
 *                                 carries the sweep settings; the tab reads
 *                                 none of that, so this client keeps none of it.
 *
 * Posture mirrors `lib/usage-admin.ts`:
 *  - `credentials: 'include'` so the auth cookie flows.
 *  - `x-requested-with: ax-admin` on the write so the CSRF guard accepts.
 *
 * This module is the wire and nothing else. What a status or an error code SAYS
 * to a person is `lib/storage-copy.ts`'s job; layout is the tab's.
 */

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/**
 * What the server accepts for the two limits (1 MB = 1,048,576 bytes). The form
 * checks against these before it sends, so a typo gets a sentence at the field
 * instead of a 400; the server re-checks, and is the authority. The same
 * numbers arrive on `GET /admin/storage` as `bounds`; a test pins the two
 * together.
 */
export const STORAGE_LIMIT_BOUNDS = {
  limitMb: { min: 64, max: 10_485_760 },
  warnPercent: { min: 1, max: 99 },
} as const;

/** 1 MB, as the server counts it. */
export const BYTES_PER_MB = 1_048_576;

/** Decided by the server, never here. */
export type StorageStatus = 'ok' | 'near-limit' | 'full';

/** The signed-in person's own reading. Bytes are whole numbers. */
export interface MyStorage {
  usedBytes: number;
  limitBytes: number;
  /** The point where the "getting full" notice starts. */
  warnBytes: number;
  /** The agent's own files ("agent files"). */
  workspaceBytes: number;
  /** Uploads and published files. */
  fileBytes: number;
  status: StorageStatus;
}

export interface StorageLimits {
  limitMb: number;
  warnPercent: number;
}

/** What the form may change. Either field alone is fine. */
export interface StorageLimitsInput {
  limitMb?: number;
  warnPercent?: number;
}

export interface StorageOwner {
  /** A person's user id, or `team:<id>`. Shown only when nothing friendlier exists. */
  ownerId: string;
  kind: 'person' | 'team';
  displayName: string | null;
  email: string | null;
  usedBytes: number;
  workspaceBytes: number;
  fileBytes: number;
  status: StorageStatus;
}

export interface AdminStorage {
  limits: StorageLimits;
  defaults: StorageLimits;
  bounds: {
    limitMb: { min: number; max: number };
    warnPercent: { min: number; max: number };
  };
  /** The biggest owners first. May be shorter than `ownerCount`. */
  owners: StorageOwner[];
  ownerCount: number;
  totalBytes: number;
}

/**
 * The last finished sweep's answer to "what could be cleaned up?", cut down to
 * what the Storage tab shows. Nothing has been removed: these are the files
 * that WOULD go once removal is switched on.
 */
export interface UnusedFilesReport {
  /** When that sweep finished (an ISO time). */
  at: string;
  /** How many files nobody uses any more. */
  wouldRetire: number;
  /** How much room they take, in bytes. */
  wouldRetireBytes: number;
}

/** `report` is `null` until the first sweep has finished (they run hourly). */
export interface UnusedFiles {
  report: UnusedFilesReport | null;
}

/**
 * A non-2xx answer. `serverError` is the server's `{ error }` string when it
 * sent one (`invalid-limits`, `forbidden`, …) — a code for the UI to
 * translate, not a sentence to print. `unexpected-response` is ours: a 200
 * whose body was not what the contract says.
 */
export class StorageHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverError?: string,
  ) {
    super(
      serverError !== undefined && serverError.length > 0
        ? serverError
        : `storage request failed: ${status}`,
    );
    this.name = 'StorageHttpError';
  }
}

async function failure(res: Response): Promise<StorageHttpError> {
  let serverError: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') serverError = body.error;
  } catch {
    // non-JSON error body — fall back to the status-only message
  }
  return new StorageHttpError(res.status, serverError);
}

function unexpected(res: Response): StorageHttpError {
  return new StorageHttpError(res.status, 'unexpected-response');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isMyStorage(body: unknown): body is MyStorage {
  return (
    isRecord(body) &&
    isNumber(body['usedBytes']) &&
    isNumber(body['limitBytes']) &&
    isNumber(body['warnBytes']) &&
    isNumber(body['workspaceBytes']) &&
    isNumber(body['fileBytes']) &&
    typeof body['status'] === 'string'
  );
}

function isLimits(v: unknown): v is StorageLimits {
  return isRecord(v) && isNumber(v['limitMb']) && isNumber(v['warnPercent']);
}

function isOwner(v: unknown): v is StorageOwner {
  return (
    isRecord(v) &&
    typeof v['ownerId'] === 'string' &&
    isNumber(v['usedBytes']) &&
    isNumber(v['workspaceBytes']) &&
    isNumber(v['fileBytes']) &&
    typeof v['status'] === 'string'
  );
}

function isAdminStorage(body: unknown): body is AdminStorage {
  return (
    isRecord(body) &&
    isLimits(body['limits']) &&
    Array.isArray(body['owners']) &&
    body['owners'].every(isOwner) &&
    isNumber(body['ownerCount']) &&
    isNumber(body['totalBytes'])
  );
}

function isUnusedFilesReport(v: unknown): v is UnusedFilesReport {
  return (
    isRecord(v) &&
    typeof v['at'] === 'string' &&
    isNumber(v['wouldRetire']) &&
    isNumber(v['wouldRetireBytes'])
  );
}

export async function fetchMyStorage(): Promise<MyStorage> {
  const res = await fetch('/settings/storage', { credentials: 'include' });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  // A 200 that is not a reading (a proxy, an older server answering with
  // something else) must not reach the renderer, which does arithmetic on it.
  if (!isMyStorage(body)) throw unexpected(res);
  return body;
}

export async function fetchAdminStorage(): Promise<AdminStorage> {
  const res = await fetch('/admin/storage', { credentials: 'include' });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  if (!isAdminStorage(body)) throw unexpected(res);
  return body;
}

export async function fetchUnusedFiles(): Promise<UnusedFiles> {
  const res = await fetch('/admin/storage/cleanup', { credentials: 'include' });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  // `report` is `null` or a report. A body with no `report` at all is not the
  // contract, and "nothing found yet" would be a false thing to say about it.
  if (!isRecord(body)) throw unexpected(res);
  const report = body['report'];
  if (report === null) return { report: null };
  if (!isUnusedFilesReport(report)) throw unexpected(res);
  // Only what the line shows rides on: the rest of the body (settings, the
  // per-holder counts) is not ours to depend on.
  return {
    report: {
      at: report.at,
      wouldRetire: report.wouldRetire,
      wouldRetireBytes: report.wouldRetireBytes,
    },
  };
}

export async function putStorageLimits(
  input: StorageLimitsInput,
): Promise<StorageLimits> {
  // Spelled out field by field: an extra property on `input` never rides along,
  // and a field left out stays as the server has it (another admin may have
  // just changed it).
  const payload: StorageLimitsInput = {};
  if (input.limitMb !== undefined) payload.limitMb = input.limitMb;
  if (input.warnPercent !== undefined) payload.warnPercent = input.warnPercent;
  const res = await fetch('/admin/storage/limits', {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  if (!isRecord(body) || !isLimits(body['limits'])) throw unexpected(res);
  return body['limits'];
}
