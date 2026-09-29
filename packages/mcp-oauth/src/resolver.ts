import {
  decodeTokenBlob,
  encodeTokenBlob,
  type ClientRegistration,
  type McpOAuthTokenBlob,
  type OAuthClientCredentials,
} from './types.js';

// --- Local re-declaration of the @ax/credentials resolver contract (invariant #2:
// no cross-plugin import; same stance as connectors' credential-plan re-declaring
// CredentialScope). The credentials plugin validates our output at the bus boundary. ---
export interface McpOAuthResolveInput { payload: Uint8Array; userId: string; ref: string; }
export interface McpOAuthResolveOutput {
  value: string;
  refreshed?: { payload: Uint8Array; expiresAt?: number; metadata?: Record<string, unknown> };
}

/** Thrown when the refresh token is gone/rejected — the connector must be re-authorized.
 *  Distinct from a transient error so the credentials layer / caller can tell "reconnect"
 *  from "try again later" (we never wipe a good refresh token on a transient failure). */
export class NeedsReconnectError extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeedsReconnectError'; }
}

/** Tokens shape returned by the injected refresh (mirrors the SDK's OAuthTokens subset we use). */
export interface RefreshedTokens {
  access_token: string; refresh_token?: string; expires_in?: number;
  token_type?: string; scope?: string;
}

export interface ResolverDeps {
  /** Only the LEGACY fallback reads the store: a blob written before TASK-696 has no
   *  `clientId`, so its client is looked up by `clientKey` in the shared row. */
  store: { getClient(clientKey: string): Promise<ClientRegistration | null> };
  /** Wired by the plugin task to oauth-flow.refresh (constructing metadata from the blob's
   *  tokenEndpoint). Injected here so the resolver unit stays offline. */
  refresh(args: {
    authServerUrl: string; tokenEndpoint: string; resource: string;
    refreshToken: string; client: OAuthClientCredentials; allowedHosts: Set<string>;
  }): Promise<RefreshedTokens>;
  now(): number;
}

/** Refresh when fewer than this many ms remain on the access token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

function hostOf(url: string): string {
  return new URL(url).hostname;
}

/** RFC 6749 §5.2 error codes that mean the stored credentials are DEAD — no retry can
 *  revive them, only a fresh authorization can: the refresh token was revoked or
 *  expired (`invalid_grant`), or the OAuth client it belongs to was deleted, expired
 *  or re-keyed at the authorization server (`invalid_client`, `unauthorized_client`).
 *  A token now refreshes as the client that issued it (TASK-696), so a long-lived
 *  token can outlive a DCR client the server garbage-collects; the MCP SDK's own
 *  `auth()` treats these same three as "invalidate the credentials". */
const DEAD_CREDENTIAL_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
const DEAD_CREDENTIAL_NAMES = new Set(['InvalidGrantError', 'InvalidClientError', 'UnauthorizedClientError']);

/** Is this the authorization server telling us the credentials are dead? Decided by the
 *  error's TYPE, never its message: the SDK builds the message from the server's free-text
 *  `error_description`, which need not contain the code. Duck-typed rather than
 *  `instanceof` because the MCP SDK can be loaded twice (two copies ⇒ two error classes).
 *  The SDK's `OAuthError` exposes the wire code as `errorCode`, and names each subclass
 *  after itself. */
function isDeadCredentialError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { errorCode?: unknown; name?: unknown };
  return (
    (typeof e.errorCode === 'string' && DEAD_CREDENTIAL_CODES.has(e.errorCode)) ||
    (typeof e.name === 'string' && DEAD_CREDENTIAL_NAMES.has(e.name))
  );
}

export function createMcpOAuthResolver(deps: ResolverDeps) {
  return async function resolve(input: McpOAuthResolveInput): Promise<McpOAuthResolveOutput> {
    const blob = decodeTokenBlob(input.payload);

    const valid = blob.expiresAt !== undefined && blob.expiresAt - deps.now() > REFRESH_MARGIN_MS;
    if (valid) return { value: blob.accessToken };

    if (!blob.refreshToken) throw new NeedsReconnectError('no refresh token; reconnect required');

    // Refresh as the client the token was ISSUED to: a strict authorization server
    // rejects a refresh token presented by any other client. The blob carries that
    // client itself; only a legacy blob (no clientId) falls back to the shared row.
    let client: OAuthClientCredentials;
    if (blob.clientId !== undefined) {
      client = { clientId: blob.clientId, clientSecret: blob.clientSecret };
    } else {
      const legacy = await deps.store.getClient(blob.clientKey);
      if (!legacy) throw new NeedsReconnectError(`client registration ${blob.clientKey} missing; reconnect required`);
      client = legacy;
    }

    // Self-contained SSRF allowlist: refresh may only reach the token endpoint + resource hosts.
    const allowedHosts = new Set([hostOf(blob.tokenEndpoint), hostOf(blob.resource)]);

    let tokens: RefreshedTokens;
    try {
      tokens = await deps.refresh({
        authServerUrl: blob.authServerUrl, tokenEndpoint: blob.tokenEndpoint,
        resource: blob.resource, refreshToken: blob.refreshToken, client, allowedHosts,
      });
    } catch (err) {
      // Dead credentials (invalid_grant / invalid_client / unauthorized_client) ⇒ must
      // re-auth. Anything else is treated as transient: rethrow WITHOUT wiping the stored
      // refresh token (caller retries later).
      if (isDeadCredentialError(err)) {
        throw new NeedsReconnectError('refresh token rejected; reconnect required');
      }
      throw err;
    }

    const next: McpOAuthTokenBlob = {
      ...blob,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? blob.refreshToken, // preserve when provider doesn't rotate
      tokenType: tokens.token_type ?? blob.tokenType,
      expiresAt: tokens.expires_in !== undefined ? deps.now() + tokens.expires_in * 1000 : undefined,
      scope: tokens.scope ?? blob.scope,
    };
    const payload = encodeTokenBlob(next);
    return {
      value: next.accessToken,
      refreshed: { payload, ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {}) },
    };
  };
}
