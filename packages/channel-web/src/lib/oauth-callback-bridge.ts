/**
 * SPA OAuth callback bridge — runs early in main.tsx before the React app boots.
 *
 * When the provider redirects the popup to /oauth/connected?oauth=success|error&connector=<id>,
 * this module detects that, posts the outcome to the opener window (origin-locked),
 * and closes the popup. The main app never renders in the popup case.
 *
 * If there is no opener (full-page redirect fallback), returns false so the App
 * can render and handle the params itself (Task 12 — toast + param strip).
 */

export const OAUTH_MESSAGE_TYPE = 'ax:oauth-callback';

export interface OAuthReturnEnv {
  pathname: string;
  search: string;
  origin: string;
  opener: Pick<Window, 'postMessage'> | null;
  closeSelf: () => void;
}

/**
 * Detect and handle an OAuth callback return.
 *
 * Returns true if the popup case was fully handled (caller must NOT boot the
 * React app — the window will close). Returns false if the app should boot
 * normally (non-oauth path, no opener, or unrecognized oauth value).
 */
export function handleOAuthReturn(env: OAuthReturnEnv): boolean {
  if (env.pathname !== '/oauth/connected') return false;

  const p = new URLSearchParams(env.search);
  const oauth = p.get('oauth');
  const connector = p.get('connector') ?? undefined;

  if (oauth !== 'success' && oauth !== 'error') return false;

  if (env.opener) {
    env.opener.postMessage(
      { type: OAUTH_MESSAGE_TYPE, connector, oauth },
      env.origin,
    );
    env.closeSelf();
    return true; // popup handled — caller must NOT boot the app
  }

  return false; // full-page fallback: App strips params + toasts (Task 12)
}

/**
 * Production entry point. Called from main.tsx before createRoot.
 * Returns true if this is the popup return case (do not render the app).
 */
export function runOAuthBridge(): boolean {
  if (typeof window === 'undefined') return false;
  return handleOAuthReturn({
    pathname: window.location.pathname,
    search: window.location.search,
    origin: window.location.origin,
    opener:
      window.opener && window.opener !== window
        ? (window.opener as Window)
        : null,
    closeSelf: () => window.close(),
  });
}
