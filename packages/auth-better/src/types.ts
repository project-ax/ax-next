/**
 * @ax/auth-better public hook payload types.
 *
 * BOUNDARY CONTRACT — these types are the auth alternate-impl boundary
 * (mirrors the `@ax/sandbox-k8s` / `@ax/sandbox-subprocess` pattern).
 * A future `@ax/auth-saml`, `@ax/auth-passkeys`, or any other auth plugin
 * MUST register the same hook surface with the same shapes. Consumers
 * (`@ax/agents`, the chat orchestrator, the CLI bootstrap, channel-web)
 * resolve users only through the bus — they MUST NOT duplicate the
 * `User` type or speak directly to `auth_better_v1_*` tables.
 *
 * Lock-ins keeping the swap cheap:
 *   1. `User` lives here only. Consumers reference this type, never copy
 *      it. Drift = boundary violation. If a consumer needs a subset
 *      (`{userId, isAdmin}` for an actor payload), that's fine — subsets
 *      don't break alternate impls.
 *   2. Tenant tables (`auth_better_v1_*`) are scoped to this package's
 *      `migrations.ts` + `plugin.ts`. Alternate impls own their own tables.
 *   3. IdP-callback error sanitization is part of the contract, not the
 *      impl: an alternate auth plugin MUST log only `error.code`,
 *      NEVER `error.message` (raw IdP errors carry user-controlled
 *      `state` and other request echoes).
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
  /**
   * Forward-compat: a future local-password slice will hash + persist this
   * via better-auth's credential account. Today it is accepted but ignored
   * by the auth-better impl (see plugin.ts `createBootstrapUser`).
   */
  password?: string;
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
   * impl wraps this token into a cookie payload without touching
   * session state — the session was already persisted by
   * `auth:create-bootstrap-user` and stays valid until normal session
   * expiry. Single-use enforcement is the caller's responsibility: the
   * onboarding wizard's `/setup/admin` route destroys the bootstrap
   * session before/after this call so the token can't be replayed.
   */
  oneTimeToken: string;
  /** Forward-compat for the local-password slice; ignored today. */
  password?: string;
}

export interface CompleteBootstrapUserOutput {
  /**
   * Cookie payload for the wizard route to set on its response. Cookie
   * shape is HTTP-universal (not transport-specific to the impl), so
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
