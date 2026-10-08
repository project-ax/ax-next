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

/**
 * Why `begin` refused before any popup opened (slice 3). Matched by the
 * client against the server's status AND error word; the sentence is ours.
 *   - `agent-store-refused`   — no agent may hold this connector's sign-in:
 *                              the workspace refused to store it
 *                              (e.g. the connector has no live definition).
 *                              An admin fixes it.
 *   - `not-on-agent`          — Sign in again, but the connector was removed.
 *   - `already-attached`      — an Add of a connector already on the agent.
 *   - `client-secret-missing` — its custom OAuth client's secret is gone from
 *                              the workspace (SIGNINS-7). An admin fixes it.
 */
export type BeginRefusal =
  | 'agent-store-refused'
  | 'not-on-agent'
  | 'already-attached'
  | 'client-secret-missing';

export function beginRefusalMessage(refusal: BeginRefusal): string {
  switch (refusal) {
    case 'agent-store-refused':
      return "This connector can't be added to agents right now. Ask a workspace admin.";
    case 'client-secret-missing':
      return "This connector's client secret is missing. Ask a workspace admin to enter it again.";
    case 'not-on-agent':
      return "This connector isn't on this agent any more.";
    case 'already-attached':
      return "It's already on this agent.";
  }
}
