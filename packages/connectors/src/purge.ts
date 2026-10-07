import type { AgentContext, HookBus } from '@ax/core';
import { deriveCredentialPlan } from './credential-plan.js';
import {
  namesOAuthClientSecretRef,
  oauthClientSecretRefFor,
} from './oauth-client-secret-ref.js';
import { deriveToolNamespaces } from './tool-namespace.js';
import type { Capabilities, Connector, ConnectorDeletedEvent } from './types.js';

/** What `purgeConnectorState` reads from a connector — no more. */
export type PurgeableConnector = Pick<Connector, 'id' | 'keyMode' | 'visibility'> & {
  capabilities: Pick<Capabilities, 'credentials' | 'mcpServers'>;
};

/**
 * Everything a connector delete reclaims OUTSIDE its own row: its stored
 * key(s) and the `connectors:deleted` announcement. Shared by the
 * `connectors:delete` hook and the boot-time stdio sweep (stdio-sweep.ts).
 */
export async function purgeConnectorState(
  bus: HookBus,
  ctx: AgentContext,
  ownerUserId: string,
  connector: PurgeableConnector,
  opts: {
    purgeGlobal: boolean;
    /** Caller-computed: authorized AND no other live shared same-id connector survives. */
    purgeAgentSignIns: boolean;
    /** Why `purgeAgentSignIns` is false (for the skip log). */
    agentSignInsSkipReason: 'not-authorized' | 'same-id-survives';
  },
): Promise<void> {
  const connectorId = connector.id;

  // Purge the connector's OWN stored key(s) so a secret never lingers with no UI
  // home. Soft-dep: only attempted when credentials:delete is present (a preset
  // without @ax/credentials still deletes the connector). The purge targets ONLY
  // the deleted connector's derived refs, at the scope it declares.
  //
  // SECURITY (invariant #5): a per-user ref (scope:'user', ownerId:ownerUserId) is
  // unambiguously the row owner's own — always safe to purge. A GLOBAL ref
  // (scope:'global', shared company key, owner-independent) is purged ONLY when
  // the caller is authorized (opts.purgeGlobal — routes pass actor.isAdmin).
  // Gating the PURGE here, not just the HTTP create route, closes EVERY path to
  // a non-admin global-credential wipe (incl. the authored-connector approve
  // path, which promotes a draft straight through connectors:upsert). Each
  // failure is logged + swallowed so a credential hiccup never wedges the delete.
  if (bus.hasService('credentials:delete')) {
    const purgeGlobal = opts.purgeGlobal;
    // TASK-797 — the connector's OAuth client secret is not a plan slot, but it
    // is the connector's own key too: the editor stores it at the author's user
    // scope, or at global for an admin's shared connector. Purge it from both
    // (global under the same purgeGlobal gate), or a later connector with the
    // same id would silently inherit it.
    const clientSecretRef = oauthClientSecretRefFor(connectorId);
    const ownsClientSecret = namesOAuthClientSecretRef(connector.capabilities, clientSecretRef);
    // Only a SHARED connector's secret is ever read at global (credential-authz),
    // so only a shared connector's delete may purge it there: a private
    // connector that happens to share the id must not wipe the shared one's.
    const purgeEntries: Array<{ scope: 'user' | 'global'; ref: string }> = [
      ...deriveCredentialPlan(connector),
      ...(ownsClientSecret ? [{ scope: 'user' as const, ref: clientSecretRef }] : []),
      ...(ownsClientSecret && connector.visibility === 'shared'
        ? [{ scope: 'global' as const, ref: clientSecretRef }]
        : []),
    ];
    for (const entry of purgeEntries) {
      if (entry.scope === 'global' && !purgeGlobal) {
        // Unauthorized to purge a shared/company key — leave it intact. (An admin
        // delete passes purgeGlobal:true; a non-admin's never does.)
        ctx.logger.info('connectors_delete_skipped_global_purge', {
          connectorId,
          ref: entry.ref,
        });
        continue;
      }
      const ownerId = entry.scope === 'user' ? ownerUserId : null;
      try {
        await bus.call('credentials:delete', ctx, {
          scope: entry.scope,
          ownerId,
          ref: entry.ref,
        });
      } catch (err) {
        ctx.logger.warn('connectors_delete_credential_purge_failed', {
          connectorId,
          ref: entry.ref,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Agent-owned sign-ins (2026-10-07 design): every agent's sign-in / per-agent
  // key for this connector lives at AGENT scope under `account:<id>[:SLOT]`.
  // Only a SHARED connector's delete may purge them: agent-scope rows are
  // readable only for the sole shared definition (TASK-711), so a private
  // connector that happens to share the id must never wipe them. Best-effort,
  // like the credential purge above. Requires admin authority (purgeGlobal) and
  // no surviving same-id shared connector (ids are not unique across owners).
  if (connector.visibility === 'shared' && !opts.purgeAgentSignIns) {
    ctx.logger.info('connectors_delete_skipped_agent_signins_purge', {
      connectorId,
      reason: opts.agentSignInsSkipReason,
    });
  } else if (connector.visibility === 'shared' && bus.hasService('credentials:purge-account')) {
    try {
      await bus.call('credentials:purge-account', ctx, { connectorId, scopes: ['agent'] });
    } catch (err) {
      ctx.logger.warn('connectors_delete_agent_signins_purge_failed', {
        connectorId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Announce the removal so other plugins reclaim state keyed on this connector's
  // tool namespaces (@ax/tool-policy purges its per-tool verdict rows). Fired
  // AFTER the credential purge. Callers invoke this only when a LIVE row was
  // actually removed — a delete of an absent / already-deleted connector
  // announces nothing. The namespaces are derived from `ownerUserId`, the row
  // owner, so they match what `connectors:resolve` handed out. Best-effort:
  // HookBus.fire isolates subscriber throws, and a fire failure must never fail
  // an already-committed delete.
  const event: ConnectorDeletedEvent = {
    connectorId,
    toolNamespaces: deriveToolNamespaces(ownerUserId, connector),
  };
  try {
    await bus.fire('connectors:deleted', ctx, event);
  } catch (err) {
    ctx.logger.warn('connectors_deleted_event_failed', {
      connectorId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
