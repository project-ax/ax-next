/**
 * @ax/shared-folders store. Pure row logic — NO authorization lives here; the
 * plugin decides who may call what before it reaches the store. The store's
 * own job is the row invariants: one owner per folder, a tombstoned folder
 * accepts no grants, and every multi-row change is one transaction.
 */
import { PluginError } from '@ax/core';
import type { Kysely, Transaction } from 'kysely';
import type { SharedFolderRole, SharedFoldersDatabase } from './migrations.js';

const PLUGIN_NAME = '@ax/shared-folders';

/** Cleanup backoff: 30s · 2^attempts, capped at one hour. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

export function cleanupBackoffMs(attempts: number): number {
  // Clamp the exponent so 2^n never overflows into Infinity on a folder that
  // has failed for months.
  const n = Math.min(Math.max(attempts, 0), 20);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** n);
}

export interface FolderState {
  folderId: string;
  /** The agent holding the `owner` grant; null only on a tombstoned folder. */
  ownerAgentId: string | null;
  deleted: boolean;
}

export type UpsertGrantResult =
  | { status: 'unavailable' }
  | { status: 'target-is-owner' }
  | { status: 'ok'; changed: boolean; previousRole: SharedFolderRole | null };

export type RevokeGrantResult =
  | { status: 'unavailable' }
  | { status: 'target-is-owner' }
  | { status: 'ok'; revoked: boolean };

export interface AgentDeletedResult {
  /** One entry per folder the agent held a grant on: who lost access there. */
  reduced: { folderId: string; agentIds: string[] }[];
  /** Folders the agent owned that had no editor to inherit them. */
  tombstoned: string[];
  /** Folders the agent owned that passed to an editor: `{ folderId, newOwner }`. */
  transferred: { folderId: string; newOwnerAgentId: string }[];
}

export interface SharedFoldersStore {
  createFolder(input: { folderId: string; ownerAgentId: string; userId: string }): Promise<void>;
  getFolder(folderId: string): Promise<FolderState | null>;
  upsertGrant(input: {
    folderId: string;
    agentId: string;
    role: 'editor' | 'viewer';
    userId: string;
  }): Promise<UpsertGrantResult>;
  revokeGrant(input: { folderId: string; agentId: string }): Promise<RevokeGrantResult>;
  /** Tombstone a live folder and remove all its grants. Null if not live. */
  tombstone(folderId: string): Promise<{ formerGrantees: string[] } | null>;
  listForAgent(agentId: string): Promise<{ folderId: string; role: SharedFolderRole; createdAt: string }[]>;
  authorize(agentId: string, folderIds: string[]): Promise<{ folderId: string; readOnly: boolean }[]>;
  /** Remove a TOMBSTONED folder's row once its bytes are gone. */
  removeTombstone(folderId: string): Promise<boolean>;
  /** Record a failed cleanup attempt and schedule the next one. */
  recordCleanupFailure(folderId: string, now: Date): Promise<void>;
  /** Tombstones whose next cleanup is due at `now`, oldest-due first. */
  dueTombstones(now: Date, limit: number): Promise<string[]>;
  /**
   * Agent deletion (§3.7), in ONE transaction: remove every grant the agent
   * holds; each folder it owned passes to its OLDEST editor, or — with no
   * editor — is tombstoned and its remaining (viewer) grants removed. A viewer
   * is never promoted. Keyed on `agent_id` alone. Throws on an empty id.
   */
  deleteAllForAgent(agentId: string): Promise<AgentDeletedResult>;
}

type Db = Kysely<SharedFoldersDatabase> | Transaction<SharedFoldersDatabase>;

async function tombstoneIn(trx: Db, folderId: string, now: Date): Promise<string[]> {
  await trx
    .updateTable('shared_folders_v1_folders')
    .set({ deleted_at: now, next_cleanup_at: now, cleanup_attempts: 0 })
    .where('folder_id', '=', folderId)
    .execute();
  const removed = await trx
    .deleteFrom('shared_folders_v1_grants')
    .where('folder_id', '=', folderId)
    .returning('agent_id')
    .execute();
  return removed.map((r) => r.agent_id);
}

/** Lock a LIVE folder row for the rest of the transaction; false if absent or tombstoned. */
async function lockLiveFolder(trx: Db, folderId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('shared_folders_v1_folders')
    .select('folder_id')
    .where('folder_id', '=', folderId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

export function createSharedFoldersStore(db: Kysely<SharedFoldersDatabase>): SharedFoldersStore {
  return {
    async createFolder({ folderId, ownerAgentId, userId }) {
      const now = new Date();
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('shared_folders_v1_folders')
          .values({
            folder_id: folderId,
            created_by_user: userId,
            created_at: now,
            deleted_at: null,
            cleanup_attempts: 0,
            next_cleanup_at: null,
          })
          .execute();
        await trx
          .insertInto('shared_folders_v1_grants')
          .values({
            folder_id: folderId,
            agent_id: ownerAgentId,
            role: 'owner',
            granted_by_user: userId,
            created_at: now,
          })
          .execute();
      });
    },

    async getFolder(folderId) {
      const folder = await db
        .selectFrom('shared_folders_v1_folders')
        .select(['folder_id', 'deleted_at'])
        .where('folder_id', '=', folderId)
        .executeTakeFirst();
      if (folder === undefined) return null;
      const owner = await db
        .selectFrom('shared_folders_v1_grants')
        .select('agent_id')
        .where('folder_id', '=', folderId)
        .where('role', '=', 'owner')
        .executeTakeFirst();
      return {
        folderId,
        ownerAgentId: owner?.agent_id ?? null,
        deleted: folder.deleted_at !== null,
      };
    },

    async upsertGrant({ folderId, agentId, role, userId }) {
      return db.transaction().execute(async (trx): Promise<UpsertGrantResult> => {
        // Re-checked under the row lock: a delete that committed after the
        // plugin's authority check must still win.
        if (!(await lockLiveFolder(trx, folderId))) return { status: 'unavailable' };
        const existing = await trx
          .selectFrom('shared_folders_v1_grants')
          .select('role')
          .where('folder_id', '=', folderId)
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        if (existing?.role === 'owner') return { status: 'target-is-owner' };
        if (existing?.role === role) return { status: 'ok', changed: false, previousRole: role };
        if (existing === undefined) {
          await trx
            .insertInto('shared_folders_v1_grants')
            .values({
              folder_id: folderId,
              agent_id: agentId,
              role,
              granted_by_user: userId,
              created_at: new Date(),
            })
            .execute();
          return { status: 'ok', changed: true, previousRole: null };
        }
        // A role change keeps the grant's original `created_at`: "oldest
        // editor" (ownership transfer) means the longest-standing grant.
        await trx
          .updateTable('shared_folders_v1_grants')
          .set({ role, granted_by_user: userId })
          .where('folder_id', '=', folderId)
          .where('agent_id', '=', agentId)
          .execute();
        return { status: 'ok', changed: true, previousRole: existing.role };
      });
    },

    async revokeGrant({ folderId, agentId }) {
      return db.transaction().execute(async (trx): Promise<RevokeGrantResult> => {
        if (!(await lockLiveFolder(trx, folderId))) return { status: 'unavailable' };
        const existing = await trx
          .selectFrom('shared_folders_v1_grants')
          .select('role')
          .where('folder_id', '=', folderId)
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        if (existing === undefined) return { status: 'ok', revoked: false };
        if (existing.role === 'owner') return { status: 'target-is-owner' };
        await trx
          .deleteFrom('shared_folders_v1_grants')
          .where('folder_id', '=', folderId)
          .where('agent_id', '=', agentId)
          .where('role', '<>', 'owner')
          .execute();
        return { status: 'ok', revoked: true };
      });
    },

    async tombstone(folderId) {
      return db.transaction().execute(async (trx) => {
        if (!(await lockLiveFolder(trx, folderId))) return null;
        const formerGrantees = await tombstoneIn(trx, folderId, new Date());
        return { formerGrantees };
      });
    },

    async listForAgent(agentId) {
      const rows = await db
        .selectFrom('shared_folders_v1_grants as g')
        .innerJoin('shared_folders_v1_folders as f', 'f.folder_id', 'g.folder_id')
        .select(['g.folder_id', 'g.role', 'f.created_at'])
        .where('g.agent_id', '=', agentId)
        .where('f.deleted_at', 'is', null)
        .orderBy('f.created_at', 'asc')
        .orderBy('g.folder_id', 'asc')
        .execute();
      return rows.map((r) => ({
        folderId: r.folder_id,
        role: r.role,
        createdAt: r.created_at.toISOString(),
      }));
    },

    async authorize(agentId, folderIds) {
      if (folderIds.length === 0) return [];
      const rows = await db
        .selectFrom('shared_folders_v1_grants as g')
        .innerJoin('shared_folders_v1_folders as f', 'f.folder_id', 'g.folder_id')
        .select(['g.folder_id', 'g.role'])
        .where('g.agent_id', '=', agentId)
        .where('g.folder_id', 'in', folderIds)
        .where('f.deleted_at', 'is', null)
        .execute();
      return rows.map((r) => ({ folderId: r.folder_id, readOnly: r.role === 'viewer' }));
    },

    async removeTombstone(folderId) {
      return db.transaction().execute(async (trx) => {
        // Belt and braces: a tombstone has no grants, but never leave an
        // orphan grant pointing at a vanished folder row.
        await trx.deleteFrom('shared_folders_v1_grants').where('folder_id', '=', folderId).execute();
        const res = await trx
          .deleteFrom('shared_folders_v1_folders')
          .where('folder_id', '=', folderId)
          .where('deleted_at', 'is not', null)
          .executeTakeFirst();
        return Number(res.numDeletedRows ?? 0n) > 0;
      });
    },

    async recordCleanupFailure(folderId, now) {
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('shared_folders_v1_folders')
          .select('cleanup_attempts')
          .where('folder_id', '=', folderId)
          .where('deleted_at', 'is not', null)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return;
        const attempts = row.cleanup_attempts + 1;
        await trx
          .updateTable('shared_folders_v1_folders')
          .set({
            cleanup_attempts: attempts,
            next_cleanup_at: new Date(now.getTime() + cleanupBackoffMs(attempts - 1)),
          })
          .where('folder_id', '=', folderId)
          .execute();
      });
    },

    async dueTombstones(now, limit) {
      const rows = await db
        .selectFrom('shared_folders_v1_folders')
        .select('folder_id')
        .where('deleted_at', 'is not', null)
        .where((eb) => eb.or([eb('next_cleanup_at', 'is', null), eb('next_cleanup_at', '<=', now)]))
        .orderBy('next_cleanup_at', 'asc')
        .limit(limit)
        .execute();
      return rows.map((r) => r.folder_id);
    },

    async deleteAllForAgent(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new PluginError({
          code: 'missing-field',
          plugin: PLUGIN_NAME,
          message: 'agentId is required',
        });
      }
      return db.transaction().execute(async (trx): Promise<AgentDeletedResult> => {
        const now = new Date();
        const removed = await trx
          .deleteFrom('shared_folders_v1_grants')
          .where('agent_id', '=', agentId)
          .returning(['folder_id', 'role'])
          .execute();

        const reduced: AgentDeletedResult['reduced'] = [];
        const tombstoned: string[] = [];
        const transferred: AgentDeletedResult['transferred'] = [];

        for (const grant of removed) {
          const lost = [agentId];
          if (grant.role === 'owner') {
            // Oldest EDITOR inherits. Viewers are never candidates: promoting
            // one would widen its access (§3.7).
            const heir = await trx
              .selectFrom('shared_folders_v1_grants')
              .select('agent_id')
              .where('folder_id', '=', grant.folder_id)
              .where('role', '=', 'editor')
              .orderBy('created_at', 'asc')
              .orderBy('agent_id', 'asc')
              .limit(1)
              .executeTakeFirst();
            if (heir !== undefined) {
              await trx
                .updateTable('shared_folders_v1_grants')
                .set({ role: 'owner' })
                .where('folder_id', '=', grant.folder_id)
                .where('agent_id', '=', heir.agent_id)
                .execute();
              transferred.push({ folderId: grant.folder_id, newOwnerAgentId: heir.agent_id });
            } else {
              const isLive = await lockLiveFolder(trx, grant.folder_id);
              if (isLive) {
                lost.push(...(await tombstoneIn(trx, grant.folder_id, now)));
                tombstoned.push(grant.folder_id);
              }
            }
          }
          reduced.push({ folderId: grant.folder_id, agentIds: lost });
        }
        return { reduced, tombstoned, transferred };
      });
    },
  };
}
