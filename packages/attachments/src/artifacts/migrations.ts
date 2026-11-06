import { sql, type Kysely } from 'kysely';
import { posix } from 'node:path';
import { mediaTypeForPath } from './media.js';
import { normalizeArtifactTitle } from './title.js';

// ---------------------------------------------------------------------------
// Published artifacts: agent-scoped heads + their versions. Owned by
// @ax/attachments alone (I4). The FK from versions to heads stays inside this
// plugin, so it is allowed; nothing references another plugin's table.
//
// A head is what people see and link to (`artifact_id` is the id a chat chip
// carries). Each publish adds a version; the head points at its current one.
// `sha256` is the file's own content digest (storage-agnostic, I1).
// `source_path` is the file's place under the agent's files root: the
// re-publish key, never handed out beyond the agent itself.
//
// Upgrade from the single-version, conversation-scoped table happens in place
// (chip ids already in transcripts must keep resolving), in three calls the
// plugin makes at init, in order:
//   1. runArtifactsMigration   — DDL, plus the legacy rows -> version 1.
//   2. backfillArtifactAgents  — each head's agent, from its version-1 chat.
//   3. finishArtifactsMigration — NOT NULL + indexes.
// All three are idempotent; a failure in 2 leaves the rows for the next boot.
// ---------------------------------------------------------------------------

export interface ArtifactsTable {
  artifact_id: string;
  agent_id: string;
  title: string;
  source_path: string | null;
  current_version: number;
  share_code: string | null;
  title_set_by_user: boolean;
  /** A chat visual (show_visual): kept out of every Artifacts surface. */
  visual: boolean;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface ArtifactVersionsTable {
  artifact_id: string;
  version: number;
  sha256: string;
  media_type: string;
  size_bytes: number;
  conversation_id: string | null;
  published_by_user: string;
  quota_owner: string;
  created_at: Date;
}

export interface ArtifactsDatabase {
  attachments_v1_artifacts: ArtifactsTable;
  attachments_v1_artifact_versions: ArtifactVersionsTable;
}

/** conversations:agent-ids takes at most this many ids per call. */
const MAP_CHUNK = 500;
const INSERT_CHUNK = 500;

const OCTET_STREAM = 'application/octet-stream';

/**
 * R27: the name show_visual gave a chart before the `visual` marker existed
 * (`visuals/<sha256 of the html>.html`, content-derived, #1135). A legacy row
 * with exactly this path is a chat chart and migrates hidden; every other
 * legacy row, `visuals/report.html` included, stays a visible artifact. A
 * Postgres regex, passed as a bound parameter so nothing is escaped twice.
 */
const LEGACY_VISUAL_PATH = '^visuals/[0-9a-f]{64}\\.html$';

interface LegacyRow {
  artifact_id: string;
  conversation_id: string;
  user_id: string;
  sha256: string;
  path: string;
  display_name: string;
  media_type: string;
  size_bytes: string | number;
  created_at: Date;
}

async function hasLegacyShape(db: Kysely<unknown>): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'attachments_v1_artifacts'
      AND column_name = 'conversation_id'
  `.execute(db);
  return (r.rows[0]?.n ?? 0) > 0;
}

/** DDL plus the legacy upgrade (steps 1-3). Idempotent. */
export async function runArtifactsMigration<DB>(db: Kysely<DB>): Promise<void> {
  const k = db as unknown as Kysely<unknown>;

  // 1. Both tables in the new shape. On a legacy DB the head CREATE is a no-op
  //    and the columns below are added instead.
  await sql`
    CREATE TABLE IF NOT EXISTS attachments_v1_artifacts (
      artifact_id        TEXT PRIMARY KEY,
      agent_id           TEXT NOT NULL,
      title              TEXT NOT NULL,
      source_path        TEXT NULL,
      current_version    INTEGER NOT NULL CHECK (current_version >= 1),
      share_code         TEXT NULL,
      title_set_by_user  BOOLEAN NOT NULL DEFAULT false,
      visual             BOOLEAN NOT NULL DEFAULT false,
      created_by_user_id TEXT NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(k);

  await sql`
    CREATE TABLE IF NOT EXISTS attachments_v1_artifact_versions (
      artifact_id       TEXT NOT NULL REFERENCES attachments_v1_artifacts (artifact_id) ON DELETE CASCADE,
      version           INTEGER NOT NULL CHECK (version >= 1),
      sha256            TEXT NOT NULL,
      media_type        TEXT NOT NULL,
      size_bytes        BIGINT NOT NULL CHECK (size_bytes >= 0),
      conversation_id   TEXT NULL,
      published_by_user TEXT NOT NULL,
      quota_owner       TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (artifact_id, version)
    )
  `.execute(k);

  // 1b. Chat visuals (show_visual) are kept out of every Artifacts surface.
  //     Additive: every existing row is a normal, visible artifact.
  await sql`
    ALTER TABLE attachments_v1_artifacts
      ADD COLUMN IF NOT EXISTS visual BOOLEAN NOT NULL DEFAULT false
  `.execute(k);

  // 2. Every new head column, nullable (a legacy table has rows to fill first;
  //    finishArtifactsMigration sets NOT NULL once they are filled).
  await sql`
    ALTER TABLE attachments_v1_artifacts
      ADD COLUMN IF NOT EXISTS agent_id           TEXT,
      ADD COLUMN IF NOT EXISTS title              TEXT,
      ADD COLUMN IF NOT EXISTS source_path        TEXT,
      ADD COLUMN IF NOT EXISTS current_version    INTEGER CHECK (current_version >= 1),
      ADD COLUMN IF NOT EXISTS share_code         TEXT,
      ADD COLUMN IF NOT EXISTS title_set_by_user  BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS created_by_user_id TEXT,
      ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW()
  `.execute(k);

  // 3. The legacy shape still carries conversation_id on the head: each row
  //    becomes version 1 of itself, and the per-version columns leave the head.
  if (!(await hasLegacyShape(k))) return;
  await k.transaction().execute(async (trx) => {
    const legacy = await sql<LegacyRow>`
      SELECT artifact_id, conversation_id, user_id, sha256, path, display_name, media_type, size_bytes, created_at
      FROM attachments_v1_artifacts
      ORDER BY artifact_id
    `.execute(trx);
    const versions = legacy.rows.map((r) => {
      // The type is re-derived from the path, as every new publish is; an
      // extension the table does not know keeps the type it was stored with.
      const derived = mediaTypeForPath(r.path);
      return {
        artifact_id: r.artifact_id,
        version: 1,
        sha256: r.sha256,
        media_type: derived === OCTET_STREAM ? r.media_type : derived,
        size_bytes: Number(r.size_bytes),
        conversation_id: r.conversation_id,
        published_by_user: r.user_id,
        quota_owner: r.user_id,
        created_at: r.created_at,
      };
    });
    const v = trx as unknown as Kysely<ArtifactsDatabase>;
    for (let i = 0; i < versions.length; i += INSERT_CHUNK) {
      await v
        .insertInto('attachments_v1_artifact_versions')
        .values(versions.slice(i, i + INSERT_CHUNK))
        .onConflict((oc) => oc.columns(['artifact_id', 'version']).doNothing())
        .execute();
    }
    // The old link key (conversation, path) does not carry over: a legacy
    // artifact has no source path, so the next publish of that file starts a
    // new artifact for the agent rather than guessing which one it was.
    await sql`
      UPDATE attachments_v1_artifacts
      SET created_by_user_id = user_id,
          current_version = 1,
          updated_at = created_at,
          source_path = NULL,
          visual = (path ~ ${LEGACY_VISUAL_PATH})
    `.execute(trx);
    // Titles get the one spelling every new publish gets (title.ts): a legacy
    // name could be 1024 characters with line breaks or bidi overrides.
    const titled = legacy.rows.map((r) => ({
      id: r.artifact_id,
      title:
        normalizeArtifactTitle(r.display_name) ??
        normalizeArtifactTitle(posix.basename(r.path)) ??
        'Untitled',
    }));
    for (let i = 0; i < titled.length; i += INSERT_CHUNK) {
      const chunk = titled.slice(i, i + INSERT_CHUNK);
      await sql`
        UPDATE attachments_v1_artifacts AS h SET title = t.title
        FROM unnest(${chunk.map((c) => c.id)}::text[], ${chunk.map((c) => c.title)}::text[]) AS t(id, title)
        WHERE h.artifact_id = t.id
      `.execute(trx);
    }
    // The legacy UNIQUE (conversation_id, path) and the old indexes go with
    // their columns.
    await sql`
      ALTER TABLE attachments_v1_artifacts
        DROP COLUMN IF EXISTS conversation_id,
        DROP COLUMN IF EXISTS user_id,
        DROP COLUMN IF EXISTS sha256,
        DROP COLUMN IF EXISTS path,
        DROP COLUMN IF EXISTS display_name,
        DROP COLUMN IF EXISTS media_type,
        DROP COLUMN IF EXISTS size_bytes
    `.execute(trx);
  });
}

/**
 * Step 4: give every head without an agent the agent of its version-1
 * conversation. `mapAgents` gets at most 500 conversation ids per call and
 * answers the ones it knows. In one transaction, mapped heads get their agent
 * and unmapped heads are deleted (no conversation row exists, so nothing can
 * reach them). A throwing `mapAgents` propagates and changes nothing.
 */
export async function backfillArtifactAgents<DB>(
  db: Kysely<DB>,
  mapAgents: (conversationIds: string[]) => Promise<Map<string, string>>,
): Promise<{ mapped: number; dropped: number }> {
  const k = db as unknown as Kysely<unknown>;
  const pending = await sql<{ artifact_id: string; conversation_id: string | null }>`
    SELECT h.artifact_id, v.conversation_id
    FROM attachments_v1_artifacts h
    LEFT JOIN attachments_v1_artifact_versions v
      ON v.artifact_id = h.artifact_id AND v.version = 1
    WHERE h.agent_id IS NULL
  `.execute(k);
  if (pending.rows.length === 0) return { mapped: 0, dropped: 0 };

  const conversationIds = [
    ...new Set(pending.rows.flatMap((r) => (r.conversation_id === null ? [] : [r.conversation_id]))),
  ];
  const agentOf = new Map<string, string>();
  for (let i = 0; i < conversationIds.length; i += MAP_CHUNK) {
    const answer = await mapAgents(conversationIds.slice(i, i + MAP_CHUNK));
    for (const [conversationId, agentId] of answer) {
      if (typeof agentId === 'string' && agentId.length > 0) agentOf.set(conversationId, agentId);
    }
  }

  const byAgent = new Map<string, string[]>();
  const dropped: string[] = [];
  for (const r of pending.rows) {
    const agentId = r.conversation_id === null ? undefined : agentOf.get(r.conversation_id);
    if (agentId === undefined) {
      dropped.push(r.artifact_id);
    } else {
      byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), r.artifact_id]);
    }
  }

  await k.transaction().execute(async (trx) => {
    for (const [agentId, ids] of byAgent) {
      await sql`
        UPDATE attachments_v1_artifacts SET agent_id = ${agentId}
        WHERE artifact_id = ANY(${ids}::text[]) AND agent_id IS NULL
      `.execute(trx);
    }
    if (dropped.length > 0) {
      // Versions go with their head (ON DELETE CASCADE).
      await sql`
        DELETE FROM attachments_v1_artifacts
        WHERE artifact_id = ANY(${dropped}::text[]) AND agent_id IS NULL
      `.execute(trx);
    }
  });
  return { mapped: pending.rows.length - dropped.length, dropped: dropped.length };
}

/** Step 5: NOT NULL on the backfilled columns, then the indexes. Idempotent. */
export async function finishArtifactsMigration<DB>(db: Kysely<DB>): Promise<void> {
  const k = db as unknown as Kysely<unknown>;
  await sql`
    ALTER TABLE attachments_v1_artifacts
      ALTER COLUMN agent_id SET NOT NULL,
      ALTER COLUMN title SET NOT NULL,
      ALTER COLUMN current_version SET NOT NULL,
      ALTER COLUMN created_by_user_id SET NOT NULL,
      ALTER COLUMN updated_at SET NOT NULL
  `.execute(k);

  // The re-publish key: one artifact per path per agent.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS attachments_v1_artifacts_agent_source_path_uq
      ON attachments_v1_artifacts (agent_id, source_path) WHERE source_path IS NOT NULL
  `.execute(k);
  // Share links are looked up only through this index.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS attachments_v1_artifacts_share_code_uq
      ON attachments_v1_artifacts (share_code) WHERE share_code IS NOT NULL
  `.execute(k);
  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_artifacts_agent_updated_idx
      ON attachments_v1_artifacts (agent_id, updated_at DESC)
  `.execute(k);
  // blob:collect-refs asks `sha256 = ANY($1)` once per sweep batch.
  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_artifact_versions_sha256_idx
      ON attachments_v1_artifact_versions (sha256)
  `.execute(k);
  // conversations:purged clears these.
  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_artifact_versions_conversation_id_idx
      ON attachments_v1_artifact_versions (conversation_id) WHERE conversation_id IS NOT NULL
  `.execute(k);
}
