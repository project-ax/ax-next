/**
 * @ax/auth-oidc public hook payload types.
 *
 * BOUNDARY CONTRACT — these types are the auth alternate-impl boundary
 * (mirrors the `@ax/sandbox-k8s` / `@ax/sandbox-subprocess` pattern).
 * A future `@ax/auth-better-auth`, `@ax/auth-saml`, or `@ax/auth-local`
 * MUST register the same hook surface with the same shapes. Consumers
 * (`@ax/agents`, the chat orchestrator, the CLI bootstrap, channel-web)
 * resolve users only through the bus — they MUST NOT duplicate the
 * `User` type or speak directly to `auth_v1_*` tables.
 *
 * Lock-ins keeping the swap cheap:
 *   1. `User` lives here only. Consumers reference this type, never copy
 *      it. Drift = boundary violation. If a consumer needs a subset
 *      (`{userId, isAdmin}` for an actor payload), that's fine — subsets
 *      don't break alternate impls.
 *   2. Tenant tables (`auth_v1_*`) are scoped to this package's
 *      `store.ts`. The `local/no-bare-tenant-tables` ESLint rule
 *      enforces it; alternate impls own their own tables.
 *   3. IdP-callback error sanitization is part of the contract, not the
 *      impl: an alternate auth plugin MUST log only `error.code`,
 *      NEVER `error.message` (raw IdP errors carry user-controlled
 *      `state` and other request echoes). See `oidc.ts`'s
 *      `auth_callback_failed` log line for the established shape.
 *
 * NOTE on `HttpRequestLike`: this plugin MUST NOT import from
 * `@ax/http-server` (Invariant I2 — no cross-plugin imports). To accept a
 * request adapter without that import, we declare the structural minimum we
 * need locally. `@ax/http-server`'s `HttpRequest` duck-types compatibly
 * because TypeScript's structural typing checks shape, not nominal type.
 * Keeping the surface minimal (cookies + headers) means a future
 * alternate-impl could provide it from a non-HTTP transport with no extra
 * coupling.
 */
export interface HttpRequestLike {
  readonly headers: Record<string, string>;
  /**
   * Returns the verified plaintext for an HMAC-signed cookie, or null if
   * absent / malformed / forged. Constant-time comparison; never throws.
   */
  signedCookie(name: string): string | null;
}

/**
 * Authenticated user as seen by every consumer (chat path, admin
 * endpoints, CLI). This is the boundary type — DO NOT redefine in
 * consumers. If a future field lands (e.g., `mfaEnrolled`), add it here
 * and let TypeScript surface every consumer that needs to handle it.
 */
export interface User {
  id: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

export interface RequireUserInput {
  req: HttpRequestLike;
}

export interface RequireUserOutput {
  user: User;
}

export interface GetUserInput {
  userId: string;
}

export type GetUserOutput = User | null;

export interface CreateBootstrapUserInput {
  displayName: string;
  email?: string;
}

export interface CreateBootstrapUserOutput {
  user: User;
  /**
   * Single-use token the bootstrap CLI exchanges for a session cookie.
   * NEVER returned via `auth:require-user` / `auth:get-user` (Invariant I9 —
   * tokens never leak through hook return values).
   */
  oneTimeToken: string;
}

export interface CompleteBootstrapUserInput {
  /**
   * The single-use token returned by `auth:create-bootstrap-user`. The
   * impl maps this to a session cookie WITHOUT consuming the token's
   * single-use semantics — the same token can be exchanged once for a
   * cookie. Subsequent calls fail (no session exists for the id).
   *
   * Phase 1's auth-better impl will accept an optional `password` field
   * here; this Phase 2 impl ignores it (auth-oidc has no local password).
   */
  oneTimeToken: string;
  /** Forward-compat for Phase 1; ignored by auth-oidc. */
  password?: string;
}

export interface CompleteBootstrapUserOutput {
  /**
   * Cookie payload for the wizard route to set on its response. Cookie
   * shape is HTTP-universal (not transport-specific to auth-oidc), so
   * passing it through the bus does not violate Invariant I1. The
   * onboarding plugin sets this verbatim via `res.setSignedCookie`.
   */
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
}

/**
 * Plugin config. Pass at least one of `providers.google` or `devBootstrap`;
 * init throws `no-auth-providers` otherwise. The CLI's `serve` boot path
 * derives this from env (see `loadAuthConfigFromEnv`); programmatic callers
 * can pass it directly for tests / preset wiring.
 *
 * Why both `providers.google` and `devBootstrap` are optional individually:
 * production usually has only `google`; laptops usually have only the
 * dev-bootstrap token. Requiring both would force ops to ship a bogus
 * google client_secret in dev or a bogus token in prod.
 */
export interface AuthConfig {
  providers: {
    google?: {
      clientId: string;
      clientSecret: string;
      issuer: string;
      redirectUri: string;
    };
  };
  devBootstrap?: {
    token: string;
  };
  /** Cookie name for the http login session. Default 'ax_auth_session'. */
  sessionCookieName?: string;
  /** Session lifetime in seconds. Default 7 days. */
  sessionLifetimeSeconds?: number;
}
