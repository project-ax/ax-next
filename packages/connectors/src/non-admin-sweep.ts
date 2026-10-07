// ---------------------------------------------------------------------------
// Boot-time sweep (slice 2b, design §7 step 1): remove every live connector
// whose owner is not an admin. Product decision 2026-10-07: "Remove all
// existing connectors that were made by people (not admins)" — only admins
// define connectors from now on.
//
// Each removal gets the cleanup a real admin `connectors:delete` has (key purge
// at full authority, agents' sign-ins, people's keys, the `connectors:deleted`
// announcement), with one ordering difference: the purge runs BEFORE the
// soft-delete (like the stdio sweep), so a crash in between leaves the live row
// for the next boot to finish instead of an orphaned key. The survivor answers
// the purge needs are therefore asked "excluding this row", which is what
// `deleteConnector` learns by asking after its soft-delete.
//
// Fails toward KEEPING data whenever it can't be sure:
//   - no `auth:get-user` provider (CLI / canary presets) → nothing is removed;
//   - an `auth:get-user` throw for an owner → that owner's connectors stay;
//   - a row whose capabilities don't parse → kept (and logged);
//   - an id another live connector still carries → its GLOBAL keys, and its
//     people's keys, stay (they may be the survivor's).
// A deleted account (`auth:get-user` → null) counts as non-admin.
//
// ONE-TIME, not a standing rule: after a COMPLETE pass (no owner-lookup or
// per-connector failure) it records the `non-admin-connector-removal` boot step
// and never runs again, so a later-demoted admin's connectors, or one a person
// creates before the non-admin creation paths are gone, are left alone. An
// incomplete pass, or one skipped for no auth provider, records nothing and
// retries next boot. Never throws.
// Soft-delete (not hard) so the tombstone keeps the id, like `connectors:delete`.
// ---------------------------------------------------------------------------

import type { Kysely } from 'kysely';
import type { AgentContext, HookBus } from '@ax/core';
import type { ConnectorDatabase } from './migrations.js';
import { announceConnectorDeleted, purgeConnectorState, type PurgeableConnector } from './purge.js';
import {
  hasOtherLiveSameIdConnectorForSystemSweep,
  isBootStepDone,
  liveConnectorRowsForSystemSweep,
  markBootStepDone,
} from './scope.js';
import { validateCapabilities, validateKeyMode, validateVisibility, type ConnectorStore } from './store.js';

interface AuthUserLike {
  isAdmin?: unknown;
}

/** The boot-step name recorded once a complete pass has run. */
export const NON_ADMIN_SWEEP_STEP = 'non-admin-connector-removal';

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function sweepNonAdminConnectors(
  db: Kysely<ConnectorDatabase>,
  store: Pick<ConnectorStore, 'softDelete' | 'hasLiveById'>,
  bus: HookBus,
  ctx: AgentContext,
): Promise<{ removed: number; complete: boolean }> {
  let done: boolean;
  try {
    done = await isBootStepDone(db, NON_ADMIN_SWEEP_STEP);
  } catch (err) {
    ctx.logger.warn('connectors_non_admin_sweep_failed', { err: errMessage(err) });
    return { removed: 0, complete: false };
  }
  if (done) {
    ctx.logger.info('connectors_non_admin_sweep_skipped', { reason: 'already-done' });
    return { removed: 0, complete: true };
  }
  if (!bus.hasService('auth:get-user')) {
    ctx.logger.info('connectors_non_admin_sweep_skipped', { reason: 'no-auth-provider' });
    return { removed: 0, complete: false };
  }

  let rows: Awaited<ReturnType<ReturnType<typeof liveConnectorRowsForSystemSweep>['execute']>>;
  try {
    rows = await liveConnectorRowsForSystemSweep(db).execute();
  } catch (err) {
    ctx.logger.warn('connectors_non_admin_sweep_failed', { err: errMessage(err) });
    return { removed: 0, complete: false };
  }

  // Any failure below leaves the step unrecorded, so the next boot retries.
  let complete = true;

  // One lookup per distinct owner. `true` = remove this owner's connectors.
  const removeOwner = new Map<string, boolean>();
  for (const owner of new Set(rows.map((row) => row.owner_user_id))) {
    try {
      const user = await bus.call<{ userId: string }, AuthUserLike | null>(
        'auth:get-user',
        ctx,
        { userId: owner },
      );
      removeOwner.set(owner, user?.isAdmin !== true);
    } catch (err) {
      ctx.logger.warn('connectors_non_admin_sweep_owner_check_failed', {
        ownerUserId: owner,
        err: errMessage(err),
      });
      removeOwner.set(owner, false);
      complete = false;
    }
  }

  let removed = 0;
  for (const row of rows) {
    if (removeOwner.get(row.owner_user_id) !== true) continue;
    const ownerUserId = row.owner_user_id;
    const connectorId = row.connector_id;
    try {
      let connector: PurgeableConnector;
      try {
        connector = {
          id: connectorId,
          keyMode: validateKeyMode(row.key_mode),
          visibility: validateVisibility(row.visibility),
          capabilities: validateCapabilities(row.capabilities),
        };
      } catch (err) {
        ctx.logger.warn('connectors_non_admin_sweep_unparseable', {
          connectorId,
          ownerUserId,
          err: errMessage(err),
        });
        complete = false;
        continue;
      }

      // The same answers `deleteConnector` gets after its soft-delete, asked
      // about every OTHER live row instead. Ids aren't unique across owners.
      const idStillLive = await hasOtherLiveSameIdConnectorForSystemSweep(db, ownerUserId, connectorId, {
        sharedOnly: false,
      });
      const sharedSurvivor =
        connector.visibility === 'shared' &&
        (await hasOtherLiveSameIdConnectorForSystemSweep(db, ownerUserId, connectorId, { sharedOnly: true }));

      // Admin authority (slice-1 ruling), except for GLOBAL refs while another
      // live connector keeps the id: a global ref carries no owner, so that key
      // may be the survivor's company key (same rule as the stdio sweep).
      if (idStillLive) {
        ctx.logger.info('connectors_non_admin_sweep_skipped_global_purge', { connectorId });
      }
      await purgeConnectorState(bus, ctx, ownerUserId, connector, {
        purgeGlobal: !idStillLive,
        purgeAgentSignIns: !sharedSurvivor,
        agentSignInsSkipReason: 'same-id-survives',
        idStillLive,
        announce: false,
      });

      const deleted = await store.softDelete(ownerUserId, connectorId);
      if (!deleted) {
        // Another replica removed it in between; that delete announces it.
        continue;
      }
      removed += 1;
      ctx.logger.info('connectors_non_admin_connector_removed', { connectorId, ownerUserId });

      // Announce with the id's liveness read AFTER the tombstone. Unknown means
      // "still live" (subscribers keep id-keyed state).
      let liveAfter = true;
      try {
        liveAfter = await store.hasLiveById(connectorId);
      } catch (err) {
        ctx.logger.warn('connectors_delete_live_check_failed', { connectorId, err: errMessage(err) });
      }
      await announceConnectorDeleted(bus, ctx, ownerUserId, connector, liveAfter);
    } catch (err) {
      // One row's failure never stops the sweep or the boot; the row (if still
      // live) is retried next boot.
      complete = false;
      ctx.logger.warn('connectors_non_admin_sweep_row_failed', {
        connectorId,
        ownerUserId,
        err: errMessage(err),
      });
    }
  }

  if (complete) {
    try {
      await markBootStepDone(db, NON_ADMIN_SWEEP_STEP);
    } catch (err) {
      // Re-running is safe (the pass is idempotent); it just runs again.
      complete = false;
      ctx.logger.warn('connectors_non_admin_sweep_mark_failed', { err: errMessage(err) });
    }
  }
  ctx.logger.info('connectors_non_admin_swept', { count: removed, complete });
  return { removed, complete };
}
