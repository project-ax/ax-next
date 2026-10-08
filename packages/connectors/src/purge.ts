import type { AgentContext, HookBus } from '@ax/core';
import { deriveCredentialPlan } from './credential-plan.js';
import {
  namesOAuthClientSecretRef,
  oauthClientSecretRefFor,
} from './oauth-client-secret-ref.js';
import { deriveToolNamespaces } from './tool-namespace.js';
import type { Capabilities, Connector, ConnectorDeletedEvent } from './types.js';
import type { ResignTarget } from './all-shared-step.js';

const AGENT_SCOPE: Array<'agent'> = ['agent'];

/** Delete one GLOBAL-scope ref. Throws on failure; callers decide what to log. */
async function deleteGlobalRef(bus: HookBus, ctx: AgentContext, ref: string): Promise<void> {
  await bus.call('credentials:delete', ctx, { scope: 'global', ownerId: null, ref });
}

/** Purge every agent's sign-ins for an id (agent scope only). Throws on failure. */
async function purgeAgentScopeSignIns(bus: HookBus, ctx: AgentContext, connectorId: string): Promise<number> {
  const out = await bus.call<
    { connectorId: string; scopes: Array<'agent'> },
    { purged: number }
  >('credentials:purge-account', ctx, { connectorId, scopes: AGENT_SCOPE });
  return out.purged;
}

/**
 * SIGNINS-9 — the all-shared boot step's injected `ResignPurge`. Before it
 * dedupes an id that has two or more SHARED definitions, the id's id-keyed
 * credentials may belong to the definition about to lose, so for each target
 * this purges every agent's sign-ins (agent scope), the global OAuth client
 * secret (`account:<id>:OAUTH_CLIENT_SECRET`) and the workspace company keys
 * (`target.globalRefs`); agents and the admin then sign in / enter the key
 * again against the kept definition.
 *
 * Failures are COUNTED, not swallowed: the step aborts (no dedup, no marker)
 * unless this answers `{failed: 0}`, and retries next boot. A missing
 * credentials hook is not a failure (nothing is stored without it). Logs a
 * count only: the step promises never to log ids or owners.
 */
export async function purgeSignInsForResign(
  bus: HookBus,
  ctx: AgentContext,
  targets: readonly ResignTarget[],
): Promise<{ failed: number }> {
  let failed = 0;
  for (const { connectorId, globalRefs } of targets) {
    if (bus.hasService('credentials:purge-account')) {
      try {
        await purgeAgentScopeSignIns(bus, ctx, connectorId);
      } catch {
        failed += 1;
      }
    }
    if (bus.hasService('credentials:delete')) {
      for (const ref of [oauthClientSecretRefFor(connectorId), ...globalRefs]) {
        try {
          await deleteGlobalRef(bus, ctx, ref);
        } catch {
          failed += 1;
        }
      }
    }
  }
  if (targets.length > 0) {
    const log = failed > 0 ? ctx.logger.warn.bind(ctx.logger) : ctx.logger.info.bind(ctx.logger);
    log('connectors_all_shared_resign_purged', { ids: targets.length, failed });
  }
  return { failed };
}

/** What `purgeConnectorState` reads from a connector — no more. */
export type PurgeableConnector = Pick<Connector, 'id' | 'keyMode'> & {
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
    /** Caller-computed: authorized AND no other live same-id connector survives. */
    purgeAgentSignIns: boolean;
    /** Why `purgeAgentSignIns` is false (for the skip log). */
    agentSignInsSkipReason: 'not-authorized' | 'same-id-survives' | 'survivor-check-failed';
    /**
     * Slice 2b — caller-computed AFTER the row is removed: does any live
     * connector (any owner) still carry this id? A failed check
     * must be passed as `true` (keep data when unsure). Rides the
     * `connectors:deleted` event.
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
  // Which purge steps failed, e.g. `credentials:delete:global:account:x` or
  // `credentials:purge-account`. Empty = every attempted purge succeeded.
  const failed: string[] = [];

  // Purge the connector's OWN stored company key(s) so a secret never lingers
  // with no UI home. Soft-dep: only attempted when credentials:delete is present
  // (a preset without @ax/credentials still deletes the connector). The purge
  // targets ONLY the deleted connector's derived refs.
  //
  // Only GLOBAL rows are deleted here. A `personal` connector's plan entries are
  // at AGENT scope (one row per agent it was added to), so they go through
  // `credentials:purge-account` below, which reaches every agent at once.
  // Nothing is stored per PERSON any more (agent-owned sign-ins, slice 5), so
  // there is no user-scope row to delete.
  //
  // SECURITY (invariant #5): a GLOBAL ref (shared company key, owner-
  // independent) is purged ONLY when the caller is authorized (opts.purgeGlobal —
  // `connectors:delete` passes the caller's `purgeGlobal`, which only the
  // admin-only DELETE route sets; the boot stdio sweep sets it unless another
  // owner's same-id connector survives). Gating the PURGE here, not just the HTTP
  // create route, closes EVERY path to a non-admin global-credential wipe. Each
  // failure is logged + swallowed so a credential hiccup never wedges the delete.
  if (bus.hasService('credentials:delete')) {
    const purgeGlobal = opts.purgeGlobal;
    // TASK-797 — the connector's OAuth client secret is not a plan slot, but it
    // is the connector's own key too: the editor stores it at global. Like the
    // plan's global refs it is owner-independent, so it is purged only with
    // `purgeGlobal`. What callers pass: `deleteConnector` passes the caller's
    // `purgeGlobal` straight through (the admin-only DELETE route sets it), even
    // while another same-id connector survives; the boot stdio and non-admin
    // sweeps withhold it while another live connector carries the id.
    // SIGNINS-9: every connector is shared, so there is no private definition
    // whose delete must be kept away from it.
    const clientSecretRef = oauthClientSecretRefFor(connectorId);
    const ownsClientSecret = namesOAuthClientSecretRef(connector.capabilities, clientSecretRef);
    const globalRefs: string[] = [
      ...deriveCredentialPlan(connector)
        .filter((entry) => entry.scope === 'global')
        .map((entry) => entry.ref),
      ...(ownsClientSecret ? [clientSecretRef] : []),
    ];
    for (const ref of globalRefs) {
      if (!purgeGlobal) {
        // Unauthorized to purge a shared/company key — leave it intact. (An admin
        // delete passes purgeGlobal:true; a non-admin's never does.)
        ctx.logger.info('connectors_delete_skipped_global_purge', { connectorId, ref });
        continue;
      }
      try {
        await deleteGlobalRef(bus, ctx, ref);
      } catch (err) {
        failed.push(`credentials:delete:global:${ref}`);
        ctx.logger.warn('connectors_delete_credential_purge_failed', {
          connectorId,
          ref,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Agent-owned sign-ins (2026-10-07 design): every agent's sign-in / per-agent
  // key for this connector lives at AGENT scope under `account:<id>[:SLOT]`.
  // Best-effort, like the credential purge above. Requires admin authority
  // (purgeGlobal) and no surviving same-id connector (ids are not unique across
  // owners): the survivor would still read them. SIGNINS-9: every connector is
  // shared, so every delete is a candidate.
  if (!opts.purgeAgentSignIns) {
    ctx.logger.info('connectors_delete_skipped_agent_signins_purge', {
      connectorId,
      reason: opts.agentSignInsSkipReason,
    });
  } else if (bus.hasService('credentials:purge-account')) {
    const scopes = AGENT_SCOPE;
    try {
      const purged = await purgeAgentScopeSignIns(bus, ctx, connectorId);
      ctx.logger.info('connectors_delete_agent_signins_purged', {
        connectorId,
        scopes,
        purged,
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
