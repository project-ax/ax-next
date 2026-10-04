import { deriveToolNamespaces } from './tool-namespace.js';
import type { Capabilities, CapabilitySlot } from './types.js';

// ---------------------------------------------------------------------------
// TASK-809 — which per-tool ceiling applies to each MCP server of a connector.
//
// Owner decision: a server people sign in to with OAuth has NO admin per-tool
// ceiling — each person picks per agent (`agent`). An API-key or no-auth
// server keeps the admin's per-connector ceiling (`connector`). This plugin is
// the source of truth for a server's auth type, so it is the one that tells
// @ax/tool-policy which source applies, keyed by tool namespace.
// ---------------------------------------------------------------------------

export type CeilingSource = 'connector' | 'agent';

export interface CeilingSourceEntry {
  toolNamespace: string;
  source: CeilingSource;
}

/**
 * One entry per `capabilities.mcpServers[]` entry, in declared order. A server
 * is `agent` iff an OAuth credential slot names it; otherwise `connector`.
 * `ownerUserId` is the connector ROW owner (namespaces derive from it).
 */
export function ceilingSourcesFor(
  ownerUserId: string,
  connector: { id: string; capabilities: Pick<Capabilities, 'mcpServers' | 'credentials'> },
): CeilingSourceEntry[] {
  const oauthServers = new Set<string>();
  // Same widening the store's validator uses: the schema-inferred element type
  // omits the oauth arm, the canonical `CapabilitySlot` union carries it.
  for (const slot of connector.capabilities.credentials as CapabilitySlot[]) {
    if (slot.kind === 'oauth') oauthServers.add(slot.server);
  }
  return deriveToolNamespaces(ownerUserId, connector).map((e) => ({
    toolNamespace: e.toolNamespace,
    source: oauthServers.has(e.server) ? 'agent' : 'connector',
  }));
}
