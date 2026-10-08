/**
 * OAuth REST client for MCP connector OAuth flows.
 *
 * Wraps the OAuth backend endpoints:
 *   POST /api/connectors/oauth/discover-hosts → { hosts, auth, clientRegistration? }
 *   POST /api/connectors/oauth/begin  → { authorizationUrl }
 *   GET  /api/connectors/oauth/status → { status }
 *
 * Fetch posture mirrors lib/connectors.ts: credentials:'include',
 * write headers carry x-requested-with:'ax-admin', errors surface the
 * server's { message } or { error } field.
 */

import type { BeginRefusal, OAuthMode } from './oauth-failure';

/**
 * A begin the server answered with a non-ok status. `refusal` is set ONLY for
 * the three known refusals at their own status (403 `agent-store-refused`,
 * 409 `not-on-agent`, 409 `already-attached`); the UI maps it to fixed copy.
 * The message is for the console, never the screen.
 */
export class BeginOAuthError extends Error {
  readonly status: number;
  readonly refusal: BeginRefusal | undefined;
  constructor(status: number, message: string, refusal?: BeginRefusal) {
    super(message);
    this.name = 'BeginOAuthError';
    this.status = status;
    this.refusal = refusal;
  }
}

function beginRefusalOf(status: number, code: unknown): BeginRefusal | undefined {
  if (status === 403 && code === 'agent-store-refused') return 'agent-store-refused';
  if (status === 409 && (code === 'not-on-agent' || code === 'already-attached')) return code;
  return undefined;
}

export type OAuthStatus = 'connected' | 'needs-reconnect' | 'not-connected';

export async function getOAuthClientMetadata(): Promise<{ clientId: string; redirectUri: string }> {
  const res = await fetch('/api/connectors/oauth/client-metadata', { credentials: 'include' });
  if (!res.ok) throw new Error('OAuth configuration is unavailable.');
  const metadata = await res.json() as { client_id?: unknown; redirect_uris?: unknown };
  if (typeof metadata.client_id !== 'string' || !Array.isArray(metadata.redirect_uris) || typeof metadata.redirect_uris[0] !== 'string') throw new Error('OAuth configuration is unavailable.');
  return { clientId: metadata.client_id, redirectUri: metadata.redirect_uris[0] };
}

/** What a remote MCP server's public metadata says about signing in.
 *  `oauth` carries the automatic client methods its authorization server
 *  advertises; `other` means it challenged without publishing OAuth metadata. */
export type OAuthDiscovery =
  | { hosts: string[]; auth: 'oauth'; clientRegistration: { cimd: boolean; dcr: boolean } }
  | { hosts: string[]; auth: 'none' | 'other' };

const DISCOVERY_FAILED = 'We couldn’t check this server. Check the URL and retry.';

/** Credential-free metadata preview for an unsaved HTTP MCP connector. */
export async function discoverOAuthHosts(url: string, signal?: AbortSignal): Promise<OAuthDiscovery> {
  const res = await fetch('/api/connectors/oauth/discover-hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    credentials: 'include',
    body: JSON.stringify({ url }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(DISCOVERY_FAILED);
  const result = await res.json() as { hosts?: unknown; auth?: unknown; clientRegistration?: unknown } | null;
  if (!result || !Array.isArray(result.hosts) || result.hosts.length > 12 ||
      !result.hosts.every((host: unknown) => typeof host === 'string' && host.length > 0 && host.length <= 253)) {
    throw new Error(DISCOVERY_FAILED);
  }
  const hosts = result.hosts as string[];
  if (result.auth === 'none' || result.auth === 'other') return { hosts, auth: result.auth };
  const registration = result.clientRegistration as { cimd?: unknown; dcr?: unknown } | null | undefined;
  if (result.auth !== 'oauth' || typeof registration?.cimd !== 'boolean' || typeof registration.dcr !== 'boolean') {
    throw new Error(DISCOVERY_FAILED);
  }
  return { hosts, auth: 'oauth', clientRegistration: { cimd: registration.cimd, dcr: registration.dcr } };
}

/**
 * Begin an OAuth flow for a connector. Returns the provider authorization URL
 * that the caller should open in a popup (or redirect to).
 *
 * Slice 3 — every sign-in belongs to an agent, so `agentId` and `mode` are
 * required: `'add'` signs in AND adds the connector (the server's callback
 * attaches it); `'sign-in-again'` replaces the sign-in of a connector already
 * on the agent.
 */
export async function beginOAuth(args: {
  connectorId: string;
  agentId: string;
  mode: OAuthMode;
}): Promise<{ authorizationUrl: string }> {
  const body = { connectorId: args.connectorId, agentId: args.agentId, mode: args.mode };

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
    let code: unknown;
    try {
      const j = JSON.parse(excerpt) as { message?: string; error?: string };
      code = j.error;
      msg = j.message ?? j.error ?? '';
    } catch {
      msg = excerpt;
    }
    throw new BeginOAuthError(
      res.status,
      msg || `begin oauth: ${res.status}`,
      beginRefusalOf(res.status, code),
    );
  }

  return (await res.json()) as { authorizationUrl: string };
}

/**
 * Check the current OAuth connection status for a connector ON an agent.
 * Slice 3 — every sign-in is an agent's, so `agentId` is required (every
 * caller has one).
 */
export async function getOAuthStatus(args: {
  connectorId: string;
  agentId: string;
}): Promise<OAuthStatus> {
  const qs = new URLSearchParams({ connectorId: args.connectorId, agentId: args.agentId });

  const res = await fetch(`/api/connectors/oauth/status?${qs.toString()}`, {
    credentials: 'include',
  });

  if (!res.ok) throw new Error(`oauth status: ${res.status}`);
  return ((await res.json()) as { status: OAuthStatus }).status;
}
