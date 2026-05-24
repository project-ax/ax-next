import { betterAuth } from 'better-auth';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from './migrations.js';
import { parseDomains, assertDomainAllowed, sessionTokenALS } from './session-bridge.js';

/**
 * Provider-row shape consumed by the handler factory. Mirrors the row
 * stored in `auth_providers` after decryption — `clientSecret` is the
 * decrypted plaintext, never the envelope. Callers (Task 1.5) are
 * responsible for unwrapping ciphertext before reaching this layer.
 *
 * `oidc` here is the generic-OAuth shape (any standards-compliant OIDC
 * provider with a discovery URL). Built-in better-auth providers like
 * `google` and `github` get first-class entries; `oidc` is wired through
 * a generic plugin in Task 1.4 — for this task it's just a passthrough
 * field on the social-providers map.
 */
export interface ProviderRow {
  kind: 'google' | 'github' | 'oidc';
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  /** Comma-separated list of allowed email domains for Google sign-in. Empty = open (all domains allowed). Populated by loadProviders() in plugin.ts. */
  allowedDomains?: string;
}

export interface HandlerInput {
  database: Kysely<AuthBetterDatabase>;
  providers: ProviderRow[];
  /**
   * Origins better-auth treats as trusted for sign-in / OAuth callback /
   * CSRF protection. When undefined, falls back to `['*']` for
   * test/dev-friendliness — production callers SHOULD pass a concrete
   * allow-list. Plumbed from `AuthBetterConfig.trustedOrigins`.
   */
  trustedOrigins?: string[];
  /**
   * Canonical public origin (e.g. `https://ax.example.com`) better-auth
   * uses to build OAuth redirect URIs and validate callbacks. When set,
   * `redirect_uri` is pinned to this origin regardless of the inbound
   * `Host` header — required so Google's configured callback matches even
   * when the server is reached via a non-canonical hostname. When
   * undefined, better-auth re-resolves the base URL per request from the
   * request origin (see the `betterAuth` call below). Plumbed from
   * `AX_PUBLIC_BASE_URL` in production via `AuthBetterConfig.baseURL`.
   */
  baseURL?: string;
  /**
   * Stable secret for OAuth state + at-rest OAuth-token encryption.
   * MUST be stable across restarts or encrypted tokens become undecryptable.
   * Plumbed from AX_AUTH_SECRET in production (Task 6).
   */
  secret?: string;
}

/**
 * The wrapper exposes a stable handle that the plugin holds for the
 * lifetime of the kernel; only the underlying handler instance swaps.
 * This is what gives us the runtime-swappable provider seam (I10) —
 * a provider CRUD edit calls `rebuild()` instead of bouncing the
 * process.
 */
export interface HandlerHandle {
  current(): (req: Request) => Promise<Response>;
  rebuild(input: HandlerInput): void;
  /**
   * Resolves when the CURRENT instance's better-auth adapter-init settles.
   *
   * better-auth resolves its database adapter asynchronously on the
   * `auth.$context` promise (a background query that introspects the schema
   * via the kysely adapter). If that query is left unawaited it can still be
   * in flight when the shared pg.Pool / Postgres testcontainer is torn down,
   * and the dying connection surfaces as `57P01` →
   * `BetterAuthError: Failed to initialize database adapter` (TASK-8: the
   * flaky full-suite teardown). Callers (the plugin's `init()`) await
   * `ready()` so the adapter is fully initialized before they report ready —
   * draining the background query so nothing races teardown, and surfacing a
   * genuine boot-time DB failure at boot instead of on the first request.
   *
   * Tracks the live instance: after a successful `rebuild()`, `ready()`
   * resolves on the NEW instance's adapter-init. A failed `rebuild()` keeps
   * the old instance and its (already-settled) readiness.
   */
  ready(): Promise<void>;
}

/** Internal: a built handler plus the better-auth `$context` adapter-init promise. */
interface BuiltHandler {
  handler: (req: Request) => Promise<Response>;
  /** better-auth's `auth.$context` — resolves when the adapter is initialized. */
  context: Promise<unknown>;
}

export function createBetterAuthHandler(input: HandlerInput): HandlerHandle {
  let built = build(input);
  return {
    current: () => built.handler,
    rebuild: (next: HandlerInput) => {
      // Build the new one BEFORE replacing — if construction throws,
      // the old instance keeps serving. This covers I10's "no kernel
      // bounce on provider edit" guarantee even when an admin saves a
      // typo'd config: requests in flight don't suddenly hit a broken
      // handler.
      try {
        built = build(next);
      } catch (err) {
        // Log and keep the old instance live. Phase 1.5 will surface
        // this back to the admin UI via the CRUD response so the user
        // sees the error inline; for now `console.error` is enough
        // because no one is calling rebuild() until that task lands.
        console.error(
          '[auth-better] handler rebuild failed; keeping previous instance',
          err,
        );
      }
    },
    // Await the LIVE instance's adapter-init. Read `built` lazily (inside the
    // thunk, not at closure-capture time) so a `rebuild()` between calls is
    // reflected.
    ready: () =>
      built.context.then(
        () => undefined,
        // Re-throw so the caller (init) sees a boot-time DB failure. The
        // .catch() inside build() prevents this same rejection from ALSO
        // becoming an unhandled rejection — ready() is the explicit await
        // seam; the swallow there is the safety net.
        (err) => {
          throw err;
        },
      ),
  };
}

function build(input: HandlerInput): BuiltHandler {
  // better-auth's `socialProviders` is a typed map keyed by built-in
  // provider names (google, github, …). We populate the keys we know;
  // `oidc` is not a built-in and gets wired through a generic plugin
  // in Task 1.4. For this task we erase to `Record<string, any>` so
  // the plan's three-kind switch compiles cleanly today and adapts
  // when generic-OAuth lands.
  const socialProviders: Record<string, unknown> = {};
  for (const p of input.providers) {
    if (p.kind === 'google') {
      socialProviders.google = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
      };
    } else if (p.kind === 'github') {
      socialProviders.github = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
      };
    } else if (p.kind === 'oidc') {
      // Placeholder — in Task 1.4 this becomes a `genericOAuth({...})`
      // plugin entry, not a socialProviders key. Leaving the field in
      // the map is harmless because better-auth ignores unknown keys.
      socialProviders.oidc = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        discoveryUrl: p.discoveryUrl,
      };
    }
  }

  const googleAllowedDomains = parseDomains(
    input.providers.find((p) => p.kind === 'google')?.allowedDomains,
  );

  const auth = betterAuth({
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
    // better-auth wants a `{ db, type }` wrapper when handed a Kysely
    // instance directly — passing the bare Kysely is the dialect path,
    // which we don't have here.
    database: { db: input.database, type: 'postgres' },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    // We mount @ax/http-server routes at `/auth/*` (sibling of `/admin/*`).
    // Better-auth's default basePath is `/api/auth`; override so its
    // internal router agrees with where we forward requests.
    basePath: '/auth',
    // baseURL pins the origin better-auth uses to build OAuth redirect
    // URIs and validate callbacks. When set (production: the preset wires
    // it from AX_PUBLIC_BASE_URL), redirect_uri is the canonical public
    // origin regardless of the inbound Host header — required so Google's
    // configured callback matches. When UNSET (local dev / tests, where
    // the OS-assigned port moves between boots), better-auth re-resolves
    // the base URL per request from the synthesized request URL's origin
    // (forwardToBetterAuth in plugin.ts builds it from the `Host` header +
    // `x-forwarded-proto`; better-auth ≥1.6 reads `request.url`'s origin,
    // not the bare `Host` header). In that unset case better-auth logs a
    // construction-time "Base URL could not be determined" warning — it's
    // benign because per-request resolution covers it; setting baseURL
    // silences it AND makes redirect_uri robust.
    ...(input.baseURL !== undefined ? { baseURL: input.baseURL } : {}),
    // `trustedOrigins` bounds which origins better-auth honors for
    // sign-in / OAuth callback / CSRF. Defaults to `['*']` so any
    // test-time host:port combo is accepted — production hosts SHOULD pin
    // via `AuthBetterConfig.trustedOrigins` (the preset sets it to the
    // AX_PUBLIC_BASE_URL origin).
    trustedOrigins: input.trustedOrigins ?? ['*'],
    socialProviders: socialProviders as Parameters<typeof betterAuth>[0]['socialProviders'],
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      modelName: 'auth_better_v1_sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'user' },
      },
      modelName: 'auth_better_v1_users',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'auth_better_v1_accounts',
      // OAuth tokens encrypted at rest. Requires a STABLE `secret` (input.secret,
      // plumbed from AX_AUTH_SECRET in the preset/chart) — without it better-auth
      // derives an ephemeral per-process key and tokens won't survive a restart.
      encryptOAuthTokens: true,
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'auth_better_v1_verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    advanced: { cookiePrefix: 'ax_better_auth' },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            // Gate runs ONLY during the Google OAuth callback — `googleAllowedDomains`
            // is parsed from the Google provider row, so checking any other provider's
            // callback (e.g. github) against it would mis-gate once others are wired.
            // better-auth's social callback path is `/callback/:providerId`.
            if (context?.path?.includes('/callback/google')) {
              assertDomainAllowed(String(user.email), googleAllowedDomains);
            }
            return { data: { ...user, role: 'user' } };
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            // Capture the session token minted by better-auth so plugin.ts's
            // forwardToBetterAuth can re-issue it as the http-server-signed
            // ax_auth_session cookie (keeping the ALS → cookie bridge intact).
            // Guard the type so a future better-auth shape change can't silently
            // write `undefined` into the box.
            const box = sessionTokenALS.getStore();
            const token = (session as { token?: string }).token;
            if (box && typeof token === 'string') box.token = token;
          },
        },
      },
    },
    // Rate-limit posture: token-bucket `/auth/*` at 30 requests / 60s /
    // source IP, unconditionally. Better-auth's built-in limiter ships:
    //   - production-only by default (gated on NODE_ENV === 'production')
    //   - global default 100 req / 10s (= 600/min) — too lax for /auth/*
    //   - special rules: 3 per 10s for /sign-in*, /sign-up*,
    //     /change-password, /change-email; 3 per 60s for
    //     /forget-password*, /request-password-reset,
    //     /send-verification-email
    //
    // We force `enabled: true` so dev/test environments get the same
    // gate (regression-safe — always-on posture), and pin window/max to
    // 60s/30 so the GLOBAL fallback for any /auth/* path without a
    // special-rule match (notably OAuth callbacks) is at least as
    // strict as 30/min. The built-in specialRules for
    // sign-in/sign-up/password-reset paths remain in force and are
    // stricter than 30/min — better posture, not worse. Storage is
    // memory (single-process, per-pod); multi-replica coordination is
    // deferred post-MVP.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: 'memory',
    },
  });

  // better-auth eagerly resolves its database adapter inside the
  // returned `$context` promise. If construction is otherwise valid
  // but the adapter init fails (e.g., the DB is unreachable at the
  // moment of rebuild), the promise rejects with no listener attached,
  // which surfaces as an unhandled rejection. Attach a no-op catch so
  // the wrapper holds the contract: "rebuild() never crashes the
  // process".
  //
  // We ALSO surface `$context` itself (via `HandlerHandle.ready()`) so the
  // plugin's `init()` can AWAIT this adapter-init before reporting ready.
  // Without that await the introspection query runs in the background,
  // unawaited, and can still be in flight when the shared pg.Pool / Postgres
  // testcontainer is torn down — the dying connection then surfaces as
  // `57P01` → `BetterAuthError: Failed to initialize database adapter`
  // (TASK-8's flaky full-suite teardown). Awaiting drains it. The `.catch()`
  // below stays as the safety net (so `ready()` going unawaited, or a
  // rebuild-side failure, never crashes the process); `ready()` re-throws
  // the SAME settled value to its caller, which is fine — both observers
  // share one promise.
  auth.$context.catch((err) => {
    console.error('[auth-better] adapter init deferred failure', err);
  });

  return { handler: auth.handler, context: auth.$context };
}
