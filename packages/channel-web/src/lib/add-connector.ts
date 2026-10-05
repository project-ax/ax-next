/**
 * The connectors rail's Add subview, as data (TASK-740, connectors-rail slice 7).
 *
 * Two questions, both answered from what the browser can already read:
 *
 *   - **What's available?** The connectors this person may use
 *     (`listConnectors`) minus the ones the agent already has (the rail's own
 *     effective list). That includes shared-key connectors (`keyMode:
 *     'workspace'`) for everyone (TASK-827): an admin adds the key once and
 *     anyone may attach it. A non-admin can't read the shared key's presence,
 *     so the row reads "Add" and the server's attach re-checks the key (409
 *     when it's missing).
 *   - **What does each one need first?** A sign-in, a key, or nothing. This is
 *     only the row's BUTTON. The attach itself is still refused server-side
 *     for anything the caller may not attach, and nothing here grants access:
 *     the subview attaches ONLY after the sign-in / key has succeeded.
 */
import {
  deriveCredentialPlan,
  type Connector,
  type ConnectorSummary,
} from './connectors';
import { getOAuthStatus } from './connectors-oauth';
import { logRequestFailure } from './http';
import type { CredentialMeta } from './credentials';

/** The row's action: "Sign in" / "Add key" / "Add". */
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

export interface AddActionContext {
  agentId: string;
  /** Credential presence (metadata only — never a secret value). */
  userCreds: readonly CredentialMeta[];
  /**
   * Workspace (shared) key presence, or `null` when the caller can't read it
   * (a non-admin). With `null` a shared key counts as present: the person
   * couldn't add it anyway, and the server's attach refuses (409) when it is
   * missing — so this never attaches a connector that can't work.
   */
  globalCreds: readonly CredentialMeta[] | null;
  /**
   * The sign-in already succeeded in this subview. The status read can lag
   * the callback, and a second "Sign in" right after a good one would read
   * as broken.
   */
  signedIn?: boolean;
}

/**
 * Sign-in first, then keys, then nothing. A connector that needs both asks
 * for the sign-in, then (after it succeeds) for the key, then attaches.
 *
 * A status read that fails answers "Sign in": signing in again is harmless,
 * while answering "Add" would attach a connector that cannot work. The failure
 * is logged (TASK-757) — the fallback is safe, but it must not be silent.
 */
export async function addActionFor(
  connector: Connector,
  ctx: AddActionContext,
): Promise<AddAction> {
  const slots = connector.capabilities.credentials;
  if (slots.some((s) => s.kind === 'oauth') && ctx.signedIn !== true) {
    const status = await getOAuthStatus({
      connectorId: connector.id,
      agentId: ctx.agentId,
    }).catch((e: unknown) => {
      logRequestFailure(e, `add-connector oauth-status ${connector.id}`);
      return 'not-connected' as const;
    });
    if (status !== 'connected') return 'sign-in';
  }
  const keySlots = new Set(slots.filter((s) => s.kind === 'api-key').map((s) => s.slot));
  const missingKey = deriveCredentialPlan(connector)
    .filter((entry) => keySlots.has(entry.slot))
    .some((entry) => {
      const pool = entry.scope === 'user' ? ctx.userCreds : ctx.globalCreds;
      if (pool === null) return false;
      return !pool.some((c) => c.ref === entry.ref && c.scope === entry.scope);
    });
  return missingKey ? 'key' : 'add';
}
