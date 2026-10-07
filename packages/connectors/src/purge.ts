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
 * `connectors:delete` hook and the boot-time sweeps (stdio-sweep.ts,
 * non-admin-sweep.ts).
 *
 * Every purge step is best-effort (logged + swallowed) so a credential hiccup
 * never wedges a delete, but the steps that failed are RETURNED: the boot
 * non-admin sweep must not tombstone a row whose keys are still stored (a later
 * same-id connector would inherit them), so it keeps the row and retries. The
 * admin delete path and the stdio sweep ignore the result.
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
    agentSignInsSkipReason: 'not-authorized' | 'same-id-survives' | 'survivor-check-failed';
    /**
     * Slice 2b — caller-computed AFTER the row is removed: does any live
     * connector (any owner, any visibility) still carry this id? A failed check
     * must be passed as `true` (keep data when unsure). Rides the
     * `connectors:deleted` event, and gates the person-scope purge below.
     */
    idStillLive: boolean;
    /**
     * Fire `connectors:deleted` at the end (default true). The boot non-admin
     * sweep purges BEFORE it tombstones the row (a crash in between leaves the
     * row for the next boot), so it passes false and calls
     * `announceConnectorDeleted` itself once the row is gone.
     */
    announce?: boolean;
  },
): Promise<{ failed: string[] }> {
  const connectorId = connector.id;
  // Which purge steps failed, e.g. `credentials:delete:user:account:x` or
  // `credentials:purge-account`. Empty = every attempted purge succeeded.
  const failed: string[] = [];

  // Purge the connector's OWN stored key(s) so a secret never lingers with no UI
  // home. Soft-dep: only attempted when credentials:delete is present (a preset
  // without @ax/credentials still deletes the connector). The purge targets ONLY
  // the deleted connector's derived refs, at the scope it declares.
  //
  // SECURITY (invariant #5): a per-user ref (scope:'user', ownerId:ownerUserId) is
  // unambiguously the row owner's own — always safe to purge. A GLOBAL ref
  // (scope:'global', shared company key, owner-independent) is purged ONLY when
  // the caller is authorized (opts.purgeGlobal — `connectors:delete` passes the
  // caller's `purgeGlobal`, which only the admin-only DELETE route sets; the boot
  // stdio sweep sets it unless another owner's same-id connector survives).
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
        failed.push(`credentials:delete:${entry.scope}:${entry.ref}`);
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
  //
  // Slice 2b — PEOPLE's keys for it (user-scope `account:<id>[:SLOT]`, every
  // user) go in the same call, under the same rule PLUS `!idStillLive`: no live
  // connector of ANY owner or visibility keeps the id. A surviving private
  // same-id connector's users may hold exactly those rows, so it keeps them.
  if (connector.visibility === 'shared' && !opts.purgeAgentSignIns) {
    ctx.logger.info('connectors_delete_skipped_agent_signins_purge', {
      connectorId,
      reason: opts.agentSignInsSkipReason,
    });
  } else if (connector.visibility === 'shared' && bus.hasService('credentials:purge-account')) {
    const scopes: Array<'agent' | 'user'> = opts.idStillLive ? ['agent'] : ['agent', 'user'];
    if (opts.idStillLive) {
      ctx.logger.info('connectors_delete_skipped_user_keys_purge', {
        connectorId,
        reason: 'id-still-live',
      });
    }
    try {
      const out = await bus.call<
        { connectorId: string; scopes: Array<'agent' | 'user'> },
        { purged: number }
      >('credentials:purge-account', ctx, { connectorId, scopes });
      ctx.logger.info('connectors_delete_agent_signins_purged', {
        connectorId,
        scopes,
        purged: out.purged,
      });
    } catch (err) {
      failed.push('credentials:purge-account');
      ctx.logger.warn('connectors_delete_agent_signins_purge_failed', {
        connectorId,
        scopes,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (opts.announce !== false) {
    await announceConnectorDeleted(bus, ctx, ownerUserId, connector, opts.idStillLive);
  }
  return { failed };
}

/**
 * Announce a removal so other plugins reclaim state keyed on this connector's
 * tool namespaces (@ax/tool-policy purges its per-tool verdict rows; agents and
 * mcp-oauth act on `idStillLive === false`). Callers invoke this only when a
 * LIVE row was actually removed. The namespaces are derived from
 * `ownerUserId`, the row owner, so they match what `connectors:resolve` handed
 * out. Best-effort: HookBus.fire isolates subscriber throws, and a fire
 * failure must never fail an already-committed delete.
 */
export async function announceConnectorDeleted(
  bus: HookBus,
  ctx: AgentContext,
  ownerUserId: string,
  connector: PurgeableConnector,
  idStillLive: boolean,
): Promise<void> {
  const connectorId = connector.id;
  const event: ConnectorDeletedEvent = {
    connectorId,
    toolNamespaces: deriveToolNamespaces(ownerUserId, connector),
    idStillLive,
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
