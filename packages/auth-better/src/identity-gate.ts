import type { BetterAuthOptions, ValidateUserInfoAction } from 'better-auth';

// ---------------------------------------------------------------------------
// The identity gate (TASK-1116): the one place that decides who may get an ax
// account, attach a sign-in to one, or sign in to one.
//
// Before it, anyone could sign up with any email and a password, pre-claim a
// teammate's email so their first Google sign-in linked into an account the
// attacker could also use, and sign up with any Google account at all: the
// Google domain check never ran (see the note on `context.path` below).
//
// handler.ts wires it as better-auth's `user.validateUserInfo`, which better-auth
// runs before every account creation, every account link and every OAuth
// sign-in, and which names the provider in `source.oauth.providerId`. A refusal
// becomes a redirect to `/auth/error?error=<code>` on a browser flow (a 403
// elsewhere), and a throw from here is a 403 `validation_failed`: it fails
// closed.
//
// Never gate on `context.path`: in better-auth 1.7 it is the route pattern
// (`/callback/:id`), not the request path, which is how the old Google domain
// check silently never ran.
// ---------------------------------------------------------------------------

/** The one sentence a refused person sees. It names neither the email nor the domain list. */
export const REFUSAL_DESCRIPTION = "This account can't sign in here. Ask your admin for help.";

export type IdentityRefusal =
  | 'sign_in_method_not_allowed'
  | 'email_not_verified'
  | 'email_domain_not_allowed'
  | 'account_not_linkable';

/** An identity better-auth is about to admit. */
export interface IdentityAttempt {
  action: ValidateUserInfoAction;
  method: string;
  providerId: string | undefined;
  email: string;
  /** What the PROVIDER asserted about this email, never what the local row says. */
  emailVerified: boolean;
}

/** The existing local user that a link or a sign-in lands on. */
export interface LocalUserFacts {
  emailVerified: boolean;
  role: string;
  accountCount: number;
}

/** The provider kinds ax wires into better-auth. Any other kind configures nothing. */
const GATED_KINDS: ReadonlySet<string> = new Set(['google', 'github']);

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
 * The rules, in order. `allowedDomains` maps each configured provider to its own
 * list (empty = any account at that provider). `local` is the existing user a
 * link or sign-in lands on; a new account has none.
 */
export function decideIdentity(
  attempt: IdentityAttempt,
  allowedDomains: ReadonlyMap<string, readonly string[]>,
  local?: LocalUserFacts,
): IdentityRefusal | null {
  // 1. Only an OAuth sign-in through a provider ax configured.
  if (attempt.method !== 'oauth' || attempt.providerId === undefined) {
    return 'sign_in_method_not_allowed';
  }
  const list = allowedDomains.get(attempt.providerId);
  if (list === undefined) return 'sign_in_method_not_allowed';

  // 2. The provider must vouch for the email. GitHub, for one, reports
  //    unverified addresses.
  if (!attempt.emailVerified) return 'email_not_verified';

  // 3. The email's domain must be in THAT provider's list, on every action, so
  //    an off-domain member made while the old check was dead is refused at its
  //    next sign-in. One exception: an existing admin. Admins are appointed by
  //    the operator (the setup wizard or SQL), never admitted by a sign-up, and
  //    the list must not lock the operator out of their own install.
  const existingAdmin = attempt.action !== 'create-user' && local?.role === 'admin';
  if (list.length > 0 && !list.includes(emailDomain(attempt.email)) && !existingAdmin) {
    return 'email_domain_not_allowed';
  }

  // 4. A link attaches this sign-in to an account that already exists, so that
  //    account must be one nobody else could have set up: its email is
  //    verified, or it is the setup wizard's admin waiting for its first
  //    sign-in (role admin, no sign-in method yet). An unverified row with a
  //    sign-in method is what a pre-registered password left behind.
  if (attempt.action === 'link-account') {
    if (local === undefined) return 'account_not_linkable';
    if (local.emailVerified) return null;
    if (local.role === 'admin' && local.accountCount === 0) return null;
    return 'account_not_linkable';
  }
  return null;
}

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions['user']>['validateUserInfo']>;

/**
 * better-auth's `user.validateUserInfo`, built from the enabled provider rows.
 * The structural `providers` type keeps this module free of a runtime import
 * cycle with handler.ts.
 */
export function createIdentityGate(
  providers: ReadonlyArray<{ kind: string; allowedDomains?: string }>,
): ValidateUserInfo {
  const allowedDomains = new Map<string, readonly string[]>();
  for (const p of providers) {
    if (GATED_KINDS.has(p.kind)) allowedDomains.set(p.kind, parseDomains(p.allowedDomains));
  }

  return async ({ user, source }, ctx) => {
    const attempt: IdentityAttempt = {
      action: source.action,
      method: source.method,
      providerId: source.oauth?.providerId,
      email: String(user.email ?? ''),
      emailVerified: user.emailVerified === true,
    };

    // On link-account and sign-in, better-auth passes the EXISTING local user's
    // id as `user.id` (the email and emailVerified are still the provider's).
    // A new account has no local user. Lookup errors are not caught: a throw
    // here is a 403, which fails closed.
    let local: LocalUserFacts | undefined;
    if (source.action !== 'create-user') {
      const found = await ctx.context.internalAdapter.findUserById(String(user.id ?? ''));
      if (found) {
        const accounts = await ctx.context.internalAdapter.findAccounts(found.id);
        local = {
          emailVerified: found.emailVerified === true,
          role: String((found as { role?: unknown }).role ?? 'user'),
          accountCount: accounts.length,
        };
      }
    }

    const refusal = decideIdentity(attempt, allowedDomains, local);
    return refusal === null ? undefined : { error: refusal, errorDescription: REFUSAL_DESCRIPTION };
  };
}
