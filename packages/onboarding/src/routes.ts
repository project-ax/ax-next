import type { OnboardingStore } from './store.js';
import type { BootstrapSessionStore } from './sessions.js';
import type { RateLimiter } from './rate-limit.js';
import { verifyToken } from './token.js';

// ---------------------------------------------------------------------------
// HTTP route handlers for /setup/*.
//
// Routes are registered against @ax/http-server via http:register-route in
// plugin.init. Handlers receive the http-server's `req`/`res` adapters — we
// duck-type the surface here (Invariant I2 — no @ax/http-server import).
// ---------------------------------------------------------------------------

/**
 * Handler-side request shape. Identical to @ax/http-server's HttpRequest
 * minus the import (Invariant I2). Re-declared structurally so a future
 * non-HTTP adapter could provide it.
 */
export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
  redirect(url: string, status?: number): void;
  setSignedCookie(
    name: string,
    value: string,
    opts?: {
      maxAge?: number;
      path?: string;
      sameSite?: 'Lax' | 'Strict' | 'None';
      secure?: boolean;
    },
  ): void;
  clearCookie(
    name: string,
    opts?: {
      path?: string;
      sameSite?: 'Lax' | 'Strict' | 'None';
      secure?: boolean;
    },
  ): void;
}

const BOOTSTRAP_SESSION_COOKIE = 'ax_bootstrap_session';
const BOOTSTRAP_SESSION_TTL_MS = 10 * 60_000;

export interface OnboardingRouteHandlerDeps {
  store: OnboardingStore;
  sessions: BootstrapSessionStore;
  rateLimit: RateLimiter;
}

export function createOnboardingRouteHandlers(deps: OnboardingRouteHandlerDeps) {
  return {
    async claim(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 1) Pre-completion gate (I11).
      const row = await deps.store.read();
      if (row?.status === 'completed') {
        res.status(410).json({ error: 'wizard-complete' });
        return;
      }

      // 2) Per-IP rate-limit.
      const rl = deps.rateLimit.check(req.headers, '/setup/claim');
      if (rl !== null) {
        res.status(429).json({ error: 'rate-limited' });
        return;
      }

      // 3) Body parse + token shape.
      let parsed: unknown;
      try { parsed = JSON.parse(req.body.toString('utf8')); }
      catch { res.status(400).json({ error: 'invalid-json' }); return; }
      const token = (parsed as { token?: unknown } | null)?.token;
      if (typeof token !== 'string' || token.length === 0) {
        res.status(400).json({ error: 'missing-token' });
        return;
      }

      // 4) Constant-time verify (I7).
      if (row === null || !(await verifyToken(token, row.token_hash))) {
        // No state mutation on bad token — avoids a status-pending oracle.
        res.status(401).json({ error: 'invalid-token' });
        return;
      }

      // 5) Atomic CAS (I6).
      const claim = await deps.store.claim();
      if (!claim.ok) {
        res.status(410).json({ error: 'already-claimed' });
        return;
      }

      // 6) Mint bootstrap-session cookie scoped to /setup/* only.
      const sessionId = deps.sessions.create(BOOTSTRAP_SESSION_TTL_MS);
      res.setSignedCookie(BOOTSTRAP_SESSION_COOKIE, sessionId, {
        path: '/setup',
        sameSite: 'Strict',
        // Set Max-Age slightly less than TTL so the browser drops it
        // before the in-memory record expires — avoids serving an
        // expired cookie.
        maxAge: Math.floor(BOOTSTRAP_SESSION_TTL_MS / 1000),
      });
      res.status(200).json({ next: '/setup/admin' });
    },
  };
}
