import {
  makeAgentContext,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { signCookieValue } from '@ax/http-server';

/**
 * Options for `signInAsAdmin`.
 *
 * BOUNDARY: this helper is plugin-implementation-AGNOSTIC — it speaks the
 * `auth:create-bootstrap-user` service-hook surface only. Works against
 * `@ax/auth-better` today and against any future alternate impl that
 * registers the same hook surface.
 *
 * Why test-harness imports `@ax/http-server`: the helper needs to sign the
 * session cookie with the same key the http-server registers, so a
 * subsequent fetch round-trips through `signedCookie()`. test-harness is
 * test infrastructure — not a plugin — so the cross-package import is not
 * an Invariant I2 violation. (Both are workspace packages; the constraint
 * is about plugins talking to each other through the bus, and this helper
 * IS the bus consumer in a test.)
 */
export interface SignInAsAdminOptions {
  bus: HookBus;
  /**
   * Same cookie key passed to `createHttpServerPlugin({ cookieKey })`. The
   * helper signs the oneTimeToken with this key so the resulting cookie
   * round-trips through @ax/http-server's `signedCookie` validator.
   */
  cookieKey: Buffer;
  ctx?: AgentContext;
  /** Defaults to `'ax_auth_session'` (the default in auth-better). */
  sessionCookieName?: string;
  /** Defaults to `'Admin McAdminface'`. */
  displayName?: string;
  /** Defaults to `'admin@example.com'`. */
  email?: string;
}

export interface SignInAsAdminResult {
  /** Ready-to-use Cookie header value: `<name>=<signed>`. */
  cookieHeader: string;
  /** Just the signed payload, useful when constructing a cookies object. */
  signedCookieValue: string;
  /** The minted user (id, email, displayName, isAdmin). Returned for assertions. */
  user: unknown;
}

/**
 * Mint an admin user via the `auth:create-bootstrap-user` hook and produce
 * a signed session cookie ready to attach to a `fetch()` call. Used by
 * Phase 1+ tests that need an authenticated admin context.
 *
 * The hook returns a `oneTimeToken` whose value is the session-cookie
 * plaintext; we sign it with the host's cookie key and format both the
 * raw signed value and the `<name>=<signed>` header form so callers can
 * attach it however they need.
 */
export async function signInAsAdmin(
  opts: SignInAsAdminOptions,
): Promise<SignInAsAdminResult> {
  const ctx =
    opts.ctx ??
    makeAgentContext({
      sessionId: 'test-sign-in',
      agentId: 'test-harness',
      userId: 'system',
    });
  const out = await opts.bus.call<
    { displayName: string; email?: string },
    { user: unknown; oneTimeToken: string }
  >('auth:create-bootstrap-user', ctx, {
    displayName: opts.displayName ?? 'Admin McAdminface',
    email: opts.email ?? 'admin@example.com',
  });
  const sessionCookieName = opts.sessionCookieName ?? 'ax_auth_session';
  const signedCookieValue = signCookieValue(opts.cookieKey, out.oneTimeToken);
  return {
    cookieHeader: `${sessionCookieName}=${signedCookieValue}`,
    signedCookieValue,
    user: out.user,
  };
}
