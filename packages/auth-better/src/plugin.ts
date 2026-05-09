import { randomBytes } from 'node:crypto';
import {
  PluginError,
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
// Type-only import from `@ax/http-server` — we never import a runtime value
// from a peer plugin (Invariant I2 — no cross-plugin imports). TypeScript's
// `verbatimModuleSyntax: true` plus `import type {...}` guarantees the
// emit drops the import entirely. The dev-dep entry in package.json is
// type-only, mirroring auth-oidc.
import type {
  HttpMethod,
  HttpRegisterRouteInput,
  HttpRegisterRouteOutput,
  HttpRequest,
  HttpResponse,
} from '@ax/http-server';
// Type-only import from `@ax/auth-oidc` — boundary types are the contract
// (a future @ax/auth-better is an alternate impl of the same hook surface).
// Same I2 escape hatch: types-only.
import type {
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  User,
} from '@ax/auth-oidc';
import { runAuthBetterMigration, type AuthBetterDatabase } from './migrations.js';
import {
  createBetterAuthHandler,
  type HandlerHandle,
  type ProviderRow,
} from './handler.js';
import {
  createProvidersStore,
  type CredentialsEnvelope,
  type ProvidersStore,
} from './providers-store.js';

const PLUGIN_NAME = '@ax/auth-better';
const DEFAULT_SESSION_COOKIE_NAME = 'ax_auth_session';
const DEFAULT_SESSION_LIFETIME_SECS = 7 * 24 * 60 * 60;

// Validation rails for `auth:create-bootstrap-user` input. The bootstrap
// caller is the unauthenticated UI — input is untrusted (Invariant I5).
// `displayName` is shown verbatim in the admin UI; cap so a giant string
// can't blow up the row. `email` is a basic well-formed check (no MX
// lookup): keep it cheap, lean on the DB UNIQUE for collision detection.
const MAX_DISPLAY_NAME_LEN = 200;
const MAX_EMAIL_LEN = 320;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

/**
 * Config surface for `@ax/auth-better`. All fields optional; defaults
 * mirror auth-oidc so a host swapping plugins doesn't change cookie
 * behavior unexpectedly.
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
}

// ---------------------------------------------------------------------------
// @ax/auth-better — Task 1.4 lights up the hook surface declared in 1.3.
//
// What's new vs. 1.3:
//   - Real impls for auth:require-user, auth:get-user, auth:create-bootstrap-user
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

  const PROVIDERS_CHANGED_KEY = `${PLUGIN_NAME}/providers-changed`;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'auth:require-user',
        'auth:get-user',
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
      subscribes: ['auth:providers-changed'],
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
      const providers = await loadProviders(localDb, bus, initCtx);

      // 3) Build the handler --------------------------------------------
      handle = createBetterAuthHandler({
        database: localDb,
        providers,
        ...(trustedOrigins !== undefined ? { trustedOrigins } : {}),
      });
      const localHandle = handle;

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
          const next = await loadProviders(localDb, bus, subCtx);
          localHandle.rebuild({
            database: localDb,
            providers: next,
            ...(trustedOrigins !== undefined ? { trustedOrigins } : {}),
          });
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
          // route layer is the auth gate (mirrors auth-oidc's impl).
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
          await forwardToBetterAuth(localHandle, req, res);
        };
        const { unregister } = await bus.call<HttpRegisterRouteInput, HttpRegisterRouteOutput>(
          'http:register-route',
          initCtx,
          { method, path: '/auth/*', handler },
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

/**
 * Structural minimum we need from an HTTP request adapter for
 * `auth:require-user`. Mirrors @ax/auth-oidc's `HttpRequestLike` so
 * consumers passing the same request shape Just Work across either auth
 * impl. Declared locally to avoid runtime import of @ax/auth-oidc.
 */
interface HttpRequestLike {
  readonly headers: Record<string, string>;
  signedCookie(name: string): string | null;
}

async function loadProviders(
  db: Kysely<AuthBetterDatabase>,
  bus: HookBus,
  ctx: AgentContext,
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
    const { plaintext } = await bus.call<
      { ciphertext: Uint8Array },
      { plaintext: string }
    >('credentials:envelope-decrypt', ctx, { ciphertext: r.client_secret_encrypted });
    if (r.kind === 'google' || r.kind === 'github' || r.kind === 'oidc') {
      // Build the row carefully: `discoveryUrl` is optional in the
      // ProviderRow type (exactOptionalPropertyTypes is ON), so emit
      // the field only when DB has a value. Conditional spread keeps
      // the shape clean.
      out.push({
        kind: r.kind,
        clientId: r.client_id,
        clientSecret: plaintext,
        ...(r.discovery_url !== null ? { discoveryUrl: r.discovery_url } : {}),
      });
    }
    // Unknown kinds are dropped — defensive against a forward-compat row
    // older binaries can't speak. Logging is deferred to Task 1.5 (the
    // CRUD layer is the right place to surface unknown kinds).
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
  const email =
    input.email !== undefined && input.email.length > 0
      ? input.email
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
//   1. Builds a fetch.Request from HttpRequest (URL = path + query, body
//      = req.body when present, headers as-is).
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

async function forwardToBetterAuth(
  handle: HandlerHandle,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  // Synthesize an absolute URL — better-auth's internal router parses
  // it via WHATWG URL. Hostname doesn't matter; better-auth keys off
  // the pathname + search.
  const host = req.headers['host'] ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  const queryString = serializeQuery(req.query);
  const url = `${proto}://${host}${req.path}${queryString.length > 0 ? `?${queryString}` : ''}`;

  // Fetch.Request rejects bodies on GET (and HEAD, which @ax/http-server
  // doesn't expose anyway). Pass body only when there's something to send.
  const init: RequestInit = {
    method: req.method,
    headers: webHeadersFrom(req.headers),
  };
  if (req.method !== 'GET' && req.body.length > 0) {
    // Node's undici fetch accepts a Buffer/Uint8Array as body even
    // though the lib.dom typing of `BodyInit` doesn't include Buffer
    // specifically. Cast through unknown to satisfy the structural
    // check without dragging the dom type in.
    init.body = req.body as unknown as ArrayBuffer;
  }

  let webResponse: Response;
  try {
    webResponse = await handle.current()(new Request(url, init));
  } catch (err) {
    // If better-auth's adapter init failed (handler.ts catches the
    // construction-side rejection but request-time rejections still
    // propagate), surface a 500 without leaking the inner message —
    // better-auth's errors can echo request-derived fields (state,
    // email, callback URL params), so we omit `err.message` from the
    // log line entirely. Method + path is enough to correlate with
    // upstream http-server access logs.
    void err;
    process.stderr.write(
      `[ax/auth-better] handler error on ${req.method} ${req.path}\n`,
    );
    res.status(500).json({ error: 'auth-handler-failed' });
    return;
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
  if (setCookies.length > 0) {
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
  if (buf.length === 0) {
    res.end();
  } else {
    // res.body() preserves any prior content-type from the loop above.
    res.body(buf);
  }
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

function serializeQuery(query: Record<string, string>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return pairs.join('&');
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
    if (err instanceof PluginError && err.code === 'unauthenticated') {
      res.status(401).json({ error: 'unauthenticated' });
      return false;
    }
    // Unknown failure — surface a 500 without leaking the cause.
    res.status(500).json({ error: 'auth-check-failed' });
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
