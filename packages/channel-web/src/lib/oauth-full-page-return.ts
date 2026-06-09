/**
 * Full-page OAuth return handler — the fallback for when the provider redirect
 * lands in the main window rather than the popup.
 *
 * The happy path is a popup: the bridge in main.tsx posts the outcome to the
 * opener and closes the popup before React ever mounts. But some providers and
 * some environments (popup blockers, email-link flows) redirect the MAIN window
 * instead. This module handles that case: strip the /oauth/connected params,
 * push a toast, and leave the user on the chat surface.
 *
 * Exported as a pure function so it's trivially testable without mounting App.
 * App.tsx calls it once on mount (inside a one-shot useEffect).
 */

export type OAuthFullPageOutcome = 'success' | 'error';

export interface OAuthFullPageResult {
  toast: OAuthFullPageOutcome;
}

export interface OAuthFullPageEnv {
  pathname: string;
  search: string;
  /** True if there IS an opener (popup case — already handled by the bridge). */
  hasOpener: boolean;
}

/**
 * Inspect the current location. Returns a result describing what toast to show,
 * or null if this is not a full-page OAuth return (the common case).
 *
 * A full-page return is: pathname === '/oauth/connected' AND no opener (the
 * popup bridge already handled the opener case in main.tsx, so this can only
 * fire when there is no opener).
 */
export function consumeOAuthFullPageReturn(
  env: OAuthFullPageEnv,
): OAuthFullPageResult | null {
  if (env.pathname !== '/oauth/connected') return null;
  // If there IS an opener, the bridge handled it and returned true → the app
  // never rendered → this function is unreachable. Belt-and-braces: if somehow
  // we get here with an opener (edge case in tests or future refactors), bail
  // so we don't double-handle.
  if (env.hasOpener) return null;

  const p = new URLSearchParams(env.search);
  const oauth = p.get('oauth');

  if (oauth === 'success') return { toast: 'success' };
  if (oauth === 'error') return { toast: 'error' };

  // Unrecognized or missing oauth param — not a valid callback; don't toast.
  return null;
}
