import { z } from 'zod';

/** The credentials-vault payload for a `mcp-oauth` credential. Self-contained:
 *  the resolver gets ONLY this payload (not the envelope metadata), so it carries
 *  everything needed to decide-to-refresh and to refresh.
 *
 *  A token is redeemed and refreshed as the OAuth client it was ISSUED to
 *  (RFC 6749 §6 binds a refresh token to its client), so the blob carries that
 *  client's `clientId`/`clientSecret` itself. They are authoritative. They are
 *  optional only because blobs written before TASK-696 do not have them; for
 *  those, `clientKey` still indexes the shared (legacy) client row in this
 *  plugin's store, and the resolver falls back to it. For a new token `clientKey`
 *  is only that legacy index — nothing reads it while `clientId` is present. */
export const McpOAuthTokenBlobSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  tokenType: z.string().default('Bearer'),
  /** Epoch ms when the access token expires (0/undefined ⇒ unknown ⇒ refresh). */
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
  resource: z.string().url(),
  authServerUrl: z.string().url(),
  tokenEndpoint: z.string().url(),
  clientKey: z.string().min(1),
  /** The client this token was issued to (see the note above). Absent on legacy blobs. */
  clientId: z.string().min(1).optional(),
  /** That client's secret, when it is confidential. Absent for a public client. */
  clientSecret: z.string().optional(),
});
export type McpOAuthTokenBlob = z.infer<typeof McpOAuthTokenBlobSchema>;

export function encodeTokenBlob(b: McpOAuthTokenBlob): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(McpOAuthTokenBlobSchema.parse(b)));
}
export function decodeTokenBlob(bytes: Uint8Array): McpOAuthTokenBlob {
  return McpOAuthTokenBlobSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** A persisted pending authorization, keyed by `state`. */
export interface PendingAuthorization {
  state: string;
  userId: string;
  agentId: string;
  connectorId: string;
  slot: string;
  codeVerifier: string;
  authServerUrl: string;
  /** Whether this authorization server requires issuer identification in its callback. */
  issuerRequired?: boolean;
  /** Legacy index to the shared client row. New rows also carry the client itself
   *  (`clientId`/`clientSecret`, below); the callback prefers those. */
  clientKey: string;
  /** The client this authorization was started with; the callback redeems the code
   *  as THIS client and hands it on to the token blob. Absent on a row written
   *  before TASK-696 (an in-flight authorization across the deploy). */
  clientId?: string;
  /** That client's secret, when confidential. Plaintext at rest until the row is
   *  consumed or purged (`purgeExpiredPending`). */
  clientSecret?: string;
  resource: string;
  scope: string | undefined;
  /**
   * The credential STORAGE scope the token will be written under once the
   * callback completes. Distinct from `scope` (the OAuth scopes string).
   * Every sign-in belongs to an agent, so `begin` always writes 'agent' (the
   * agent holds its own token; a team agent's members ride along). The callback
   * no longer reads it: it always stores on `agentId`, including for a 'user'
   * row written before that rule and still in flight. Kept only because the
   * pending table's column still carries it.
   */
  credScope: 'user' | 'agent';
  /**
   * Which flow started this authorization:
   *   'add'           — adding the connector to the agent; the callback attaches it.
   *   'sign-in-again' — the connector is already on the agent; nothing is attached.
   * A row without a known value reads as 'sign-in-again', so it never attaches.
   */
  mode: SignInMode;
  createdAt: number;
}

/** The two flows a sign-in can belong to (see {@link PendingAuthorization.mode}). */
export type SignInMode = 'add' | 'sign-in-again';

/** The OAuth client credentials the token-endpoint calls need. */
export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string | undefined;
}

/** An OAuth client registration (DCR result or pinned), as `ensureClient` returns it. */
export interface ClientRegistration extends OAuthClientCredentials {
  /** `${connectorId}|${authServerUrl}` — stable per (connector, auth server). */
  clientKey: string;
  /** Whether this came from dynamic registration (vs admin-pinned). */
  dynamic: boolean;
}

/** Compose the stable client key. */
export function clientKeyOf(connectorId: string, authServerUrl: string): string {
  return `${connectorId}|${authServerUrl}`;
}
