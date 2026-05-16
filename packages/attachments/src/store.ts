import { sql, type Kysely } from 'kysely';
import type { AttachmentsDatabase } from './migrations.js';

export interface TempInsert {
  attachmentId: string;
  userId: string;
  bytes: Buffer;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  expiresAt: Date;
}

export interface TempRow {
  attachmentId: string;
  userId: string;
  bytes: Buffer;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  expiresAt: Date;
  createdAt: Date;
}

export type InsertTempIfWithinQuotaResult =
  | { ok: true }
  | { ok: false; reason: 'quota-exceeded' };

/**
 * Pure data access over `attachments_v1_temps`. No policy, no ACL — handlers
 * (Task 5+) layer those on top. `getTemp` filters out already-expired rows
 * so callers can't accidentally redeem a stale temp; the janitor (Task 8)
 * calls `purgeExpired()` to actually delete them.
 */
export interface AttachmentsStore {
  insertTemp(input: TempInsert): Promise<void>;
  /**
   * Atomic quota-and-insert. Performs the per-user sum-check and the insert
   * in a single SQL statement so two concurrent callers can't both pass
   * the check and then both insert past the quota. Returns `ok: false`
   * with `reason: 'quota-exceeded'` when the insert would push the user
   * past `maxPendingBytes`.
   */
  insertTempIfWithinQuota(
    input: TempInsert,
    maxPendingBytes: number,
  ): Promise<InsertTempIfWithinQuotaResult>;
  /** Returns null for absent OR expired rows. Never returns an expired row. */
  getTemp(attachmentId: string): Promise<TempRow | null>;
  /** Sum of `size_bytes` for non-expired rows owned by this user. */
  sumPendingBytesForUser(userId: string): Promise<number>;
  deleteTemp(attachmentId: string): Promise<void>;
  /** Deletes rows past expires_at. Returns the count deleted. */
  purgeExpired(): Promise<number>;
}

export function createAttachmentsStore(
  db: Kysely<AttachmentsDatabase>,
): AttachmentsStore {
  return {
    async insertTemp(input) {
      await db
        .insertInto('attachments_v1_temps')
        .values({
          attachment_id: input.attachmentId,
          user_id: input.userId,
          bytes: input.bytes,
          display_name: input.displayName,
          media_type: input.mediaType,
          size_bytes: input.sizeBytes,
          expires_at: input.expiresAt,
          // The column has DEFAULT NOW() in the migration, but Kysely
          // sees the column type as a non-optional Date so we set it
          // explicitly. Matches the @ax/conversations pattern.
          created_at: new Date(),
        })
        .execute();
    },

    async insertTempIfWithinQuota(input, maxPendingBytes) {
      // Quota check needs per-user serialization. Read-committed does NOT
      // serialize inserts across different rows — two concurrent transactions
      // inserting different `attachment_id`s for the same user don't block
      // each other, and each post-check `sum()` sees the other transaction's
      // row as uncommitted (invisible). Both can pass and commit, blowing
      // the quota. The earlier comment here was wrong about that.
      //
      // Fix: take a Postgres transaction-scoped advisory lock keyed on
      // `hashtext(user_id)`. The second concurrent tx for the same user
      // waits until the first commits, then its pre-check sum() sees the
      // first row and returns `quota-exceeded`. Different users still run
      // concurrently. Auto-released on COMMIT/ROLLBACK; no retry loop.
      const result = await db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`.execute(trx);
        const sumBefore = await trx
          .selectFrom('attachments_v1_temps')
          .select((eb) => eb.fn.sum<number>('size_bytes').as('sum'))
          .where('user_id', '=', input.userId)
          .where('expires_at', '>', new Date())
          .executeTakeFirst();
        if (Number(sumBefore?.sum ?? 0) + input.sizeBytes > maxPendingBytes) {
          return { ok: false as const, reason: 'quota-exceeded' as const };
        }
        await trx
          .insertInto('attachments_v1_temps')
          .values({
            attachment_id: input.attachmentId,
            user_id: input.userId,
            bytes: input.bytes,
            display_name: input.displayName,
            media_type: input.mediaType,
            size_bytes: input.sizeBytes,
            expires_at: input.expiresAt,
            created_at: new Date(),
          })
          .execute();
        return { ok: true as const };
      });
      return result;
    },

    async getTemp(attachmentId) {
      const row = await db
        .selectFrom('attachments_v1_temps')
        .selectAll()
        .where('attachment_id', '=', attachmentId)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();
      if (!row) return null;
      return {
        attachmentId: row.attachment_id,
        userId: row.user_id,
        bytes: row.bytes,
        displayName: row.display_name,
        mediaType: row.media_type,
        sizeBytes: Number(row.size_bytes),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      };
    },

    async sumPendingBytesForUser(userId) {
      const result = await db
        .selectFrom('attachments_v1_temps')
        .select((eb) => eb.fn.sum<number>('size_bytes').as('sum'))
        .where('user_id', '=', userId)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();
      return Number(result?.sum ?? 0);
    },

    async deleteTemp(attachmentId) {
      await db
        .deleteFrom('attachments_v1_temps')
        .where('attachment_id', '=', attachmentId)
        .execute();
    },

    async purgeExpired() {
      const result = await db
        .deleteFrom('attachments_v1_temps')
        .where('expires_at', '<=', new Date())
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}
