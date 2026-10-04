import {
  decodeTokenBlob,
  encodeTokenBlob,
  type ClientRegistration,
  type McpOAuthTokenBlob,
  type OAuthClientCredentials,
} from './types.js';
import type { MarkerOwner } from './store.js';

// --- Local re-declaration of the @ax/credentials resolver contract (invariant #2:
// no cross-plugin import; same stance as connectors' credential-plan re-declaring
// CredentialScope). The credentials plugin validates our output at the bus boundary. ---
export interface McpOAuthResolveInput {
  payload: Uint8Array; userId: string; ref: string;
  /** TASK-756 — the vault scope + owner of the row `payload` came from. Optional
   *  so a direct (non-vault) caller still works; absent reads as the caller's own. */
  scope?: 'user' | 'agent' | 'global';
  ownerId?: string | null;
  /** TASK-817 — the caller presented this ref's last value and the service
   *  refused it (HTTP 401). Renew instead of answering the stored token. */
  rejected?: true;
}
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
  /**
   * TASK-741 — the stored "sign-in expired" marker the connectors rail reads.
   * `mark` runs when this resolve ends in NeedsReconnectError; `clear` when a
   * refresh succeeds. Both are best-effort: the implementation must not throw
   * (the plugin's logs and swallows), and a throw here is swallowed anyway —
   * a marker write can never change what the resolve itself answers.
   * Optional so the resolver unit stays usable without a store.
   */
  marker?: {
    mark(owner: MarkerOwner, connectorId: string): Promise<void>;
    clear(owner: MarkerOwner, connectorId: string): Promise<void>;
    /**
     * TASK-817 — is `owner`'s sign-in to `connectorId` marked? Read ONLY for
     * a token the clock still calls valid (an expired one renews anyway).
     * Must not throw either; a throw here counts as "not marked", so a
     * failed read degrades to today's behaviour, never to a refresh storm.
     */
    isMarked?(owner: MarkerOwner, connectorId: string): Promise<boolean>;
  };
}

/**
 * TASK-756 — whose sign-in a resolve is about: the token's OWNER, read from the
 * vault row it came from. An agent-scope row is a team agent's shared sign-in,
 * so its marker is the agent's — one member reconnecting clears it for all.
 * Everything else (a user row, a global row, a caller that did not say) stays
 * keyed on the person resolving, as before.
 */
export function markerOwnerOf(input: McpOAuthResolveInput): MarkerOwner {
  if (input.scope === 'agent' && typeof input.ownerId === 'string' && input.ownerId.length > 0) {
    return { kind: 'agent', agentId: input.ownerId };
  }
  return { kind: 'user', userId: input.userId };
}

/** The vault ref the OAuth callback stores a connector's token under. */
const ACCOUNT_REF_RE = /^account:([a-z0-9][a-z0-9_-]*)$/;

/** The connector a token ref belongs to, or null for a ref not shaped `account:<id>`. */
export function connectorIdOfRef(ref: string): string | null {
  const m = ACCOUNT_REF_RE.exec(ref);
  return m ? m[1]! : null;
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
  const marker = deps.marker;
  // TASK-817 — when may a token the clock calls valid be answered as-is? Not
  // when the caller just saw it refused, and not while its owner's sign-in is
  // marked "expired": the marker is only ever written when the authorization
  // server refused us, so a marked token is one we already know is dead. That
  // is what turns a provider-side revocation into the next chat turn's
  // "reconnect" error instead of a session that silently lacks the tools.
  const resolveToken = createTokenResolver(deps, async (input) => {
    if (input.rejected === true) return true;
    const connectorId = connectorIdOfRef(input.ref);
    if (marker?.isMarked === undefined || connectorId === null) return false;
    return marker.isMarked(markerOwnerOf(input), connectorId).catch(() => false);
  });
  if (marker === undefined) return resolveToken;
  return async function resolve(input: McpOAuthResolveInput): Promise<McpOAuthResolveOutput> {
    const connectorId = connectorIdOfRef(input.ref);
    let out: McpOAuthResolveOutput;
    try {
      out = await resolveToken(input);
    } catch (err) {
      if (err instanceof NeedsReconnectError && connectorId !== null) {
        await marker.mark(markerOwnerOf(input), connectorId).catch(() => undefined);
      }
      throw err;
    }
    // Only a REFRESH proves the authorization server still accepts this sign-in;
    // an unexpired token answered from the blob proves nothing new, and clearing
    // on every resolve would put a write on the hot path.
    if (out.refreshed !== undefined && connectorId !== null) {
      await marker.clear(markerOwnerOf(input), connectorId).catch(() => undefined);
    }
    return out;
  };
}

function createTokenResolver(
  deps: ResolverDeps,
  /** TASK-817 — asked only for a token the clock calls valid: renew it anyway? */
  mustRenew: (input: McpOAuthResolveInput) => Promise<boolean>,
) {
  return async function resolve(input: McpOAuthResolveInput): Promise<McpOAuthResolveOutput> {
    const blob = decodeTokenBlob(input.payload);

    const valid = blob.expiresAt !== undefined && blob.expiresAt - deps.now() > REFRESH_MARGIN_MS;
    if (valid && !(await mustRenew(input))) return { value: blob.accessToken };

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
