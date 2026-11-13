import { betterAuth } from 'better-auth';
import type { BetterAuthPlugin } from 'better-auth';
import type { Kysely } from 'kysely';
import type { AuthBetterDatabase } from './migrations.js';
import { createIdentityGate } from './identity-gate.js';
import { sessionTokenALS } from './session-bridge.js';

/**
 * Refuses a request whose Host header was malformed with a fixed 400
 * `{"error":"malformed-host"}`. forwardToBetterAuth (plugin.ts) flags it in the
 * request's async-local box; the client can't set or clear that flag.
 *
 * It answers from `onRequest` because of where better-auth 1.7.7 runs that
 * hook: the router's `onRequest` checks disabled paths, then the schema, then
 * the rate limiter, then each plugin's `onRequest` (`dist/api/index.mjs`). So a
 * refused request is counted by the limiter like any other auth request, and
 * the endpoint never runs. Over the limit, Better Auth answers its own 429 and
 * this never runs. malformed-host-rate-limit.test.ts pins that order: a Better
 * Auth upgrade that reorders it goes red there.
 */
const refuseMalformedHost: BetterAuthPlugin = {
  id: 'ax-refuse-malformed-host',
  onRequest: async () => {
    const box = sessionTokenALS.getStore();
    if (box?.malformedHost !== true) return;
    box.refused = true;
    // A fresh Response per refusal: a body can be read only once.
    return { response: Response.json({ error: 'malformed-host' }, { status: 400 }) };
  },
};

/**
 * Provider-row shape consumed by the handler factory. Mirrors the row
 * stored in `auth_providers` after decryption — `clientSecret` is the
 * decrypted plaintext, never the envelope. Callers (Task 1.5) are
 * responsible for unwrapping ciphertext before reaching this layer.
 *
 * Only the two kinds better-auth is wired for. A generic `oidc` kind was
 * once offered by the admin form but never wired (better-auth rejects an
 * unknown social-provider key, so a saved one took every sign-in down);
 * loadProviders() in plugin.ts skips any other kind (TASK-1116).
 */
export interface ProviderRow {
  kind: 'google' | 'github';
  clientId: string;
  clientSecret: string;
  /**
   * Comma-separated email domains this provider may let in, for sign-up and
   * sign-in. Empty = any account at the provider. Enforced in identity-gate.ts.
   * Populated by loadProviders() in plugin.ts.
   */
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
  // provider names. We populate the two ax wires, one entry per row, on a
  // plain record that's cast once at the call below.
  const socialProviders: Record<string, unknown> = {};
  for (const p of input.providers) {
    if (p.kind === 'google') {
      socialProviders.google = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        // The login page uses the redirect flow. An ID token posted by a client
        // to /sign-in/social skipped every check (TASK-1116), so that door is shut.
        disableIdTokenSignIn: true,
      };
    } else if (p.kind === 'github') {
      socialProviders.github = {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
      };
    }
  }

  const auth = betterAuth({
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
    // better-auth wants a `{ db, type }` wrapper when handed a Kysely
    // instance directly — passing the bare Kysely is the dialect path,
    // which we don't have here.
    database: { db: input.database, type: 'postgres' },
    // Off on purpose (TASK-1116). A typed email proves nothing without a
    // verification mail, and we send none, so email sign-up let anyone make an
    // account and pre-claim a teammate's email before their first Google
    // sign-in. Nothing uses it: the setup wizard's admin has no password, and
    // the login page is Google-only. `enabled: false` turns password sign-IN
    // off too, so a password someone set before the fix no longer works.
    emailAndPassword: { enabled: false },
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
    // (forwardToBetterAuth in plugin.ts builds it in `better-auth-url.ts`
    // from http-server's `req.protocol` — `X-Forwarded-Proto` counts only
    // under `AX_TRUST_PROXY=1` — and the Host header when well-formed;
    // better-auth ≥1.6 reads `request.url`'s origin, not the bare `Host`
    // header). In that unset case better-auth logs a
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
      // Who may get an account, attach a sign-in to one, or sign in at all
      // (TASK-1116). better-auth runs it before every account creation, link
      // and OAuth sign-in; identity-gate.ts has the rules.
      validateUserInfo: createIdentityGate(input.providers),
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
      // Implicit linking (attach a sign-in to the EXISTING user with that email)
      // stays on so the setup wizard's admin can sign in at all: the wizard
      // inserts it with NO password and `email_verified: false`, so its first
      // Google sign-in has to link to it.
      //
      // identity-gate.ts (`user.validateUserInfo` above) decides who may link:
      // the provider must have verified the email, and the existing user must
      // be verified too, or be that setup admin before its first sign-in.
      //
      // No provider is trusted to skip email verification (better-auth's
      // trusted-providers list stays unset): GitHub reports unverified emails,
      // and trusting it let an unverified copy of a teammate's email take over
      // their account (TASK-1116). `requireLocalEmailVerified` stays false only
      // because better-auth can't make the setup-admin exception; the gate
      // enforces it instead. better-auth flips the local user's emailVerified
      // to true on a link with a verified email.
      accountLinking: {
        enabled: true,
        requireLocalEmailVerified: false,
      },
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
          // Every account better-auth creates is a member; admins come only
          // from the setup wizard (or the operator's own SQL). Who may create
          // an account at all is identity-gate.ts's call, and it runs first.
          // Don't gate on `context.path` here: in better-auth 1.7 it's the
          // route pattern (`/callback/:id`), which is how the old Google domain
          // check silently never ran (TASK-1116).
          before: async (user) => ({ data: { ...user, role: 'user' } }),
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
    // Runs after the limiter above, so a refused malformed Host still counts.
    plugins: [refuseMalformedHost],
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
