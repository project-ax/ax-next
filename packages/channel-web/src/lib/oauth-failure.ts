/**
 * Why a connector sign-in failed, as one of four fixed words (slice 3).
 *
 * The OAuth callback redirects to `/oauth/connected?…&oauth=error&reason=<r>`.
 * The URL is attacker-reachable (anyone can link to it), so the reason is
 * only ever compared against this list: anything else is dropped, and what
 * reaches the screen is OUR sentence for the word, never text from the URL or
 * the provider.
 *
 *   - `cancelled`      — the provider said the person declined.
 *   - `not-allowed`    — they may no longer set this agent's account.
 *   - `add-failed`     — signed in, but the attach was refused or threw; the
 *                        token was deleted, so nothing was saved.
 *   - `sign-in-failed` — anything else.
 */

export const OAUTH_FAILURE_REASONS = [
  'cancelled',
  'not-allowed',
  'add-failed',
  'sign-in-failed',
] as const;

export type OAuthFailureReason = (typeof OAUTH_FAILURE_REASONS)[number];

/** What a sign-in is for: adding the connector, or replacing its sign-in. */
export type OAuthMode = 'add' | 'sign-in-again';

/** The reason if it is exactly one of the four; otherwise `undefined`. */
export function parseOAuthFailureReason(value: unknown): OAuthFailureReason | undefined {
  return typeof value === 'string' &&
    (OAUTH_FAILURE_REASONS as readonly string[]).includes(value)
    ? (value as OAuthFailureReason)
    : undefined;
}

/**
 * The fixed sentence for a failed sign-in. `undefined` (no reason, or one we
 * don't know) and `sign-in-failed` share the generic sentence.
 */
export function oauthFailureMessage(
  reason: OAuthFailureReason | undefined,
  mode: OAuthMode,
  serviceName: string,
): string {
  switch (reason) {
    case 'cancelled':
      return mode === 'add'
        ? 'Sign-in was cancelled, so nothing was added.'
        : 'Sign-in was cancelled, so nothing changed.';
    case 'not-allowed':
      return mode === 'add'
        ? "You can't add connectors to this agent any more."
        : "You can't sign in on this agent any more.";
    case 'add-failed':
      return "You signed in, but we couldn't add it to this agent. Nothing was saved; try again.";
    default:
      return `Sign-in didn't finish, so ${serviceName} isn't connected. You can try again whenever you're ready.`;
  }
}
