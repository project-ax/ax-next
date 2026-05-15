import { type Kysely } from 'kysely';
import type { AttachmentsDatabase } from './migrations.js';

/**
 * Internal rollback signal for `insertTempIfWithinQuota`'s post-insert
 * re-check. We throw to abort the Kysely transaction and convert to the
 * typed `{ ok: false, reason }` result in the outer catch — this keeps
 * the transaction body symmetric (no escape-hatch return) and ensures
 * the partial insert is undone even if a future edit forgets to mirror
 * the rollback.
 */
class QuotaExceededRollback extends Error {
  constructor() {
    super('quota-exceeded');
    this.name = 'QuotaExceededRollback';
  }
}

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
      // INSERT ... SELECT ... WHERE collapses the sum-check and insert into
      // a single SQL statement. Postgres evaluates the WHERE against the
      // statement's snapshot, so two concurrent statements could still both
      // see the same sum. The defense-in-depth here is the second
      // sum-and-reject pass: we insert, then re-read the sum in the SAME
      // transaction, and roll back if the post-insert sum exceeds the
      // quota. Read-committed serializes the writes, so whichever insert
      // commits second will see the first one's bytes in the sum and roll
      // back.
      const result = await db.transaction().execute(async (trx) => {
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
        // Re-check inside the same transaction. A concurrent committed
        // insert lands here as visible rows (read-committed), so the
        // recheck catches the over-quota case the initial check missed.
        const sumAfter = await trx
          .selectFrom('attachments_v1_temps')
          .select((eb) => eb.fn.sum<number>('size_bytes').as('sum'))
          .where('user_id', '=', input.userId)
          .where('expires_at', '>', new Date())
          .executeTakeFirst();
        if (Number(sumAfter?.sum ?? 0) > maxPendingBytes) {
          // Roll back by throwing — Kysely surfaces the rollback to the
          // outer await. We catch it just outside this block and surface
          // the typed result.
          throw new QuotaExceededRollback();
        }
        return { ok: true as const };
      }).catch((err) => {
        if (err instanceof QuotaExceededRollback) {
          return { ok: false as const, reason: 'quota-exceeded' as const };
        }
        throw err;
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
