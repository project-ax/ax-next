/**
 * ConnectorOAuthConnect — reusable OAuth connect/reconnect widget for a single
 * MCP connector. Handles:
 *
 *   - Status polling (on mount + after a successful OAuth round-trip).
 *   - Optional consent gate (for agent-scope connects where the authorization
 *     acts as the current user on behalf of a shared agent).
 *   - Popup-based OAuth flow (via `useOAuthPopup`, TASK-740): opens a provider
 *     authorization URL in a small window, listens for the `ax:oauth-callback`
 *     postMessage from the bridge page, and handles the popup-closed-without-
 *     message (user dismissed) case.
 *
 * SECURITY (invariant #5): The `message` listener origin filter is the primary
 * security control — any message not from `window.location.origin` is silently
 * dropped (in `useOAuthPopup`). This is tested explicitly (ConnectorOAuthConnect.test.tsx test (f)).
 *
 * shadcn primitives + semantic tokens only (invariant #6). No raw colors.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import { getOAuthStatus, type OAuthStatus } from '@/lib/connectors-oauth';
import type { OAuthMode } from '@/lib/oauth-failure';
import { useOAuthPopup } from '@/lib/use-oauth-popup';

export interface ConnectorOAuthConnectProps {
  connectorId: string;
  serviceName: string;
  /** The agent the sign-in belongs to (slice 3: every sign-in has one). */
  agentId: string;
  /** `'add'` signs in and adds; `'sign-in-again'` replaces an attached connector's sign-in. */
  mode: OAuthMode;
  /**
   * When true (team agent), show the shared-key consent line before connecting.
   * The Connect button is not reachable until the user accepts.
   */
  requiresConsent?: boolean;
  /**
   * (TASK-700) Show the access disclosure — what signing in hands the assistant —
   * above the Connect button. Defaults ON, so a new caller can never forget it;
   * a host that already shows a wider notice for the same decision (the
   * workspace rail's connector card) turns it off rather than stack two.
   */
  showAccessNotice?: boolean;
  /** Called after a successful connect so the parent can refresh. */
  onConnected?: () => void;
}

export function ConnectorOAuthConnect({
  connectorId,
  agentId,
  mode,
  serviceName,
  requiresConsent = false,
  showAccessNotice = true,
  onConnected,
}: ConnectorOAuthConnectProps) {
  // 'checking' while the status request is in flight; 'error' if the fetch threw.
  const [status, setStatus] = useState<OAuthStatus | 'checking' | 'error'>('checking');
  const [consented, setConsented] = useState(false);

  const fetchStatus = useCallback(async () => {
    setStatus('checking');
    try {
      const s = await getOAuthStatus({ connectorId, agentId });
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

  // The popup flow itself (origin-locked listener, popup-blocked guard,
  // closed-popup poll) lives in `useOAuthPopup` (TASK-740), shared with the
  // connectors rail's Add subview. Every way the flow ends re-reads the badge.
  const popup = useOAuthPopup({
    connectorId,
    agentId,
    mode,
    serviceName,
    onSettled: () => void fetchStatus(),
    ...(onConnected !== undefined ? { onConnected } : {}),
  });
  const busy = popup.busy;
  const error = popup.error;
  const handleConnect = popup.start;

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

      {/* (TASK-700) What signing in hands the assistant. Above the consent gate AND
          the Connect button, so it is on screen in every state the decision can
          be in — and one notice, not one per state. */}
      {showAccessNotice && <ConnectorAccessNotice kind="sign-in" />}

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
