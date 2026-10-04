/**
 * Usage-and-limits wire client (TASK-692). Every route is admin-only and lives
 * in `@ax/usage-limits`:
 *
 *   GET    /admin/usage                         who used what, last 24h
 *   PUT    /admin/usage/limits                  change the two limits
 *   PUT    /admin/usage/users/:userId/suspension    pause a person's agents
 *   DELETE /admin/usage/users/:userId/suspension    resume them
 *
 * Posture mirrors `lib/branding.ts`:
 *  - `credentials: 'include'` so the auth cookie flows.
 *  - `x-requested-with: ax-admin` on every write so the CSRF guard accepts.
 *
 * This module is the wire and nothing else. What a status or an error code SAYS
 * to a person is the tab's job (`components/admin/UsageTab.tsx`).
 */

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/**
 * What the server accepts for the two limits. The tab checks against these
 * before it sends, so a typo gets a sentence at the field instead of a 400; the
 * server re-checks, and is the authority.
 */
export const USAGE_LIMIT_BOUNDS = {
  fleetDailySpendUsd: { min: 0.01, max: 1_000_000 },
  assumedTurnCostUsd: { min: 0, max: 100 },
  dailySpendUsd: { min: 0.01, max: 10_000 },
  /** Whole numbers only. */
  turnsPerHour: { min: 1, max: 100_000 },
} as const;

/** `near-limit` / `at-limit` / `suspended` are decided by the server, not here. */
export type UsageStatus = 'ok' | 'near-limit' | 'at-limit' | 'suspended';

export interface UsageLimits {
  dailySpendUsd: number;
  fleetDailySpendUsd: number;
  turnsPerHour: number;
  /** What the host charges for a turn that reports no usage, or that ends abnormally. */
  assumedTurnCostUsd: number;
}

/** What the tab may change. The workspace cap and the assumed turn cost are optional; omitted means unchanged. */
export interface UsageLimitsInput {
  dailySpendUsd: number;
  turnsPerHour: number;
  fleetDailySpendUsd?: number;
  assumedTurnCostUsd?: number;
}

export interface UsageSuspension {
  /** ISO timestamp. */
  at: string;
  /** User id of the admin who paused them. */
  by: string;
  note: string | null;
}

export interface UsageUser {
  userId: string;
  displayName: string | null;
  email: string | null;
  turnsLastHour: number;
  turnsLast24h: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  spendUsd: number;
  status: UsageStatus;
  suspended: UsageSuspension | null;
  overrides?: UserLimitsInput | null;
  limits?: UsageLimits;
}

export interface UsageReport {
  windowHours: number;
  /** True when the server cut the list short (it sends the biggest users). */
  truncated: boolean;
  limits: UsageLimits;
  totals: { turns: number; spendUsd: number; users: number };
  users: UsageUser[];
  prices?: ModelPrice[];
  fleetBlocked?: boolean;
}

export interface SuspendResult {
  suspended: UsageSuspension;
  /** How many in-flight turns the server stopped. */
  interrupted: number;
}

/**
 * A non-2xx answer. `serverError` is the server's `{ error }` string when it
 * sent one (`invalid-limits`, `cannot-suspend-self`, …) — a code for the UI to
 * translate, not a sentence to print.
 */
export class UsageHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverError?: string,
  ) {
    super(
      serverError !== undefined && serverError.length > 0
        ? serverError
        : `usage request failed: ${status}`,
    );
    this.name = 'UsageHttpError';
  }
}

async function failure(res: Response): Promise<UsageHttpError> {
  let serverError: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') serverError = body.error;
  } catch {
    // non-JSON error body — fall back to the status-only message
  }
  return new UsageHttpError(res.status, serverError);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function fetchUsage(): Promise<UsageReport> {
  const res = await fetch('/admin/usage', { credentials: 'include' });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  // A 200 that is not a usage report (a proxy or an older server answering
  // with something else) must not reach the renderer, which reads `.users`.
  if (
    !isRecord(body) ||
    !Array.isArray(body['users']) ||
    !isRecord(body['limits']) ||
    !isRecord(body['totals'])
  ) {
    throw new UsageHttpError(res.status, 'unexpected-response');
  }
  return body as unknown as UsageReport;
}

export async function putUsageLimits(input: UsageLimitsInput): Promise<UsageLimits> {
  const res = await fetch('/admin/usage/limits', {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    // Spelled out field by field so an extra property on `input` never rides
    // along — the assumed turn cost is not ours to send.
    body: JSON.stringify({
      dailySpendUsd: input.dailySpendUsd,
      turnsPerHour: input.turnsPerHour,
      ...(input.fleetDailySpendUsd === undefined
        ? {}
        : { fleetDailySpendUsd: input.fleetDailySpendUsd }),
      ...(input.assumedTurnCostUsd === undefined
        ? {}
        : { assumedTurnCostUsd: input.assumedTurnCostUsd }),
    }),
  });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { limits: UsageLimits };
  return body.limits;
}

function suspensionUrl(userId: string): string {
  return `/admin/usage/users/${encodeURIComponent(userId)}/suspension`;
}

export async function suspendUser(userId: string, note?: string): Promise<SuspendResult> {
  const trimmed = note?.trim() ?? '';
  const res = await fetch(suspensionUrl(userId), {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(trimmed.length > 0 ? { note: trimmed } : {}),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as SuspendResult;
}

export async function resumeUser(userId: string): Promise<void> {
  const res = await fetch(suspensionUrl(userId), {
    method: 'DELETE',
    headers: writeHeaders,
    credentials: 'include',
  });
  if (!res.ok) throw await failure(res);
}

export interface UserLimitsInput {
  dailySpendUsd?: number;
  turnsPerHour?: number;
}
export interface ModelPrice {
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
}
export async function putUserLimits(userId: string, input: UserLimitsInput | null): Promise<void> {
  const res = await fetch(`/admin/usage/users/${encodeURIComponent(userId)}/limits`, {
    method: input === null ? 'DELETE' : 'PUT',
    credentials: 'include',
    headers: writeHeaders,
    ...(input === null ? {} : { body: JSON.stringify(input) }),
  });
  if (!res.ok) throw await failure(res);
}
export async function putModelPrices(prices: ModelPrice[]): Promise<ModelPrice[]> {
  const res = await fetch('/admin/usage/prices', {
    method: 'PUT',
    credentials: 'include',
    headers: writeHeaders,
    body: JSON.stringify({ prices }),
  });
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { prices: ModelPrice[] }).prices;
}
export interface PersonalUsage {
  spendUsd: number;
  turnsLastHour: number;
  limits: UsageLimits;
  status: UsageStatus;
}
export async function fetchOwnUsage(): Promise<PersonalUsage> {
  const res = await fetch('/api/usage', {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  if (!isRecord(body) || !isRecord(body['limits']) ||
      ![body['spendUsd'], body['turnsLastHour'], body['limits']['dailySpendUsd'], body['limits']['turnsPerHour']].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
    throw new UsageHttpError(200, 'unexpected-response');
  }
  return body as unknown as PersonalUsage;
}
