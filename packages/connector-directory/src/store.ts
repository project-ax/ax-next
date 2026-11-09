import type { Kysely } from 'kysely';
import type { ConnectorDirectoryDatabase } from './migrations.js';
import type { DirectoryRow } from './normalize.js';

/** The one sync-state row. */
export interface SyncState {
  /** The registry base URL the mirror was copied from. */
  source: string;
  /** Our clock's start time of the last complete sync; the next one asks from just before it. */
  watermark: Date | null;
  /** When the copy was last complete; null = never (the mirror is not served). */
  syncedAt: Date | null;
  lastAttemptAt: Date | null;
  lastAttemptFailed: boolean;
}

export interface DirectoryStore {
  readState(): Promise<SyncState | null>;
  /**
   * Insert the state row if missing. A different stored source: delete every
   * entry and reset the state, in one transaction, so the mirror never mixes
   * two registries. Resolves true when it cleared.
   */
  useSource(source: string): Promise<boolean>;
  /**
   * One transaction: delete every entry and reset the state to never synced
   * (no checkpoint, no attempt), keeping the source: the same reset a source
   * change does. A full crawl starts here, because the full list leaves
   * deleted servers out and so could never remove a row kept from before.
   */
  reset(): Promise<void>;
  /**
   * One transaction: deletes first; then upserts, where a NEW id is skipped
   * once the table holds `maxRows` rows (updates to stored ids still apply).
   * When an id appears twice in `upserts`, the later one wins.
   */
  applyPage(
    page: { upserts: readonly DirectoryRow[]; deletes: readonly string[] },
    maxRows: number,
  ): Promise<{ upserted: number; deleted: number; capped: number }>;
  /** Also sets the last attempt (at `syncedAt`) and clears `lastAttemptFailed`. */
  recordSuccess(at: { watermark: Date; syncedAt: Date }): Promise<void>;
  /** Sets the last attempt and `lastAttemptFailed`; keeps the checkpoint and `syncedAt`. */
  recordFailure(at: Date): Promise<void>;
}

const ENTRIES = 'connector_directory_v1_entries';
const STATE = 'connector_directory_v1_sync_state';
const STATE_ID = 1;

/** The state of a mirror that has never synced: nothing is served from it. */
const NEVER_SYNCED = {
  watermark: null,
  synced_at: null,
  last_attempt_at: null,
  last_attempt_failed: false,
} as const;

/**
 * Rows (or ids) per statement. A registry page is capped in bytes, not in
 * entries, so one can carry tens of thousands of small listings: written in
 * one statement at 11 columns a row, that passes Postgres' 65,535 bind
 * parameters and would fail the page on every sync.
 */
const WRITE_BATCH = 1_000;

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += WRITE_BATCH) out.push(items.slice(i, i + WRITE_BATCH));
  return out;
}

export function createDirectoryStore(db: Kysely<ConnectorDirectoryDatabase>): DirectoryStore {
  return {
    async readState() {
      const row = await db
        .selectFrom(STATE)
        .selectAll()
        .where('id', '=', STATE_ID)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        source: row.source,
        watermark: row.watermark,
        syncedAt: row.synced_at,
        lastAttemptAt: row.last_attempt_at,
        lastAttemptFailed: row.last_attempt_failed,
      };
    },

    async useSource(source) {
      return db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto(STATE)
          .values({ id: STATE_ID, source })
          .onConflict((oc) => oc.column('id').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (created === undefined) {
          const current = await trx
            .selectFrom(STATE)
            .select('source')
            .where('id', '=', STATE_ID)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (current.source === source) return false;
          await trx
            .updateTable(STATE)
            .set({ source, ...NEVER_SYNCED })
            .where('id', '=', STATE_ID)
            .execute();
        }
        // A new source, or a new state row: any row already mirrored came
        // from somewhere else (or from nowhere we can name).
        const cleared = await trx.deleteFrom(ENTRIES).executeTakeFirst();
        return created === undefined || cleared.numDeletedRows > 0n;
      });
    },

    async reset() {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable(STATE).set(NEVER_SYNCED).where('id', '=', STATE_ID).execute();
        await trx.deleteFrom(ENTRIES).execute();
      });
    },

    async applyPage({ upserts, deletes }, maxRows) {
      return db.transaction().execute(async (trx) => {
        let deleted = 0;
        for (const ids of batches(deletes)) {
          const r = await trx.deleteFrom(ENTRIES).where('id', 'in', ids).executeTakeFirst();
          deleted += Number(r.numDeletedRows);
        }

        // Postgres refuses one statement that upserts the same key twice.
        const latest = new Map<string, DirectoryRow>();
        for (const row of upserts) latest.set(row.id, row);
        const rows = [...latest.values()];
        if (rows.length === 0) return { upserted: 0, deleted, capped: 0 };

        const stored = new Set<string>();
        for (const chunk of batches(rows)) {
          const found = await trx
            .selectFrom(ENTRIES)
            .select('id')
            .where(
              'id',
              'in',
              chunk.map((r) => r.id),
            )
            .execute();
          for (const f of found) stored.add(f.id);
        }

        let room = 0;
        if (rows.some((r) => !stored.has(r.id))) {
          const { n } = await trx
            .selectFrom(ENTRIES)
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .executeTakeFirstOrThrow();
          room = Math.max(0, maxRows - Number(n));
        }
        const kept: DirectoryRow[] = [];
        let capped = 0;
        for (const row of rows) {
          if (stored.has(row.id)) {
            kept.push(row);
          } else if (room > 0) {
            kept.push(row);
            room -= 1;
          } else {
            capped += 1;
          }
        }

        for (const chunk of batches(kept)) {
          await trx
            .insertInto(ENTRIES)
            .values(
              chunk.map((r) => ({
                id: r.id,
                title: r.title,
                description: r.description,
                publisher: r.publisher,
                publisher_proof: r.publisherProof,
                url: r.url,
                auth: r.auth,
                key_header: r.keyHeader,
                version: r.version,
                updated_at: r.updatedAt,
                deprecated: r.deprecated,
              })),
            )
            .onConflict((oc) =>
              oc.column('id').doUpdateSet((eb) => ({
                title: eb.ref('excluded.title'),
                description: eb.ref('excluded.description'),
                publisher: eb.ref('excluded.publisher'),
                publisher_proof: eb.ref('excluded.publisher_proof'),
                url: eb.ref('excluded.url'),
                auth: eb.ref('excluded.auth'),
                key_header: eb.ref('excluded.key_header'),
                version: eb.ref('excluded.version'),
                updated_at: eb.ref('excluded.updated_at'),
                deprecated: eb.ref('excluded.deprecated'),
              })),
            )
            .execute();
        }
        return { upserted: kept.length, deleted, capped };
      });
    },

    async recordSuccess({ watermark, syncedAt }) {
      await db
        .updateTable(STATE)
        .set({
          watermark,
          synced_at: syncedAt,
          last_attempt_at: syncedAt,
          last_attempt_failed: false,
        })
        .where('id', '=', STATE_ID)
        .execute();
    },

    async recordFailure(at) {
      await db
        .updateTable(STATE)
        .set({ last_attempt_at: at, last_attempt_failed: true })
        .where('id', '=', STATE_ID)
        .execute();
    },
  };
}
