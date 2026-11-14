import { randomBytes } from 'node:crypto';
import {
  PluginError,
  answerRequireUserFailure,
  faultLogFields,
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { z } from 'zod';
// Type-only import from `@ax/http-server` — we never import a runtime value
// from a peer plugin (Invariant I2 — no cross-plugin imports). TypeScript's
// `verbatimModuleSyntax: true` plus `import type {...}` guarantees the
// emit drops the import entirely. The dev-dep entry in package.json is
// type-only.
import type {
  HttpMethod,
  HttpRegisterRouteInput,
  HttpRegisterRouteOutput,
  HttpRequest,
  HttpResponse,
} from '@ax/http-server';
import type {
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  FindUserByEmailInput,
  FindUserByEmailOutput,
  HttpRequestLike,
  User,
} from './types.js';
import { runAuthBetterMigration, type AuthBetterDatabase } from './migrations.js';
import { betterAuthUrl } from './better-auth-url.js';
import {
  createBetterAuthHandler,
  type HandlerHandle,
  type ProviderRow,
} from './handler.js';
import { sessionTokenALS, type AuthRequestBox } from './session-bridge.js';
import { GATED_KINDS, isOnApprovedDomain, isPlainAscii, parseDomains } from './identity-gate.js';
import {
  createProvidersStore,
  type CredentialsEnvelope,
  type ProvidersStore,
} from './providers-store.js';

const PLUGIN_NAME = '@ax/auth-better';
const DEFAULT_SESSION_COOKIE_NAME = 'ax_auth_session';
const DEFAULT_SESSION_LIFETIME_SECS = 7 * 24 * 60 * 60;
// Every Better Auth request arrives on this splat; the handler-error line names it, never the path (TASK-1047).
const AUTH_ROUTE = '/auth/*';

// Validation rails for `auth:create-bootstrap-user` input. The bootstrap
// caller is the unauthenticated UI — input is untrusted (Invariant I5).
// `displayName` is shown verbatim in the admin UI; cap so a giant string
// can't blow up the row. `email` is a basic well-formed check (no MX
// lookup): keep it cheap, lean on the DB UNIQUE for collision detection.
const MAX_DISPLAY_NAME_LEN = 200;
const MAX_EMAIL_LEN = 320;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

// `auth:find-user-by-email` returns the id and nothing else. `.strict()` makes
// a future edit that returns more (the email, the admin flag) fail loudly as
// `invalid-return` instead of having the extra keys quietly stripped.
const FindUserByEmailOutputSchema = z.object({ userId: z.string().min(1) }).strict().nullable();

/**
 * Config surface for `@ax/auth-better`. All fields optional; defaults
 * keep cookie behavior stable.
 */
export interface AuthBetterConfig {
  /** Cookie name for the http login session. Default 'ax_auth_session'. */
  sessionCookieName?: string;
  /** Session lifetime in seconds. Default 7 days. */
  sessionLifetimeSeconds?: number;
  /**
   * Origins better-auth considers trusted for sign-in / OAuth callback / CSRF
   * protection. Each entry is a full origin like `https://ax.example.com` or
   * `http://localhost:8080`.
   *
   * Default: `['*']` (test-friendly; production hosts SHOULD pin). Pass a
   * concrete list to lock down better-auth's CSRF gate. Multiple origins are
   * fine — common pattern is one canonical public URL plus localhost for
   * port-forward debugging.
   */
  trustedOrigins?: string[];
  /**
   * Canonical public origin (e.g. `https://ax.example.com`) better-auth
   * uses to build OAuth redirect URIs and validate callbacks. Set this in
   * production so `redirect_uri` matches Google's configured callback
   * regardless of the inbound Host header. When omitted, better-auth
   * re-resolves the base URL per request from the request origin (and logs
   * a benign "Base URL could not be determined" warning at construction).
   * The `@ax/preset-k8s` wires this from `AX_PUBLIC_BASE_URL` when set.
   */
  baseURL?: string;
  /**
   * Stable secret for the underlying better-auth instance (OAuth state +
   * at-rest OAuth-token encryption). MUST be stable across restarts or
   * encrypted tokens become undecryptable. Falls back to better-auth's
   * BETTER_AUTH_SECRET/AUTH_SECRET env read when omitted.
   */
  secret?: string;
}

// ---------------------------------------------------------------------------
// @ax/auth-better — Task 1.4 lights up the hook surface declared in 1.3.
//
// What's new vs. 1.3:
//   - Real impls for auth:require-user, auth:get-user, auth:create-bootstrap-user
//   - auth:find-user-by-email (TASK-1092): host-internal verified-email lookup
//     for @ax/channel-slack; returns only `{ userId }` or null
//   - `/auth/*` splat route forwards to better-auth's WebStandards handler
//   - auth:providers-changed subscriber rebuilds the handler in place
//
// What's deferred to 1.5:
//   - /admin/auth/providers/* CRUD routes (the FIRER of providers-changed)
//   - credentials:envelope-encrypt/decrypt declaration in manifest.calls
//     — Task 1.5 adds them when CRUD actually wires envelope-encrypt.
//     Today loadProviders() short-circuits on empty result sets, so the
//     plugin boots without a credentials peer (test-friendly).
//
// Half-wired window: the auth:providers-changed subscriber is wired today
// but no FIRER exists yet. That's fine — the rebuild path is reachable
// from contract tests by firing the hook directly. Task 1.5 closes the
// window by adding the CRUD route that fires it.
// ---------------------------------------------------------------------------

export function createAuthBetterPlugin(config: AuthBetterConfig = {}): Plugin {
  let db: Kysely<AuthBetterDatabase> | undefined;
  let handle: HandlerHandle | undefined;
  let busRef: HookBus | undefined;
  const unregisterRoutes: Array<() => void> = [];

  const sessionCookieName = config.sessionCookieName ?? DEFAULT_SESSION_COOKIE_NAME;
  const sessionLifetimeSeconds =
    config.sessionLifetimeSeconds ?? DEFAULT_SESSION_LIFETIME_SECS;
  // Capture trustedOrigins at construction so the providers-changed
  // subscriber doesn't have to re-read config on every fire — config is
  // already captured by the closure, but pinning it here is one less
  // hop and makes the rebuild call site read straight.
  const trustedOrigins = config.trustedOrigins;
  const baseURL = config.baseURL;
  const secret = config.secret;

  const PROVIDERS_CHANGED_KEY = `${PLUGIN_NAME}/providers-changed`;
  // Provider kinds loadProviders() has already said it skips, so each is
  // logged once per process rather than on every provider change.
  const reportedSkippedKinds = new Set<string>();
  const RESET_CLEANUP_KEY = `${PLUGIN_NAME}/bootstrap-reset-cleanup`;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'auth:require-user',
        'auth:get-user',
        'auth:find-user-by-email',
        'auth:create-bootstrap-user',
        'auth:complete-bootstrap-user',
      ],
      // Task 1.5 adds the envelope hooks to `calls` because the admin
      // provider CRUD routes now wrap/unwrap secrets unconditionally
      // (they encrypt on insert and decrypt on list). Hosts loading
      // @ax/auth-better MUST also load @ax/credentials — verifyCalls()
      // catches the misconfiguration at boot. Bootstrap-user contract
      // tests that don't need providers mock the envelope hooks via
      // `services:` on the test harness.
      calls: [
        'database:get-instance',
        'http:register-route',
        'credentials:envelope-encrypt',
        'credentials:envelope-decrypt',
      ],
      subscribes: ['auth:providers-changed', 'bootstrap:reset-cleanup'],
    },

    async init({ bus }) {
      busRef = bus;
      const initCtx = makeAgentContext({
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
      db = shared as Kysely<AuthBetterDatabase>;
      await runAuthBetterMigration(db);
      const localDb = db;

      // 2) Initial provider load + store -------------------------------
      // The store wraps DB access and hides the envelope plumbing. The
      // envelope closure routes through `credentials:envelope-encrypt`
      // / `-decrypt`; both live in @ax/credentials, declared in `calls`
      // so verifyCalls() catches a missing peer at boot.
      const envelope: CredentialsEnvelope = {
        async encrypt(plaintext: string): Promise<Uint8Array> {
          const { ciphertext } = await bus.call<
            { plaintext: string },
            { ciphertext: Uint8Array }
          >('credentials:envelope-encrypt', initCtx, { plaintext });
          return ciphertext;
        },
        async decrypt(ciphertext: Uint8Array): Promise<string> {
          const { plaintext } = await bus.call<
            { ciphertext: Uint8Array },
            { plaintext: string }
          >('credentials:envelope-decrypt', initCtx, { ciphertext });
          return plaintext;
        },
      };
      const store = createProvidersStore(localDb, envelope);
      const providers = await loadProviders(localDb, bus, initCtx, reportedSkippedKinds);

      // 3) Build the handler --------------------------------------------
      handle = createBetterAuthHandler({
        database: localDb,
        providers,
        ...(trustedOrigins !== undefined ? { trustedOrigins } : {}),
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(secret !== undefined ? { secret } : {}),
      });
      const localHandle = handle;

      // Drain better-auth's async adapter-init BEFORE init() returns.
      // better-auth resolves its database adapter on a background promise
      // (`auth.$context`, surfaced here as `handle.ready()`) that runs a
      // schema-introspection query. Leaving it unawaited means that query
      // can still be in flight when the shared pg.Pool / Postgres
      // testcontainer is torn down at the end of a test — the dying
      // connection then surfaces as `57P01` →
      // `BetterAuthError: Failed to initialize database adapter`. That race
      // only loses under full-suite concurrency (the background init runs
      // slower), which is why only the push-to-main full suite saw it
      // (TASK-8). Awaiting `ready()` drains the query so nothing races
      // teardown — and a genuine boot-time DB failure now fails boot loudly
      // (better posture) instead of surfacing on the first user request.
      await localHandle.ready();

      // 4) Subscribe to providers-changed for hot-reload -----------------
      // Task 1.5's CRUD routes fire `auth:providers-changed` after every
      // insert/update/delete; we re-read the table and rebuild the
      // handler. The handler-wrapper's catch path (handler.ts) keeps the
      // OLD instance live if construction throws, so a typo'd config
      // doesn't take down the auth surface mid-flight.
      bus.subscribe(
        'auth:providers-changed',
        PROVIDERS_CHANGED_KEY,
        async (subCtx: AgentContext) => {
          const next = await loadProviders(localDb, bus, subCtx, reportedSkippedKinds);
          localHandle.rebuild({
            database: localDb,
            providers: next,
            ...(trustedOrigins !== undefined ? { trustedOrigins } : {}),
            ...(baseURL !== undefined ? { baseURL } : {}),
            ...(secret !== undefined ? { secret } : {}),
          });
          return undefined;
        },
      );

      // Bootstrap-reset cleanup: when an operator runs `ax admin
      // reset-bootstrap --force`, wipe the leftover admin user + sessions
      // so the next wizard run can complete (auth:create-bootstrap-user
      // refuses to mint a second admin while one exists — see I6 gate).
      // The handler keeps its in-memory provider catalog; only user/
      // session rows are dropped. Runs on the same Kysely instance the
      // handler uses, so a wipe-while-handler-serves race is bounded by
      // the table-level lock TRUNCATE takes.
      bus.subscribe(
        'bootstrap:reset-cleanup',
        RESET_CLEANUP_KEY,
        async () => {
          await sql`TRUNCATE auth_better_v1_sessions, auth_better_v1_users CASCADE`.execute(
            localDb,
          );
          return undefined;
        },
      );

      // 5) Service hooks -------------------------------------------------
      bus.registerService<{ req: HttpRequestLike }, { user: User }>(
        'auth:require-user',
        PLUGIN_NAME,
        async (_ctx, input) => requireUser(localDb, sessionCookieName, input.req),
      );

      bus.registerService<{ userId: string }, User | null>(
        'auth:get-user',
        PLUGIN_NAME,
        async (_ctx, input) => getUserById(localDb, input.userId),
      );

      // Host-internal identity mapping for @ax/channel-slack (TASK-1092):
      // never an HTTP route or an IPC action. The contract is on
      // FindUserByEmailInput in types.ts.
      bus.registerService<FindUserByEmailInput, FindUserByEmailOutput>(
        'auth:find-user-by-email',
        PLUGIN_NAME,
        (ctx, input) => findUserByEmail(localDb, ctx, input),
        { returns: FindUserByEmailOutputSchema },
      );

      bus.registerService<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
        'auth:create-bootstrap-user',
        PLUGIN_NAME,
        async (_ctx, input) =>
          createBootstrapUser(localDb, sessionLifetimeSeconds, input),
      );

      bus.registerService<CompleteBootstrapUserInput, CompleteBootstrapUserOutput>(
        'auth:complete-bootstrap-user',
        PLUGIN_NAME,
        async (_ctx, input) => {
          // The oneTimeToken IS a sessionId pre-minted by the create hook.
          // We just package it as a cookie. We do NOT validate it here — the
          // route layer is the auth gate.
          // `password` is accepted in the input type for forward-compat with
          // Phase 3 local-auth plans but is silently ignored for now (no
          // local password support yet; deferred per YAGNI guard in plan).
          return {
            sessionCookie: {
              name: sessionCookieName,
              value: input.oneTimeToken,
              opts: {
                path: '/',
                sameSite: 'Lax',
                // Production: cookie only over HTTPS. Dev/test: omit so kind
                // and local docker work over plain HTTP.
                ...(process.env['NODE_ENV'] === 'production' ? { secure: true } : {}),
                maxAge: sessionLifetimeSeconds,
              },
            },
          };
        },
      );

      // 6) Mount /auth/* via http:register-route -------------------------
      // better-auth's handler is `(req: Request) => Promise<Response>`
      // (WebStandards). It does its own internal routing across the
      // sign-up / sign-in / sign-out / session / OAuth-callback surface.
      // We expose a single splat per HTTP verb and forward through the
      // adapter — saves a brittle finite-list of paths drifting against
      // better-auth releases.
      //
      // The router accepts `/*` splats per `Router.compilePathPattern`
      // (see http-server/src/router.ts); the captured remainder lands in
      // `req.params['*']`, but we don't need it — we reconstruct the URL
      // from `req.path` directly (the original path is preserved).
      const splatMethods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      for (const method of splatMethods) {
        const handler = async (req: HttpRequest, res: HttpResponse): Promise<void> => {
          await forwardToBetterAuth(localHandle, req, res, { sessionCookieName, sessionLifetimeSeconds });
        };
        const { unregister } = await bus.call<HttpRegisterRouteInput, HttpRegisterRouteOutput>(
          'http:register-route',
          initCtx,
          { method, path: AUTH_ROUTE, handler },
        );
        unregisterRoutes.push(unregister);
      }

      // 6.5) /admin/me + /admin/sign-out — channel-web's `lib/auth.ts`
      // calls these. Without them, static-files's SPA fallback would
      // catch /admin/me and return index.html — the SPA's getSession()
      // would then see no user field and treat every fresh sign-in as
      // unauthenticated.
      {
        const meHandler = async (req: HttpRequest, res: HttpResponse): Promise<void> => {
          try {
            const { user } = await requireUser(localDb, sessionCookieName, req);
            res.status(200).json({ user });
          } catch (err) {
            // Only 'unauthenticated' is a 401. A DB fault is a logged 500, so
            // the outage shows up in the logs. (The SPA's boot check still
            // shows sign-in for ANY non-OK answer here: channel-web
            // lib/auth.ts getSession(); lib/http.ts explains why.)
            answerRequireUserFailure(initCtx, res, err, 'auth_me_failed');
          }
        };
        const { unregister } = await bus.call<HttpRegisterRouteInput, HttpRegisterRouteOutput>(
          'http:register-route',
          initCtx,
          { method: 'GET', path: '/admin/me', handler: meHandler },
        );
        unregisterRoutes.push(unregister);
      }

      {
        const signOutHandler = async (req: HttpRequest, res: HttpResponse): Promise<void> => {
          // Idempotent — absent / forged cookie still returns 200 so the
          // endpoint isn't a session-existence oracle. Best-effort delete.
          const sessionId = req.signedCookie(sessionCookieName);
          if (sessionId !== null) {
            await localDb
              .deleteFrom('auth_better_v1_sessions')
              .where('token', '=', sessionId)
              .execute();
          }
          res.clearCookie(sessionCookieName, { path: '/', sameSite: 'Lax' });
          res.status(200).json({ ok: true });
        };
        const { unregister } = await bus.call<HttpRegisterRouteInput, HttpRegisterRouteOutput>(
          'http:register-route',
          initCtx,
          { method: 'POST', path: '/admin/sign-out', handler: signOutHandler },
        );
        unregisterRoutes.push(unregister);
      }

      // 7) /admin/auth/providers/* — runtime CRUD (closes I10) ----------
      // These routes are the FIRER of `auth:providers-changed`. The
      // subscriber registered above re-reads the table and rebuilds the
      // handler, so a provider added at runtime is live within the next
      // HTTP request — no kernel restart.
      //
      // SECURITY POSTURE:
      //   - Admin-only: every route calls `auth:require-user` and rejects
      //     401 (unauthenticated) / 403 (non-admin).
      //   - Input is bounded + enum-validated in the store (Invariant I5).
      //   - GET strips `clientSecret` before responding (Invariant I9 —
      //     plaintext secrets never leak through hook returns OR the
      //     wire). The store's `list()` returns secrets for the rebuild
      //     path; the route is responsible for the wire-side strip.
      //   - Error messages NEVER echo `clientSecret`. The validators in
      //     providers-store.ts deliberately omit value echoes.
      await registerAdminRoutes({
        bus,
        initCtx,
        store,
        unregisterRoutes,
      });
    },

    async shutdown() {
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
      busRef?.unsubscribe('auth:providers-changed', PROVIDERS_CHANGED_KEY);
      busRef?.unsubscribe('bootstrap:reset-cleanup', RESET_CLEANUP_KEY);
      busRef = undefined;
      handle = undefined;
      db = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — kept inline for now; Task 1.5 may extract a `store.ts` if they
// grow. The kysely-direct calls are short enough that a separate module
// adds more boilerplate than it removes.
// ---------------------------------------------------------------------------

async function loadProviders(
  db: Kysely<AuthBetterDatabase>,
  bus: HookBus,
  ctx: AgentContext,
  reportedSkippedKinds: Set<string>,
): Promise<ProviderRow[]> {
  const rows = await db
    .selectFrom('auth_providers')
    .where('enabled', '=', true)
    .selectAll()
    .execute();

  // Short-circuit: no rows → no envelope-decrypt calls. This is the seam
  // that lets the bootstrap-user contract test boot @ax/auth-better
  // without @ax/credentials registered. Once Task 1.5's CRUD inserts a
  // real row, hosts MUST load @ax/credentials too — that's tracked in
  // the half-wired-window note.
  if (rows.length === 0) return [];

  const out: ProviderRow[] = [];
  for (const r of rows) {
    // Only the kinds better-auth is wired for, checked BEFORE the secret is
    // decrypted. Anything else (a leftover `oidc` row from when the admin
    // form offered it, or a row a newer binary wrote) never reaches
    // better-auth, which rejects an unknown social-provider key and would
    // take every sign-in down with it (TASK-1116). The admin list still
    // shows such a row, and DELETE removes it.
    //
    // Said once per kind per process, so an operator can see why an enabled
    // row signs nobody in. The kind is the row's own key, written by an admin
    // or SQL, never request input.
    if (r.kind !== 'google' && r.kind !== 'github') {
      if (!reportedSkippedKinds.has(r.kind)) {
        reportedSkippedKinds.add(r.kind);
        process.stderr.write(
          `[ax/auth-better] sign-in provider ignored ${JSON.stringify({ code: 'provider-kind-unsupported', kind: r.kind })}\n`,
        );
      }
      continue;
    }
    const { plaintext } = await bus.call<
      { ciphertext: Uint8Array },
      { plaintext: string }
    >('credentials:envelope-decrypt', ctx, { ciphertext: r.client_secret_encrypted });
    // `allowedDomains` is optional in ProviderRow (exactOptionalPropertyTypes
    // is ON), so emit it only when the DB has a value.
    out.push({
      kind: r.kind,
      clientId: r.client_id,
      clientSecret: plaintext,
      ...(r.allowed_domains !== null ? { allowedDomains: r.allowed_domains } : {}),
    });
  }
  return out;
}

async function requireUser(
  db: Kysely<AuthBetterDatabase>,
  sessionCookieName: string,
  req: HttpRequestLike,
): Promise<{ user: User }> {
  const sessionId = req.signedCookie(sessionCookieName);
  if (sessionId === null) {
    throw new PluginError({
      code: 'unauthenticated',
      plugin: PLUGIN_NAME,
      hookName: 'auth:require-user',
      message: 'no session cookie',
    });
  }
  const row = await db
    .selectFrom('auth_better_v1_sessions')
    .innerJoin(
      'auth_better_v1_users',
      'auth_better_v1_users.id',
      'auth_better_v1_sessions.user_id',
    )
    .where('auth_better_v1_sessions.token', '=', sessionId)
    .where('auth_better_v1_sessions.expires_at', '>', new Date())
    .select([
      'auth_better_v1_users.id',
      'auth_better_v1_users.email',
      'auth_better_v1_users.name',
      'auth_better_v1_users.role',
    ])
    .executeTakeFirst();
  if (row === undefined) {
    throw new PluginError({
      code: 'unauthenticated',
      plugin: PLUGIN_NAME,
      hookName: 'auth:require-user',
      message: 'session unknown or expired',
    });
  }
  return { user: rowToUser(row) };
}

async function getUserById(
  db: Kysely<AuthBetterDatabase>,
  userId: string,
): Promise<User | null> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'auth:get-user',
      message: 'userId must be a non-empty string',
    });
  }
  const row = await db
    .selectFrom('auth_better_v1_users')
    .where('id', '=', userId)
    .select(['id', 'email', 'name', 'role'])
    .executeTakeFirst();
  return row === undefined ? null : rowToUser(row);
}

/**
 * `auth:find-user-by-email`: the one verified account that owns `email`, on an
 * approved sign-in domain, or null. The contract is on FindUserByEmailInput in
 * types.ts. Every rule fails closed, and the address never reaches an error
 * message or a log line (it's PII from an outside system).
 */
async function findUserByEmail(
  db: Kysely<AuthBetterDatabase>,
  ctx: AgentContext,
  input: FindUserByEmailInput,
): Promise<FindUserByEmailOutput> {
  // The address arrives from another system through host code. A wrong type is
  // a caller bug, so it throws; a malformed string of the right type simply
  // finds nobody.
  const email: unknown = input?.email;
  if (typeof email !== 'string' || email.length === 0 || email.length > MAX_EMAIL_LEN) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'auth:find-user-by-email',
      message: `email must be a non-empty string of at most ${MAX_EMAIL_LEN} characters`,
    });
  }

  // Printable ASCII only (U+0021 to U+007E, the sign-in gate's own test),
  // checked before any query: nothing outside ASCII can be folded onto an
  // ASCII address, and no byte the database would reject reaches it.
  if (!isPlainAscii(email)) return null;

  // ASCII case-insensitive, otherwise exact: emailEqualsAsciiFold folds A-Z
  // and nothing else, on both sides, compared with `=`. Never LIKE/ILIKE: they
  // read `%` and `_` as wildcards. No trimming. The UNIQUE on email is
  // case-sensitive, and auth:create-bootstrap-user stored the address as typed
  // until TASK-1116 made it lowercase, so rows written before that can still
  // differ only in case; we fetch at most two to tell that
  // apart. The verified rule is part of the match itself, so an unverified row
  // is never returned and never counts toward ambiguity.
  const rows = await db
    .selectFrom('auth_better_v1_users')
    .select(['id', 'email'])
    .where(emailEqualsAsciiFold(email))
    .where('email_verified', '=', true)
    .limit(2)
    .execute();
  const row = rows[0];
  if (row === undefined) {
    // On a miss only, one more parameterized lookup with the same match and no
    // verified rule, so an operator can tell "not verified yet" (e.g. the
    // wizard admin before a Google sign-in) from "no account". Code-only line:
    // never the address, never its domain. The caller still gets plain null.
    const unverified = await db
      .selectFrom('auth_better_v1_users')
      .select('id')
      .where(emailEqualsAsciiFold(email))
      .limit(1)
      .executeTakeFirst();
    if (unverified !== undefined) ctx.logger.info('auth_find_user_by_email_unverified_only');
    return null;
  }
  if (rows.length > 1) {
    // Never pick one: that could hand one person's agent to another. Code-only
    // line, never the address. (The query stops at two.)
    ctx.logger.warn('auth_find_user_by_email_ambiguous', { matches: 2 });
    return null;
  }

  // Approved domains, read now (never a cached copy) by readApprovedDomainLists:
  // see isOnApprovedDomain for the rule. Both the input's domain and the STORED
  // verified email's are checked: after the ASCII-only match they are the same
  // domain up to case, and checking both keeps this rule from resting on the
  // match alone.
  const lists = await readApprovedDomainLists(db);
  if (!isOnApprovedDomain(email, lists) || !isOnApprovedDomain(row.email, lists)) {
    // A verified account matched, on a domain the lists exclude. Code-only.
    ctx.logger.info('auth_find_user_by_email_off_domain');
    return null;
  }
  return { userId: row.id };
}

/**
 * Every sign-in provider's allowed-domain list, parsed, for `isOnApprovedDomain`.
 * Read WHETHER OR NOT a provider is enabled: turning a sign-in method off
 * neither widens nor narrows who counts as on an approved domain (its list
 * still keeps other domains out, and still approves its own). Only the kinds
 * the sign-in gate enforces (`GATED_KINDS`); any other row configures nothing.
 */
async function readApprovedDomainLists(
  db: Kysely<AuthBetterDatabase>,
): Promise<string[][]> {
  const rows = await db
    .selectFrom('auth_providers')
    .select('allowed_domains')
    .where('kind', 'in', [...GATED_KINDS])
    .execute();
  return rows.map((r) => parseDomains(r.allowed_domains));
}

/**
 * `email` equals `input` up to ASCII case. Under COLLATE "C", lower() folds
 * A-Z and nothing else. Plain lower() follows the database locale, which folds
 * lookalikes onto ASCII (U+0130 dotted capital I to 'i', U+212A Kelvin sign to
 * 'k'), so 'al\u0130ce@…' would find alice. `input` is a bound parameter.
 */
function emailEqualsAsciiFold(input: string): RawBuilder<boolean> {
  return sql<boolean>`lower(${sql.ref('email')} COLLATE "C") = lower(${input} COLLATE "C")`;
}

async function createBootstrapUser(
  db: Kysely<AuthBetterDatabase>,
  sessionLifetimeSeconds: number,
  input: CreateBootstrapUserInput,
): Promise<CreateBootstrapUserOutput> {
  // Validate untrusted input (I5). The bootstrap caller is the
  // unauthenticated onboarding UI — every field arrives from the wire.
  if (typeof input.displayName !== 'string') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'auth:create-bootstrap-user',
      message: 'displayName must be a string',
    });
  }
  if (input.displayName.length > MAX_DISPLAY_NAME_LEN) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'auth:create-bootstrap-user',
      message: `displayName exceeds ${MAX_DISPLAY_NAME_LEN} characters`,
    });
  }
  if (input.email !== undefined) {
    if (typeof input.email !== 'string' || input.email.length === 0) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'auth:create-bootstrap-user',
        message: 'email must be a non-empty string when provided',
      });
    }
    if (input.email.length > MAX_EMAIL_LEN) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'auth:create-bootstrap-user',
        message: `email exceeds ${MAX_EMAIL_LEN} characters`,
      });
    }
    if (!EMAIL_RE.test(input.email)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'auth:create-bootstrap-user',
        message: 'email must look like an email address',
      });
    }
    // Checked as typed, before lowercasing: `toLowerCase()` turns some
    // non-ASCII letters into ASCII ones (the Kelvin sign U+212A into "k").
    // The sign-in gate refuses any address beyond plain ASCII, so an admin
    // saved with one could never sign in (TASK-1116).
    if (!isPlainAscii(input.email)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'auth:create-bootstrap-user',
        message: 'email must be plain ASCII',
      });
    }
  }

  // I6: bootstrap is one-shot. Refuse if any admin already exists.
  // (Task 2.2 hardens this further — a follow-up bootstrap-completed
  // marker lands then. For 1.4 the admin-row check is the gate.)
  const existing = await db
    .selectFrom('auth_better_v1_users')
    .where('role', '=', 'admin')
    .select('id')
    .executeTakeFirst();
  if (existing !== undefined) {
    throw new PluginError({
      code: 'admin-already-exists',
      plugin: PLUGIN_NAME,
      hookName: 'auth:create-bootstrap-user',
      message: 'admin already exists; bootstrap refused',
    });
  }

  const id = `usr_${randomBytes(16).toString('hex')}`;
  // Lowercase (TASK-1116). better-auth finds a user by the lowercased email
  // and the column compares case-sensitively, so an admin stored as typed
  // (`Owner@CanopyWorks.com`) was never found at its first sign-in: Google
  // made a new member instead, and the admin could never sign in. Plain ASCII
  // was checked above, so this folds ASCII case and nothing else.
  const email =
    input.email !== undefined && input.email.length > 0
      ? input.email.toLowerCase()
      : `bootstrap+${id}@local.invalid`;
  const displayName = input.displayName.length > 0 ? input.displayName : null;
  const now = new Date();

  // Mint a 32-byte token; store it as the session row. The token IS the
  // session cookie value — Task 2 (onboarding flow) hands the bootstrap
  // CLI the token and exchanges it for a Set-Cookie immediately.
  const oneTimeToken = randomBytes(32).toString('base64url');
  const sessionId = `sess_${randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000);

  // Wrap both inserts in a transaction so a session-insert failure
  // (constraint violation, transient pg error, etc.) rolls back the
  // user insert too. Without this, an orphaned admin row would block
  // every subsequent bootstrap call with `admin-already-exists` —
  // recovery would require a DB reset. With the transaction, a failed
  // bootstrap leaves the table in its pre-call state and the operator
  // can simply retry.
  return await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('auth_better_v1_users')
      .values({
        id,
        email,
        email_verified: false,
        name: displayName,
        image: null,
        role: 'admin',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('auth_better_v1_sessions')
      .values({
        id: sessionId,
        user_id: id,
        token: oneTimeToken,
        expires_at: expiresAt,
        ip_address: null,
        user_agent: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const userRow = { id, email, name: displayName, role: 'admin' as const };
    return { user: rowToUser(userRow), oneTimeToken };
  });
}

function rowToUser(row: {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
}): User {
  return {
    id: row.id,
    // Table column is NOT NULL; User type is `string | null`. Pass the
    // string through — the User boundary type is the contract, not the
    // table shape.
    email: row.email,
    displayName: row.name,
    isAdmin: row.role === 'admin',
  };
}

// ---------------------------------------------------------------------------
// HTTP adapter — bridges @ax/http-server's HttpRequest/HttpResponse to
// the WebStandards Request/Response that better-auth's handler expects.
//
// The /auth/* splat is registered for every method we expect better-auth
// to route. The adapter:
//   1. Builds a fetch.Request from HttpRequest (URL = `betterAuthUrl(req)`:
//      http-server's scheme, the Host header when well-formed, the path and
//      the query; body = req.body when present, headers as-is).
//   2. Invokes handle.current()(webRequest) → fetch.Response.
//   3. Translates the Response back: status, every header (including
//      multi-value Set-Cookie), and the raw body bytes.
//
// Cookies: better-auth's session cookies ride on the standard Set-Cookie
// header. http-server's response writer stores headers in a Map, so we
// can only set one Set-Cookie value at a time — we collect every
// Set-Cookie better-auth emits and join them with ', ' before calling
// res.header('set-cookie', …) ONCE. See the dedicated comment near the
// join below for the RFC/UA-compatibility rationale.
// ---------------------------------------------------------------------------

interface BridgeOpts { sessionCookieName: string; sessionLifetimeSeconds: number; }

async function forwardToBetterAuth(
  handle: HandlerHandle,
  req: HttpRequest,
  res: HttpResponse,
  bridge: BridgeOpts,
): Promise<void> {
  const { url, malformedHost } = betterAuthUrl(req);

  // Fetch.Request rejects bodies on GET (and HEAD, which @ax/http-server
  // doesn't expose anyway). Pass body only when there's something to send.
  const init: RequestInit = { method: req.method, headers: webHeadersFrom(req.headers) };
  if (req.method !== 'GET' && req.body.length > 0) {
    // Node's undici fetch accepts a Buffer/Uint8Array as body even
    // though the lib.dom typing of `BodyInit` doesn't include Buffer
    // specifically. Cast through unknown to satisfy the structural
    // check without dragging the dom type in.
    init.body = req.body as unknown as ArrayBuffer;
  }

  // Run the better-auth call inside the ALS so session.create.after
  // (in handler.ts) can write the minted token into box.token, and the
  // refuse plugin (also handler.ts) can answer a malformed Host with a 400
  // after Better Auth's rate limiter has counted it.
  const box: AuthRequestBox = malformedHost ? { malformedHost: true } : {};
  let webResponse: Response;
  try {
    webResponse = await sessionTokenALS.run(box, () => handle.current()(new Request(url, init)));
  } catch (err) {
    // The request failed before Better Auth could answer it: Better Auth
    // failing before it routes (adapter init, base-URL or origin resolution).
    // An endpoint's own error never lands here, because Better Auth's router
    // answers it itself (an APIError with its own status, anything else with
    // a 500).
    //
    // The line names the route as registered, never the request path. Better
    // Auth mounts `GET /reset-password/:token`, so once `sendResetPassword` is
    // configured, a failing reset link would write a live token here. It
    // carries the failure's codes, never its message: Better Auth's errors can
    // echo state, email or callback-URL params. The client gets a bare 500
    // either way (TASK-1047).
    process.stderr.write(
      `[ax/auth-better] handler error on ${req.method} ${AUTH_ROUTE} ${JSON.stringify(faultLogFields(err))}\n`,
    );
    res.status(500).json({ error: 'auth-handler-failed' });
    return;
  }

  if (box.refused === true) {
    // Only when the 400 was actually served: over the limit, Better Auth
    // answered 429 and nothing is written. That bounds this line per client
    // per path only: the limiter keys on ip|path and the refusal runs before
    // routing, so a client rotating the path under /auth/* gets a fresh bucket
    // (and a line) each time, as a throwing Host did before.
    // Code-only, like the line above: never the Host value, the path or the query.
    process.stderr.write(
      `[ax/auth-better] bad request on ${req.method} ${AUTH_ROUTE} {"code":"malformed-host"}\n`,
    );
  }

  res.status(webResponse.status);

  // Copy all headers. fetch.Headers normalizes names to lowercase;
  // multi-value headers (Set-Cookie) come through `getSetCookie()` on
  // node's undici fetch.
  const setCookies = readSetCookies(webResponse.headers);
  for (const [name, value] of webResponse.headers.entries()) {
    if (name.toLowerCase() === 'set-cookie') continue;
    // content-type is set on the response writer below via body() — but
    // better-auth doesn't always set one; we forward whatever it gave us.
    res.header(name, value);
  }

  if (box.token !== undefined) {
    // Session-creating response (the OAuth callback; email sign-in and sign-up
    // are off, TASK-1116): re-issue the session token as our
    // http-server-signed cookie. better-auth's own
    // Set-Cookies on this response (its `ax_better_auth.session_token` session
    // cookie + short-lived OAuth-state cookie) are intentionally dropped — its
    // session cookie is replaced by ours; its state cookie self-expires.
    // (The header-copy loop above already skipped every better-auth set-cookie,
    // so setSignedCookie writes the only cookie on this response — we simply
    // don't forward setCookies here.)
    res.setSignedCookie(bridge.sessionCookieName, box.token, {
      path: '/', sameSite: 'Lax',
      ...(process.env['NODE_ENV'] === 'production' ? { secure: true } : {}),
      maxAge: bridge.sessionLifetimeSeconds,
    });
  } else if (setCookies.length > 0) {
    // Non-session responses (e.g. /sign-in/social sets the OAuth-state cookie):
    // forward better-auth's cookies unchanged.
    // http-server's response writer stores headers in a Map
    // (last-write-wins), so calling res.header('set-cookie', …) once
    // per cookie would silently drop all but the last value. Until
    // http-server gains a multi-value header API, we collapse every
    // Set-Cookie into a single comma-joined header. Per RFC 6265 §3
    // and the de-facto behavior of all major user agents, comma-joined
    // Set-Cookie values are parsed correctly when the individual
    // cookie attributes don't contain unquoted commas — which
    // better-auth's emitted cookies do not. A future http-server
    // change to support multi-value headers would let us emit one
    // Set-Cookie per cookie; until then, this preserves all cookies
    // in one header line so session + CSRF (and clear-old + set-new
    // on rotation) both reach the browser.
    res.header('set-cookie', setCookies.join(', '));
  }

  const buf = Buffer.from(await webResponse.arrayBuffer());
  if (buf.length === 0) res.end();
  else res.body(buf);
}

function webHeadersFrom(in_: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(in_)) {
    if (typeof v !== 'string') continue;
    try {
      h.set(k, v);
    } catch {
      // Skip headers Headers refuses (forbidden names, invalid bytes).
      // Forwarding `host` etc. into an outbound Request is fine; node's
      // fetch only rejects on truly invalid characters.
    }
  }
  return h;
}

function readSetCookies(h: Headers): string[] {
  // Node 20.4+ supports getSetCookie(); fall back to a single header
  // value if the runtime is older.
  const dyn = h as unknown as { getSetCookie?: () => string[] };
  if (typeof dyn.getSetCookie === 'function') {
    return dyn.getSetCookie();
  }
  const single = h.get('set-cookie');
  return single === null ? [] : [single];
}

// ---------------------------------------------------------------------------
// /admin/auth/providers/* — admin-only runtime CRUD.
//
// Routes:
//   GET    /admin/auth/providers      → list (secrets STRIPPED)
//   POST   /admin/auth/providers      → upsert
//   PATCH  /admin/auth/providers/:kind → setEnabled
//   DELETE /admin/auth/providers/:kind → delete
//
// Each mutation fires `auth:providers-changed` on success; the subscriber
// registered in init() rebuilds the handler in place — closing I10.
// ---------------------------------------------------------------------------

interface RegisterAdminRoutesDeps {
  bus: HookBus;
  initCtx: AgentContext;
  store: ProvidersStore;
  unregisterRoutes: Array<() => void>;
}

async function registerAdminRoutes(deps: RegisterAdminRoutesDeps): Promise<void> {
  const { bus, initCtx, store, unregisterRoutes } = deps;

  const register = async (method: HttpMethod, path: string, handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): Promise<void> => {
    const { unregister } = await bus.call<HttpRegisterRouteInput, HttpRegisterRouteOutput>(
      'http:register-route',
      initCtx,
      { method, path, handler },
    );
    unregisterRoutes.push(unregister);
  };

  await register('GET', '/admin/auth/providers', async (req, res) => {
    if (!(await requireAdmin(bus, initCtx, req, res))) return;
    const rows = await store.list();
    // Strip clientSecret before going on the wire (Invariant I9). The
    // route is the LAST line of defense — the store deliberately returns
    // plaintext for the rebuild path, so we strip explicitly here rather
    // than overload the store with two read modes.
    const sanitized = rows.map((r) => ({
      kind: r.kind,
      clientId: r.clientId,
      discoveryUrl: r.discoveryUrl,
      allowedDomains: r.allowedDomains,
      enabled: r.enabled,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    res.status(200).json({ providers: sanitized });
  });

  await register('POST', '/admin/auth/providers', async (req, res) => {
    if (!(await requireAdmin(bus, initCtx, req, res))) return;
    const body = parseJsonBody(req.body);
    if (body === null) {
      res.status(400).json({ error: 'invalid-json' });
      return;
    }
    try {
      await store.upsert({
        kind: asString(body.kind),
        clientId: asString(body.clientId),
        clientSecret: asString(body.clientSecret),
        ...(body.discoveryUrl !== undefined
          ? { discoveryUrl: asString(body.discoveryUrl) }
          : {}),
        ...(body.allowedDomains !== undefined
          ? { allowedDomains: asString(body.allowedDomains) }
          : {}),
      });
    } catch (err) {
      sendValidationError(res, err);
      return;
    }
    await bus.fire('auth:providers-changed', initCtx, {});
    res.status(201).json({ ok: true });
  });

  await register('PATCH', '/admin/auth/providers/:kind', async (req, res) => {
    if (!(await requireAdmin(bus, initCtx, req, res))) return;
    const kind = req.params['kind'] ?? '';
    const body = parseJsonBody(req.body);
    if (body === null) {
      res.status(400).json({ error: 'invalid-json' });
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'invalid-payload', message: 'enabled must be a boolean' });
      return;
    }
    try {
      await store.setEnabled(kind, body.enabled);
    } catch (err) {
      sendValidationError(res, err);
      return;
    }
    await bus.fire('auth:providers-changed', initCtx, {});
    res.status(200).json({ ok: true });
  });

  await register('DELETE', '/admin/auth/providers/:kind', async (req, res) => {
    if (!(await requireAdmin(bus, initCtx, req, res))) return;
    const kind = req.params['kind'] ?? '';
    try {
      await store.delete(kind);
    } catch (err) {
      sendValidationError(res, err);
      return;
    }
    await bus.fire('auth:providers-changed', initCtx, {});
    res.status(204).end();
  });
}

/**
 * Calls `auth:require-user` against the bus and emits 401/403 directly on
 * the response. Returns `true` if the caller is an admin (route handler
 * should continue) or `false` if a response was already sent (handler
 * should return immediately).
 *
 * The hook is OUR own service — calling it via the bus rather than reaching
 * into the impl directly keeps the helper interchangeable with a future
 * alternate auth impl that registers the same surface.
 */
async function requireAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: HttpRequest,
  res: HttpResponse,
): Promise<boolean> {
  let user: User;
  try {
    const out = await bus.call<{ req: HttpRequestLike }, { user: User }>(
      'auth:require-user',
      ctx,
      { req },
    );
    user = out.user;
  } catch (err) {
    // Only 'unauthenticated' is a 401. Anything else is a logged 500 that
    // doesn't leak the cause.
    answerRequireUserFailure(ctx, res, err, 'auth_admin_require_user_failed');
    return false;
  }
  if (!user.isAdmin) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
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

function asString(v: unknown): string {
  // Cheap normalization for the validators downstream — they re-check
  // type/length. We only convert here so a missing field surfaces as
  // empty-string and validation rejects it cleanly.
  return typeof v === 'string' ? v : '';
}

function sendValidationError(res: HttpResponse, err: unknown): void {
  if (err instanceof PluginError && err.code === 'invalid-payload') {
    // Safe: PluginError messages from providers-store.ts are static,
    // never include the raw secret value.
    res.status(400).json({ error: 'invalid-payload', message: err.message });
    return;
  }
  // Anything else — log NOTHING about the body and return a generic 500.
  // Even an unexpected DB error mustn't echo a payload field.
  res.status(500).json({ error: 'internal' });
}
