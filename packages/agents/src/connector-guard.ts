import { PluginError, type AgentContext, type HookBus } from '@ax/core';

const PLUGIN_NAME = '@ax/agents';

/**
 * Marks a `forbidden` PluginError as the workspace-connector guard's refusal
 * (vs. the agent-ownership ACL's). The admin route surfaces this one's message
 * to the caller — it names only the connector id the caller themselves sent —
 * while the ACL's `forbidden` stays an opaque "forbidden".
 */
const WORKSPACE_CONNECTOR_REASON = 'workspace-connector';

/**
 * SECURITY (non-admin owner-scoped attachment). Agent CRUD + attachments are
 * owner-scoped (the agent-ownership ACL lives in the hooks' `assertWriteAllowed`),
 * so a non-admin may manage their OWN agents. The one escalation an attachment
 * could enable is making the agent spend a GLOBAL (company) credential — and that
 * only ever comes from a `keyMode:'workspace'` connector. So a non-admin's set is
 * rejected iff ANY of the given connector ids resolves — OWNER-SCOPED to the actor
 * — to keyMode 'workspace'. A personal connector is the user's own per-user key
 * (their own reach → no escalation); a connector the actor doesn't own never
 * resolves and is a runtime no-op (tolerated, like a dangling id). Admins bypass
 * this entirely (callers skip it for `isAdmin`).
 *
 * Fail-closed: if `connectors:resolve` is unavailable we can't verify keyMode, so
 * a non-empty connector set from a non-admin is refused (attaching stays
 * admin-only in a connectors-less preset).
 *
 * Returns an error message to refuse with, or null when the set is allowed.
 */
export async function workspaceConnectorGrantViolation(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  connectorIds: readonly string[],
): Promise<string | null> {
  if (connectorIds.length === 0) return null;
  if (!bus.hasService('connectors:resolve')) {
    return 'cannot verify connector reach — attaching connectors is admin-only here';
  }
  for (const connectorId of connectorIds) {
    let keyMode: string | undefined;
    try {
      const resolved = await bus.call<
        { userId: string; connectorId: string },
        { keyMode: string }
      >('connectors:resolve', ctx, { userId, connectorId });
      keyMode = resolved.keyMode;
    } catch {
      // not-found / not owned by this user → never resolves at runtime → no-op.
      continue;
    }
    if (keyMode === 'workspace') {
      return `forbidden: '${connectorId}' is a workspace (shared) connector — only an admin can attach it`;
    }
  }
  return null;
}

/**
 * Hook-side enforcement: throws `forbidden` (tagged as the guard's refusal)
 * when a non-admin actor would gain a workspace connector among `addedIds`.
 * Admins pass through. Callers pass ONLY the ids being added — removing or
 * keeping an already-attached connector never trips the guard.
 */
export async function assertConnectorGrantAllowed(
  bus: HookBus,
  ctx: AgentContext,
  actor: { userId: string; isAdmin: boolean },
  addedIds: readonly string[],
  hookName: string,
): Promise<void> {
  if (actor.isAdmin) return;
  const violation = await workspaceConnectorGrantViolation(bus, ctx, actor.userId, addedIds);
  if (violation === null) return;
  throw new PluginError({
    code: 'forbidden',
    plugin: PLUGIN_NAME,
    hookName,
    message: violation,
    diagnosis: { reason: WORKSPACE_CONNECTOR_REASON },
  });
}

/** True when `err` is the workspace-connector guard's `forbidden`. */
export function isWorkspaceConnectorForbidden(err: unknown): err is PluginError {
  return (
    err instanceof PluginError &&
    err.code === 'forbidden' &&
    err.diagnosis?.['reason'] === WORKSPACE_CONNECTOR_REASON
  );
}

/**
 * TASK-766 — marks a `forbidden` PluginError as "this connector was removed
 * from this agent (it is excluded), and this actor may not bring it back"
 * (TASK-765's `refuseIfExcluded`). Routes answer it with this stable error
 * code, so a member learns WHY their add failed instead of a bare `forbidden`.
 *
 * It says nothing about who excluded the connector or when — only that it is
 * excluded on THIS agent, which a caller already past this agent's ACL can see
 * from the agent's own list anyway. Hosts match the string (they may not import
 * this plugin), so it is part of the `agents:attach-connector` /
 * `agents:set-connector-attachments` error contract: do not rename it lightly.
 */
export const CONNECTOR_EXCLUDED_REASON = 'connector-excluded';

/** The refusal `refuseIfExcluded` throws, tagged with {@link CONNECTOR_EXCLUDED_REASON}. */
export function connectorExcludedForbidden(connectorId: string): PluginError {
  return new PluginError({
    code: 'forbidden',
    plugin: PLUGIN_NAME,
    message: `connector '${connectorId}' was removed from this agent; only its owner or an admin can bring it back`,
    diagnosis: { reason: CONNECTOR_EXCLUDED_REASON },
  });
}

/** True when `err` is {@link connectorExcludedForbidden}'s refusal. */
export function isConnectorExcludedForbidden(err: unknown): err is PluginError {
  return (
    err instanceof PluginError &&
    err.code === 'forbidden' &&
    err.diagnosis?.['reason'] === CONNECTOR_EXCLUDED_REASON
  );
}
