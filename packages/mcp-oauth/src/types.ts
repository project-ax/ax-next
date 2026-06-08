import { z } from 'zod';

/** The credentials-vault payload for a `mcp-oauth` credential. Self-contained:
 *  the resolver gets ONLY this payload (not the envelope metadata), so it carries
 *  everything needed to decide-to-refresh and to refresh. `clientKey` indexes the
 *  client-registration row in this plugin's own store. */
export const McpOAuthTokenBlobSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  tokenType: z.string().default('Bearer'),
  /** Epoch ms when the access token expires (0/undefined ⇒ unknown ⇒ refresh). */
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
  resource: z.string().url(),
  authServerUrl: z.string().url(),
  clientKey: z.string().min(1),
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
  clientKey: string;
  resource: string;
  scope: string | undefined;
  createdAt: number;
}

/** A stored OAuth client registration (DCR result or pinned). */
export interface ClientRegistration {
  /** `${connectorId}|${authServerUrl}` — stable per (connector, auth server). */
  clientKey: string;
  clientId: string;
  clientSecret: string | undefined;
  /** Whether this came from dynamic registration (vs admin-pinned). */
  dynamic: boolean;
}

/** Compose the stable client key. */
export function clientKeyOf(connectorId: string, authServerUrl: string): string {
  return `${connectorId}|${authServerUrl}`;
}
