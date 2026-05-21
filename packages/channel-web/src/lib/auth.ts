/**
 * Auth client — wraps the auth-plugin wire surface (@ax/auth-better is
 * the only auth impl).
 *
 * Endpoints (host: ax-next serve, mounted via @ax/http-server):
 *   POST /auth/sign-in/social  — { provider: 'google' } → { url } to navigate to
 *   GET  /auth/callback/google — server-side; sets cookie + 302 to /
 *   GET  /admin/me             — returns { user: BackendUser } for the calling session
 *   POST /admin/sign-out       — clears cookie (idempotent)
 *
 * Wire-shape mapping: the backend's `User` (`{id, email, displayName,
 * isAdmin}`) is the shared boundary contract — @ax/auth-better
 * registers against this exact shape. We translate to the UI's
 * local `AuthUser` (`{id, email, name, role}`) here at the wire
 * boundary so the rest of channel-web doesn't have to track changes
 * to the backend type. If the backend adds a field, this file is the
 * only place that needs to know.
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
  // Treat empty/whitespace-only strings as missing — `??` would keep them
  // and render a blank avatar/menu name (e.g., empty displayName, or an
  // email like '@example.com' yielding an empty local-part). Trim first
  // so a cosmetic space doesn't slip through; `||` then walks past empty
  // strings and undefined alike.
  const displayName = u.displayName?.trim();
  const localPart = u.email?.split('@')[0]?.trim();
  return {
    id: u.id,
    email: u.email ?? '',
    // Bootstrap admins (created via the auth:create-bootstrap-user hook
    // with no body fields) have neither displayName nor email, so they
    // show as "Administrator" rather than the meaningless "unnamed".
    name:
      displayName ||
      localPart ||
      (u.isAdmin ? 'Administrator' : 'unnamed'),
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

export async function signInWithGoogle(): Promise<void> {
  // better-auth has no `GET /sign-in/google` route. Social sign-in is a
  // POST to `/auth/sign-in/social` carrying the provider in the body;
  // better-auth builds the Google authorize URL and hands it back as
  // `{ url }` for us to navigate to (it does NOT 302 the POST itself,
  // since the browser issued it via fetch). `callbackURL` is where
  // better-auth lands the user after `/auth/callback/google` completes.
  //
  // CSRF: send `X-Requested-With: ax-admin` like every other
  // state-changing call (see file header) so the http-server gate passes
  // regardless of origin.
  const res = await fetch('/auth/sign-in/social', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'ax-admin',
    },
    body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
  });
  if (!res.ok) {
    // Most likely the Google provider isn't configured (better-auth
    // returns 404 PROVIDER_NOT_FOUND) — surface it rather than navigate
    // to `undefined`. The LoginPage CTA is fire-and-forget, so a thrown
    // error just logs; there's no inline error surface yet.
    throw new Error(`social sign-in failed: HTTP ${res.status}`);
  }
  const { url } = (await res.json()) as { url?: string };
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('social sign-in response missing redirect url');
  }
  window.location.href = url;
}

export async function signOut(): Promise<void> {
  await fetch('/admin/sign-out', {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Requested-With': 'ax-admin' },
  });
  window.location.reload();
}
