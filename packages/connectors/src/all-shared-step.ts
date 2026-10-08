// ---------------------------------------------------------------------------
// One-time boot step (SIGNINS-9, slice 7): every connector is shared.
//
// Owner decision 2026-10-08: "Every connector is shared and usable by agents.
// Remove the Private option." The code no longer reads the `visibility`
// column, so this step makes the stored data agree with that, once:
//
//   1. Dedup. A connector id with more than one LIVE row (two admins each held
//      it privately, or one private and one shared) keeps exactly one: the
//      shared row if exactly one is shared, otherwise the earliest
//      `created_at`, tie-broken by `owner_user_id`. The others are
//      soft-deleted. Nothing needs purging: a private row could never hold an
//      agent sign-in or a global client secret.
//   2. Flip. Every remaining live private row becomes shared. The `visibility`
//      column itself stays (with `DEFAULT 'shared'`) so a rolled-back image
//      still reads every row as shared.
//
// Both writes and the done-marker share ONE transaction, so a crash part-way
// leaves nothing half-done and no marker: the next boot runs the whole step
// again. Tombstoned rows are never touched or counted.
//
// Logs counts only, never ids or owners. Never throws, never fails boot.
// ---------------------------------------------------------------------------

import type { Kysely } from 'kysely';
import type { Logger } from '@ax/core';
import type { ConnectorDatabase } from './migrations.js';
import { isBootStepDone, liveRowsForAllSharedStep, markBootStepDone } from './scope.js';

/** The boot-step name recorded once a complete pass has run. */
export const ALL_SHARED_STEP = 'all-connectors-shared';

export interface AllConnectorsSharedResult {
  /** True iff this call completed a pass and recorded the marker. */
  ran: boolean;
  /** Live private rows flipped to shared. */
  flipped: number;
  /** Live rows soft-deleted because another row kept their id. */
  deduped: number;
}

interface LiveRow {
  owner_user_id: string;
  connector_id: string;
  visibility: string;
  created_at: Date;
}

/** Earliest `created_at` first, then `owner_user_id`. */
function byAge(a: LiveRow, b: LiveRow): number {
  const diff = a.created_at.getTime() - b.created_at.getTime();
  if (diff !== 0) return diff;
  return a.owner_user_id < b.owner_user_id ? -1 : a.owner_user_id > b.owner_user_id ? 1 : 0;
}

/** The rows to soft-delete so every connector id keeps exactly one live row. */
function losers(rows: readonly LiveRow[]): LiveRow[] {
  const byId = new Map<string, LiveRow[]>();
  for (const row of rows) {
    const group = byId.get(row.connector_id) ?? [];
    group.push(row);
    byId.set(row.connector_id, group);
  }
  const out: LiveRow[] = [];
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    // Reads `visibility` for the last time: a sole shared row was already what
    // every user saw under this id, so it wins.
    const shared = group.filter((row) => row.visibility === 'shared');
    const keep = shared.length === 1 ? shared[0]! : [...group].sort(byAge)[0]!;
    for (const row of group) if (row !== keep) out.push(row);
  }
  return out;
}

const NOT_RUN: AllConnectorsSharedResult = { ran: false, flipped: 0, deduped: 0 };

export async function makeAllConnectorsShared(
  db: Kysely<ConnectorDatabase>,
  logger: Logger,
): Promise<AllConnectorsSharedResult> {
  try {
    if (await isBootStepDone(db, ALL_SHARED_STEP)) return NOT_RUN;

    const { flipped, deduped } = await db.transaction().execute(async (trx) => {
      const rows = (await liveRowsForAllSharedStep(trx).execute()) as LiveRow[];
      const drop = losers(rows);

      let dedupedCount = 0;
      if (drop.length > 0) {
        const now = new Date();
        const res = await trx
          .updateTable('connectors_v1_connectors')
          .set({ deleted_at: now, updated_at: now })
          .where('deleted_at', 'is', null)
          .where((eb) =>
            eb.or(
              drop.map((row) =>
                eb.and([
                  eb('owner_user_id', '=', row.owner_user_id),
                  eb('connector_id', '=', row.connector_id),
                ]),
              ),
            ),
          )
          .executeTakeFirst();
        dedupedCount = Number(res.numUpdatedRows ?? 0n);
      }

      // The flip. `visibility` is written here and nowhere else.
      const flip = await trx
        .updateTable('connectors_v1_connectors')
        .set({ visibility: 'shared' })
        .where('deleted_at', 'is', null)
        .where('visibility', '=', 'private')
        .executeTakeFirst();

      await markBootStepDone(trx, ALL_SHARED_STEP);
      return { flipped: Number(flip.numUpdatedRows ?? 0n), deduped: dedupedCount };
    });

    if (flipped > 0 || deduped > 0) {
      logger.info('connectors_all_shared', { flipped, deduped });
    }
    return { ran: true, flipped, deduped };
  } catch (err) {
    // The error's class only: a message may name a connector id or owner.
    // Nothing was committed, so the next boot runs the whole step again.
    logger.warn('connectors_all_shared_failed', {
      name: err instanceof Error ? err.name : typeof err,
    });
    return NOT_RUN;
  }
}
