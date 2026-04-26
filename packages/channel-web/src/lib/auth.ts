/**
 * Auth client — wraps the @ax/auth-oidc wire surface.
 *
 * Endpoints (host: ax-next serve, mounted via @ax/http-server):
 *   GET  /auth/sign-in/google  — server 302-redirects to Google OIDC
 *   GET  /auth/callback/google — server-side; sets cookie + 302 to /
 *   GET  /admin/me             — returns { user: BackendUser } for the calling session
 *   POST /admin/sign-out       — clears cookie (idempotent)
 *
 * Wire-shape mapping: the backend's `User` (`{id, email, displayName,
 * isAdmin}`) is the boundary contract owned by `@ax/auth-oidc`. We
 * translate to the UI's local `AuthUser` (`{id, email, name, role}`)
 * here at the wire boundary so the rest of channel-web doesn't have to
 * track changes to the backend type. If the backend adds a field, this
 * file is the only place that needs to know.
 *
 * CSRF: state-changing requests (POST/PUT/PATCH/DELETE) need either an
 * allow-listed Origin header or `X-Requested-With: ax-admin`. We send
 * the latter so the UI can run from any allowed origin without CSRF
 * config churn.
 *
 * Same-origin assumption: the UI is served from the same origin as the
 * API (or a Vite/proxy that forwards `/auth/*` and `/admin/*` upstream).
 * Cookies are HttpOnly + Secure-when-https + SameSite=Lax — the browser
 * sends them automatically on same-origin fetches with credentials:'include'.
 */

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
}

export interface AuthSession {
  user: AuthUser;
}

interface BackendUser {
  id: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

function toAuthUser(u: BackendUser): AuthUser {
  return {
    id: u.id,
    email: u.email ?? '',
    // displayName falls back to email's local-part, then to a generic
    // label. The avatar/initial in UserMenu derives from this string.
    name: u.displayName ?? u.email?.split('@')[0] ?? 'unnamed',
    role: u.isAdmin ? 'admin' : 'user',
  };
}

export async function getSession(): Promise<AuthSession | null> {
  try {
    const res = await fetch('/admin/me', { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: BackendUser };
    if (!data.user) return null;
    return { user: toAuthUser(data.user) };
  } catch {
    return null;
  }
}

export function signInWithGoogle(): void {
  // Synchronous nav — server 302-redirects to Google. The fetch+JSON
  // exchange the v1 UI used was needed when better-auth synthesized the
  // authorize URL server-side and returned it; openid-client builds the
  // URL in the route handler and emits the redirect itself.
  window.location.href = '/auth/sign-in/google';
}

export async function signOut(): Promise<void> {
  await fetch('/admin/sign-out', {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Requested-With': 'ax-admin' },
  });
  window.location.reload();
}
