/**
 * Auth providers wire client — typed wrappers around `/admin/auth/providers/*`.
 *
 * The route handlers live in `@ax/auth-better` (see `plugin.ts:670-784`).
 * Secrets are stripped server-side on read; the UI never sees `clientSecret`
 * after submit.
 *
 * Wire posture matches `lib/admin.ts` and `lib/providers.ts`:
 *   - `credentials: 'include'` on every call so the auth-better cookie flows
 *   - `x-requested-with: ax-admin` on writes so requests pass the
 *     http-server's CSRF guard
 */

export type AuthProviderKind = 'google' | 'github' | 'oidc';

export interface AuthProviderEntry {
  kind: AuthProviderKind;
  clientId: string;
  discoveryUrl: string | null;
  allowedDomains: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAuthProviderInput {
  kind: AuthProviderKind;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  allowedDomains?: string;
}

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

export async function listAuthProviders(): Promise<AuthProviderEntry[]> {
  const res = await fetch('/admin/auth/providers', {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`list auth providers: ${res.status}`);
  const body = (await res.json()) as { providers: AuthProviderEntry[] };
  return body.providers;
}

export async function upsertAuthProvider(input: UpsertAuthProviderInput): Promise<void> {
  const res = await fetch('/admin/auth/providers', {
    method: 'POST',
    credentials: 'include',
    headers: writeHeaders,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(message || `upsert auth provider: ${res.status}`);
  }
}

export async function setAuthProviderEnabled(
  kind: AuthProviderKind,
  enabled: boolean,
): Promise<void> {
  const res = await fetch(`/admin/auth/providers/${encodeURIComponent(kind)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: writeHeaders,
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(message || `set auth provider enabled: ${res.status}`);
  }
}

export async function deleteAuthProvider(kind: AuthProviderKind): Promise<void> {
  const res = await fetch(`/admin/auth/providers/${encodeURIComponent(kind)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'x-requested-with': 'ax-admin' },
  });
  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(message || `delete auth provider: ${res.status}`);
  }
}
