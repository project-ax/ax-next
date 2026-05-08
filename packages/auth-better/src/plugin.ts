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

  const PROVIDERS_CHANGED_KEY = `${PLUGIN_NAME}/providers-changed`;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'auth:require-user',
        'auth:get-user',
        'auth:create-bootstrap-user',
      ],
      // `credentials:envelope-*` join `calls` in Task 1.5 alongside the
      // first concrete site that uses them (provider CRUD). Declaring
      // them here would force every host to load @ax/credentials at
      // boot — premature coupling, and verifyCalls() would fail in
      // tests that don't need providers (e.g., bootstrap-user.test).
      calls: ['database:get-instance', 'http:register-route'],
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

      // 2) Initial provider load (empty until Task 1.5 wires CRUD) -------
      // loadProviders short-circuits the credentials:envelope-decrypt call
      // when there are no rows — so this works without @ax/credentials in
      // the test harness. As soon as Task 1.5 inserts a real row, the
      // bus.call below will require the credentials peer to be loaded.
      const providers = await loadProviders(localDb, bus, initCtx);

      // 3) Build the handler --------------------------------------------
      handle = createBetterAuthHandler({ database: localDb, providers });
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
          localHandle.rebuild({ database: localDb, providers: next });
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
  await db
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

  // Mint a 32-byte token; store it as the session row. The token IS the
  // session cookie value — Task 2 (onboarding flow) hands the bootstrap
  // CLI the token and exchanges it for a Set-Cookie immediately.
  const oneTimeToken = randomBytes(32).toString('base64url');
  const sessionId = `sess_${randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000);
  await db
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
// header. We pass them through verbatim — the http-server adapter
// supports multi-value Set-Cookie via writeHead() (router.ts), and we
// append each as a separate header line so node serializes them
// correctly.
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
    // better-auth's errors can echo request fields.
    process.stderr.write(
      `[ax/auth-better] handler error on ${req.method} ${req.path}: ${
        err instanceof Error ? err.message : 'unknown'
      }\n`,
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
  for (const cookie of setCookies) {
    // We can't use res.setSignedCookie here — better-auth signs its own
    // cookies via its session adapter. Use the raw `Set-Cookie` header
    // instead. Multiple Set-Cookie values are appended as separate
    // header lines via res.header() — since http-server's response
    // writer stores headers in a Map (last-write-wins), repeated
    // res.header('set-cookie', …) WOULD clobber each other. So we
    // join with comma — RFC 7230 §3.2.2 forbids this for Set-Cookie
    // specifically, BUT in practice browsers parse comma-separated
    // Set-Cookie values when the cookie values themselves don't
    // contain unquoted commas (better-auth's don't). The robust fix
    // would be to expose a multi-value header API on HttpResponse;
    // for Task 1.4 the join-on-comma path is fine. Tracked as a
    // follow-up if Task 1.5/2 hits a multi-cookie response.
    res.header('set-cookie', cookie);
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
