/**
 * Auth client — wraps `/api/auth/*` calls.
 *
 * Mirrors v1's `ui/chat/src/lib/auth.ts` shape so the channel-web mock
 * backend can hand-shake with the same endpoints. The mock middleware
 * (Task 4) honours `/api/auth/get-session`, `/api/auth/sign-in/social`,
 * and `/api/auth/sign-out`.
 *
 * Single-source-of-truth note: this is the only place in channel-web that
 * speaks to `/api/auth/*`. The auth gate in `App.tsx` calls `getSession`,
 * `LoginPage` calls `signInWithGoogle`, the user menu (Task 21) will call
 * `signOut`. Other callers should route through here.
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

export async function getSession(): Promise<AuthSession | null> {
  try {
    const res = await fetch('/api/auth/get-session', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.user ? data : null;
  } catch {
    return null;
  }
}

export async function signInWithGoogle(): Promise<void> {
  const res = await fetch('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
  });
  const data = await res.json();
  if (data?.url) window.location.href = data.url;
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
  window.location.reload();
}
