/**
 * Coming back from Slack's Allow page (TASK-1093).
 *
 * After an admin clicks Allow (or Cancel) on Slack's page, @ax/channel-slack's
 * OAuth callback sends their browser to `/?slack=connected|cancelled|failed`.
 * `App.tsx` reads that once, takes it out of the address bar (so a reload
 * doesn't say it again), and, for an admin, shows the toast below and opens
 * Admin › Slack, which shows how things stand.
 *
 * Only those three exact words are read, and what is shown is a fixed
 * sentence per word: nothing from the URL ever reaches the page.
 */

export type SlackInstallOutcome = 'connected' | 'cancelled' | 'failed';

const PARAM = 'slack';

function isOutcome(value: string | null): value is SlackInstallOutcome {
  return value === 'connected' || value === 'cancelled' || value === 'failed';
}

/** The outcome in a location's `search`, or null when it carries none. */
export function readSlackInstallReturn(search: string): SlackInstallOutcome | null {
  const value = new URLSearchParams(search).get(PARAM);
  return isOutcome(value) ? value : null;
}

/** `search` without the `slack` parameter, keeping everything else (`''` when nothing is left). */
export function withoutSlackInstallReturn(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(PARAM);
  const rest = params.toString();
  return rest === '' ? '' : `?${rest}`;
}

/** What the toast says. `failed` is shown as an error. */
export const SLACK_INSTALL_RETURN_MESSAGES: Readonly<Record<SlackInstallOutcome, string>> = Object.freeze({
  connected: 'Slack is connected.',
  cancelled: 'Slack install was cancelled.',
  failed: "We couldn't finish connecting Slack. Try again.",
});
