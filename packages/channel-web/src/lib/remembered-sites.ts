/**
 * Remembered sites wire client (TASK-406) — typed wrappers around
 * `/api/chat/remembered-sites`, the Settings mirror of `web_extract`'s
 * per-host "read this page without asking" approval.
 *
 * Mirrors `lib/connections.ts`'s posture: `credentials: 'include'` so the
 * auth cookie rides along; the state-changing DELETE carries
 * `x-requested-with: ax-admin` so it passes @ax/http-server's CSRF gate. The
 * server forces the owner from the auth cookie — these calls never send a
 * user id.
 *
 * A `scope: 'global'` entry was pre-approved by the deployment's admin for
 * everyone; the server refuses to revoke one (`{ revoked: false }`) rather
 * than erroring, since asking for it back is not a request error — the panel
 * uses that outcome to say so rather than offering a button it would reject.
 */
import { HttpError, httpFetch } from './http';

const csrfHeader = { 'x-requested-with': 'ax-admin' } as const;

export interface RememberedSite {
  host: string;
  scope: 'global' | 'user';
  rememberedAt: string;
}

/**
 * Every site `web_extract` may read without asking — this user's grants plus
 * any admin-set global ones.
 *
 * RESOLVING IS THE ONLY WAY THIS SAYS "THE LIST IS EMPTY" (TASK-464). A
 * non-200 throws, and the server now answers 503 when the allowlist could not
 * be read at all, so a caller can never mistake a failed read for a short one.
 * The corollary is a rule for callers: a rejection means UNKNOWN, and a
 * surface that renders it as "nothing allowed" has put the bug back.
 */
export async function listRememberedSites(): Promise<RememberedSite[]> {
  const res = await httpFetch('/api/chat/remembered-sites', { credentials: 'include' });
  if (!res.ok) throw new HttpError('/api/chat/remembered-sites', res.status);
  const body = (await res.json()) as { sites: RememberedSite[] };
  return body.sites;
}

/**
 * Forget a remembered host, restoring the ask-first prompt for it. Returns
 * whether a row was actually revoked — `false` covers both "already gone"
 * and "that host is a global grant, not this user's to revoke" (the server
 * never errors for the latter; it just declines).
 */
export async function forgetRememberedSite(host: string): Promise<{ revoked: boolean }> {
  const res = await httpFetch(`/api/chat/remembered-sites/${encodeURIComponent(host)}`, {
    method: 'DELETE',
    headers: csrfHeader,
    credentials: 'include',
  });
  if (!res.ok) throw new HttpError('/api/chat/remembered-sites', res.status);
  return (await res.json()) as { revoked: boolean };
}
