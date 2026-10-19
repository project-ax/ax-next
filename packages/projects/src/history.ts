import { createHash, randomBytes } from 'node:crypto';
import { makeAgentContext, type AgentContext, type BlobRef, type HookBus } from '@ax/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FileVersionRow, HistoryLabel, ProjectRow, ProjectsDatabase } from './migrations.js';
import { HISTORY_MAX_FILE_BYTES } from './types.js';

// ---------------------------------------------------------------------------
// W3d file history: the recording core (spec §7.2, plan 2026-10-18 W3d-1).
//
// ONE pass function (`recordPass`) serves every trigger that looks at the
// folder as a whole (the agent's turn end, the orchestrator's pre-session
// snapshot); `record` serves the host writes, which already know the path
// and the bytes. Host writes don't update the manifest: the next pass
// re-reads such a file once. Both store a version only when the file's state
// differs from its latest version, so a touch with no content change, a host
// write the next pass sees again, or a pass that races another records
// nothing twice.
//
// Bytes go to the blob store as the project's OWNER (the person charged by
// disk-quota), never as whoever triggered the pass. The folder's contents are
// agent-written and untrusted: paths and bytes are stored and handed back,
// never interpreted.
// ---------------------------------------------------------------------------

/**
 * `sandbox:scan-shared-folder` (W3d): a recursive, confined stat of a folder.
 * Grant-free, like the reader; called only for a project already loaded.
 * Undeclared and `hasService`-guarded for the same boot-cycle reason as the
 * reader (see the manifest in plugin.ts). Declared locally (no cross-plugin
 * import).
 */
export const SCAN_SHARED_FOLDER_HOOK = 'sandbox:scan-shared-folder';
interface ScanSharedFolderIn {
  folderId: string;
  maxEntries?: number;
}
interface ScannedFile {
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
}
type ScanSharedFolderOut = { kind: 'done'; files: ScannedFile[]; truncated: boolean } | { kind: 'unavailable' };

/** The reader's answer, as plugin.ts declares it (only what history reads). */
export type HistoryReadOut =
  | { kind: 'file'; contents: Uint8Array; truncated: boolean; size: number }
  | { kind: 'dir' }
  | { kind: 'absent' }
  | { kind: 'unavailable' };

/** Files a scan reports at most (the provider's ceiling). */
export const SCAN_MAX_ENTRIES = 10_000;
/** Changed files one pass handles at most; the rest wait for the next pass. */
export const PASS_MAX_CHANGES = 500;
/** Retention: every version from the last this-many days… */
export const RETENTION_DAYS = 30;
/** …plus the last this-many versions of each file. */
export const RETENTION_KEEP_PER_FILE = 50;
/** `file-history` lists at most this many versions and gaps. */
export const HISTORY_LIST_MAX_VERSIONS = 500;
export const HISTORY_LIST_MAX_GAPS = 100;

/**
 * Passes running at once in this process, at most. A pass holds no database
 * connection while it waits on the folder or the blob store (see the lease),
 * but its queries still come from the host's small shared pool, so a burst of
 * turn ends can't crowd every other plugin out of it. Past the cap a pass
 * answers `locked` (the turn-end path retries on a later turn).
 */
export const PASS_MAX_CONCURRENT = 2;
/** A pass stops taking new items after this long; the rest wait for the next pass. */
export const PASS_DEADLINE_MS = 2 * 60_000;
/** A pass's lease on its project. Longer than the deadline, so a live pass keeps it. */
export const PASS_LEASE_MS = 3 * 60_000;

/** Postgres `foreign_key_violation`. */
const FK_VIOLATION = '23503';

/**
 * True when `err` is a write that referenced a project whose row is gone (a
 * project deleted while a pass, a snapshot or a host write was running). Every
 * history table cascades from the project row, so the write had nowhere to go:
 * the project is gone, nothing more to record.
 */
export function isProjectGone(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === FK_VIOLATION;
}

/** Process-wide: one host process, one count. */
let passesRunning = 0;

const BLOB_PUT_HOOK = 'blob:put';
const BLOB_GET_HOOK = 'blob:get';
const RETENTION_LOCK_KEY = 'projects-history:retention';

export interface Attribution {
  userId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
  reqId?: string | null;
}

/** A file's state at one moment, as history records it. */
export type FileState =
  | { kind: 'write'; bytes: Uint8Array }
  | { kind: 'too-large'; size: number }
  | { kind: 'delete' };

export type PassResult =
  | {
      kind: 'done';
      recorded: number;
      /** Files whose version couldn't be recorded (a gap was written); the next pass retries them. */
      failed: number;
      /** More than PASS_MAX_CHANGES changed; the rest wait. */
      deferred: boolean;
      truncated: boolean;
    }
  /**
   * Another pass over this project holds its lease (here or on another
   * replica), or this process is already running PASS_MAX_CONCURRENT passes.
   */
  | { kind: 'locked' }
  /** The project was deleted while the pass ran; it stopped, recording nothing more. */
  | { kind: 'gone' }
  /** No scanner, reader or blob store on this deployment. */
  | { kind: 'unavailable' };

type Db = Kysely<ProjectsDatabase>;
type Exec = Db | Transaction<ProjectsDatabase>;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mintVersionId(): string {
  return `pv_${randomBytes(16).toString('base64url')}`;
}

function errOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** True when `state` is what `latest` already says (or there's nothing to say). */
export function sameAsLatest(latest: FileVersionRow | undefined, state: FileState): boolean {
  if (latest === undefined) return state.kind === 'delete';
  switch (state.kind) {
    case 'delete':
      return latest.kind === 'delete';
    case 'too-large':
      return latest.kind === 'write' && latest.too_large && Number(latest.size) === state.size;
    case 'write':
      return latest.kind === 'write' && !latest.too_large && latest.blob_sha === sha256Hex(state.bytes);
  }
}

function isScanOut(v: unknown): v is ScanSharedFolderOut {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { kind?: unknown; files?: unknown; truncated?: unknown };
  if (o.kind === 'unavailable') return true;
  if (o.kind !== 'done' || !Array.isArray(o.files) || typeof o.truncated !== 'boolean') return false;
  return (o.files as unknown[]).every((f) => {
    const x = f as Partial<ScannedFile> | null;
    return (
      x !== null &&
      typeof x === 'object' &&
      typeof x.path === 'string' &&
      x.path.length > 0 &&
      typeof x.size === 'number' &&
      typeof x.mtimeMs === 'number' &&
      typeof x.ino === 'number'
    );
  });
}

export interface HistoryDeps {
  db: Db;
  bus: HookBus;
  pluginName: string;
  /** One confined read (plugin.ts' `readFolder`). */
  readFile(ctx: AgentContext, folderId: string, relPath: string, limitBytes: number): Promise<HistoryReadOut>;
  /** The clock a pass's deadline is measured with (tests move it). Default `Date.now`. */
  now?: () => number;
}

export type History = ReturnType<typeof createHistory>;

export function createHistory(deps: HistoryDeps) {
  const { db, bus, pluginName } = deps;
  const now = deps.now ?? Date.now;

  /** History needs somewhere to keep bytes. Without a blob store nothing is recorded. */
  function enabled(): boolean {
    return bus.hasService(BLOB_PUT_HOOK);
  }

  /**
   * Retention's try-lock. A session-level advisory lock lives on ONE
   * connection, so it's taken, used and released on that pinned connection:
   * `fn` runs every statement on `conn` and never asks the pool for another
   * one while holding this (that's how a small pool deadlocks).
   */
  async function withTryLock<T>(
    key: string,
    fn: (conn: Kysely<ProjectsDatabase>) => Promise<T>,
  ): Promise<{ locked: false } | { locked: true; value: T }> {
    return db.connection().execute(async (conn) => {
      const got = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(hashtext(${key})) AS locked`.execute(conn);
      if (got.rows[0]?.locked !== true) return { locked: false as const };
      try {
        return { locked: true as const, value: await fn(conn) };
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtext(${key}))`.execute(conn);
      }
    });
  }

  /**
   * A pass's lease on its project: a row, not a held connection, so a pass
   * waiting on the folder or the blob store keeps nothing from the pool. Taken
   * when there's no lease or the one there has expired; true iff it's ours.
   * Throws a foreign-key violation when the project is gone.
   */
  async function takeLease(projectId: string, token: string): Promise<boolean> {
    const got = await sql<{ token: string }>`
      INSERT INTO projects_v1_history_leases (project_id, token, until)
      VALUES (${projectId}, ${token}, NOW() + make_interval(secs => ${PASS_LEASE_MS / 1000}))
      ON CONFLICT (project_id) DO UPDATE SET token = EXCLUDED.token, until = EXCLUDED.until
        WHERE projects_v1_history_leases.until < NOW()
      RETURNING token
    `.execute(db);
    return got.rows[0]?.token === token;
  }

  /**
   * Renew OUR lease and confirm we still hold it. The scan isn't bounded by
   * the pass deadline (10k stats over NFS can be slow), so a lease can lapse
   * before any recording starts and another replica can take it. A pass that
   * lost its lease stops before writing anything.
   */
  async function renewLease(projectId: string, token: string): Promise<boolean> {
    const out = await sql<{ token: string }>`
      UPDATE projects_v1_history_leases
      SET until = NOW() + make_interval(secs => ${PASS_LEASE_MS / 1000})
      WHERE project_id = ${projectId} AND token = ${token}
      RETURNING token
    `.execute(db);
    return out.rows[0]?.token === token;
  }

  /** Release OUR lease only: one taken over after it expired isn't ours to drop. Never throws. */
  async function releaseLease(ctx: AgentContext, projectId: string, token: string): Promise<void> {
    try {
      await db
        .deleteFrom('projects_v1_history_leases')
        .where('project_id', '=', projectId)
        .where('token', '=', token)
        .execute();
    } catch (err) {
      // It expires on its own.
      ctx.logger.warn('projects_history_lease_release_failed', { projectId, err: errOf(err) });
    }
  }

  async function latest(projectId: string, path: string): Promise<FileVersionRow | undefined> {
    return db
      .selectFrom('projects_v1_file_versions')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('path', '=', path)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** `blob:put` as the project's owner, so the owner's quota pays for the history. */
  async function putAsOwner(ctx: AgentContext, owner: string, bytes: Uint8Array): Promise<string> {
    const ownerCtx = makeAgentContext({
      sessionId: ctx.sessionId,
      agentId: pluginName,
      userId: owner,
      logger: ctx.logger,
    });
    const out = await bus.call<{ bytes: Uint8Array }, { sha256: string; size: number }>(BLOB_PUT_HOOK, ownerCtx, {
      bytes,
    });
    const expected = sha256Hex(bytes);
    if (out.sha256 !== expected) throw new Error('blob:put returned a different sha256 than the bytes it was given');
    return expected;
  }

  /**
   * Record `state` for `path` unless it's what the latest version already
   * says. True when a version was written. Throws on a blob or database failure.
   */
  async function record(
    ctx: AgentContext,
    projectId: string,
    owner: string,
    path: string,
    state: FileState,
    label: HistoryLabel,
    attribution: Attribution,
  ): Promise<boolean> {
    if (sameAsLatest(await latest(projectId, path), state)) return false;
    let blobSha: string | null = null;
    let size = 0;
    if (state.kind === 'write') {
      blobSha = await putAsOwner(ctx, owner, state.bytes);
      size = state.bytes.length;
    } else if (state.kind === 'too-large') {
      size = state.size;
    }
    await db
      .insertInto('projects_v1_file_versions')
      .values({
        version_id: mintVersionId(),
        project_id: projectId,
        path,
        blob_sha: blobSha,
        size,
        kind: state.kind === 'delete' ? 'delete' : 'write',
        too_large: state.kind === 'too-large',
        label,
        owner_user_id: blobSha !== null ? owner : null,
        author_user_id: attribution.userId ?? null,
        author_agent_id: attribution.agentId ?? null,
        conversation_id: attribution.conversationId ?? null,
        req_id: attribution.reqId ?? null,
      })
      .execute();
    return true;
  }

  /** A file's current state from one confined read; null when it's a folder or can't be read here. */
  async function currentState(ctx: AgentContext, folderId: string, path: string): Promise<FileState | null> {
    const out = await deps.readFile(ctx, folderId, path, HISTORY_MAX_FILE_BYTES);
    switch (out.kind) {
      case 'file':
        if (out.truncated || out.contents.length > HISTORY_MAX_FILE_BYTES || out.size > HISTORY_MAX_FILE_BYTES) {
          return { kind: 'too-large', size: out.size };
        }
        return { kind: 'write', bytes: out.contents };
      case 'absent':
        return { kind: 'delete' };
      default:
        return null;
    }
  }

  async function recordGap(projectId: string, reason: string): Promise<void> {
    await db.insertInto('projects_v1_history_gaps').values({ project_id: projectId, reason }).execute();
  }

  /**
   * Never throws: a gap that can't be written is logged. A project deleted in
   * the meantime has no history left to mark, so that's not an error.
   */
  async function recordGapQuietly(ctx: AgentContext, projectId: string, reason: string): Promise<void> {
    try {
      await recordGap(projectId, reason);
    } catch (err) {
      if (isProjectGone(err)) {
        ctx.logger.debug('projects_history_gap_skipped', { projectId, reason, why: 'project-gone' });
        return;
      }
      ctx.logger.error('projects_history_gap_failed', { projectId, reason, err: errOf(err) });
    }
  }

  async function markStarted(projectId: string): Promise<void> {
    await db
      .insertInto('projects_v1_history_state')
      .values({ project_id: projectId })
      .onConflict((oc) => oc.column('project_id').doNothing())
      .execute();
  }

  /**
   * THE pass: scan the folder, diff it against the manifest by
   * (size, mtimeMs, ino), record what changed (at most PASS_MAX_CHANGES), and
   * update the manifest. A project whose history hasn't started gets the
   * baseline label, unattributed. A file missing from a TRUNCATED scan may
   * still exist, so it is never recorded as deleted.
   */
  async function recordPass(
    ctx: AgentContext,
    row: ProjectRow,
    opts: { label: 'agent' | 'outside'; owner: string; attribution: Attribution },
  ): Promise<PassResult> {
    if (!enabled() || !bus.hasService(SCAN_SHARED_FOLDER_HOOK)) return { kind: 'unavailable' };
    if (passesRunning >= PASS_MAX_CONCURRENT) return { kind: 'locked' };
    passesRunning++;
    const projectId = row.project_id;
    const token = randomBytes(16).toString('base64url');
    let leased = false;
    try {
      leased = await takeLease(projectId, token);
      if (!leased) return { kind: 'locked' };
      return await passUnderLease(ctx, row, opts, token);
    } catch (err) {
      if (!isProjectGone(err)) throw err;
      ctx.logger.info('projects_history_pass_gone', { projectId });
      return { kind: 'gone' };
    } finally {
      passesRunning--;
      if (leased) await releaseLease(ctx, projectId, token);
    }
  }

  /** The pass itself, once the lease is ours. Throws a foreign-key violation when the project goes. */
  async function passUnderLease(
    ctx: AgentContext,
    row: ProjectRow,
    opts: { label: 'agent' | 'outside'; owner: string; attribution: Attribution },
    token: string,
  ): Promise<PassResult> {
    const projectId = row.project_id;
    const deadlineAt = now() + PASS_DEADLINE_MS;
    const scan = await bus.call<ScanSharedFolderIn, unknown>(SCAN_SHARED_FOLDER_HOOK, ctx, {
      folderId: row.folder_id,
      maxEntries: SCAN_MAX_ENTRIES,
    });
    if (!isScanOut(scan)) throw new Error('sandbox:scan-shared-folder returned a malformed answer');
    if (scan.kind === 'unavailable') return { kind: 'unavailable' };
    // Review, 2026-10-18: a slow scan could outlive the lease.
    if (!(await renewLease(projectId, token))) {
      ctx.logger.info('projects_history_lease_lost', { projectId });
      return { kind: 'locked' };
    }

    const manifest = new Map(
      (await db.selectFrom('projects_v1_file_manifest').selectAll().where('project_id', '=', projectId).execute()).map(
        (m) => [m.path, m],
      ),
    );
    const started =
      (await db
        .selectFrom('projects_v1_history_state')
        .select('project_id')
        .where('project_id', '=', projectId)
        .executeTakeFirst()) !== undefined;
    const label: HistoryLabel = started ? opts.label : 'baseline';
    const attribution: Attribution = started ? opts.attribution : {};

    const seen = new Set(scan.files.map((f) => f.path));
    const changed = scan.files.filter((f) => {
      const m = manifest.get(f.path);
      return m === undefined || m.size !== f.size || m.mtime_ms !== f.mtimeMs || m.ino !== f.ino;
    });
    const gone = scan.truncated ? [] : [...manifest.keys()].filter((p) => !seen.has(p)).sort();
    const work: ({ type: 'file'; file: ScannedFile } | { type: 'gone'; path: string })[] = [
      ...changed.map((file) => ({ type: 'file' as const, file })),
      ...gone.map((path) => ({ type: 'gone' as const, path })),
    ];
    let deferred = work.length > PASS_MAX_CHANGES;

    let recorded = 0;
    let failed = 0;
    let done = 0;
    for (const item of work.slice(0, PASS_MAX_CHANGES)) {
      // Past the deadline, the rest wait for the next pass. At least one item
      // is always taken, so a slow folder still makes progress.
      if (done > 0 && now() > deadlineAt) {
        deferred = true;
        break;
      }
      done++;
      const path = item.type === 'file' ? item.file.path : item.path;
      try {
        if (item.type === 'gone') {
          if (await record(ctx, projectId, opts.owner, path, { kind: 'delete' }, label, attribution)) recorded++;
          await db
            .deleteFrom('projects_v1_file_manifest')
            .where('project_id', '=', projectId)
            .where('path', '=', path)
            .execute();
          continue;
        }
        const f = item.file;
        const state: FileState | null =
          f.size > HISTORY_MAX_FILE_BYTES
            ? { kind: 'too-large', size: f.size }
            : await currentState(ctx, row.folder_id, path);
        // Gone between the scan and the read (the next pass sees it), or a
        // folder now: nothing to record, and the manifest stays as it was.
        if (state === null || state.kind === 'delete') continue;
        if (await record(ctx, projectId, opts.owner, path, state, label, attribution)) recorded++;
        const values = {
          size: f.size,
          mtime_ms: f.mtimeMs,
          ino: f.ino,
          sha256: state.kind === 'write' ? sha256Hex(state.bytes) : null,
        };
        await db
          .insertInto('projects_v1_file_manifest')
          .values({ project_id: projectId, path, ...values })
          .onConflict((oc) => oc.columns(['project_id', 'path']).doUpdateSet(values))
          .execute();
      } catch (err) {
        // The project is gone: stop here (recordPass answers `gone`).
        if (isProjectGone(err)) throw err;
        // The manifest isn't touched, so the next pass tries this file again.
        failed++;
        ctx.logger.warn('projects_history_record_failed', { projectId, err: errOf(err) });
      }
    }
    if (failed > 0) await recordGap(projectId, 'record-failed');
    if (!started && !deferred) await markStarted(projectId);
    if (recorded > 0 || failed > 0 || deferred) {
      ctx.logger.info('projects_history_pass', { projectId, label, recorded, failed, deferred, truncated: scan.truncated });
    }
    return { kind: 'done', recorded, failed, deferred, truncated: scan.truncated };
  }

  // ---- reads ----------------------------------------------------------------

  async function listVersions(projectId: string, path: string): Promise<FileVersionRow[]> {
    return db
      .selectFrom('projects_v1_file_versions')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('path', '=', path)
      .orderBy('seq', 'desc')
      .limit(HISTORY_LIST_MAX_VERSIONS)
      .execute();
  }

  async function listGaps(projectId: string): Promise<{ at: Date; reason: string }[]> {
    return db
      .selectFrom('projects_v1_history_gaps')
      .select(['at', 'reason'])
      .where('project_id', '=', projectId)
      .orderBy('at', 'desc')
      .orderBy('gap_id', 'desc')
      .limit(HISTORY_LIST_MAX_GAPS)
      .execute();
  }

  /** A version of THIS project, or undefined. */
  async function getVersion(projectId: string, versionId: string): Promise<FileVersionRow | undefined> {
    return db
      .selectFrom('projects_v1_file_versions')
      .selectAll()
      .where('version_id', '=', versionId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
  }

  /** A version's bytes, or null when there's no blob store or the bytes are gone. */
  async function readBlob(ctx: AgentContext, sha: string): Promise<Uint8Array | null> {
    if (!bus.hasService(BLOB_GET_HOOK)) return null;
    const out = await bus.call<{ sha256: string }, { bytes?: Uint8Array; found?: false }>(BLOB_GET_HOOK, ctx, {
      sha256: sha,
    });
    if (!(out.bytes instanceof Uint8Array)) return null;
    // Content-addressed: anything else isn't the version's bytes.
    if (sha256Hex(out.bytes) !== sha) throw new Error('blob:get returned bytes that do not match their sha256');
    return out.bytes;
  }

  // ---- cleanup ----------------------------------------------------------------

  /**
   * Everything history keeps for a project. Used inside the delete's
   * transaction. Every history table also cascades from the project row, which
   * is what catches a write that lands after this ran; this stays explicit.
   */
  async function purgeProject(exec: Exec, projectId: string): Promise<void> {
    await exec.deleteFrom('projects_v1_history_leases').where('project_id', '=', projectId).execute();
    await exec.deleteFrom('projects_v1_file_versions').where('project_id', '=', projectId).execute();
    await exec.deleteFrom('projects_v1_file_manifest').where('project_id', '=', projectId).execute();
    await exec.deleteFrom('projects_v1_history_gaps').where('project_id', '=', projectId).execute();
    await exec.deleteFrom('projects_v1_history_state').where('project_id', '=', projectId).execute();
  }

  async function forgetAgent(agentId: string): Promise<number> {
    const res = await db
      .updateTable('projects_v1_file_versions')
      .set({ author_agent_id: null })
      .where('author_agent_id', '=', agentId)
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  }

  async function forgetConversations(conversationIds: string[]): Promise<number> {
    if (conversationIds.length === 0) return 0;
    const res = await db
      .updateTable('projects_v1_file_versions')
      .set({ conversation_id: null })
      .where(sql<boolean>`conversation_id = ANY(${conversationIds}::text[])`)
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  }

  /** `blob:collect-refs`: which of these shas a version still holds, and for whom (the owner charged). */
  async function blobRefs(shas: string[]): Promise<BlobRef[]> {
    if (shas.length === 0) return [];
    const rows = await db
      .selectFrom('projects_v1_file_versions')
      .select(['blob_sha', 'owner_user_id'])
      .distinct()
      .where(sql<boolean>`blob_sha = ANY(${shas}::text[])`)
      .execute();
    return rows
      .filter((r): r is { blob_sha: string; owner_user_id: string | null } => r.blob_sha !== null)
      .map((r) => ({ sha256: r.blob_sha, userIds: r.owner_user_id !== null ? [r.owner_user_id] : [] }));
  }

  /**
   * Retention: keep every version from the last RETENTION_DAYS days plus the
   * last RETENTION_KEEP_PER_FILE of each file; delete the rest (blob-gc then
   * releases bytes nobody holds). Gaps older than the window go too. Under a
   * try-lock, so one replica runs it; every statement runs on the lock's own
   * connection.
   */
  async function runRetention(): Promise<{ kind: 'done'; versions: number; gaps: number } | { kind: 'locked' }> {
    const out = await withTryLock(RETENTION_LOCK_KEY, async (conn) => {
      const versions = await sql`
        DELETE FROM projects_v1_file_versions
        WHERE seq IN (
          SELECT seq FROM (
            SELECT seq, created_at,
                   row_number() OVER (PARTITION BY project_id, path ORDER BY seq DESC) AS rn
            FROM projects_v1_file_versions
          ) ranked
          WHERE ranked.rn > ${RETENTION_KEEP_PER_FILE}
            AND ranked.created_at < NOW() - make_interval(days => ${RETENTION_DAYS})
        )
      `.execute(conn);
      const gaps = await conn
        .deleteFrom('projects_v1_history_gaps')
        .where(sql<boolean>`at < NOW() - make_interval(days => ${RETENTION_DAYS})`)
        .executeTakeFirst();
      return { versions: Number(versions.numAffectedRows ?? 0), gaps: Number(gaps.numDeletedRows) };
    });
    return out.locked ? { kind: 'done', ...out.value } : { kind: 'locked' };
  }

  return {
    enabled,
    currentState,
    record,
    recordGap,
    recordGapQuietly,
    markStarted,
    recordPass,
    listVersions,
    listGaps,
    getVersion,
    readBlob,
    purgeProject,
    forgetAgent,
    forgetConversations,
    blobRefs,
    runRetention,
  };
}
