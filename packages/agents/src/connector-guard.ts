import { PluginError, type AgentContext, type HookBus } from '@ax/core';

const PLUGIN_NAME = '@ax/agents';

/**
 * Marks a `forbidden` PluginError as the workspace-connector guard's refusal
 * (vs. the agent-ownership ACL's). Its message names only the connector id the
 * caller themselves sent, so a transport may surface it, while the ACL's
 * `forbidden` stays an opaque "forbidden". This is part of
 * `agents:attach-connector`'s documented error contract — see the
 * attach/detach block in ./types.ts.
 */
const WORKSPACE_CONNECTOR_REASON = 'workspace-connector';

/**
 * SECURITY (non-admin owner-scoped attachment). Agent CRUD + attachments are
 * owner-scoped (the agent-ownership ACL lives in the hooks' `assertWriteAllowed`),
 * so a non-admin may manage their OWN agents. The one escalation an attachment
 * could enable is making the agent spend a GLOBAL (company) credential — and that
 * only ever comes from a `keyMode:'workspace'` connector. So a non-admin's grant is
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
 * Hook-side enforcement (used by `agents:attach-connector`): throws `forbidden`
 * with `diagnosis.reason === 'workspace-connector'` (the guard's refusal —
 * the error contract documented on the attach hook in ./types.ts)
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
