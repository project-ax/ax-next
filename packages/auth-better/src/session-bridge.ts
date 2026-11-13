import { AsyncLocalStorage } from 'node:async_hooks';
import { APIError } from 'better-auth';

/**
 * One box per `/auth/*` request. plugin.ts's forwardToBetterAuth creates it and
 * runs the better-auth call inside sessionTokenALS.run(box, ...). Nothing in it
 * is read from the request, so a client can't forge any field.
 *
 * - `malformedHost`: set by forwardToBetterAuth when the Host header wasn't a
 *   bare `host[:port]`. handler.ts's refuse plugin answers it with a 400.
 * - `refused`: set by that plugin when it actually served the 400 (a request
 *   over the rate limit gets Better Auth's 429 instead), so forwardToBetterAuth
 *   logs only refusals that happened.
 * - `token`: the session token better-auth mints during a sign-in flow, written
 *   by handler.ts's databaseHooks.session.create.after. forwardToBetterAuth
 *   re-issues it as the http-server-signed ax_auth_session cookie, keeping
 *   auth_better_v1_sessions + ax_auth_session the single source of truth even
 *   though better-auth would set its own cookie.
 */
export interface AuthRequestBox {
  token?: string;
  malformedHost?: boolean;
  refused?: boolean;
}

export const sessionTokenALS = new AsyncLocalStorage<AuthRequestBox>();

/** Parse the provider's allowed_domains (comma-separated) into lowercased bare domains. */
export function parseDomains(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
}

/** Domain portion of an email (after the last @), lowercased; '' if malformed. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '';
  return email.slice(at + 1).toLowerCase();
}

/**
 * THE approved-domain predicate. An empty `allowed` list means any domain
 * (blank = open). Otherwise the email's domain must equal a listed one exactly:
 * a subdomain is not a match, and an email with no domain never is. `allowed`
 * is expected from `parseDomains` (lowercased, trimmed).
 *
 * The Google sign-in gate (`assertDomainAllowed`) and `auth:find-user-by-email`
 * both answer through this one function, so "who may sign in" and "who Slack
 * may map to an account" can't drift apart.
 */
export function isDomainAllowed(email: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.includes(emailDomain(email));
}

/**
 * Authorization gate for Google provisioning. Empty `allowed` => open. Throws
 * better-auth's APIError (FORBIDDEN) so a rejected sign-in surfaces as a clean
 * 403 from better-auth's router rather than an unhandled 500. Message is generic
 * — never echoes the allowed list or the rejected email.
 */
export function assertDomainAllowed(email: string, allowed: string[]): void {
  if (!isDomainAllowed(email, allowed)) {
    throw new APIError('FORBIDDEN', { message: 'email domain not permitted' });
  }
}
