import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
}

const COOKIE_NAME = 'mock-session';

// Mock-only: real backend ships HttpOnly per @ax/auth security checklist.
const SET_COOKIE = (id: string) =>
  `${COOKIE_NAME}=${id}; Path=/; SameSite=Lax`;
const CLEAR_COOKIE = `${COOKIE_NAME}=; Path=/; Max-Age=0`;

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(/;\s*/)) {
    const [k, v] = part.split('=');
    if (k === name) return v;
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  if (body === undefined) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload);
}

export function requireSession(req: IncomingMessage, store: Store): User | null {
  const id = readCookie(req, COOKIE_NAME);
  if (!id) return null;
  const user = store.collection<User>('users').get(id);
  return user ?? null;
}

// Admin gate: returns the user on success, or { status: 401 | 403 } on failure.
// 401 = no session at all; 403 = session but not admin role. The distinction
// matters because the UI surfaces them differently (sign-in prompt vs forbidden).
export function requireAdmin(
  req: IncomingMessage,
  store: Store,
): User | { status: 401 | 403 } {
  const user = requireSession(req, store);
  if (!user) return { status: 401 };
  if (user.role !== 'admin') return { status: 403 };
  return user;
}

// ACL helper: an agent is usable if the caller owns it (personal) or is a
// member of the team that owns it. Lives here (the auth/ACL home) so both
// chat.ts and the user-scoped /api/agents endpoint share a single source.
interface AclAgent {
  id: string;
  owner_id: string;
  owner_type: 'user' | 'team';
}

interface AclTeam {
  id: string;
  name: string;
  members: string[];
}

export function canUseAgent(user: User, agent: AclAgent, store: Store): boolean {
  if (agent.owner_type === 'user') return agent.owner_id === user.id;
  if (agent.owner_type === 'team') {
    const team = store.collection<AclTeam>('teams').get(agent.owner_id);
    return !!team && team.members.includes(user.id);
  }
  return false;
}

/**
 * Translate the mock store's UI-shaped User to the BackendUser wire
 * shape `@ax/auth-oidc` returns from /admin/me. Mirrors `lib/auth.ts`'s
 * inverse mapping so the UI's wire client and this mock agree on the
 * boundary contract.
 */
interface BackendUser {
  id: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

function toBackendUser(u: User): BackendUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.name,
    isAdmin: u.role === 'admin',
  };
}

export function authMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    const [pathRaw, query = ''] = url.split('?', 2);
    const path = pathRaw ?? '';
    const method = req.method ?? 'GET';

    // Mock the @ax/auth-oidc wire surface (NOT the v1 better-auth shape):
    //   GET  /auth/sign-in/google
    //   GET  /auth/callback/google
    //   GET  /admin/me
    //   POST /admin/sign-out
    // Plus a mock-only `/auth/mock/google-callback` that stands in for
    // Google's redirect — Vite dev never reaches the real Google.

    // ---- Session readback --------------------------------------------------
    if (path === '/admin/me' && method === 'GET') {
      const user = requireSession(req, store);
      if (!user) {
        send(res, 401, { error: 'unauthenticated' });
        return true;
      }
      send(res, 200, { user: toBackendUser(user) });
      return true;
    }

    // ---- Sign-in (sync redirect, mirrors the real backend) -----------------
    if (path === '/auth/sign-in/google' && method === 'GET') {
      // Real backend hands off to Google; the mock skips ahead to the
      // post-callback step. Default to user u2 (Alice, regular user);
      // override via ?user=<id> for admin testing.
      const params = new URLSearchParams(query);
      const userId = params.get('user') ?? 'u2';
      send(res, 302, undefined, {
        Location: `/auth/mock/google-callback?user=${encodeURIComponent(userId)}`,
      });
      return true;
    }

    // ---- Mock callback: sets cookie, redirects to / -----------------------
    if (path === '/auth/mock/google-callback' && method === 'GET') {
      const params = new URLSearchParams(query);
      const userId = params.get('user') ?? '';
      const user = store.collection<User>('users').get(userId);
      if (!user) {
        send(res, 400, { error: 'unknown user' });
        return true;
      }
      send(res, 302, undefined, {
        'Set-Cookie': SET_COOKIE(user.id),
        Location: '/',
      });
      return true;
    }

    // ---- Sign-out (POST, idempotent, CSRF inherited from real backend) ----
    if (path === '/admin/sign-out' && method === 'POST') {
      // Real backend would reject without `Origin` allow-list match OR
      // `X-Requested-With: ax-admin`. Mock honours the same rule for
      // posture parity — the UI sends X-Requested-With.
      const xrw = req.headers['x-requested-with'];
      if (xrw !== 'ax-admin') {
        send(res, 403, { error: 'csrf-failed' });
        return true;
      }
      send(res, 204, undefined, { 'Set-Cookie': CLEAR_COOKIE });
      return true;
    }

    // ---- Backwards-compat: keep /api/auth/* alive during migration --------
    // Tests / external scripts that still poke the v1 paths get a 410 so
    // the failure is loud and trivially greppable. Drop this block once
    // all callers are off the old wire.
    if (path.startsWith('/api/auth/')) {
      send(res, 410, {
        error: 'gone',
        message:
          '/api/auth/* moved to /auth/* + /admin/me — see packages/channel-web/src/lib/auth.ts',
      });
      return true;
    }

    return false;
  };
}

