import { reject, type Rejection } from '@ax/core';
import type { HttpMethod, HttpRequestEvent } from './types.js';

const STATE_CHANGING_METHODS: ReadonlySet<HttpMethod> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

const BYPASS_HEADER = 'x-requested-with';
const BYPASS_VALUE = 'ax-admin';

export type CsrfReason =
  | 'csrf-failed:origin-missing'
  | 'csrf-failed:origin-mismatch';

export interface CsrfGuardConfig {
  /** Exact-match allow-list. No wildcards; no URL parsing. */
  allowedOrigins: readonly string[];
}

/**
 * Pure decision function. Exposed for unit testing without booting a
 * server. Returns null when the request passes; a Rejection otherwise.
 *
 * Rule: GET/HEAD/OPTIONS pass. State-changing methods MUST EITHER carry
 * an `Origin` header in `allowedOrigins` OR `X-Requested-With: ax-admin`.
 */
export function evaluateCsrf(
  method: string,
  headers: Record<string, string>,
  config: CsrfGuardConfig,
): Rejection | null {
  if (!STATE_CHANGING_METHODS.has(method as HttpMethod)) return null;

  if (headers[BYPASS_HEADER] === BYPASS_VALUE) return null;

  const origin = headers['origin'];
  if (origin === undefined || origin.length === 0) {
    return reject({
      reason: 'csrf-failed:origin-missing',
      source: '@ax/http-server/csrf',
    });
  }
  // Exact-match only — Origin is `scheme://host[:port]` with no path or
  // trailing slash, so substring / prefix checks would only invite
  // bypass via lookalike hostnames (e.g. `https://attacker.com.evil`).
  for (const allowed of config.allowedOrigins) {
    if (origin === allowed) return null;
  }
  return reject({
    reason: 'csrf-failed:origin-mismatch',
    source: '@ax/http-server/csrf',
  });
}

/**
 * Build the http:request subscriber that enforces evaluateCsrf. The
 * subscriber returns a Rejection on violation; the http-server pipeline
 * already maps any reason starting with `csrf` to 403.
 *
 * `isBypassed`, if provided, lets the subscriber consult the router and
 * skip the check for routes registered with `bypassCsrf: true` (e.g.
 * external-receiver webhooks whose auth is a token in the path). The
 * lookup runs BEFORE `evaluateCsrf` so even no-Origin requests sail
 * through for those routes; everything else falls back to the standard
 * Origin / X-Requested-With rule.
 */
export function createCsrfSubscriber(
  config: CsrfGuardConfig,
  isBypassed?: (method: HttpMethod, path: string) => boolean,
) {
  return async (
    _ctx: unknown,
    payload: HttpRequestEvent,
  ): Promise<HttpRequestEvent | Rejection> => {
    if (isBypassed?.(payload.method, payload.path) === true) return payload;
    const verdict = evaluateCsrf(payload.method, payload.headers, config);
    return verdict ?? payload;
  };
}
