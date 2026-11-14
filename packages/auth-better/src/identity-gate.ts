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
// handler.ts wires it as better-auth's `user.validateUserInfo`. better-auth 1.7
// runs it on the OAuth callback (create-user, link-account and sign-in, naming
// the provider in `source.oauth.providerId`) and inside every
// `internalAdapter.createUser`, which fails closed when a caller names no
// source. A refusal becomes a redirect to `/auth/error?error=<code>` on a
// browser flow (a 403 elsewhere), and a throw from here is a 403
// `validation_failed`: it fails closed.
//
// It does NOT run everywhere a sign-in method is added to an existing account.
// Three better-auth paths add one without it: `/link-social` with an ID token
// (`createAccount` straight from the token), `/reset-password` (a password),
// and the server-only `setPassword`. Config keeps them shut, and that config is
// load-bearing: Google's `disableIdTokenSignIn` (the only guard on the first;
// GitHub has no ID-token sign-in), no `sendResetPassword` (no reset token can
// be minted), and no route for `setPassword`. Re-check this list on a
// better-auth upgrade.
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
  | 'email_not_supported'
  | 'email_mismatch'
  | 'email_domain_not_allowed'
  | 'account_not_linkable';

/** An identity better-auth is about to admit. */
export interface IdentityAttempt {
  action: ValidateUserInfoAction;
  method: string;
  providerId: string | undefined;
  /**
   * The email exactly as the provider sent it, or null when there is none the
   * gate can trust (see createIdentityGate). Never better-auth's `user.email`,
   * which has been through `toLowerCase()` by the time the gate runs.
   */
  email: string | null;
  /** What the PROVIDER asserted about this email, never what the local row says. */
  emailVerified: boolean;
}

/** The existing local user that a link or a sign-in lands on. */
export interface LocalUserFacts {
  /** The account's own email, as stored on its row. */
  email: string;
  emailVerified: boolean;
  role: string;
  accountCount: number;
}

/** The provider kinds ax wires into better-auth. Any other kind configures nothing. */
export const GATED_KINDS: ReadonlySet<string> = new Set(['google', 'github']);

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
 * The sign-in gate (`decideIdentity` rule 5) applies it to the list of the
 * provider being used. `isOnApprovedDomain` applies it across every
 * provider's list, for checks that aren't a sign-in.
 */
export function isDomainAllowed(email: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.includes(emailDomain(email));
}

/**
 * Is `email` on an approved sign-in domain, for a check that isn't itself a
 * sign-in (`auth:find-user-by-email`, TASK-1092)? `lists` holds every gated
 * provider's parsed list, enabled or not. The email must be on at least one
 * non-blank list. A blank list adds nothing, and only when no provider has a
 * list at all is every domain approved, the same as sign-in with no lists.
 *
 * This fails closed where sign-in is per provider: with Google limited to
 * canopyworks.com and GitHub left blank, a gmail GitHub member can sign in
 * but is not on an approved domain here. Sign-in also lets an existing admin
 * through an off-domain list; this doesn't.
 */
export function isOnApprovedDomain(
  email: string,
  lists: ReadonlyArray<readonly string[]>,
): boolean {
  const set = lists.filter((l) => l.length > 0);
  if (set.length === 0) return true;
  return set.some((l) => isDomainAllowed(email, l));
}

/**
 * True when every character is printable ASCII, U+0021 to U+007E: no space, no
 * control character, nothing beyond ASCII. The gate compares only such emails,
 * so folding their case can't turn one address into another.
 */
export function isPlainAscii(s: string): boolean {
  return /^[\x21-\x7E]+$/.test(s);
}

/**
 * Two emails are the same address when they match ignoring ASCII case only.
 * Not `toLowerCase()`: that maps some non-ASCII letters onto ASCII ones (the
 * Kelvin sign U+212A becomes "k"), which would make two different mailboxes
 * compare equal.
 */
function sameEmail(a: string, b: string): boolean {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return fold(a) === fold(b);
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

  // 3. Every rule below reads the email as the provider spelled it, and only
  //    plain ASCII: one with any other character is refused outright, admins
  //    included. Case-folding then can't make two mailboxes one. (better-auth
  //    lowercases with full Unicode rules, which turned a GitHub address
  //    written with the Kelvin sign into a teammate's.) The cost: someone
  //    whose address really has an accented letter can't sign in here.
  const email = attempt.email;
  if (email === null || !isPlainAscii(email)) return 'email_not_supported';

  // 4. A link or a sign-in lands on an existing account only when the provider
  //    vouches for THAT account's own email. better-auth finds the account for
  //    a sign-in by the provider's account id, never by email, so without this
  //    a link made once keeps working whatever email the provider names now.
  //    Before TASK-1116, `trustedProviders` let a GitHub account holding an
  //    UNVERIFIED copy of a teammate's email link into their account. Nothing
  //    in the data marks those rows, and their holder can verify an address of
  //    their own. This runs before the domain list, which never turns an admin
  //    away. The cost: someone whose provider email changed since they linked
  //    it (a renamed Google account, a new GitHub primary email) is refused
  //    until it matches again, or until the operator changes the account's
  //    email after confirming it's them (deploy/GKE.md 4i: there's no UI).
  if (attempt.action !== 'create-user') {
    if (local === undefined) return 'account_not_linkable';
    if (!sameEmail(email, local.email)) return 'email_mismatch';
  }

  // 5. The email's domain must be in THAT provider's list, on every action, so
  //    an off-domain member made while the old check was dead is refused at its
  //    next sign-in. One exception: an existing admin. Admins are appointed by
  //    the operator (the setup wizard or SQL), never admitted by a sign-up, and
  //    the list must not lock the operator out of their own install.
  const existingAdmin = attempt.action !== 'create-user' && local?.role === 'admin';
  if (!isDomainAllowed(email, list) && !existingAdmin) {
    return 'email_domain_not_allowed';
  }

  // 6. A link attaches this sign-in to an account that already exists, so that
  //    account must be one nobody else could have set up: its email is
  //    verified, or it is the setup wizard's admin waiting for its first
  //    sign-in (role admin, no sign-in method yet). An unverified row with a
  //    sign-in method is what a pre-registered password left behind. (Rule 4
  //    already refused a link that lands on no user.)
  if (attempt.action === 'link-account' && local !== undefined) {
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
    // The email exactly as the provider sent it: the raw profile, which
    // better-auth 1.7 passes on every OAuth path (Google's ID-token claims,
    // GitHub's `/user` with its primary email filled in). Not `user.email`:
    // better-auth has lowercased that with full Unicode rules, so a look-alike
    // written with the Kelvin sign U+212A arrives there as an ASCII address.
    // And only when it is the address better-auth itself will look up, store or
    // link (`user.email`), so the gate never approves one address while
    // better-auth acts on another. A path that passes no profile email is
    // refused (fail closed): re-check that every path still passes one on a
    // better-auth upgrade.
    const sent = source.oauth?.profile?.email;
    const acted = String(user.email ?? '');
    const attempt: IdentityAttempt = {
      action: source.action,
      method: source.method,
      providerId: source.oauth?.providerId,
      email: typeof sent === 'string' && sameEmail(sent, acted) ? sent : null,
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
          email: String(found.email ?? ''),
          emailVerified: found.emailVerified === true,
          role: String((found as { role?: unknown }).role ?? 'user'),
          accountCount: accounts.length,
        };
      }
    }

    const refusal = decideIdentity(attempt, allowedDomains, local);
    if (refusal === null) return undefined;
    logRefusal(refusal, attempt);
    return { error: refusal, errorDescription: REFUSAL_DESCRIPTION };
  };
}

/**
 * One stderr line per refusal, so a turned-away sign-in leaves a trace an
 * operator can find. Code-only, like the other `[ax/auth-better]` lines
 * (TASK-1047): the refusal code, better-auth's action and the provider id,
 * all fixed values. Never the email, its domain or the allowed list, which
 * would put a person's address (or an attacker's text) in the log.
 */
function logRefusal(code: IdentityRefusal, attempt: IdentityAttempt): void {
  const fields = { code, action: attempt.action, provider: attempt.providerId ?? null };
  process.stderr.write(`[ax/auth-better] sign-in refused ${JSON.stringify(fields)}\n`);
}
