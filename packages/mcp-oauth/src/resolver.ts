import { decodeTokenBlob, encodeTokenBlob, type McpOAuthTokenBlob, type ClientRegistration } from './types.js';

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
  store: { getClient(clientKey: string): Promise<ClientRegistration | null> };
  /** Wired by the plugin task to oauth-flow.refresh (constructing metadata from the blob's
   *  tokenEndpoint). Injected here so the resolver unit stays offline. */
  refresh(args: {
    authServerUrl: string; tokenEndpoint: string; resource: string;
    refreshToken: string; client: ClientRegistration; allowedHosts: Set<string>;
  }): Promise<RefreshedTokens>;
  now(): number;
}

/** Refresh when fewer than this many ms remain on the access token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

function hostOf(url: string): string {
  return new URL(url).hostname;
}

export function createMcpOAuthResolver(deps: ResolverDeps) {
  return async function resolve(input: McpOAuthResolveInput): Promise<McpOAuthResolveOutput> {
    const blob = decodeTokenBlob(input.payload);

    const valid = blob.expiresAt !== undefined && blob.expiresAt - deps.now() > REFRESH_MARGIN_MS;
    if (valid) return { value: blob.accessToken };

    if (!blob.refreshToken) throw new NeedsReconnectError('no refresh token; reconnect required');
    const client = await deps.store.getClient(blob.clientKey);
    if (!client) throw new NeedsReconnectError(`client registration ${blob.clientKey} missing; reconnect required`);

    // Self-contained SSRF allowlist: refresh may only reach the token endpoint + resource hosts.
    const allowedHosts = new Set([hostOf(blob.tokenEndpoint), hostOf(blob.resource)]);

    let tokens: RefreshedTokens;
    try {
      tokens = await deps.refresh({
        authServerUrl: blob.authServerUrl, tokenEndpoint: blob.tokenEndpoint,
        resource: blob.resource, refreshToken: blob.refreshToken, client, allowedHosts,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // invalid_grant ⇒ the refresh token is dead — must re-auth. Anything else is treated
      // as transient: rethrow WITHOUT wiping the stored refresh token (caller retries later).
      if (m.includes('invalid_grant')) {
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
