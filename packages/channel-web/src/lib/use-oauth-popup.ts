/**
 * useOAuthPopup — the popup half of a connector sign-in, as a hook.
 *
 * Lifted out of `ConnectorOAuthConnect` (TASK-740) so the connectors rail's
 * Add subview can start a sign-in from one "Sign in" click, show the row as
 * pending, and offer Cancel — none of which the widget's own button and status
 * badge could do from outside. One implementation of the flow, two surfaces:
 * the widget and the rail cannot drift into checking the callback differently.
 *
 * SECURITY (invariant #5): the `message` listener's origin filter is the
 * primary security control — any message not from `window.location.origin`,
 * not of `OAUTH_MESSAGE_TYPE`, or not naming THIS connector is silently
 * dropped. `onConnected` runs ONLY on an explicit success message; a provider
 * error, a closed popup, a blocked popup and a cancel never call it. Callers
 * that grant something on success (the rail attaches the connector) rely on
 * exactly that.
 *
 * `cancel()` is a client-side abandon: it closes the popup and stops
 * listening. If the person somehow finishes the provider's page anyway, the
 * token is stored server-side but nothing that keyed off `onConnected` runs —
 * so the rail never attaches the connector on a sign-in the person cancelled.
 *
 * Anything that renders a sign-in through this hook must also render
 * `<ConnectorAccessNotice>`; `connector-access-coverage.test.ts` scans for it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { beginOAuth } from '@/lib/connectors-oauth';
import { logRequestFailure } from '@/lib/http';
import { OAUTH_MESSAGE_TYPE } from '@/lib/oauth-callback-bridge';

export interface UseOAuthPopupArgs {
  connectorId: string;
  /** Pass for an agent-scoped connect; omit for a user-scoped one. */
  agentId?: string;
  /** Display name, used in the "sign-in didn't finish" message. */
  serviceName: string;
  /** The provider confirmed the sign-in. Never called on any other outcome. */
  onConnected?: () => void;
  /**
   * The flow ended without a cancel — success, provider error, or the popup
   * closed with no answer. The widget re-reads its status badge here.
   */
  onSettled?: () => void;
}

export interface OAuthPopupState {
  /** A sign-in is in flight (begin requested or popup open). */
  busy: boolean;
  /** A friendly message for the last failure, or null. */
  error: string | null;
  start: () => Promise<void>;
  /** Abandon the in-flight sign-in. No callback runs. */
  cancel: () => void;
}

export function useOAuthPopup({
  connectorId,
  agentId,
  serviceName,
  onConnected,
  onSettled,
}: UseOAuthPopupArgs): OAuthPopupState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so cleanup sees current values without re-registering listeners.
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const msgHandlerRef = useRef<((e: MessageEvent) => void) | null>(null);
  const busyRef = useRef(false);
  // Bumped by cancel/unmount so a begin request that resolves AFTER the
  // person cancelled never opens a popup.
  const attemptRef = useRef(0);

  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);

  const cleanup = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (msgHandlerRef.current !== null) {
      window.removeEventListener('message', msgHandlerRef.current);
      msgHandlerRef.current = null;
    }
    popupRef.current = null;
  }, []);

  useEffect(
    () => () => {
      attemptRef.current += 1;
      cleanup();
    },
    [cleanup],
  );

  const cancel = useCallback(() => {
    attemptRef.current += 1;
    const popup = popupRef.current;
    cleanup();
    try {
      popup?.close();
    } catch {
      // A cross-origin popup may refuse; the listener is gone either way.
    }
    setError(null);
    setBusyBoth(false);
  }, [cleanup, setBusyBoth]);

  const start = useCallback(async () => {
    // Double-click guard: a fast second click before the disabled-state
    // re-render would otherwise register a second listener + interval.
    if (busyRef.current) return;
    const attempt = ++attemptRef.current;
    setError(null);
    setBusyBoth(true);

    let authorizationUrl: string;
    try {
      const result = await beginOAuth(
        agentId !== undefined ? { connectorId, agentId } : { connectorId },
      );
      authorizationUrl = result.authorizationUrl;
    } catch (e) {
      // Never silent (TASK-757): the person sees the sentence below, the
      // console gets the reason.
      logRequestFailure(e, `oauth-sign-in ${connectorId}`);
      if (attemptRef.current !== attempt) return;
      setError("We couldn't start the sign-in. Please try again — if it keeps happening, let us know.");
      setBusyBoth(false);
      return;
    }
    if (attemptRef.current !== attempt) return; // cancelled while beginning

    const popup = window.open(authorizationUrl, 'ax-oauth-connect', 'width=600,height=720');
    // Popup-blocked guard: without it the listener + poll register against
    // null, busy stays true forever, and no error is shown.
    if (!popup) {
      setError("We couldn't open the sign-in window — check your popup blocker and try again.");
      setBusyBoth(false);
      return;
    }
    popupRef.current = popup;

    // ── Message listener (origin-locked — load-bearing security control) ──
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; connector?: string; oauth?: string } | null;
      if (!data || data.type !== OAUTH_MESSAGE_TYPE) return;
      // Strict connector match: a message that can't prove it's for this
      // connector is ignored, so it can't tear down another instance's flow.
      if (data.connector !== connectorId) return;

      cleanup();
      setBusyBoth(false);
      if (data.oauth === 'error') {
        setError(`Sign-in didn't finish, so ${serviceName} isn't connected. You can try again whenever you're ready.`);
        onSettled?.();
        return; // never onConnected on failure
      }
      onSettled?.();
      onConnected?.();
    };
    msgHandlerRef.current = handler;
    window.addEventListener('message', handler);

    // The person closed the popup without an answer: stop waiting.
    pollRef.current = setInterval(() => {
      if (popupRef.current?.closed) {
        cleanup();
        setBusyBoth(false);
        onSettled?.();
      }
    }, 500);
  }, [connectorId, agentId, serviceName, cleanup, setBusyBoth, onConnected, onSettled]);

  return { busy, error, start, cancel };
}
