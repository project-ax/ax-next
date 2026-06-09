/**
 * OAuth REST client for MCP connector OAuth flows.
 *
 * Wraps the two Phase-2a backend endpoints:
 *   POST /api/connectors/oauth/begin  → { authorizationUrl }
 *   GET  /api/connectors/oauth/status → { status }
 *
 * Fetch posture mirrors lib/connectors.ts: credentials:'include',
 * write headers carry x-requested-with:'ax-admin', errors surface the
 * server's { message } or { error } field.
 */

export type OAuthStatus = 'connected' | 'needs-reconnect' | 'not-connected';

/**
 * Begin an OAuth flow for a connector. Returns the provider authorization URL
 * that the caller should open in a popup (or redirect to).
 */
export async function beginOAuth(args: {
  connectorId: string;
  agentId?: string;
}): Promise<{ authorizationUrl: string }> {
  const body =
    args.agentId !== undefined
      ? { connectorId: args.connectorId, agentId: args.agentId }
      : { connectorId: args.connectorId };

  const res = await fetch('/api/connectors/oauth/begin', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    let msg = '';
    try {
      const j = JSON.parse(excerpt) as { message?: string; error?: string };
      msg = j.message ?? j.error ?? '';
    } catch {
      msg = excerpt;
    }
    throw new Error(msg || `begin oauth: ${res.status}`);
  }

  return (await res.json()) as { authorizationUrl: string };
}

/**
 * Check the current OAuth connection status for a connector.
 */
export async function getOAuthStatus(args: {
  connectorId: string;
  agentId?: string;
}): Promise<OAuthStatus> {
  const qs = new URLSearchParams({ connectorId: args.connectorId });
  if (args.agentId !== undefined) qs.set('agentId', args.agentId);

  const res = await fetch(`/api/connectors/oauth/status?${qs.toString()}`, {
    credentials: 'include',
  });

  if (!res.ok) throw new Error(`oauth status: ${res.status}`);
  return ((await res.json()) as { status: OAuthStatus }).status;
}
