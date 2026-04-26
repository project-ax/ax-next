import {
  makeChatContext,
  PluginError,
  type ChatContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import {
  bootstrapUserViaHook,
  createAuthRouteHandlers,
  type RouteRequest,
  type RouteResponse,
} from './admin-routes.js';
import { runAuthMigration, type AuthDatabase } from './migrations.js';
import {
  createOidcHandshake,
  type OidcHandshake,
  type OidcProviderConfig,
} from './oidc.js';
import { createRateLimiter } from './rate-limit.js';
import { isProduction } from './dev-bootstrap.js';
import { createAuthStore, type AuthStore } from './store.js';
import type {
  AuthConfig,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  GetUserInput,
  GetUserOutput,
  HttpRequestLike,
  RequireUserInput,
  RequireUserOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/auth';
const DEFAULT_SESSION_COOKIE_NAME = 'ax_auth_session';
const DEFAULT_SESSION_LIFETIME_SECS = 7 * 24 * 60 * 60; // 7 days
const RATE_LIMIT_TOKENS_PER_MIN = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// @ax/auth plugin — Task 4 lights up Task 3's scaffolding.
//
// What's new vs. Task 3:
//   - Real impls for auth:require-user, auth:get-user, auth:create-bootstrap-user
//   - Four /auth/* routes registered via http:register-route
//   - In-memory token-bucket rate-limit subscriber on http:request,
//     scoped to /auth/* paths only
//
// Half-wired check (CLAUDE.md policy): every code path created here is
// reachable from the route or the hook. No "wire later" stubs survive.
//
// Manifest changes vs. Task 3: adds the two subscriber hooks we now FIRE
// (auth:user-signed-in, auth:user-signed-out). We do NOT register a
// service for them; observers add subscribers.
// ---------------------------------------------------------------------------

/**
 * Task 4 plugin entry. `config` carries the OIDC + dev-bootstrap settings;
 * env-driven construction is provided by `loadAuthConfigFromEnv`.
 */
export function createAuthPlugin(config: AuthConfig = { providers: {} }): Plugin {
  let db: Kysely<AuthDatabase> | undefined;
  let store: AuthStore | undefined;
  const handshakes = new Map<string, OidcHandshake>();
  const unregisterRoutes: Array<() => void> = [];

  const sessionCookieName = config.sessionCookieName ?? DEFAULT_SESSION_COOKIE_NAME;
  const sessionLifetimeSeconds =
    config.sessionLifetimeSeconds ?? DEFAULT_SESSION_LIFETIME_SECS;

  // Config validation is deferred to init() — `createPlugin()` shouldn't
  // throw, since some test harnesses construct first and hand off to
  // bootstrap later. The deferred init throws map cleanly to a
  // PluginError that callers can catch.
  const hasGoogle = config.providers?.google !== undefined;
  const hasBootstrap = config.devBootstrap !== undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'auth:require-user',
        'auth:get-user',
        'auth:create-bootstrap-user',
      ],
      calls: ['database:get-instance', 'http:register-route'],
      // We FIRE auth:user-signed-in / auth:user-signed-out (subscriber
      // hooks). Per the manifest convention (mirrors Task 3 comment),
      // `subscribes` is for hooks the plugin LISTENS to — observers
      // subscribe at their end, not ours. We do subscribe internally to
      // http:request for the rate-limit guard, but plugin-internal
      // subscribers (matching @ax/http-server's CSRF subscriber pattern)
      // don't form bootstrap dependency edges.
      subscribes: [],
    },

    async init({ bus }) {
      if (!hasGoogle && !hasBootstrap) {
        throw new PluginError({
          code: 'no-auth-providers',
          plugin: PLUGIN_NAME,
          message:
            'configure at least one of providers.google or devBootstrap',
        });
      }
      if (hasBootstrap && isProduction()) {
        throw new PluginError({
          code: 'dev-bootstrap-in-production',
          plugin: PLUGIN_NAME,
          message:
            'devBootstrap is refused when NODE_ENV=production; remove it from auth config',
        });
      }

      const initCtx = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      // 1) DB + migration ------------------------------------------------
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      db = shared as Kysely<AuthDatabase>;
      await runAuthMigration(db);
      store = createAuthStore(db);
      const localStore = store; // freeze for closure

      // 2) OIDC handshakes (one Issuer.discover per configured provider) -
      if (config.providers?.google !== undefined) {
        const cfg: OidcProviderConfig = config.providers.google;
        const handshake = await createOidcHandshake({
          providerKey: 'google',
          config: cfg,
        });
        handshakes.set('google', handshake);
      }

      // 3) Rate limiter --------------------------------------------------
      const rateLimiter = createRateLimiter({
        tokensPerWindow: RATE_LIMIT_TOKENS_PER_MIN,
        windowMs: RATE_LIMIT_WINDOW_MS,
        matchPath: (p) => p.startsWith('/auth/'),
      });
      bus.subscribe('http:request', `${PLUGIN_NAME}/rate-limit`, async (
        _ctx,
        payload: { method: string; path: string; headers: Record<string, string> },
      ) => {
        const verdict = rateLimiter.check(payload.headers, payload.path);
        return verdict ?? payload;
      });

      // 4) Route handlers ------------------------------------------------
      const handlers = createAuthRouteHandlers({
        bus,
        initCtx,
        store: localStore,
        sessionCookieName,
        sessionLifetimeSeconds,
        handshakes,
        devBootstrapToken: config.devBootstrap?.token ?? null,
      });

      // 5) Register routes via http:register-route ------------------------
      // Provider routes are registered for each enabled provider; the
      // router is exact-match (no `:provider` params), so we mount one
      // literal path per provider.
      for (const providerKey of handshakes.keys()) {
        unregisterRoutes.push(
          await registerRoute(bus, initCtx, {
            method: 'GET',
            path: `/auth/sign-in/${providerKey}`,
            handler: async (req, res) =>
              handlers.signIn(providerKey, asRouteReq(req), asRouteRes(res)),
          }),
        );
        unregisterRoutes.push(
          await registerRoute(bus, initCtx, {
            method: 'GET',
            path: `/auth/callback/${providerKey}`,
            handler: async (req, res) =>
              handlers.callback(providerKey, asRouteReq(req), asRouteRes(res)),
          }),
        );
      }

      unregisterRoutes.push(
        await registerRoute(bus, initCtx, {
          method: 'POST',
          path: '/auth/sign-out',
          handler: async (req, res) =>
            handlers.signOut(asRouteReq(req), asRouteRes(res)),
        }),
      );

      // /admin/sign-out is a thin alias for /auth/sign-out — same handler,
      // same idempotent semantics. Keeps every `/admin/*` route consistent
      // for the bootstrap CLI and Week 10-12 UI without duplicating logic.
      unregisterRoutes.push(
        await registerRoute(bus, initCtx, {
          method: 'POST',
          path: '/admin/sign-out',
          handler: async (req, res) =>
            handlers.signOut(asRouteReq(req), asRouteRes(res)),
        }),
      );

      // /admin/me — minimum identity probe for the calling session. 401
      // if no cookie, 200 `{user}` otherwise. The store call is cheap and
      // the route is the auth gate (no auth:require-user round-trip).
      unregisterRoutes.push(
        await registerRoute(bus, initCtx, {
          method: 'GET',
          path: '/admin/me',
          handler: async (req, res) =>
            handlers.me(asRouteReq(req), asRouteRes(res)),
        }),
      );

      unregisterRoutes.push(
        await registerRoute(bus, initCtx, {
          method: 'POST',
          path: '/auth/dev-bootstrap',
          handler: async (req, res) =>
            handlers.devBootstrap(asRouteReq(req), asRouteRes(res)),
        }),
      );

      // 6) Service hooks -------------------------------------------------
      bus.registerService<RequireUserInput, RequireUserOutput>(
        'auth:require-user',
        PLUGIN_NAME,
        async (_ctx, input) => requireUser(localStore, sessionCookieName, input.req),
      );

      bus.registerService<GetUserInput, GetUserOutput>(
        'auth:get-user',
        PLUGIN_NAME,
        async (_ctx, input) => localStore.getUserById(input.userId),
      );

      bus.registerService<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
        'auth:create-bootstrap-user',
        PLUGIN_NAME,
        async (_ctx, input) =>
          bootstrapUserViaHook(localStore, sessionLifetimeSeconds, input),
      );
    },

    async shutdown() {
      // Routes hold a closure over the DB and handshakes; unregister so a
      // re-init in tests doesn't trip duplicate-route. Idempotent.
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
      handshakes.clear();
      db = undefined;
      store = undefined;
    },
  };
}

async function requireUser(
  store: AuthStore,
  sessionCookieName: string,
  req: HttpRequestLike,
): Promise<RequireUserOutput> {
  const sessionId = req.signedCookie(sessionCookieName);
  if (sessionId === null) {
    // PluginError thrown inside a service handler is the kernel's
    // documented rejection shape — bus.call catches and re-raises with
    // code preserved. Callers `try { await bus.call('auth:require-user',
    // …) } catch (e) { if (e.code === 'unauthenticated') … }`.
    throw new PluginError({
      code: 'unauthenticated',
      plugin: PLUGIN_NAME,
      hookName: 'auth:require-user',
      message: 'no session cookie',
    });
  }
  const user = await store.resolveSessionUser(sessionId);
  if (user === null) {
    throw new PluginError({
      code: 'unauthenticated',
      plugin: PLUGIN_NAME,
      hookName: 'auth:require-user',
      message: 'session unknown or expired',
    });
  }
  return { user };
}

// ---------------------------------------------------------------------------
// Adapters between @ax/http-server's HttpRequest / HttpResponse and the
// structurally-defined RouteRequest / RouteResponse in admin-routes.ts.
//
// These are identity casts at runtime — the structural shape is identical.
// We re-declare the types here only so admin-routes.ts can stay free of
// any @ax/http-server dependency (Invariant I2).
// ---------------------------------------------------------------------------

interface AnyHttpReq {
  headers: Record<string, string>;
  body: Buffer;
  cookies: Record<string, string>;
  query: Record<string, string>;
  signedCookie(name: string): string | null;
}
interface AnyHttpRes {
  status(n: number): unknown;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
  redirect(url: string, status?: number): void;
  setSignedCookie(name: string, value: string, opts?: unknown): void;
  clearCookie(name: string, opts?: unknown): void;
}

function asRouteReq(req: AnyHttpReq): RouteRequest {
  return req as RouteRequest;
}
function asRouteRes(res: AnyHttpRes): RouteResponse {
  return res as RouteResponse;
}

async function registerRoute(
  bus: HookBus,
  initCtx: ChatContext,
  input: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: AnyHttpReq, res: AnyHttpRes) => Promise<void>;
  },
): Promise<() => void> {
  const result = await bus.call<unknown, { unregister: () => void }>(
    'http:register-route',
    initCtx,
    input,
  );
  return result.unregister;
}

