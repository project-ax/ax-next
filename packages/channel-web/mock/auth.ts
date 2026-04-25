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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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

export function authMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/auth/')) return false;

    // Strip query for routing comparisons.
    const [path, query = ''] = url.split('?', 2);
    const method = req.method ?? 'GET';

    if (path === '/api/auth/get-session' && method === 'GET') {
      const user = requireSession(req, store);
      if (!user) {
        send(res, 401, {});
        return true;
      }
      send(res, 200, { user });
      return true;
    }

    if (path === '/api/auth/sign-in/social' && method === 'POST') {
      const body = (await readJsonBody(req)) as { callbackURL?: string };
      const callbackURL = body.callbackURL ?? '/';
      // Default mock user: u2 (Alice, regular user). Tests targeting admin
      // (u1) hit /api/auth/callback?user=u1 directly.
      const callback = `/api/auth/callback?user=u2&callbackURL=${encodeURIComponent(callbackURL)}`;
      send(res, 200, { url: callback });
      return true;
    }

    if (path === '/api/auth/callback' && method === 'GET') {
      const params = new URLSearchParams(query);
      const userId = params.get('user') ?? '';
      const callbackURL = params.get('callbackURL') ?? '/';
      const user = store.collection<User>('users').get(userId);
      if (!user) {
        send(res, 400, { error: 'unknown user' });
        return true;
      }
      send(res, 302, undefined, {
        'Set-Cookie': SET_COOKIE(user.id),
        Location: callbackURL,
      });
      return true;
    }

    if (path === '/api/auth/sign-out' && method === 'POST') {
      send(res, 204, undefined, { 'Set-Cookie': CLEAR_COOKIE });
      return true;
    }

    return false;
  };
}
