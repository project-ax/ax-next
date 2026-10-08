/**
 * The connectors rail's Add subview, as data (TASK-740, connectors-rail slice 7).
 *
 * Two questions, both answered from what the browser can already read:
 *
 *   - **What's available?** The connectors this person may use
 *     (`listConnectors`) minus the ones the agent already has (the rail's own
 *     effective list). That includes shared-key connectors (`keyMode:
 *     'workspace'`) for everyone (TASK-827): an admin adds the key once and
 *     anyone may attach it; the server's attach checks the key is there (409
 *     when it's missing).
 *   - **What does Add do?** Decided by the connector's KIND alone (slice 3) —
 *     nobody's saved keys or sign-ins are read, because every Add sets up the
 *     agent's own, all or nothing:
 *       - a sign-in connector → the sign-in popup, whose callback adds it;
 *       - a per-agent key connector → the key form, whose save adds it;
 *       - a shared-key or no-auth connector → added straight away.
 *     This only picks the row's behaviour. The server refuses anything the
 *     caller may not add, and nothing here grants access.
 */
import {
  deriveCredentialPlan,
  type Connector,
  type ConnectorCredentialPlanEntry,
  type ConnectorSummary,
} from './connectors';
import { OAUTH_CLIENT_SECRET_SLOT } from './connector-credential-slots';

/** What the row's Add does: sign in / take the agent's keys / add. */
export type AddAction = 'sign-in' | 'key' | 'add';

export function availableConnectors(
  catalog: readonly ConnectorSummary[],
  effectiveIds: ReadonlySet<string>,
): ConnectorSummary[] {
  return catalog
    .filter((c) => !effectiveIds.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Case-insensitive name match; an empty query matches everything. */
export function matchesQuery(c: ConnectorSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length === 0 || c.name.toLowerCase().includes(q);
}

/**
 * The api-key slots an agent's own key fills: no sign-in, and never the
 * connector's own OAuth client secret (an admin's setting) — the same
 * exclusion the server's `credentialChecks` makes. The slot NAME is all the
 * client ever sends; the server derives the vault ref itself.
 */
export function agentKeyEntries(connector: Connector): ConnectorCredentialPlanEntry[] {
  return deriveCredentialPlan(connector).filter(
    (entry) =>
      connector.capabilities.credentials.find((s) => s.slot === entry.slot)?.kind === 'api-key' &&
      !entry.ref.endsWith(`:${OAUTH_CLIENT_SECRET_SLOT}`),
  );
}

/**
 * Sign-in first: a connector that also declares a header key still adds by
 * signing in alone (its key is then added from the rail row). Then a per-agent
 * key. A shared key is the workspace's, never the agent's, so it's a plain Add.
 */
export function addActionFor(connector: Connector): AddAction {
  if (connector.capabilities.credentials.some((s) => s.kind === 'oauth')) return 'sign-in';
  if (connector.keyMode !== 'workspace' && agentKeyEntries(connector).length > 0) return 'key';
  return 'add';
}
