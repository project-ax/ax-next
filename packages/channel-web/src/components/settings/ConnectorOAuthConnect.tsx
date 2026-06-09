/**
 * ConnectorOAuthConnect — reusable OAuth connect/reconnect widget for a single
 * MCP connector. Handles:
 *
 *   - Status polling (on mount + after a successful OAuth round-trip).
 *   - Optional consent gate (for agent-scope connects where the authorization
 *     acts as the current user on behalf of a shared agent).
 *   - Popup-based OAuth flow: opens a provider authorization URL in a small
 *     window, listens for the `ax:oauth-callback` postMessage from the bridge
 *     page, and handles the popup-closed-without-message (user dismissed) case.
 *
 * SECURITY (invariant #5): The `message` listener origin filter is the primary
 * security control — any message not from `window.location.origin` is silently
 * dropped. This is tested explicitly (ConnectorOAuthConnect.test.tsx test (f)).
 *
 * shadcn primitives + semantic tokens only (invariant #6). No raw colors.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  beginOAuth,
  getOAuthStatus,
  type OAuthStatus,
} from '@/lib/connectors-oauth';
import { OAUTH_MESSAGE_TYPE } from '@/lib/oauth-callback-bridge';

export interface ConnectorOAuthConnectProps {
  connectorId: string;
  serviceName: string;
  /** Pass for a team-agent (agent-scope) connect; omit for personal/Connectors-tab. */
  agentId?: string;
  /**
   * When true (team agent), show the shared-key consent line before connecting.
   * The Connect button is not reachable until the user accepts.
   */
  requiresConsent?: boolean;
  /** Called after a successful connect so the parent can refresh. */
  onConnected?: () => void;
}

export function ConnectorOAuthConnect({
  connectorId,
  agentId,
  serviceName,
  requiresConsent = false,
  onConnected,
}: ConnectorOAuthConnectProps) {
  // 'checking' while the status request is in flight; 'error' if the fetch threw.
  const [status, setStatus] = useState<OAuthStatus | 'checking' | 'error'>('checking');
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so cleanup functions in useEffect see current values without adding
  // them to effect deps (avoids re-registering the popup listener on every
  // render).
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const msgHandlerRef = useRef<((e: MessageEvent) => void) | null>(null);

  const fetchStatus = useCallback(async () => {
    setStatus('checking');
    try {
      const s = await getOAuthStatus(
        agentId !== undefined ? { connectorId, agentId } : { connectorId },
      );
      setStatus(s);
    } catch {
      // On status fetch failure, surface a distinct 'error' state (design §8 —
      // a fetch failure must not be reported as "Not connected").
      setStatus('error');
    }
  }, [connectorId, agentId]);

  // Fetch status on mount and whenever connectorId/agentId change.
  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Cleanup helper — clears the popup poll + message listener.
  const cleanupPopupFlow = useCallback(() => {
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

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      cleanupPopupFlow();
    };
  }, [cleanupPopupFlow]);

  const handleConnect = useCallback(async () => {
    // M5 — double-click guard: a fast second click before the disabled-state
    // re-render would otherwise register a second listener + interval.
    if (busy) return;
    setError(null);
    setBusy(true);

    let authorizationUrl: string;
    try {
      const result = await beginOAuth(
        agentId !== undefined ? { connectorId, agentId } : { connectorId },
      );
      authorizationUrl = result.authorizationUrl;
    } catch {
      setError("We couldn't start the sign-in. Please try again — if it keeps happening, let us know.");
      setBusy(false);
      return;
    }

    // Open the provider's auth URL in a small popup window.
    const popup = window.open(
      authorizationUrl,
      'ax-oauth-connect',
      'width=600,height=720',
    );

    // C1 — popup-blocked guard: window.open() returns null when a popup blocker
    // intervenes. Without this guard, the listener + poll are registered against
    // null, busy stays true forever, and no error is shown.
    if (!popup) {
      setError("We couldn't open the sign-in window — check your popup blocker and try again.");
      setBusy(false);
      return;
    }

    popupRef.current = popup;

    // ── Message listener (origin-locked — load-bearing security control) ──
    // MUST check: event.origin === window.location.origin AND type ===
    // OAUTH_MESSAGE_TYPE. Any other message is silently ignored.
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; connector?: string; oauth?: string } | null;
      if (!data || data.type !== OAUTH_MESSAGE_TYPE) return;
      // M2 — strict connector match: a message that can't prove it's for this
      // connector is silently ignored. This prevents a connector-less error (e.g.
      // the 2a provider-denial redirect with no `connector` param) from tearing
      // down another mounted instance's flow.
      if (data.connector !== connectorId) return;

      // I1 — branch on the OAuth outcome. A provider error/denial must surface
      // a friendly message and must NOT call onConnected.
      if (data.oauth === 'error') {
        cleanupPopupFlow();
        setBusy(false);
        setError(`Sign-in didn't finish, so ${serviceName} isn't connected. You can try again whenever you're ready.`);
        void fetchStatus();      // keep the badge truthful
        return;                  // do NOT call onConnected on failure
      }

      // success path:
      cleanupPopupFlow();
      setBusy(false);
      void fetchStatus();
      onConnected?.();
    };

    msgHandlerRef.current = handler;
    window.addEventListener('message', handler);

    // ── Popup-closed poll ──────────────────────────────────────────────────
    // If the user closes the popup without completing OAuth (no message arrives),
    // clean up and do a best-effort status refresh (full-page fallback may have
    // succeeded).
    const poll = setInterval(() => {
      if (popupRef.current?.closed) {
        cleanupPopupFlow();
        setBusy(false);
        void fetchStatus();
      }
    }, 500);
    pollRef.current = poll;
  }, [connectorId, agentId, fetchStatus, cleanupPopupFlow, onConnected]);

  // ── Status badge ──────────────────────────────────────────────────────────

  function StatusBadge() {
    if (status === 'checking') {
      return (
        <span className="text-sm text-muted-foreground">Checking…</span>
      );
    }
    if (status === 'error') {
      // M4 — a status-fetch failure must read a distinct message, not
      // "Not connected" (design §8).
      return (
        <span className="text-sm text-muted-foreground">Couldn't check the connection — refresh to try again.</span>
      );
    }
    if (status === 'connected') {
      return <Badge variant="secondary">Connected</Badge>;
    }
    if (status === 'needs-reconnect') {
      return (
        <>
          <Badge variant="destructive">Reconnect needed</Badge>
          <span className="text-xs text-muted-foreground">Your sign-in to {serviceName} needs a refresh. Reconnect to keep this working.</span>
        </>
      );
    }
    // not-connected
    return <Badge variant="outline">Not connected</Badge>;
  }

  // ── Connect button label ──────────────────────────────────────────────────

  const connectLabel =
    status === 'needs-reconnect' ? 'Reconnect' : `Connect with ${serviceName}`;

  // ── Consent gate (only when requiresConsent && not yet accepted) ──────────

  const showConsentGate = requiresConsent && !consented;

  return (
    <div className="flex flex-col gap-4">
      {/* Status indicator */}
      <div>
        <StatusBadge />
      </div>

      {/* Error from beginOAuth */}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Consent gate — blocks the Connect button until accepted */}
      {showConsentGate ? (
        <div className="flex flex-col gap-4">
          <Alert>
            <AlertDescription>
              {`Authorizing lets anyone who uses this shared agent act as you on ${serviceName}. Only people already on this agent are affected.`}
            </AlertDescription>
          </Alert>
          <div className="flex justify-end">
            <Button onClick={() => setConsented(true)}>Continue</Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            onClick={() => void handleConnect()}
            disabled={busy || status === 'checking'}
          >
            {connectLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
