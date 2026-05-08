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
const BOOTSTRAP_SESSION_TTL_MS = 10 * 60_000;        // 10 minutes — wizard completion budget.
// 30s shorter than the in-memory record so the browser stops sending the
// cookie before the server expires it. Avoids the dead-cookie window where
// the client thinks it's authenticated but the next /setup/* request sees
// expired session.
const BOOTSTRAP_COOKIE_MAX_AGE_S = (10 * 60) - 30;   // 570 seconds.

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
      // Token-bucket consumes on every matched request, including the
      // successful claim. That's intentional on a single-use surface: after
      // the first successful claim, every subsequent /setup/claim returns 410
      // from the pre-completion gate (step 1) anyway, so the consumed-on-
      // success token has no observable effect. Keeps the rate-limit code
      // path simple — no conditional record-on-failure ceremony needed.
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
        maxAge: BOOTSTRAP_COOKIE_MAX_AGE_S,
      });
      res.status(200).json({ next: '/setup/admin' });
    },
  };
}
