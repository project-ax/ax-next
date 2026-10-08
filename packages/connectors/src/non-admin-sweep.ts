// ---------------------------------------------------------------------------
// Boot-time sweep (slice 2b, design §7 step 1): remove every live connector
// whose owner is not an admin. Product decision 2026-10-07: "Remove all
// existing connectors that were made by people (not admins)" — only admins
// define connectors from now on.
//
// Each removal gets the cleanup a real admin `connectors:delete` has (key purge
// at full authority, agents' sign-ins, the `connectors:deleted`
// announcement), with one ordering difference: the purge runs BEFORE the
// soft-delete (like the stdio sweep), so a crash in between leaves the live row
// for the next boot to finish instead of an orphaned key. The survivor answers
// the purge needs are therefore asked "excluding this row", which is what
// `deleteConnector` learns by asking after its soft-delete.
//
// Fails toward KEEPING data whenever it can't be sure:
//   - no `auth:get-user` provider (CLI / canary presets) → nothing is removed;
//   - an `auth:get-user` throw for an owner → that owner's connectors stay;
//   - an `auth:get-user` answer whose `isAdmin` isn't a boolean → same as a throw;
//   - an `auth:get-user` answer that is neither an explicit `null` nor an
//     object (e.g. `undefined`) → same as a throw;
//   - a row whose capabilities don't parse → kept (and logged). That is
//     permanent, not transient, so it does NOT block the one-time marker;
//   - a row whose key purge fails (any `credentials:delete` /
//     `credentials:purge-account` step) → kept, not announced, and the pass is
//     incomplete: tombstoning it would strand its keys for a later same-id
//     connector to inherit, so the next boot retries the whole row;
//   - an id another live connector still carries → its GLOBAL keys stay (they
//     may be the survivor's).
// A deleted account (`auth:get-user` → explicit null) counts as non-admin. So
// does the platform owner `'system'` (skills cap-migration): DELIBERATE, owner
// decision 2026-10-07 — skills relying on such connectors may break.
//
// NOT handled here: authored drafts (`connectors_v1_authored`) proposing a
// removed id are left alone. Pending ones surface in the admins' Awaiting
// approval queue (with their age, so a stale one is easy to Dismiss); old
// `active` ones are inert — nothing reads them as reach.
//
// ONE-TIME, not a standing rule: after a COMPLETE pass (no owner-lookup,
// purge or row-processing failure) it records the `non-admin-connector-removal` boot step
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
import { validateCapabilities, validateKeyMode, type ConnectorStore } from './store.js';

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
  // A failed lookup keeps the owner's rows and blocks the marker (it may be
  // transient, so the next boot asks again).
  const removeOwner = new Map<string, boolean>();
  let ownerChecksFailed = 0;
  for (const owner of new Set(rows.map((row) => row.owner_user_id))) {
    try {
      // Typed `unknown`: the answer crosses a plugin boundary and is narrowed here.
      const user = await bus.call<{ userId: string }, unknown>(
        'auth:get-user',
        ctx,
        { userId: owner },
      );
      if (user === null) {
        // The account is gone — or it is the platform's 'system' owner, removed
        // deliberately (owner decision 2026-10-07: skills relying on it may break).
        // Only an EXPLICIT null means that; anything else non-object is unknown.
        removeOwner.set(owner, true);
      } else if (typeof user !== 'object') {
        throw new Error(`auth:get-user answered ${typeof user}, not a user or null`);
      } else if (typeof (user as AuthUserLike).isAdmin === 'boolean') {
        removeOwner.set(owner, !(user as AuthUserLike).isAdmin);
      } else {
        throw new Error('auth:get-user answered without a boolean isAdmin');
      }
    } catch (err) {
      ctx.logger.warn('connectors_non_admin_sweep_owner_check_failed', {
        ownerUserId: owner,
        err: errMessage(err),
      });
      removeOwner.set(owner, false);
      ownerChecksFailed += 1;
      complete = false;
    }
  }

  let removed = 0;
  let unparseable = 0;
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
          capabilities: validateCapabilities(row.capabilities),
        };
      } catch (err) {
        ctx.logger.warn('connectors_non_admin_sweep_unparseable', {
          connectorId,
          ownerUserId,
          err: errMessage(err),
        });
        // Permanent: kept, counted, and NOT a reason to run again next boot.
        unparseable += 1;
        continue;
      }

      // The same answers `deleteConnector` gets after its soft-delete, asked
      // about every OTHER live row instead. Ids aren't unique across owners.
      const idStillLive = await hasOtherLiveSameIdConnectorForSystemSweep(db, ownerUserId, connectorId);

      // Admin authority (slice-1 ruling), except for GLOBAL refs while another
      // live connector keeps the id: a global ref carries no owner, so that key
      // may be the survivor's company key (same rule as the stdio sweep).
      if (idStillLive) {
        ctx.logger.info('connectors_non_admin_sweep_skipped_global_purge', { connectorId });
      }
      const { failed } = await purgeConnectorState(bus, ctx, ownerUserId, connector, {
        purgeGlobal: !idStillLive,
        purgeAgentSignIns: !idStillLive,
        agentSignInsSkipReason: 'same-id-survives',
        idStillLive,
        announce: false,
      });
      if (failed.length > 0) {
        // Keys may still be stored: keep the row live (no tombstone, no
        // announcement) so the next boot retries the whole removal.
        complete = false;
        ctx.logger.warn('connectors_non_admin_sweep_row_failed', {
          connectorId,
          ownerUserId,
          reason: 'purge-failed',
          failed,
        });
        continue;
      }

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

  // Crash window: a crash after some removals but before this write reruns
  // the sweep next boot. Rows already tombstoned are no longer live, so they
  // are no-ops; only a non-admin connector created in between would also go.
  if (complete) {
    try {
      await markBootStepDone(db, NON_ADMIN_SWEEP_STEP);
    } catch (err) {
      // Re-running is safe (the pass is idempotent); it just runs again.
      complete = false;
      ctx.logger.warn('connectors_non_admin_sweep_mark_failed', { err: errMessage(err) });
    }
  }
  ctx.logger.info('connectors_non_admin_swept', {
    count: removed,
    unparseable,
    ownerChecksFailed,
    complete,
  });
  return { removed, complete };
}
