import { PluginError } from '@ax/core';
import { requireUserId } from './input-guards.js';
import { validateConnectorId, type AvailableConnector, type ConnectorStore } from './store.js';
import { deriveToolNamespaces } from './tool-namespace.js';
import type {
  EffectiveConnectorEntry,
  EffectiveConnectorSource,
  ListEffectiveInput,
  ListEffectiveOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/connectors';

// TASK-788 — moved out of plugin.ts unchanged so the agent-scope credential
// gate (credential-authz.ts) asks the SAME union the session folds, without a
// module cycle back through plugin.ts.

/** Upper bound on the per-agent id lists `connectors:list-effective` accepts.
 *  The agent store caps attachments at 50 and exclusions at 100; this is a
 *  looser boundary guard against an unbounded loop of store reads. */
const EFFECTIVE_ID_LIST_MAX = 200;

function optionalIdList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > EFFECTIVE_ID_LIST_MAX ||
    !value.every((v): v is string => typeof v === 'string')
  ) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'connectors:list-effective',
      message: `${field} must be an array of at most ${EFFECTIVE_ID_LIST_MAX} strings if provided`,
    });
  }
  return value;
}

/**
 * TASK-739 — an agent's effective connector set. See `ListEffectiveInput` for
 * the union contract. Every source reads the user's LIVE rows only, so a
 * pending authored draft or a tombstoned connector contributes nothing.
 */
export async function listEffectiveConnectors(
  store: ConnectorStore,
  input: ListEffectiveInput,
): Promise<ListEffectiveOutput> {
  const userId = requireUserId(input.userId, 'connectors:list-effective');
  const attachmentIds = optionalIdList(input.attachmentIds, 'attachmentIds');
  const excluded = new Set(optionalIdList(input.exclusions, 'exclusions'));

  const byId = new Map<string, EffectiveConnectorEntry>();
  const add = (
    { connector, ownerUserId }: AvailableConnector,
    source: EffectiveConnectorSource,
  ): void => {
    if (byId.has(connector.id)) return;
    // An exclusion hides a connector the agent got IMPLICITLY (a legacy-owned
    // row). An explicit attachment always wins: `agents:attach-connector`
    // clears the exclusion anyway, and an admin re-attaching through the
    // wholesale list must not be masked by a stale one.
    if (source !== 'attached' && excluded.has(connector.id)) return;
    const { capabilities, ...rest } = connector;
    byId.set(connector.id, {
      summary: { ...rest, canEdit: ownerUserId === userId },
      source,
      capabilities,
      // Same derivation as connectors:resolve — the ROW owner, not the caller.
      toolNamespaces: deriveToolNamespaces(ownerUserId, connector),
    });
  };

  // 1. Per-agent ATTACHMENTS, in the agent's order. A malformed or dangling id
  //    is skipped: an attachment that resolves to nothing grants nothing.
  for (const rawId of attachmentIds) {
    if (byId.has(rawId)) continue;
    let connectorId: string;
    try {
      connectorId = validateConnectorId(rawId);
    } catch {
      continue;
    }
    const available = await store.getAvailableById(userId, connectorId);
    if (available !== null) add(available, 'attached');
  }

  // 2. LEGACY OWNED rows keep their implicit attachment. A definition the
  //    user does not own, or any row created after explicit attachment landed,
  //    is discoverable but never attached implicitly.
  for (const entry of await store.listAvailable(userId)) {
    if (entry.connector.canEdit === false || entry.connector.requiresAttachment === true) continue;
    add(entry, 'legacy-owned');
  }

  return { connectors: [...byId.values()] };
}
