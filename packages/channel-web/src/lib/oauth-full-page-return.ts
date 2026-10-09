/**
 * Full-page OAuth return handler — the fallback for when the provider redirect
 * lands in the main window rather than the popup.
 *
 * The happy path is a popup: the bridge in main.tsx posts the outcome to the
 * opener and closes the popup before React ever mounts. But some providers and
 * some environments (popup blockers, email-link flows) redirect the MAIN window
 * instead. This module handles that case: strip the /oauth/connected params,
 * push a toast, and return to the originating agent's connectors settings.
 *
 * Exported as a pure function so it's trivially testable without mounting App.
 * App.tsx calls it once on mount (inside a one-shot useEffect).
 */

import { parseWorkspaceRoute, workspaceRoutePath } from './workspace-route';
import {
  oauthFailureMessage,
  parseOAuthFailureReason,
  type OAuthFailureReason,
} from './oauth-failure';

export type OAuthFullPageOutcome = 'success' | 'error';

export interface OAuthFullPageResult {
  toast: OAuthFullPageOutcome;
  /** Slice 3 — only on an error, and only one of the four known reasons. */
  reason?: OAuthFailureReason;
  /** The originating agent's connectors settings, when its id is usable. */
  returnPath?: string;
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

  // Build a fixed local route rather than accepting an arbitrary destination.
  // Reject empty ids before the lenient parser can drop an empty segment;
  // the workspace parser owns the remaining validation, including dot ids.
  const agentId = p.get('agentId');
  const route = agentId === null || agentId.length === 0 ? null : parseWorkspaceRoute(
    `/workspace/agents/${encodeURIComponent(agentId)}/settings/connectors`,
  );
  const destination = route?.kind === 'agent-settings'
    ? { returnPath: workspaceRoutePath(route) }
    : {};

  if (oauth === 'success') return { toast: 'success', ...destination };
  if (oauth === 'error') {
    const reason = parseOAuthFailureReason(p.get('reason'));
    return { toast: 'error', ...(reason !== undefined ? { reason } : {}), ...destination };
  }

  // Unrecognized or missing oauth param — not a valid callback; don't toast.
  return null;
}

/**
 * The error toast for a full-page return. A known reason gets its fixed
 * sentence (never URL text). This page can't tell an Add from a Sign in again;
 * the reasons other than `sign-in-failed` are an Add's, so they read as one.
 */
export function oauthFullPageErrorMessage(reason: OAuthFailureReason | undefined): string {
  return reason !== undefined && reason !== 'sign-in-failed'
    ? oauthFailureMessage(reason, 'add', '')
    : "Couldn't connect. Please try again.";
}
