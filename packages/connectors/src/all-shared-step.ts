// ---------------------------------------------------------------------------
// One-time boot step (SIGNINS-9, slice 7): every connector is shared.
//
// Owner decision 2026-10-08: "Every connector is shared and usable by agents.
// Remove the Private option." The code no longer reads the `visibility`
// column, so this step makes the stored data agree with that, once:
//
//   1. Dedup. A connector id with more than one LIVE row (two admins each held
//      it privately, one private and one shared, or a legacy pair of shared
//      rows) keeps exactly one: if ANY row is shared, the earliest SHARED row
//      (`created_at`, tie-broken by `owner_user_id`); only when none is
//      shared, the earliest row overall. The others are soft-deleted.
//      SECURITY: a private row never wins over a shared one, because the id's
//      agent sign-ins and global OAuth client secret are keyed by the id alone
//      and were granted against a shared definition; letting an older private
//      row win would send them to that row's URL and hosts.
//
//      Purging, FIRST. A private loser holds nothing (a private row could never
//      take an agent sign-in or a global client secret). But when a group has
//      TWO OR MORE shared rows, its id-keyed credentials (agents' sign-ins, the
//      global OAuth client secret, the workspace company key) may have been
//      granted against a definition that is about to lose. While the id is
//      ambiguous nothing can read them; the dedup would make them readable
//      under the kept definition. So the step reads the groups first, calls the
//      injected `purge` for those ids (`ResignTarget`, with the global refs of
//      every workspace-keyed definition in the group), and runs the dedup
//      transaction ONLY if every purge succeeded. A purge that throws or
//      reports a failure aborts the whole step: no dedup, no flip, no marker;
//      the ids stay ambiguous, so the next boot detects and purges them again.
//      If the transaction's own re-read finds a 2+-shared id the purge did not
//      cover (written in between), it aborts the same way.
//   2. Flip. Every remaining live private row becomes shared. The `visibility`
//      column itself stays (with `DEFAULT 'shared'`) so a rolled-back image
//      still reads every row as shared.
//
// Both writes and the done-marker share ONE transaction, so a crash part-way
// leaves nothing half-done and no marker: the next boot runs the whole step
// again. Tombstoned rows are never touched or counted.
//
// Logs counts only, never ids or owners (the purge targets and `resignIds`
// are passed or returned, never logged). Never throws, never fails boot.
// ---------------------------------------------------------------------------

import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Logger } from '@ax/core';
import { accountRef, deriveCredentialPlan } from './credential-plan.js';
import type { ConnectorDatabase } from './migrations.js';
import { oauthClientSecretRefFor } from './oauth-client-secret-ref.js';
import { isBootStepDone, liveRowsForAllSharedStep, markBootStepDone } from './scope.js';
import type { Capabilities } from './types.js';

/** The boot-step name recorded once a complete pass has run. */
export const ALL_SHARED_STEP = 'all-connectors-shared';

export interface AllConnectorsSharedResult {
  /** True iff this call completed a pass and recorded the marker. */
  ran: boolean;
  /** Live private rows flipped to shared. */
  flipped: number;
  /** Live rows soft-deleted because another row kept their id. */
  deduped: number;
  /**
   * Internal, never logged: the ids (sorted) whose group had two or more
   * SHARED rows. Their id-keyed credentials were purged before the dedup.
   */
  resignIds: string[];
}

/** One id whose id-keyed credentials must go before its group is deduped. */
export interface ResignTarget {
  connectorId: string;
  /**
   * The GLOBAL refs (company keys) of every workspace-keyed definition in the
   * group, sorted and deduped. The OAuth client secret is not listed; the
   * purge adds it for every target.
   */
  globalRefs: string[];
}

/**
 * Purges the targets' credentials. Resolves `{failed: 0}` only when every
 * purge succeeded; any failure (thrown or counted) aborts the step.
 */
export type ResignPurge = (targets: readonly ResignTarget[]) => Promise<{ failed: number }>;

interface LiveRow {
  owner_user_id: string;
  connector_id: string;
  visibility: string;
  created_at: Date;
  key_mode: string;
  capabilities: unknown;
}

/** Just the slot list a plan derives from; lenient, the store validates fully. */
const SlotsShape = z.object({
  credentials: z.array(z.object({ slot: z.string(), kind: z.string() }).passthrough()),
});

/** The global refs a workspace-keyed row's plan holds (the collapsed ref when its slots don't parse). */
function workspaceRefs(row: LiveRow): string[] {
  const parsed = SlotsShape.safeParse(row.capabilities);
  if (!parsed.success) return [accountRef(row.connector_id)];
  return deriveCredentialPlan({
    id: row.connector_id,
    keyMode: 'workspace',
    capabilities: parsed.data as unknown as Pick<Capabilities, 'credentials'>,
  }).map((entry) => entry.ref);
}

function groupById(rows: readonly LiveRow[]): Map<string, LiveRow[]> {
  const byId = new Map<string, LiveRow[]>();
  for (const row of rows) {
    const group = byId.get(row.connector_id) ?? [];
    group.push(row);
    byId.set(row.connector_id, group);
  }
  return byId;
}

/** Ids with two or more SHARED live rows, each with its workspace refs. Sorted by id. */
function resignTargets(rows: readonly LiveRow[]): ResignTarget[] {
  const out: ResignTarget[] = [];
  for (const [connectorId, group] of groupById(rows)) {
    if (group.filter((row) => row.visibility === 'shared').length < 2) continue;
    const secret = oauthClientSecretRefFor(connectorId);
    const refs = new Set<string>();
    for (const row of group) {
      if (row.key_mode !== 'workspace') continue;
      for (const ref of workspaceRefs(row)) if (ref !== secret) refs.add(ref);
    }
    out.push({ connectorId, globalRefs: [...refs].sort() });
  }
  return out.sort((a, b) => (a.connectorId < b.connectorId ? -1 : a.connectorId > b.connectorId ? 1 : 0));
}

/** An abort the step reports by class name (never a message). */
class StepAbort extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

/** Earliest `created_at` first, then `owner_user_id`. */
function byAge(a: LiveRow, b: LiveRow): number {
  const diff = a.created_at.getTime() - b.created_at.getTime();
  if (diff !== 0) return diff;
  return a.owner_user_id < b.owner_user_id ? -1 : a.owner_user_id > b.owner_user_id ? 1 : 0;
}

/**
 * The rows to soft-delete so every connector id keeps exactly one live row,
 * and the ids whose group had two or more shared rows.
 */
function losers(rows: readonly LiveRow[]): { drop: LiveRow[]; resignIds: string[] } {
  const byId = groupById(rows);
  const drop: LiveRow[] = [];
  const resignIds: string[] = [];
  for (const [connectorId, group] of byId) {
    if (group.length < 2) continue;
    // Reads `visibility` for the last time. Any shared row beats every
    // private one (see the header's SECURITY note).
    const shared = group.filter((row) => row.visibility === 'shared');
    const keep = [...(shared.length > 0 ? shared : group)].sort(byAge)[0]!;
    for (const row of group) if (row !== keep) drop.push(row);
    if (shared.length > 1) resignIds.push(connectorId);
  }
  resignIds.sort();
  return { drop, resignIds };
}

const notRun = (): AllConnectorsSharedResult => ({ ran: false, flipped: 0, deduped: 0, resignIds: [] });

export async function makeAllConnectorsShared(
  db: Kysely<ConnectorDatabase>,
  logger: Logger,
  purge: ResignPurge,
): Promise<AllConnectorsSharedResult> {
  try {
    if (await isBootStepDone(db, ALL_SHARED_STEP)) return notRun();

    // Purge BEFORE the dedup (header: "Purging, FIRST"). A throw lands in the
    // catch below: nothing was written, so the next boot retries.
    const targets = resignTargets((await liveRowsForAllSharedStep(db).execute()) as LiveRow[]);
    if (targets.length > 0) {
      const { failed } = await purge(targets);
      if (failed > 0) {
        logger.warn('connectors_all_shared_failed', { name: 'ResignPurgeFailed', failed });
        return notRun();
      }
    }
    const purged = new Set(targets.map((t) => t.connectorId));

    const { flipped, deduped, resignIds } = await db.transaction().execute(async (trx) => {
      const rows = (await liveRowsForAllSharedStep(trx).execute()) as LiveRow[];
      const { drop, resignIds } = losers(rows);
      // A 2+-shared id that appeared after the purge read was not purged:
      // abort (rolls back) rather than make its credentials readable.
      if (resignIds.some((id) => !purged.has(id))) throw new StepAbort('ResignSetChanged');

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
      return { flipped: Number(flip.numUpdatedRows ?? 0n), deduped: dedupedCount, resignIds };
    });

    if (flipped > 0 || deduped > 0) {
      logger.info('connectors_all_shared', { flipped, deduped, resigned: resignIds.length });
    }
    return { ran: true, flipped, deduped, resignIds };
  } catch (err) {
    // The error's class only: a message may name a connector id or owner.
    // Nothing was committed, so the next boot runs the whole step again.
    logger.warn('connectors_all_shared_failed', {
      name: err instanceof Error ? err.name : typeof err,
    });
    return notRun();
  }
}
