// ---------------------------------------------------------------------------
// Auth headers for one connector server, built from the connector's own
// credential plan. Shared by `connectors:describe-tools` (the tool inventory)
// and the one-shot approved call (TASK-1046), so both spend exactly the refs,
// through the same `credentials:get` (user → agent → global) scope walk, that
// a session's credential-proxy spends for that user and agent.
//
// Secrets: a header value lives only in the map this returns. It is never
// logged here; the one log line carries the connector id and an error CODE,
// which is a PluginError's short lower-case slug or 'error' (review r3 S5:
// `loggableCode`), never an error's message.
// ---------------------------------------------------------------------------

import { PluginError, type AgentContext } from '@ax/core';
import { loggableCode } from './loggable-code.js';

// Local structural view of `connectors:resolve` output (I2: no runtime import
// of @ax/connectors; only the fields these callers read).
export interface ResolvedSlot {
  slot: string;
  kind: 'api-key' | 'oauth';
  headerName?: string;
  server?: string;
}
export interface ResolvedServer {
  name: string;
  transport: 'http';
  url?: string;
}
export interface ResolvedConnector {
  id: string;
  capabilities: {
    credentials: ResolvedSlot[];
    mcpServers: ResolvedServer[];
    /** Hosts the connector may reach (exact match). Optional on this view, so
     *  callers that never read it need not supply it. */
    allowedHosts?: string[];
  };
  credentialPlan: Array<{ slot: string; ref: string }>;
  toolNamespaces?: Array<{ server: string; toolNamespace: string }>;
}

/**
 * TASK-756 — a credential failure that means "there is no usable sign-in":
 * nothing stored for the ref, or an OAuth sign-in the authorization server
 * rejected. The reconnect error crosses the bus twice (resolver →
 * credentials:get → here) and is wrapped on the way, so it is recognised by
 * name on the error or its cause, never by importing @ax/mcp-oauth (I2) —
 * the same rule channel-web's `credentialMissing` applies. Anything else (a
 * vault/storage blip, a refresh the provider could not answer right now) says
 * nothing about the sign-in, so it must not be reported as one.
 */
export function noUsableCredential(err: unknown): boolean {
  if (err instanceof PluginError && err.code === 'credential-not-found') return true;
  const named = (e: unknown): boolean => e instanceof Error && e.name === 'NeedsReconnectError';
  return named(err) || named((err as { cause?: unknown } | null)?.cause);
}

/**
 * The headers `server` needs, read from the vault as (`userId`, `ctx.agentId`):
 *   - `'absent'`: nothing is stored for a slot's ref (never signed in, or
 *     signed out; TASK-841);
 *   - `'needs-auth'`: no ref is planned for a slot, an OAuth sign-in was
 *     rejected, or the vault answered with no value;
 *   - `'unavailable'`: the credential could not be READ right now (a vault
 *     blip, TASK-756), which says nothing about the sign-in.
 * `bearerRef` is the ref whose token is in `Authorization`, when an OAuth slot
 * put it there.
 */
export async function connectorHeaders(
  bus: { call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> },
  connector: ResolvedConnector,
  server: ResolvedServer,
  ctx: AgentContext,
  userId: string,
): Promise<{ headers: Record<string, string>; bearerRef?: string } | 'absent' | 'needs-auth' | 'unavailable'> {
  const headers: Record<string, string> = {};
  // The ref whose token is in `Authorization` (the last OAuth slot wins).
  let bearerRef: string | undefined;
  for (const slot of connector.capabilities.credentials) {
    if (slot.server !== server.name) continue;
    const header = slot.kind === 'oauth' ? 'Authorization' : slot.headerName;
    if (header === undefined || header.length === 0) continue;
    const ref = connector.credentialPlan.find((p) => p.slot === slot.slot)?.ref;
    if (ref === undefined) return 'needs-auth';
    let value: string;
    try {
      value = await bus.call<{ ref: string; userId: string }, string>('credentials:get', ctx, {
        ref,
        userId,
      });
    } catch (err) {
      const missing = noUsableCredential(err);
      ctx.logger.info('connector_inventory_credential_unavailable', {
        connectorId: connector.id,
        // A slug from a closed vocabulary, or 'error' (review r3 S5).
        code: loggableCode(err) ?? 'error',
        transient: !missing,
      });
      if (!missing) return 'unavailable';
      // TASK-841 — nothing stored at all (never signed in, or signed out),
      // as opposed to a sign-in the authorization server rejected.
      return err instanceof PluginError && err.code === 'credential-not-found' ? 'absent' : 'needs-auth';
    }
    if (typeof value !== 'string' || value.length === 0) return 'needs-auth';
    headers[header] = slot.kind === 'oauth' ? `Bearer ${value}` : value;
    if (slot.kind === 'oauth') bearerRef = ref;
    // A key slot that writes its own `Authorization` replaced the bearer.
    else if (header.toLowerCase() === 'authorization') bearerRef = undefined;
  }
  return { headers, ...(bearerRef !== undefined ? { bearerRef } : {}) };
}
