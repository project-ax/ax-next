import type { ChatContext, HookBus } from '@ax/core';
import { constantTimeTokenEquals, isProduction } from './dev-bootstrap.js';
import {
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_MAX_AGE_SECS,
  OidcCallbackError,
  type OidcHandshake,
} from './oidc.js';
import type { AuthStore } from './store.js';
import type { User } from './types.js';

// ---------------------------------------------------------------------------
// HTTP route handlers for /auth/*.
//
// Routes are registered against @ax/http-server via http:register-route in
// plugin.init. Handlers receive the http-server's `req`/`res` adapters — we
// duck-type the surface here (Invariant I2 — no @ax/http-server import).
//
// IMPORTANT logging discipline: when an OIDC callback fails, we log ONLY
// `auth_callback_failed` with `provider` + `error.code`. The raw OPError
// can carry user-controlled fields (state, error_description echoes); none
// of that ever hits a log call. A grep for `error.message` in this file
// should return zero matches.
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

export interface RouteHandlerDeps {
  bus: HookBus;
  initCtx: ChatContext;
  store: AuthStore;
  sessionCookieName: string;
  sessionLifetimeSeconds: number;
  /** Handshakes keyed by URL `:provider` slug ('google'). */
  handshakes: Map<string, OidcHandshake>;
  /** Token from AX_DEV_BOOTSTRAP_TOKEN, or null when dev-bootstrap is disabled. */
  devBootstrapToken: string | null;
}

const PLUGIN_NAME = '@ax/auth-oidc';

/**
 * Build the four /auth/* handlers. Returned as a record so `plugin.init`
 * can map them to `http:register-route` calls without re-stating wire
 * shape.
 */
export function createAuthRouteHandlers(deps: RouteHandlerDeps) {
  return {
    /** GET /auth/sign-in/:provider */
    async signIn(
      providerKey: string,
      _req: RouteRequest,
      res: RouteResponse,
    ): Promise<void> {
      const handshake = deps.handshakes.get(providerKey);
      if (handshake === undefined) {
        res.status(404).json({ error: 'unknown-provider' });
        return;
      }
      const { authUrl, cookieValue } = handshake.begin();
      res.setSignedCookie(OIDC_STATE_COOKIE, cookieValue, {
        maxAge: OIDC_STATE_COOKIE_MAX_AGE_SECS,
        sameSite: 'Lax',
        path: '/',
      });
      res.redirect(authUrl, 302);
    },

    /** GET /auth/callback/:provider */
    async callback(
      providerKey: string,
      req: RouteRequest,
      res: RouteResponse,
    ): Promise<void> {
      const query = req.query;
      const handshake = deps.handshakes.get(providerKey);
      if (handshake === undefined) {
        res.status(404).json({ error: 'unknown-provider' });
        return;
      }
      const cookieValue = req.signedCookie(OIDC_STATE_COOKIE);
      // Always clear the state cookie before the handler returns — single-
      // use, regardless of success or failure.
      res.clearCookie(OIDC_STATE_COOKIE, { path: '/', sameSite: 'Lax' });

      try {
        const claims = await handshake.finish({
          callbackParams: query,
          cookieValue,
        });
        const existing = await deps.store.findUserByProviderSubject(
          handshake.authProvider,
          claims.subjectId,
        );
        const user =
          existing ??
          (await deps.store.createUser({
            provider: handshake.authProvider,
            subjectId: claims.subjectId,
            email: claims.email,
            displayName: claims.displayName,
            isAdmin: false,
          }));
        const sessionId = await deps.store.createSession(
          user.id,
          new Date(Date.now() + deps.sessionLifetimeSeconds * 1000),
        );
        res.setSignedCookie(deps.sessionCookieName, sessionId, {
          maxAge: deps.sessionLifetimeSeconds,
          path: '/',
          sameSite: 'Lax',
        });
        // Subscribers (audit) get a payload that intentionally omits the
        // session_id. Tokens never leak through hook returns (Invariant I9).
        await deps.bus.fire('auth:user-signed-in', deps.initCtx, {
          userId: user.id,
          provider: handshake.authProvider,
        });
        res.redirect('/', 302);
      } catch (err) {
        // CRITICAL — NEVER log err.message here. Some IdP errors
        // include user-controlled `state` / `error_description` strings
        // that would taint our structured logs. Only the code is safe.
        const code = err instanceof OidcCallbackError ? err.code : 'callback-failed';
        deps.initCtx.logger.warn('auth_callback_failed', {
          plugin: PLUGIN_NAME,
          provider: handshake.authProvider,
          code,
        });
        res.status(400).json({ error: 'callback-failed' });
      }
    },

    /**
     * GET /admin/me — returns `{ user: User }` for the calling session, or
     * 401 if no/forged/expired cookie. Mirrors the auth:require-user shape
     * but goes direct to the store; the route is the auth gate, not a
     * subscriber. Idempotent + safe to call repeatedly.
     */
    async me(req: RouteRequest, res: RouteResponse): Promise<void> {
      const sessionId = req.signedCookie(deps.sessionCookieName);
      if (sessionId === null) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const user = await deps.store.resolveSessionUser(sessionId);
      if (user === null) {
        // Session unknown / expired / reaped. Same shape as no-cookie so
        // the client gets one error path to handle.
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      res.status(200).json({ user });
    },

    /**
     * POST /auth/sign-out — and POST /admin/sign-out (same handler, both
     * paths registered in plugin.ts to keep all `/admin/*` namespacing
     * consistent). CSRF enforced by @ax/http-server's built-in subscriber.
     */
    async signOut(req: RouteRequest, res: RouteResponse): Promise<void> {
      const sessionId = req.signedCookie(deps.sessionCookieName);
      // Idempotent: an absent / forged cookie still returns 200 (we don't
      // want a sign-out endpoint to differentiate between authed and
      // unauthed callers — it would be a session-existence oracle).
      if (sessionId !== null) {
        // Best-effort lookup so the audit subscriber gets a userId; if
        // the session is gone (e.g. expired and reaped), we still clear.
        const user = await deps.store.resolveSessionUser(sessionId);
        await deps.store.deleteSession(sessionId);
        if (user !== null) {
          await deps.bus.fire('auth:user-signed-out', deps.initCtx, {
            userId: user.id,
          });
        }
      }
      res.clearCookie(deps.sessionCookieName, { path: '/', sameSite: 'Lax' });
      res.status(200).json({ ok: true });
    },

    /** POST /auth/dev-bootstrap (NODE_ENV=production → 404). */
    async devBootstrap(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 404, not 401 — production callers shouldn't even learn the path
      // exists. Same posture for an entirely-disabled config (no token).
      if (isProduction() || deps.devBootstrapToken === null) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      const body = parseJsonBody(req.body);
      if (body === null) {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      const token = typeof body.token === 'string' ? body.token : '';
      if (!constantTimeTokenEquals(token, deps.devBootstrapToken)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const displayName =
        typeof body.displayName === 'string' && body.displayName.length > 0
          ? body.displayName
          : null;
      const email =
        typeof body.email === 'string' && body.email.length > 0
          ? body.email
          : null;
      const { user, created } = await deps.store.upsertBootstrapAdmin({
        displayName,
        email,
      });
      const sessionId = await deps.store.createSession(
        user.id,
        new Date(Date.now() + deps.sessionLifetimeSeconds * 1000),
      );
      res.setSignedCookie(deps.sessionCookieName, sessionId, {
        maxAge: deps.sessionLifetimeSeconds,
        path: '/',
        sameSite: 'Lax',
      });
      await deps.bus.fire('auth:user-signed-in', deps.initCtx, {
        userId: user.id,
        provider: 'dev-bootstrap',
      });
      // `isNew` mirrors the store's `created` flag — the CLI uses it to
      // distinguish first-run from idempotent re-run so it can print
      // `bootstrap_already_done`. Backend-agnostic name (no row/insert
      // vocabulary) so an alternate auth-store impl can keep the same
      // wire shape.
      res.status(200).json({ user, isNew: created });
    },
  };
}

function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Used by the auth:create-bootstrap-user hook in plugin.ts. */
export async function bootstrapUserViaHook(
  store: AuthStore,
  sessionLifetimeSeconds: number,
  input: { displayName: string; email?: string },
): Promise<{ user: User; oneTimeToken: string }> {
  const { user } = await store.upsertBootstrapAdmin({
    displayName: input.displayName.length > 0 ? input.displayName : null,
    email: input.email !== undefined && input.email.length > 0 ? input.email : null,
  });
  const sessionId = await store.createSession(
    user.id,
    new Date(Date.now() + sessionLifetimeSeconds * 1000),
  );
  return { user, oneTimeToken: sessionId };
}
