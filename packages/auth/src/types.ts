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
