import type { OnboardingStore } from './store.js';
import type { BootstrapSessionStore } from './sessions.js';
import type { RateLimiter } from './rate-limit.js';
import { verifyToken } from './token.js';
import type { AgentContext, HookBus } from '@ax/core';
import { runCompletionTransaction } from './completion-tx.js';

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
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  header(name: string, value: string): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  body(buf: Buffer, contentType?: string): void;
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
  bus: HookBus;
  initCtx: AgentContext;
  /** Test seam — forwarded to runCompletionTransaction. Omit in production. */
  validationTimeoutMs?: number;
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
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

    async admin(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 1) Pre-completion gate (I11). Must precede the session-cookie
      // check: a post-completion request needs to see "wizard done" (410),
      // not "session expired" (401), or operators get a misleading signal.
      const row = await deps.store.read();
      if (row?.status === 'completed') {
        res.status(410).json({ error: 'wizard-complete' });
        return;
      }

      // 2) Verify bootstrap-session cookie (minted by /setup/claim).
      const sessionId = req.signedCookie(BOOTSTRAP_SESSION_COOKIE);
      if (sessionId === null || !deps.sessions.verify(sessionId)) {
        res.status(401).json({ error: 'no-bootstrap-session' });
        return;
      }

      // 2) Parse body. Phase 2 captures only { name, email } — password is
      // a Phase 3 concern (auth-better lands the local sign-in path).
      let parsed: unknown;
      try { parsed = JSON.parse(req.body.toString('utf8')); }
      catch { res.status(400).json({ error: 'invalid-json' }); return; }
      const { name, email } = (parsed ?? {}) as { name?: unknown; email?: unknown };
      if (typeof name !== 'string' || name.length === 0) {
        res.status(400).json({ error: 'missing-name' });
        return;
      }
      if (typeof email !== 'string' || !isValidEmail(email)) {
        res.status(400).json({ error: 'invalid-email' });
        return;
      }

      // 3) Call auth:create-bootstrap-user → oneTimeToken.
      const { oneTimeToken } = await deps.bus.call(
        'auth:create-bootstrap-user',
        deps.initCtx,
        { displayName: name, email },
      ) as { oneTimeToken: string };

      // 4) Call auth:complete-bootstrap-user → cookie payload.
      const { sessionCookie } = await deps.bus.call(
        'auth:complete-bootstrap-user',
        deps.initCtx,
        { oneTimeToken },
      ) as {
        sessionCookie: {
          name: string;
          value: string;
          opts: {
            path: string;
            sameSite: 'Lax' | 'Strict' | 'None';
            secure?: boolean;
            maxAge: number;
          };
        };
      };

      // 5) Swap cookies: clear bootstrap-session, set auth-session.
      deps.sessions.destroy(sessionId);
      res.clearCookie(BOOTSTRAP_SESSION_COOKIE, { path: '/setup', sameSite: 'Strict' });
      res.setSignedCookie(sessionCookie.name, sessionCookie.value, sessionCookie.opts);
      res.status(200).json({ next: '/setup/model' });
    },

    async model(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 1) Pre-completion gate (I11). Mirrors the claim handler.
      const row = await deps.store.read();
      if (row?.status === 'completed') {
        res.status(410).json({ error: 'wizard-complete' });
        return;
      }

      // 2) Auth gate via auth:require-user. The admin step minted an auth
      // session cookie; this route is no longer behind the bootstrap-session
      // cookie. Use the bus to fetch the user without re-implementing the
      // session validation.
      let user: { id: string; isAdmin: boolean };
      try {
        const out = await deps.bus.call(
          'auth:require-user',
          deps.initCtx,
          { req: req as unknown as { headers: Record<string, string>; signedCookie(n: string): string | null } },
        ) as { user: { id: string; isAdmin: boolean } };
        user = out.user;
      } catch {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }

      // 3) Body parse.
      let parsed: unknown;
      try { parsed = JSON.parse(req.body.toString('utf8')); }
      catch { res.status(400).json({ error: 'invalid-json' }); return; }
      const { apiKey, models } = (parsed ?? {}) as {
        apiKey?: unknown;
        models?: { fast?: unknown; default?: unknown };
      };
      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        res.status(400).json({ error: 'missing-apiKey' });
        return;
      }
      const fastModel =
        typeof models?.fast === 'string' ? models.fast : 'claude-haiku-4-5-20251001';
      const defaultModel =
        typeof models?.default === 'string' ? models.default : 'claude-sonnet-4-6';

      // 4) Run the completion transaction.
      const result = await runCompletionTransaction({
        bus: deps.bus,
        ctx: deps.initCtx,
        adminUserId: user.id,
        apiKey,
        fastModel,
        defaultModel,
        ...(deps.validationTimeoutMs !== undefined
          ? { timeoutMs: deps.validationTimeoutMs }
          : {}),
      });

      if (!result.ok) {
        // 200 with ok:false — preserves the wizard's UX where validation
        // failures are recoverable (operator can retry with a different key).
        res.status(200).json({ ok: false, reason: result.reason });
        return;
      }
      res.status(200).json({ ok: true, next: '/' });
    },
  };
}
