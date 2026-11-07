import { sql, type Kysely, type Selectable } from 'kysely';
import type { BlobRef } from '@ax/core';
import type { AttachmentFilesTable, AttachmentsDatabase } from './migrations.js';

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

// TASK-68: durable metadata for a committed upload. The
// bytes are in the blob store (sha256-addressed); this is the row that maps an
// id → owner, conversation, sha256 + display metadata.
export interface FileRowInsert {
  id: string;
  conversationId: string;
  userId: string;
  sha256: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
}

export type FileRow = FileRowInsert;

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

  // --- TASK-68: committed-upload (`files`) metadata ---
  /**
   * Record a committed upload under its attachment id. An id that already has
   * a row is left untouched (never overwritten), and the call returns `false`
   * so the caller can tell a replay from a first commit. Content-addressed
   * bytes already live in the blob store; this only records ownership +
   * display metadata.
   */
  insertFile(input: FileRowInsert): Promise<boolean>;
  /** Resolve a committed upload by its attachment id. Null if absent. */
  getFileById(id: string): Promise<FileRow | null>;
  /**
   * All committed uploads for a conversation owned by `userId` (empty if none /
   * foreign), oldest first, ties broken by id — a stable order, so a runner
   * that names its copies in list order derives the same names every time.
   */
  listFilesForConversation(conversationId: string, userId: string): Promise<FileRow[]>;

  // --- TASK-718: conversation purge ---
  /**
   * Delete every committed-upload (`attachments_v1_files`) row that belongs to
   * one of `conversationIds`, in one transaction. Returns how many went. An
   * empty list is a no-op. Never touches `attachments_v1_temps` (pre-commit
   * uploads carry no conversation id; the TTL janitor owns them), published
   * artifacts (they outlive their chat, D12: the artifact store clears their
   * chat ids instead) or blob bytes.
   */
  purgeForConversations(conversationIds: string[]): Promise<{ files: number }>;

  // --- TASK-776: blob:collect-refs holder ---
  /**
   * Which of `shas` do committed uploads still point at, and for whom? One
   * entry per ROW (so two users holding the same bytes give two entries; the
   * caller merges them), with the row's owner. Artifact versions answer through
   * the artifact store.
   *
   * Reads every row, whatever state its conversation is in: a soft-deleted
   * conversation can come back, so it still holds its files. Throws on a query
   * failure — the holder turns that into `ok: false`, never into "no refs".
   */
  blobRefs(shas: string[]): Promise<BlobRef[]>;
}

// Postgres caps one statement at 65535 bind parameters. The plugin already caps
// what it accepts far below that; this keeps the store safe for any caller.
const PURGE_ID_CHUNK = 1000;

function fileRowFrom(row: Selectable<AttachmentFilesTable>): FileRow {
  return {
    id: row.attachment_id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    sha256: row.sha256,
    displayName: row.display_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
  };
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

    async insertFile(input) {
      const inserted = await db
        .insertInto('attachments_v1_files')
        .values({
          attachment_id: input.id,
          conversation_id: input.conversationId,
          user_id: input.userId,
          sha256: input.sha256,
          display_name: input.displayName,
          media_type: input.mediaType,
          size_bytes: input.sizeBytes,
          created_at: new Date(),
        })
        // First commit wins. A replay of the same id (a retried send whose
        // temp row survived) must not move or rewrite the existing row.
        .onConflict((oc) => oc.column('attachment_id').doNothing())
        .returning('attachment_id')
        .executeTakeFirst();
      return inserted !== undefined;
    },

    async getFileById(id) {
      const row = await db
        .selectFrom('attachments_v1_files')
        .selectAll()
        .where('attachment_id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      return fileRowFrom(row);
    },

    async listFilesForConversation(conversationId, userId) {
      const rows = await db
        .selectFrom('attachments_v1_files')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', userId)
        .orderBy('created_at', 'asc')
        .orderBy('attachment_id', 'asc')
        .execute();
      return rows.map(fileRowFrom);
    },

    async purgeForConversations(conversationIds) {
      if (conversationIds.length === 0) return { files: 0 };
      return db.transaction().execute(async (trx) => {
        let files = 0;
        for (let i = 0; i < conversationIds.length; i += PURGE_ID_CHUNK) {
          const chunk = conversationIds.slice(i, i + PURGE_ID_CHUNK);
          // Rows only. The blob bytes these rows pointed at are deliberately
          // left in place: blobs are content-addressed and shared across users
          // (one sha256 can back another tenant's file), so deleting by sha256
          // would need a cross-plugin reference authority, and a
          // check-then-delete would race a concurrent commit of the same bytes.
          // With the rows gone no id maps to the sha, so the bytes are
          // unreachable, not leaked-and-readable. Reclaiming them is the blob
          // sweeper's job (blob:collect-refs), not this delete.
          const f = await trx
            .deleteFrom('attachments_v1_files')
            .where('conversation_id', 'in', chunk)
            .executeTakeFirst();
          files += Number(f.numDeletedRows);
        }
        return { files };
      });
    },

    async blobRefs(shas) {
      if (shas.length === 0) return [];
      // `= ANY(array)` rather than IN (...): one bind parameter however many
      // candidates there are, and it uses the sha256 index from the migration.
      const files = await db
        .selectFrom('attachments_v1_files')
        .select(['sha256', 'user_id'])
        .where(sql<boolean>`sha256 = ANY(${shas}::text[])`)
        .execute();
      return files.map((r) => ({ sha256: r.sha256, userIds: [r.user_id] }));
    },
  };
}
