/**
 * @ax/auth public hook payload types.
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
