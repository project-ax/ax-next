import { AsyncLocalStorage } from 'node:async_hooks';
import { APIError } from 'better-auth';

/**
 * Request-scoped carrier for the session token better-auth mints during a
 * sign-in flow. handler.ts's databaseHooks.session.create.after writes
 * box.token; plugin.ts's forwardToBetterAuth runs the better-auth call inside
 * sessionTokenALS.run(box, ...) and re-issues the token as the http-server-
 * signed ax_auth_session cookie. Keeps auth_better_v1_sessions + ax_auth_session
 * the single source of truth even though better-auth would set its own cookie.
 */
export const sessionTokenALS = new AsyncLocalStorage<{ token?: string }>();

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
 * Authorization gate for Google provisioning. Empty `allowed` => open. Throws
 * better-auth's APIError (FORBIDDEN) so a rejected sign-in becomes a clean
 * callback-error redirect, not a 500. Message is generic (never echoes the list).
 */
export function assertDomainAllowed(email: string, allowed: string[]): void {
  if (allowed.length === 0) return;
  if (!allowed.includes(emailDomain(email))) {
    throw new APIError('FORBIDDEN', { message: 'email domain not permitted' });
  }
}
