import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { PluginError, type BlobRef } from '@ax/core';
import type { ArtifactsDatabase } from './migrations.js';

/** Versions kept per artifact. The current version is never pruned (D5). */
export const MAX_RETAINED_VERSIONS = 20;

/** The re-publish key's unique index (artifacts/migrations.ts). */
const SOURCE_PATH_INDEX = 'attachments_v1_artifacts_agent_source_path_uq';

/** Thrown inside the publish transaction when the head it conflicted with is gone. */
class HeadVanished extends Error {}

/** A unique violation on the (agent_id, source_path) index. */
function isPathTaken(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e.constraint === SOURCE_PATH_INDEX;
}

/** Postgres caps one statement at 65535 bind parameters. */
const ID_CHUNK = 1000;

export interface VersionRow {
  artifactId: string;
  version: number;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  /** The chat it was published from; null once that chat is purged (D12). */
  conversationId: string | null;
  publishedBy: string;
  /** Ledger owner key (`quotaOwnerKey`): who the bytes are charged to. */
  quotaOwner: string;
  createdAt: Date;
}

export interface ArtifactRow {
  artifactId: string;
  agentId: string;
  title: string;
  /** Relative to the agent's files root. Never leaves the plugin except back to the agent. */
  sourcePath: string | null;
  currentVersion: number;
  /** Never log this, in full or in part. */
  shareCode: string | null;
  titleSetByUser: boolean;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  current: VersionRow;
}

export interface PublishVersionInput {
  agentId: string;
  /** Re-publish this artifact (possibly from a new path). Omitted: keyed by path. */
  artifactId?: string;
  sourcePath: string;
  title: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  conversationId: string | null;
  publishedBy: string;
  quotaOwner: string;
}

export type PublishVersionResult =
  | { ok: true; artifactId: string; version: number; title: string; created: boolean }
  | { ok: false; reason: 'unknown-artifact' | 'path-taken' };

export interface ArtifactStore {
  publishVersion(i: PublishVersionInput): Promise<PublishVersionResult>;
  /** Newest first (updated_at DESC), ties by artifact_id ASC. */
  listForAgent(agentId: string, limit: number): Promise<ArtifactRow[]>;
  getHead(artifactId: string): Promise<ArtifactRow | null>;
  /** Newest first. */
  listVersions(artifactId: string): Promise<VersionRow[]>;
  getVersion(artifactId: string, version: number): Promise<VersionRow | null>;
  findByShareCode(code: string): Promise<ArtifactRow | null>;
  /** Sets title_set_by_user, so a later publish keeps it (C5). Does not bump updated_at. */
  rename(artifactId: string, title: string): Promise<ArtifactRow | null>;
  /** Moves the pointer; copies nothing. Null when the version is not retained. Bumps updated_at. */
  restore(artifactId: string, version: number): Promise<ArtifactRow | null>;
  /**
   * `ensure` keeps an existing code (or sets `fresh()`), `rotate` replaces it,
   * `off` clears it. Returns the code now in force; null when off or unknown.
   */
  setShareCode(artifactId: string, mode: 'ensure' | 'rotate' | 'off', fresh: () => string): Promise<string | null>;
  deleteArtifact(artifactId: string): Promise<boolean>;
  deleteForAgent(agentId: string): Promise<{ artifacts: number; versions: number }>;
  /** Nulls conversation_id on those chats' versions. Deletes nothing (D12). */
  clearConversations(conversationIds: string[]): Promise<number>;
  /** One `{ sha256, userIds: [quota_owner] }` per version that points at a candidate. */
  blobRefs(shas: string[]): Promise<BlobRef[]>;
}

/**
 * The versions to delete so that at most `keep` remain, newest first, plus the
 * current one wherever it is. Ascending. Never contains `current`.
 */
export function versionsToPrune(versions: number[], current: number, keep: number): number[] {
  const newestFirst = [...versions].sort((a, b) => b - a);
  return newestFirst
    .slice(keep)
    .filter((v) => v !== current)
    .sort((a, b) => a - b);
}

type Db = Kysely<ArtifactsDatabase>;
type Trx = Transaction<ArtifactsDatabase>;

interface JoinedRow {
  artifact_id: string;
  agent_id: string;
  title: string;
  source_path: string | null;
  current_version: number;
  share_code: string | null;
  title_set_by_user: boolean;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
  v_sha256: string;
  v_media_type: string;
  v_size_bytes: number | string;
  v_conversation_id: string | null;
  v_published_by_user: string;
  v_quota_owner: string;
  v_created_at: Date;
}

function headsWithCurrent(db: Db | Trx) {
  return db
    .selectFrom('attachments_v1_artifacts as h')
    .innerJoin('attachments_v1_artifact_versions as v', (j) =>
      j.onRef('v.artifact_id', '=', 'h.artifact_id').onRef('v.version', '=', 'h.current_version'),
    )
    .select([
      'h.artifact_id',
      'h.agent_id',
      'h.title',
      'h.source_path',
      'h.current_version',
      'h.share_code',
      'h.title_set_by_user',
      'h.created_by_user_id',
      'h.created_at',
      'h.updated_at',
      'v.sha256 as v_sha256',
      'v.media_type as v_media_type',
      'v.size_bytes as v_size_bytes',
      'v.conversation_id as v_conversation_id',
      'v.published_by_user as v_published_by_user',
      'v.quota_owner as v_quota_owner',
      'v.created_at as v_created_at',
    ]);
}

function artifactFrom(r: JoinedRow): ArtifactRow {
  return {
    artifactId: r.artifact_id,
    agentId: r.agent_id,
    title: r.title,
    sourcePath: r.source_path,
    currentVersion: r.current_version,
    shareCode: r.share_code,
    titleSetByUser: r.title_set_by_user,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    current: {
      artifactId: r.artifact_id,
      version: r.current_version,
      sha256: r.v_sha256,
      mediaType: r.v_media_type,
      sizeBytes: Number(r.v_size_bytes),
      conversationId: r.v_conversation_id,
      publishedBy: r.v_published_by_user,
      quotaOwner: r.v_quota_owner,
      createdAt: r.v_created_at,
    },
  };
}

function versionFrom(r: {
  artifact_id: string;
  version: number;
  sha256: string;
  media_type: string;
  size_bytes: number | string;
  conversation_id: string | null;
  published_by_user: string;
  quota_owner: string;
  created_at: Date;
}): VersionRow {
  return {
    artifactId: r.artifact_id,
    version: r.version,
    sha256: r.sha256,
    mediaType: r.media_type,
    sizeBytes: Number(r.size_bytes),
    conversationId: r.conversation_id,
    publishedBy: r.published_by_user,
    quotaOwner: r.quota_owner,
    createdAt: r.created_at,
  };
}

async function headById(db: Db | Trx, artifactId: string): Promise<ArtifactRow | null> {
  const row = await headsWithCurrent(db).where('h.artifact_id', '=', artifactId).executeTakeFirst();
  return row === undefined ? null : artifactFrom(row);
}

async function insertVersion(trx: Trx, i: PublishVersionInput, artifactId: string, version: number): Promise<void> {
  await trx
    .insertInto('attachments_v1_artifact_versions')
    .values({
      artifact_id: artifactId,
      version,
      sha256: i.sha256,
      media_type: i.mediaType,
      size_bytes: i.sizeBytes,
      conversation_id: i.conversationId,
      published_by_user: i.publishedBy,
      quota_owner: i.quotaOwner,
      created_at: new Date(),
    })
    .execute();
}

interface LockedHead {
  artifact_id: string;
  source_path: string | null;
}

/** The whole publish, in one transaction. See ArtifactStore.publishVersion. */
async function publishIn(trx: Trx, i: PublishVersionInput): Promise<PublishVersionResult> {
  let head: LockedHead | undefined;
  if (i.artifactId !== undefined) {
    // 1. A named artifact must be this agent's.
    head = await trx
      .selectFrom('attachments_v1_artifacts')
      .select(['artifact_id', 'source_path'])
      .where('artifact_id', '=', i.artifactId)
      .where('agent_id', '=', i.agentId)
      .forUpdate()
      .executeTakeFirst();
    if (head === undefined) return { ok: false, reason: 'unknown-artifact' };
    if (head.source_path !== i.sourcePath) {
      const holder = await trx
        .selectFrom('attachments_v1_artifacts')
        .select('artifact_id')
        .where('agent_id', '=', i.agentId)
        .where('source_path', '=', i.sourcePath)
        .where('artifact_id', '<>', i.artifactId)
        .executeTakeFirst();
      if (holder !== undefined) return { ok: false, reason: 'path-taken' };
    }
  } else {
    // 2. Keyed by path: a fresh head, unless this agent already has one there.
    //    ON CONFLICT waits for a concurrent first publish of the same path to
    //    commit, so two of them make one artifact.
    const artifactId = randomBytes(16).toString('hex');
    const now = new Date();
    const inserted = await trx
      .insertInto('attachments_v1_artifacts')
      .values({
        artifact_id: artifactId,
        agent_id: i.agentId,
        title: i.title,
        source_path: i.sourcePath,
        current_version: 1,
        share_code: null,
        title_set_by_user: false,
        created_by_user_id: i.publishedBy,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['agent_id', 'source_path']).where('source_path', 'is not', null).doNothing(),
      )
      .returning('artifact_id')
      .executeTakeFirst();
    if (inserted !== undefined) {
      await insertVersion(trx, i, artifactId, 1);
      return { ok: true, artifactId, version: 1, title: i.title, created: true };
    }
    head = await trx
      .selectFrom('attachments_v1_artifacts')
      .select(['artifact_id', 'source_path'])
      .where('agent_id', '=', i.agentId)
      .where('source_path', '=', i.sourcePath)
      .forUpdate()
      .executeTakeFirst();
    // The conflicting head was deleted between our insert and this read.
    if (head === undefined) throw new HeadVanished();
  }

  // 3. Re-publish: MAX + 1, not current + 1 (a restore moves current back).
  const artifactId = head.artifact_id;
  const max = await trx
    .selectFrom('attachments_v1_artifact_versions')
    .select((eb) => eb.fn.max<number>('version').as('max'))
    .where('artifact_id', '=', artifactId)
    .executeTakeFirst();
  const next = Number(max?.max ?? 0) + 1;
  await insertVersion(trx, i, artifactId, next);
  const updated = await trx
    .updateTable('attachments_v1_artifacts')
    .set({
      current_version: next,
      updated_at: new Date(),
      source_path: i.sourcePath,
      // C5: a title the user set sticks.
      title: sql<string>`CASE WHEN title_set_by_user THEN title ELSE ${i.title} END`,
    })
    .where('artifact_id', '=', artifactId)
    .returning('title')
    .executeTakeFirstOrThrow();

  // 4. Prune.
  const all = await trx
    .selectFrom('attachments_v1_artifact_versions')
    .select('version')
    .where('artifact_id', '=', artifactId)
    .execute();
  const prune = versionsToPrune(
    all.map((r) => r.version),
    next,
    MAX_RETAINED_VERSIONS,
  );
  if (prune.length > 0) {
    await trx
      .deleteFrom('attachments_v1_artifact_versions')
      .where('artifact_id', '=', artifactId)
      .where('version', 'in', prune)
      .execute();
  }
  return { ok: true, artifactId, version: next, title: updated.title, created: false };
}

export function createArtifactStore<DB>(database: Kysely<DB>): ArtifactStore {
  const db = database as unknown as Db;
  return {
    async publishVersion(i) {
      // One retry: the head a first publish conflicted with was deleted before
      // we could lock it, so the path is free now and a fresh attempt inserts.
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.transaction().execute((trx) => publishIn(trx, i));
        } catch (err) {
          // Moving an artifact to a path: the path-taken check above is an
          // unlocked read, so a concurrent first publish of that path can win
          // the unique index. Same answer as when the check sees it.
          if (isPathTaken(err)) return { ok: false, reason: 'path-taken' };
          if (err instanceof HeadVanished && attempt === 0) continue;
          if (err instanceof HeadVanished) {
            throw new PluginError({
              code: 'conflict',
              plugin: '@ax/attachments',
              message: 'the artifact changed while it was being published; try again',
            });
          }
          throw err;
        }
      }
    },

    async listForAgent(agentId, limit) {
      const rows = await headsWithCurrent(db)
        .where('h.agent_id', '=', agentId)
        .orderBy('h.updated_at', 'desc')
        .orderBy('h.artifact_id', 'asc')
        .limit(limit)
        .execute();
      return rows.map(artifactFrom);
    },

    getHead(artifactId) {
      return headById(db, artifactId);
    },

    async listVersions(artifactId) {
      const rows = await db
        .selectFrom('attachments_v1_artifact_versions')
        .selectAll()
        .where('artifact_id', '=', artifactId)
        .orderBy('version', 'desc')
        .execute();
      return rows.map(versionFrom);
    },

    async getVersion(artifactId, version) {
      const row = await db
        .selectFrom('attachments_v1_artifact_versions')
        .selectAll()
        .where('artifact_id', '=', artifactId)
        .where('version', '=', version)
        .executeTakeFirst();
      return row === undefined ? null : versionFrom(row);
    },

    async findByShareCode(code) {
      const row = await headsWithCurrent(db).where('h.share_code', '=', code).executeTakeFirst();
      return row === undefined ? null : artifactFrom(row);
    },

    async rename(artifactId, title) {
      const r = await db
        .updateTable('attachments_v1_artifacts')
        .set({ title, title_set_by_user: true })
        .where('artifact_id', '=', artifactId)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) return null;
      return headById(db, artifactId);
    },

    restore(artifactId, version) {
      return db.transaction().execute(async (trx) => {
        // Lock the head first, so a concurrent publish's prune cannot delete
        // the version between our check and the pointer move.
        const head = await trx
          .selectFrom('attachments_v1_artifacts')
          .select('artifact_id')
          .where('artifact_id', '=', artifactId)
          .forUpdate()
          .executeTakeFirst();
        if (head === undefined) return null;
        const kept = await trx
          .selectFrom('attachments_v1_artifact_versions')
          .select('version')
          .where('artifact_id', '=', artifactId)
          .where('version', '=', version)
          .executeTakeFirst();
        if (kept === undefined) return null;
        await trx
          .updateTable('attachments_v1_artifacts')
          .set({ current_version: version, updated_at: new Date() })
          .where('artifact_id', '=', artifactId)
          .execute();
        return headById(trx, artifactId);
      });
    },

    async setShareCode(artifactId, mode, fresh) {
      const share_code =
        mode === 'off' ? null : mode === 'rotate' ? fresh() : sql<string>`COALESCE(share_code, ${fresh()})`;
      const row = await db
        .updateTable('attachments_v1_artifacts')
        .set({ share_code })
        .where('artifact_id', '=', artifactId)
        .returning('share_code')
        .executeTakeFirst();
      return row?.share_code ?? null;
    },

    async deleteArtifact(artifactId) {
      // Versions go with the head (ON DELETE CASCADE).
      const r = await db.deleteFrom('attachments_v1_artifacts').where('artifact_id', '=', artifactId).executeTakeFirst();
      return Number(r.numDeletedRows) > 0;
    },

    deleteForAgent(agentId) {
      return db.transaction().execute(async (trx) => {
        const v = await trx
          .deleteFrom('attachments_v1_artifact_versions')
          .where('artifact_id', 'in', (eb) =>
            eb.selectFrom('attachments_v1_artifacts').select('artifact_id').where('agent_id', '=', agentId),
          )
          .executeTakeFirst();
        const h = await trx.deleteFrom('attachments_v1_artifacts').where('agent_id', '=', agentId).executeTakeFirst();
        return { artifacts: Number(h.numDeletedRows), versions: Number(v.numDeletedRows) };
      });
    },

    async clearConversations(conversationIds) {
      let cleared = 0;
      for (let i = 0; i < conversationIds.length; i += ID_CHUNK) {
        const r = await db
          .updateTable('attachments_v1_artifact_versions')
          .set({ conversation_id: null })
          .where('conversation_id', 'in', conversationIds.slice(i, i + ID_CHUNK))
          .executeTakeFirst();
        cleared += Number(r.numUpdatedRows);
      }
      return cleared;
    },

    async blobRefs(shas) {
      if (shas.length === 0) return [];
      const rows = await db
        .selectFrom('attachments_v1_artifact_versions')
        .select(['sha256', 'quota_owner'])
        .where(sql<boolean>`sha256 = ANY(${shas}::text[])`)
        .execute();
      return rows.map((r) => ({ sha256: r.sha256, userIds: [r.quota_owner] }));
    },
  };
}
