import { createHash, randomBytes } from 'node:crypto';
import {
  answerBlobCollectRefs,
  BLOB_COLLECT_REFS_HOOK,
  isOwnerlessId,
  makeAgentContext,
  PluginError,
  SystemPromptAugmentOutputSchema,
  type AgentContext,
  type HookBus,
  type Plugin,
  type SystemPromptAugmentInput,
  type SystemPromptAugmentOutput,
} from '@ax/core';
import { isValidSharedFolderId } from '@ax/sandbox-protocol';
import { sql, type Kysely } from 'kysely';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  CONTEXT_INSTRUCTIONS_MAX_CHARS,
  CONTEXT_STATUS_MAX_CHARS,
  CONTEXT_TREE_MAX_LINES,
  INSTRUCTIONS_PATH,
  renderProjectBlock,
  renderProjectContext,
  STATUS_PATH,
  type ContextFilePart,
  type ContextTreeEntry,
  type ContextTreePart,
} from './block.js';
import {
  createdLogLine,
  LAYOUT_SWEEP_LOG_LINE,
  LAYOUT_TOP_LEVEL,
  layoutChanges,
  PROTECTED_PATHS,
  SOURCES_DIR,
  type LayoutChange,
} from './layout.js';
import { createHistory, isProjectGone, type Attribution, type FileState, type History, type PassResult } from './history.js';
import {
  runProjectsMigration,
  type FileVersionRow,
  type ProjectRow,
  type ProjectsDatabase,
} from './migrations.js';
import {
  CreateFolderInputSchema,
  CreateFolderOutputSchema,
  CreateInputSchema,
  CreateOutputSchema,
  DeleteFileInputSchema,
  DeleteFileOutputSchema,
  DeleteInputSchema,
  DeleteOutputSchema,
  DOWNLOAD_FILE_MAX_BYTES,
  DownloadFileInputSchema,
  DownloadFileOutputSchema,
  FileHistoryInputSchema,
  FileHistoryOutputSchema,
  GetInputSchema,
  HISTORY_MAX_FILE_BYTES,
  GetOutputSchema,
  ListInputSchema,
  ListOutputSchema,
  READ_FILE_MAX_ENTRIES,
  READ_FILE_PREVIEW_MAX_BYTES,
  ReadFileInputSchema,
  ReadFileOutputSchema,
  ReadVersionInputSchema,
  ReadVersionOutputSchema,
  ResolveInputSchema,
  ResolveOutputSchema,
  RestoreVersionInputSchema,
  RestoreVersionOutputSchema,
  SetMemberInputSchema,
  SetMemberOutputSchema,
  SnapshotInputSchema,
  SnapshotOutputSchema,
  UpdateInputSchema,
  UpdateOutputSchema,
  WRITE_FILE_MAX_BYTES,
  WriteFileInputSchema,
  WriteFileOutputSchema,
  type ProjectMember,
  type ProjectsChangeRefusal,
  type ProjectsCreateFolderOutput,
  type ProjectsDeleteFileOutput,
  type ProjectsCreateOutput,
  type ProjectsDeletedEvent,
  type ProjectsDeleteOutput,
  type ProjectsDownloadFileOutput,
  type ProjectsDownloadRefusal,
  type ProjectsFileHistoryOutput,
  type ProjectsGetOutput,
  type ProjectsListOutput,
  type ProjectsReadFileOutput,
  type ProjectsResolveOutput,
  type ProjectsReadVersionOutput,
  type ProjectsRestoreVersionOutput,
  type ProjectsSetMemberOutput,
  type ProjectsSnapshotOutput,
  type ProjectsUpdateOutput,
  type ProjectsWriteFileOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/projects';

/**
 * Fired once a project's row is deleted, by `projects:delete` or by the
 * `shared-folders:deleted` subscriber — whichever deleted the row
 * (`DELETE … RETURNING`), so once per row. See `ProjectsDeletedEvent`.
 */
export const PROJECTS_DELETED_HOOK = 'projects:deleted';
export const PROJECTS_BLOCK_HOOK = 'system-prompt:augment:optional:projects';
/** Fired (not declared: manifests have no "fires" field) once per member agent on update. */
const AUGMENT_CHANGED_HOOK = 'system-prompt:augment-changed';
/** W2's event. String literal + local payload type: no cross-plugin import. */
const SHARED_FOLDERS_DELETED_HOOK = 'shared-folders:deleted';

// ---- the slices of peer outputs this plugin reads (declared locally) -------
interface SharedFolderMember {
  agentId: string;
  role: 'owner' | 'editor' | 'viewer';
}
interface SharedFoldersGetOut {
  folderId: string;
  members: SharedFolderMember[];
}
interface SharedFoldersListOut {
  folders: { folderId: string; role: 'owner' | 'editor' | 'viewer' }[];
}
interface AuthorizeMountsOut {
  folders: { folderId: string; readOnly: boolean }[];
}
/**
 * `sandbox:read-shared-folder` (the sandbox provider's confined, read-only,
 * grant-free reader — so it is called only after `loadUsable` /
 * `resolveProject`). Declared locally, like the slices above. Called
 * undeclared in the manifest (a declared edge is a boot cycle; see there).
 */
const READ_SHARED_FOLDER_HOOK = 'sandbox:read-shared-folder';
interface ReadSharedFolderIn {
  folderId: string;
  relPath?: string;
  limitBytes: number;
  maxEntries?: number;
}
type ReadSharedFolderOut =
  | { kind: 'file'; contents: Uint8Array; truncated: boolean; size: number }
  | {
      kind: 'dir';
      entries: { name: string; kind: 'file' | 'dir'; size?: number; updatedAt?: string }[];
      truncated: boolean;
    }
  | { kind: 'absent' }
  | { kind: 'unavailable' };

/**
 * `sandbox:change-shared-folder` (W3c): the provider's confined WRITE path,
 * grant-free like the reader, so called only after `loadEditable` (or by
 * `projects:create` on the folder it just made). Undeclared and
 * `hasService`-guarded for the same boot-cycle reason as the reader.
 */
const CHANGE_SHARED_FOLDER_HOOK = 'sandbox:change-shared-folder';
interface ChangeSharedFolderIn {
  folderId: string;
  changes: LayoutChange[];
  createFolder?: true;
}
type ChangeOutcome = 'written' | 'created' | 'exists' | 'deleted' | 'absent' | 'conflict';
type ChangeSharedFolderOut =
  | { kind: 'done'; results: { path: string; outcome: ChangeOutcome }[] }
  | { kind: 'unavailable' };
/** Removes a folder's bytes; `projects:create` calls it when seeding fails. Undeclared, as shared-folders does. */
const DELETE_SHARED_FOLDER_HOOK = 'sandbox:delete-shared-folder';
/** The person's display name for the new project's log line (optional). */
const GET_USER_HOOK = 'auth:get-user';

// ---- W3d file history ---------------------------------------------------------
/** The runner's turn end (fired by the IPC server; ctx carries the session's project). */
const CHAT_TURN_END_HOOK = 'chat:turn-end';
const AGENTS_DELETED_HOOK = 'agents:deleted';
const CONVERSATIONS_PURGED_HOOK = 'conversations:purged';
/** Turn keys remembered for the twice-fired turn end (tool, then assistant). */
const TURN_DEDUPE_MAX = 2_000;
/** Projects whose owner we remember (the owner never changes: W2 folders are same-owner). */
const OWNER_CACHE_MAX = 1_000;
/** A runner-written id longer than this isn't one (it's only a key and a label). */
const TURN_ID_MAX_CHARS = 200;
/** `conversations:purged` sends at most 500 ids; twice that is still a real payload. */
const PURGED_IDS_MAX = 1_000;
/** The orchestrator gives `projects:snapshot` 10 s; we answer (with a gap) a little before that. */
const DEFAULT_SNAPSHOT_BUDGET_MS = 9_000;
const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_INITIAL_DELAY_MS = 5 * 60 * 1000;

export interface ProjectsPluginOptions {
  /** How long `projects:snapshot` waits for its pass before answering with a gap. */
  snapshotBudgetMs?: number;
  /** How often history retention runs; 0 turns the timer off. Default daily. */
  historyRetentionIntervalMs?: number;
  /** Delay before the first retention run. Default 5 minutes. */
  historyRetentionInitialDelayMs?: number;
  /** The clock a history pass's deadline is measured with (tests move it). Default `Date.now`. */
  historyNow?: () => number;
}

export interface ProjectsPlugin extends Plugin {
  /** Run history retention now (what the daily timer does). */
  runHistoryRetention(): Promise<{ kind: 'done'; versions: number; gaps: number } | { kind: 'locked' } | { kind: 'not-started' }>;
  /** Resolves once every background history pass has settled. */
  drainHistory(): Promise<void>;
}

/** A runner-written turn id we'll use as a key: a short non-empty string. */
function turnIdOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= TURN_ID_MAX_CHARS ? v : undefined;
}

/**
 * The project block's file reads all finish inside this, or the block goes
 * without its `context` (the `brief` still lands). Well inside the
 * orchestrator's 15 s per-provider deadline, which would drop the brief too.
 */
const CONTEXT_READ_DEADLINE_MS = 5_000;
/** The block expands at most this many top-level folders one level down. */
const CONTEXT_TREE_EXPAND_MAX_DIRS = 10;
/** UTF-8 is at most 4 bytes a character, so this many bytes always hold the cap. */
const BYTES_PER_CHAR = 4;

type RefusalFields = { projectId?: string; agentId?: string };

/** How a person's change is recorded in history (W3d). */
interface RecordAs {
  label: 'edit' | 'restore';
  actor: string;
  members: SharedFolderMember[];
}

function mintProjectId(): string {
  return `prj_${randomBytes(16).toString('base64url')}`;
}

function parseInput<T>(schema: ZodType<T, ZodTypeDef, unknown>, hookName: string, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${hookName}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    });
  }
  return parsed.data;
}

/**
 * A refused call: one structured `projects_refused` warning (the audit line —
 * there is no audit table), then a throw with ONE message per code, so a
 * refused caller learns nothing about which check failed. Writes nothing.
 *
 * `not-found` is used wherever even "you may not" would confirm a project
 * exists: an unknown project and one the actor can't use are indistinguishable.
 */
function refuse(
  ctx: AgentContext,
  hookName: string,
  code: 'forbidden' | 'not-found',
  reason: string,
  fields: RefusalFields = {},
): never {
  ctx.logger.warn('projects_refused', { hook: hookName, reason, actor: ctx.userId, ...fields });
  throw new PluginError({
    code,
    plugin: PLUGIN_NAME,
    hookName,
    message: code === 'forbidden' ? `${hookName}: not allowed` : `${hookName}: not found`,
  });
}

/**
 * A download that can't be served. `not-found` here (no file at the path)
 * carries the SAME message as `refuse`'s, so it can't be told from an unknown
 * or foreign project. Not a security event, so no `projects_refused` line.
 */
function fileRefusal(hookName: string, code: ProjectsDownloadRefusal): PluginError {
  const message =
    code === 'not-found'
      ? `${hookName}: not found`
      : code === 'too-large'
        ? `${hookName}: this file is too big to download here`
        : code === 'not-a-file'
          ? `${hookName}: not a file`
          : `${hookName}: project files can't be read on this deployment`;
  return new PluginError({ code, plugin: PLUGIN_NAME, hookName, message });
}

const CHANGE_REFUSAL_MESSAGES: Record<ProjectsChangeRefusal, string> = {
  conflict: 'someone changed this file since it was opened',
  exists: 'something with that name is already there',
  'protected-path': 'this file keeps the project running, so it can be edited but not deleted',
  'read-only-path': 'sources/ is read-only: it holds copies from connected sources',
  'too-large': 'this file is too big to save here (10 MiB at most)',
  'files-unavailable': "project files can't be changed on this deployment",
};

/** A change the rules or the folder refused. `code` and `reasonCode` are the same refusal. */
function changeRefusal(hookName: string, code: ProjectsChangeRefusal): PluginError {
  return new PluginError({
    code,
    reasonCode: code,
    plugin: PLUGIN_NAME,
    hookName,
    message: `${hookName}: ${CHANGE_REFUSAL_MESSAGES[code]}`,
  });
}

/**
 * A path a person may name for a change: relative, not `''`, and no empty,
 * `.` or `..` segment and no NUL. The provider's walk refuses those too; we
 * check here so `sources/` can't be reached by another spelling.
 */
function changePath(hookName: string, raw: string): string {
  const segments = raw.split('/');
  if (raw === '' || segments.some((seg) => seg === '' || seg === '.' || seg === '..' || seg.includes('\0'))) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${hookName}: path must be a relative path inside the project folder`,
    });
  }
  return raw;
}

function isUnderSources(path: string): boolean {
  return path === SOURCES_DIR || path.startsWith(`${SOURCES_DIR}/`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A person, or nothing: empty, `system` and owner-less session ids are not actors. */
function actorOf(ctx: AgentContext): string | null {
  const userId = ctx.userId;
  if (typeof userId !== 'string' || userId.length === 0 || userId === 'system' || isOwnerlessId(userId)) {
    return null;
  }
  return userId;
}

function requireActor(ctx: AgentContext, hookName: string): string {
  const actor = actorOf(ctx);
  if (actor === null) refuse(ctx, hookName, 'forbidden', 'no-actor');
  return actor;
}

/** A forbidden/not-found from a peer is a denial; anything else is a real failure. */
function isDenial(err: unknown): boolean {
  return err instanceof PluginError && (err.code === 'forbidden' || err.code === 'not-found');
}

function errOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

type ResolveResult =
  | { ok: true; value: ProjectsResolveOutput }
  | { ok: false; reason: 'no-actor' | 'cannot-use-agent' | 'unknown-project' | 'agent-has-no-grant' };

export function createProjectsPlugin(opts: ProjectsPluginOptions = {}): ProjectsPlugin {
  let bus: HookBus | undefined;
  let db: Kysely<ProjectsDatabase> | undefined;
  let history: History | undefined;
  const snapshotBudgetMs = opts.snapshotBudgetMs ?? DEFAULT_SNAPSHOT_BUDGET_MS;
  /** Background history work (turn-end passes, a snapshot past its budget), drained on shutdown. */
  const inFlight = new Set<Promise<unknown>>();
  /** `(sessionId, reqId)` keys whose turn already ran a pass. Insertion-ordered: oldest evicted first. */
  const turnsSeen = new Set<string>();
  const ownerCache = new Map<string, string>();
  let retentionStartTimer: NodeJS.Timeout | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;

  function track(p: Promise<unknown>): void {
    const tracked: Promise<unknown> = p.catch(() => undefined).finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  }

  async function getRow(projectId: string): Promise<ProjectRow | undefined> {
    return db!.selectFrom('projects_v1_projects').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  }

  async function canManage(ctx: AgentContext, agentId: string): Promise<boolean> {
    try {
      const out = await bus!.call<{ agentId: string }, { allowed: boolean }>('agents:can-manage-sharing', ctx, {
        agentId,
      });
      return out.allowed === true;
    } catch (err) {
      if (isDenial(err)) return false;
      throw err;
    }
  }

  /** `agents:resolve` as the actor: false when the actor may not use the agent (or it doesn't exist). */
  async function canUseAgent(ctx: AgentContext, actor: string, agentId: string): Promise<boolean> {
    try {
      await bus!.call<{ agentId: string; userId: string }, unknown>('agents:resolve', ctx, { agentId, userId: actor });
      return true;
    } catch (err) {
      if (isDenial(err)) return false;
      throw err;
    }
  }

  /**
   * Whom the project's history is charged to (W3d): the owner of its member
   * agents — a person, or `team:<id>` for a team's agents, the key disk-quota
   * keeps a team's storage under. W2 folders are same-owner, so any member the
   * actor can resolve answers; the owner agent is tried first. Null when none
   * resolves (nobody to charge, so nothing is recorded). Remembered per project.
   */
  async function projectOwner(
    ctx: AgentContext,
    actor: string,
    projectId: string,
    agentIds: string[],
  ): Promise<string | null> {
    const cached = ownerCache.get(projectId);
    if (cached !== undefined) return cached;
    for (const agentId of agentIds) {
      let agent: { ownerId?: unknown; ownerType?: unknown } | undefined;
      try {
        const out = await bus!.call<
          { agentId: string; userId: string },
          { agent?: { ownerId?: unknown; ownerType?: unknown } } | null
        >('agents:resolve', ctx, { agentId, userId: actor });
        agent = out?.agent;
      } catch (err) {
        if (isDenial(err)) continue;
        throw err;
      }
      if (typeof agent?.ownerId !== 'string' || agent.ownerId.length === 0) continue;
      const owner = agent.ownerType === 'team' ? `team:${agent.ownerId}` : agent.ownerId;
      if (ownerCache.size >= OWNER_CACHE_MAX) ownerCache.clear();
      ownerCache.set(projectId, owner);
      return owner;
    }
    return null;
  }

  /** Member agent ids, the owner first. */
  function ownerFirst(members: SharedFolderMember[]): string[] {
    const rank = { owner: 0, editor: 1, viewer: 2 } as const;
    return [...members].sort((a, z) => rank[a.role] - rank[z.role]).map((m) => m.agentId);
  }

  /**
   * The folder's members, as the actor. `shared-folders:get` is the "use a
   * project" check: it answers only when the actor can use at least one
   * member agent of a live folder, and `not-found` otherwise. Null = denied.
   */
  async function folderMembers(ctx: AgentContext, folderId: string): Promise<SharedFolderMember[] | null> {
    try {
      const out = await bus!.call<{ folderId: string }, SharedFoldersGetOut>('shared-folders:get', ctx, { folderId });
      return out.members;
    } catch (err) {
      if (isDenial(err)) return null;
      throw err;
    }
  }

  /**
   * Load a project the actor can use, or refuse `not-found` (unknown and
   * not-yours look the same). Returns the row and the folder's members.
   */
  async function loadUsable(
    ctx: AgentContext,
    hookName: string,
    projectId: string,
  ): Promise<{ row: ProjectRow; members: SharedFolderMember[] }> {
    const row = await getRow(projectId);
    if (row === undefined) refuse(ctx, hookName, 'not-found', 'unknown-project', { projectId });
    const members = await folderMembers(ctx, row.folder_id);
    if (members === null) refuse(ctx, hookName, 'not-found', 'cannot-use-project', { projectId });
    return { row, members };
  }

  /** As `loadUsable`, plus "manage the project" = manage the folder's owner agent; `forbidden` otherwise. */
  async function loadManaged(
    ctx: AgentContext,
    hookName: string,
    projectId: string,
  ): Promise<{ row: ProjectRow; members: SharedFolderMember[] }> {
    const loaded = await loadUsable(ctx, hookName, projectId);
    const owner = loaded.members.find((m) => m.role === 'owner');
    if (owner === undefined || !(await canManage(ctx, owner.agentId))) {
      refuse(ctx, hookName, 'forbidden', 'cannot-manage-project', { projectId });
    }
    return loaded;
  }

  /**
   * As `loadUsable`, plus "edit the project's files" (W3c): the actor can use a
   * member agent whose role is editor or owner. Someone who reaches the project
   * only through viewers is `forbidden` (they can already see it exists).
   */
  async function loadEditable(
    ctx: AgentContext,
    hookName: string,
    actor: string,
    projectId: string,
  ): Promise<{ row: ProjectRow; members: SharedFolderMember[] }> {
    const loaded = await loadUsable(ctx, hookName, projectId);
    for (const m of loaded.members) {
      if (m.role === 'viewer') continue;
      if (await canUseAgent(ctx, actor, m.agentId)) return loaded;
    }
    refuse(ctx, hookName, 'forbidden', 'viewer-only', { projectId });
  }

  /**
   * THE check behind `projects:resolve` and the prompt block: the actor can use
   * `agentId`, the project exists, and `agentId` holds a live grant on its
   * folder. Never throws a denial; real failures (database, bus) propagate.
   */
  async function resolveProject(ctx: AgentContext, projectId: string, agentId: string): Promise<ResolveResult> {
    const actor = actorOf(ctx);
    if (actor === null) return { ok: false, reason: 'no-actor' };
    if (!(await canUseAgent(ctx, actor, agentId))) return { ok: false, reason: 'cannot-use-agent' };
    const row = await getRow(projectId);
    if (row === undefined) return { ok: false, reason: 'unknown-project' };
    const out = await bus!.call<{ agentId: string; folderIds: string[] }, AuthorizeMountsOut>(
      'shared-folders:authorize-mounts',
      ctx,
      { agentId, folderIds: [row.folder_id] },
    );
    const grant = out.folders.find((f) => f.folderId === row.folder_id);
    if (grant === undefined) return { ok: false, reason: 'agent-has-no-grant' };
    return {
      ok: true,
      value: {
        projectId: row.project_id,
        name: row.name,
        description: row.description,
        folderId: row.folder_id,
        readOnly: grant.readOnly === true,
      },
    };
  }

  /**
   * Delete the row for a folder, if any, and announce it. `DELETE … RETURNING`
   * makes this exactly-once per row however many paths race to it.
   */
  async function deleteRowsWhere(
    ctx: AgentContext,
    column: 'project_id' | 'folder_id',
    value: string,
  ): Promise<string[]> {
    // The row and its history (W3d) go in one transaction.
    const deleted = await db!.transaction().execute(async (trx) => {
      const rows = await trx.deleteFrom('projects_v1_projects').where(column, '=', value).returning('project_id').execute();
      for (const { project_id } of rows) await history!.purgeProject(trx, project_id);
      return rows;
    });
    for (const { project_id } of deleted) {
      ownerCache.delete(project_id);
      ctx.logger.info('projects_deleted', { projectId: project_id, actor: ctx.userId });
      // Fired here, AFTER the delete committed. `HookBus.fire` isolates a
      // subscriber's throw, so a broken listener can't fail the delete.
      const payload: ProjectsDeletedEvent = { projectId: project_id };
      await bus!.fire(PROJECTS_DELETED_HOOK, ctx, payload);
    }
    return deleted.map((r) => r.project_id);
  }

  /** One confined read of a project's folder. Only after the person passed `loadUsable` / `resolveProject`. */
  async function readFolder(
    ctx: AgentContext,
    folderId: string,
    relPath: string,
    limitBytes: number,
    maxEntries: number,
  ): Promise<ReadSharedFolderOut> {
    if (!bus!.hasService(READ_SHARED_FOLDER_HOOK)) return { kind: 'unavailable' };
    return bus!.call<ReadSharedFolderIn, ReadSharedFolderOut>(READ_SHARED_FOLDER_HOOK, ctx, {
      folderId,
      relPath,
      limitBytes,
      maxEntries,
    });
  }

  /**
   * One confined change of a project's folder. Only after `loadEditable`, or on
   * a folder `projects:create` just made.
   *
   * Every caller here passes `createFor`, so the provider's "folder missing"
   * refusal (`createFolder` unset) has no caller in projects today.
   *
   * `createFor` creates the folder when it's missing (a W3a folder exists on
   * disk only once a session mounted it). That opens a window: the project can
   * be deleted, and its folder reaped, between our row check and the write,
   * which would bring the folder back with nobody left to clean it. So after
   * the change we look at the row again; if the project (or its folder) is
   * gone, we reap what we may have made and answer not-found. A delete that
   * lands after this check reaps our bytes itself.
   */
  async function changeFolder(
    ctx: AgentContext,
    folderId: string,
    changes: LayoutChange[],
    createFor?: { projectId: string; hookName: string },
  ): Promise<ChangeSharedFolderOut> {
    if (!bus!.hasService(CHANGE_SHARED_FOLDER_HOOK)) return { kind: 'unavailable' };
    const out = await bus!.call<ChangeSharedFolderIn, ChangeSharedFolderOut>(CHANGE_SHARED_FOLDER_HOOK, ctx, {
      folderId,
      changes,
      ...(createFor !== undefined ? { createFolder: true as const } : {}),
    });
    if (createFor !== undefined && out.kind === 'done') {
      const row = await getRow(createFor.projectId);
      if (row === undefined || row.folder_id !== folderId) {
        if (bus!.hasService(DELETE_SHARED_FOLDER_HOOK)) {
          try {
            await bus!.call(DELETE_SHARED_FOLDER_HOOK, ctx, { folderId });
          } catch (err) {
            ctx.logger.error('projects_change_reap_failed', { projectId: createFor.projectId, folderId, err: errOf(err) });
          }
        }
        refuse(ctx, createFor.hookName, 'not-found', 'deleted-during-change', { projectId: createFor.projectId });
      }
    }
    return out;
  }

  /**
   * Projects whose layout this process already ensured (or tried to): the
   * sweep runs at most once per project per process. A W3a project gets its
   * top level on its first listing or change; everything is `ifAbsent`.
   */
  const ensured = new Set<string>();

  /**
   * The lazy layout sweep (§6.2). Never throws and never blocks the caller's
   * own read or change: a failure is logged. `skipPath` leaves out the entry
   * the caller is about to change, so a "create only" save isn't beaten to
   * its own name. True when it created something.
   */
  async function ensureLayout(ctx: AgentContext, row: ProjectRow, skipPath?: string): Promise<boolean> {
    if (ensured.has(row.project_id)) return false;
    ensured.add(row.project_id);
    try {
      const changes = layoutChanges({
        name: row.name,
        description: row.description,
        logLine: LAYOUT_SWEEP_LOG_LINE,
      }).filter((c) => c.path !== skipPath);
      // `createFolder`: a W3a project's folder exists on disk only once a
      // session mounted it. The row was just loaded, so the id is live.
      const out = await changeFolder(ctx, row.folder_id, changes, { projectId: row.project_id, hookName: 'projects:ensure-layout' });
      if (out.kind === 'unavailable') return false;
      const created = out.results.filter((r) => r.outcome === 'created').map((r) => r.path);
      if (created.length > 0) ctx.logger.info('projects_layout_ensured', { projectId: row.project_id, created });
      return created.length > 0;
    } catch (err) {
      ctx.logger.warn('projects_layout_ensure_failed', { projectId: row.project_id, err: errOf(err) });
      return false;
    }
  }

  /** The audit line for a person's change (W3c §6.1): one per attempt that passed the access check. */
  function auditChange(
    ctx: AgentContext,
    projectId: string,
    path: string,
    op: LayoutChange['op'],
    outcome: string,
  ): void {
    ctx.logger.info('project_file_changed', { userId: ctx.userId, projectId, path, op, outcome });
  }

  /** Refuse a change on the rules, audited. */
  function refuseChange(
    ctx: AgentContext,
    hookName: string,
    projectId: string,
    change: { op: LayoutChange['op']; path: string },
    code: ProjectsChangeRefusal,
  ): never {
    auditChange(ctx, projectId, change.path, change.op, code);
    throw changeRefusal(hookName, code);
  }

  /**
   * W3d: true (and logged at debug) when a history write failed because the
   * project was deleted meanwhile: every history table cascades from the
   * project row, so there's nothing to record and no gap to leave.
   */
  function projectGone(ctx: AgentContext, projectId: string, err: unknown): boolean {
    if (!isProjectGone(err)) return false;
    ctx.logger.debug('projects_history_skipped', { projectId, reason: 'project-gone' });
    return true;
  }

  /**
   * W3d: the preimage before a person's write or delete. The file's current
   * bytes are compared with its latest version; if they differ (or there's no
   * version and the file exists) they're recorded first, "Changed outside
   * history", so the change can always be undone. Returns the owner to charge
   * the change's own version to, or null when history is off for this change.
   * Never throws: a failure is logged and leaves a gap, and the change goes ahead.
   */
  async function preimage(ctx: AgentContext, row: ProjectRow, change: LayoutChange, recordAs: RecordAs): Promise<string | null> {
    if (change.op === 'mkdir' || !history!.enabled()) return null;
    const projectId = row.project_id;
    let owner: string | null;
    try {
      owner = await projectOwner(ctx, recordAs.actor, projectId, ownerFirst(recordAs.members));
    } catch (err) {
      ctx.logger.warn('projects_history_skipped', { projectId, reason: 'owner-lookup-failed', err: errOf(err) });
      await history!.recordGapQuietly(ctx, projectId, 'record-failed');
      return null;
    }
    if (owner === null) {
      ctx.logger.warn('projects_history_skipped', { projectId, reason: 'no-owner' });
      return null;
    }
    try {
      const state = await history!.currentState(ctx, row.folder_id, change.path);
      if (state !== null) await history!.record(ctx, projectId, owner, change.path, state, 'outside', {});
    } catch (err) {
      if (projectGone(ctx, projectId, err)) return owner;
      ctx.logger.warn('projects_history_preimage_failed', { projectId, err: errOf(err) });
      await history!.recordGapQuietly(ctx, projectId, 'preimage-failed');
    }
    return owner;
  }

  /** W3d: the version a person's successful change leaves. Never throws. */
  async function recordChange(
    ctx: AgentContext,
    row: ProjectRow,
    change: LayoutChange,
    outcome: ChangeOutcome,
    owner: string,
    recordAs: RecordAs,
  ): Promise<void> {
    let state: FileState | null = null;
    if (change.op === 'write' && (outcome === 'written' || outcome === 'created')) {
      state =
        change.content.length > HISTORY_MAX_FILE_BYTES
          ? { kind: 'too-large', size: change.content.length }
          : { kind: 'write', bytes: change.content };
    } else if (change.op === 'delete' && outcome === 'deleted') {
      // A folder that never had a version records nothing (`record` skips it).
      state = { kind: 'delete' };
    }
    if (state === null) return;
    try {
      await history!.record(ctx, row.project_id, owner, change.path, state, recordAs.label, { userId: recordAs.actor });
    } catch (err) {
      if (projectGone(ctx, row.project_id, err)) return;
      ctx.logger.warn('projects_history_record_failed', { projectId: row.project_id, err: errOf(err) });
      await history!.recordGapQuietly(ctx, row.project_id, 'record-failed');
    }
  }

  /**
   * Apply one person's change (after `loadEditable` and the path rules):
   * the layout sweep first, then the change. Returns the provider's outcome;
   * `unavailable` (or no provider) is `files-unavailable`. With `recordAs`
   * (W3d), a write or delete is recorded in history: the preimage before, the
   * new version after.
   */
  async function applyChange(
    ctx: AgentContext,
    hookName: string,
    row: ProjectRow,
    change: LayoutChange,
    recordAs?: RecordAs,
  ): Promise<ChangeOutcome> {
    const projectId = row.project_id;
    if (!bus!.hasService(CHANGE_SHARED_FOLDER_HOOK)) refuseChange(ctx, hookName, projectId, change, 'files-unavailable');
    await ensureLayout(ctx, row, change.path);
    const owner = recordAs !== undefined ? await preimage(ctx, row, change, recordAs) : null;
    let out: ChangeSharedFolderOut;
    try {
      out = await changeFolder(ctx, row.folder_id, [change], { projectId, hookName });
    } catch (err) {
      // A refusal from the walk (a symlink or a file in the way, a non-empty
      // folder) or a storage failure. Passed through as is.
      auditChange(ctx, projectId, change.path, change.op, 'failed');
      throw err;
    }
    if (out.kind === 'unavailable') refuseChange(ctx, hookName, projectId, change, 'files-unavailable');
    const outcome = out.results[0]?.outcome;
    if (outcome === undefined) {
      auditChange(ctx, projectId, change.path, change.op, 'failed');
      throw new PluginError({
        code: 'unknown',
        plugin: PLUGIN_NAME,
        hookName,
        message: `${hookName}: the file change returned no result`,
      });
    }
    auditChange(ctx, projectId, change.path, change.op, outcome);
    if (owner !== null && recordAs !== undefined) await recordChange(ctx, row, change, outcome, owner, recordAs);
    return outcome;
  }

  /**
   * W3d: a new project's history starts now (nothing came before it, so its
   * first pass is no baseline), with a `seed` version of each file the layout
   * created. Never throws: a failure is logged and leaves a gap.
   */
  async function startHistory(
    ctx: AgentContext,
    actor: string,
    projectId: string,
    ownerAgentId: string,
    seeded: { path: string; content: Uint8Array }[],
  ): Promise<void> {
    try {
      await history!.markStarted(projectId);
      if (seeded.length === 0 || !history!.enabled()) return;
      const owner = await projectOwner(ctx, actor, projectId, [ownerAgentId]);
      if (owner === null) return;
      for (const f of seeded) {
        await history!.record(ctx, projectId, owner, f.path, { kind: 'write', bytes: f.content }, 'seed', { userId: actor });
      }
    } catch (err) {
      if (projectGone(ctx, projectId, err)) return;
      ctx.logger.warn('projects_history_seed_failed', { projectId, err: errOf(err) });
      await history!.recordGapQuietly(ctx, projectId, 'record-failed');
    }
  }

  /** "Project created by <display name>", when an auth provider knows one. Never throws. */
  async function creatorLogLine(ctx: AgentContext, actor: string): Promise<string> {
    if (!bus!.hasService(GET_USER_HOOK)) return createdLogLine(null);
    try {
      const user = await bus!.call<{ userId: string }, { displayName?: string | null } | null>(GET_USER_HOOK, ctx, {
        userId: actor,
      });
      return createdLogLine(user?.displayName);
    } catch (err) {
      ctx.logger.warn('projects_creator_name_failed', { err: errOf(err) });
      return createdLogLine(null);
    }
  }

  /**
   * Undo a `projects:create` that failed after the folder was made: the row
   * (if inserted; deleted directly, so no `projects:deleted` fires for a
   * project nobody saw), the folder's bytes, then the folder. Never throws.
   */
  async function rollbackCreate(ctx: AgentContext, folderId: string, projectId?: string): Promise<void> {
    if (projectId !== undefined) {
      try {
        await db!.transaction().execute(async (trx) => {
          await trx.deleteFrom('projects_v1_projects').where('project_id', '=', projectId).execute();
          await history!.purgeProject(trx, projectId);
        });
      } catch (err) {
        ctx.logger.error('projects_create_rollback_failed', { folderId, projectId, step: 'row', err: errOf(err) });
      }
    }
    if (bus!.hasService(DELETE_SHARED_FOLDER_HOOK)) {
      try {
        await bus!.call(DELETE_SHARED_FOLDER_HOOK, ctx, { folderId });
      } catch (err) {
        ctx.logger.error('projects_create_rollback_failed', { folderId, step: 'bytes', err: errOf(err) });
      }
    }
    try {
      await bus!.call('shared-folders:delete', ctx, { folderId });
    } catch (cleanupErr) {
      ctx.logger.error('projects_create_rollback_failed', { folderId, err: errOf(cleanupErr) });
    }
  }

  /**
   * The project block's `context`: instructions.md, a short tree, and
   * memory/status.md, read in parallel. `undefined` when this deployment
   * can't read the folder, or the reads don't finish in time. Never throws: a
   * read that fails becomes a one-line "couldn't be read" for that part only.
   */
  async function projectContext(ctx: AgentContext, folderId: string): Promise<string | undefined> {
    if (!bus!.hasService(READ_SHARED_FOLDER_HOOK)) return undefined;
    let unavailable = false;
    const filePart = async (relPath: string, maxChars: number): Promise<ContextFilePart> => {
      try {
        const out = await readFolder(ctx, folderId, relPath, maxChars * BYTES_PER_CHAR, 1);
        if (out.kind === 'unavailable') unavailable = true;
        if (out.kind !== 'file') return { kind: 'absent' };
        return { kind: 'file', contents: out.contents, truncated: out.truncated };
      } catch (err) {
        ctx.logger.warn('projects_context_read_failed', { relPath, err: errOf(err) });
        return { kind: 'failed' };
      }
    };
    const treePart = async (): Promise<ContextTreePart> => {
      try {
        const top = await readFolder(ctx, folderId, '', 1, CONTEXT_TREE_MAX_LINES + 1);
        if (top.kind === 'unavailable') unavailable = true;
        if (top.kind !== 'dir') return { kind: 'tree', entries: [], truncated: false };
        const sorted = [...top.entries].sort((a, z) => (a.name < z.name ? -1 : a.name > z.name ? 1 : 0));
        const expand = new Set(
          sorted
            .filter((e) => e.kind === 'dir')
            .slice(0, CONTEXT_TREE_EXPAND_MAX_DIRS)
            .map((e) => e.name),
        );
        const entries = await Promise.all(
          sorted.map(async (e): Promise<ContextTreeEntry> => {
            if (!expand.has(e.name)) return { name: e.name, kind: e.kind };
            const sub = await readFolder(ctx, folderId, e.name, 1, CONTEXT_TREE_MAX_LINES);
            if (sub.kind !== 'dir') return { name: e.name, kind: e.kind };
            return {
              name: e.name,
              kind: e.kind,
              children: [...sub.entries]
                .sort((a, z) => (a.name < z.name ? -1 : a.name > z.name ? 1 : 0))
                .map((c) => ({ name: c.name, kind: c.kind })),
              childrenTruncated: sub.truncated,
            };
          }),
        );
        return { kind: 'tree', entries, truncated: top.truncated };
      } catch (err) {
        ctx.logger.warn('projects_context_read_failed', { relPath: '', err: errOf(err) });
        return { kind: 'failed' };
      }
    };

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), CONTEXT_READ_DEADLINE_MS);
      timer.unref();
    });
    try {
      const parts = await Promise.race([
        Promise.all([
          filePart(INSTRUCTIONS_PATH, CONTEXT_INSTRUCTIONS_MAX_CHARS),
          treePart(),
          filePart(STATUS_PATH, CONTEXT_STATUS_MAX_CHARS),
        ]),
        deadline,
      ]);
      if (parts === 'deadline') {
        ctx.logger.warn('projects_context_skipped', { reason: 'deadline' });
        return undefined;
      }
      // Decided before any path matters, so one `unavailable` means all.
      if (unavailable) return undefined;
      const [instructions, tree, status] = parts;
      return renderProjectContext({ instructions, tree, status });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- W3d: the history triggers -------------------------------------------

  /**
   * The pass at the end of an agent's turn, in the background. Only for an
   * agent holding a WRITABLE grant (a viewer's session can't change the
   * folder); checked as the session's person, like the prompt block. Never
   * throws: a failure is logged and leaves a gap.
   */
  async function turnEndPass(ctx: AgentContext, projectId: string, reqId: string | undefined, key: string): Promise<void> {
    try {
      const res = await resolveProject(ctx, projectId, ctx.agentId);
      if (!res.ok || res.value.readOnly) {
        ctx.logger.debug('projects_history_turn_skipped', {
          projectId,
          agentId: ctx.agentId,
          reason: res.ok ? 'read-only' : res.reason,
        });
        return;
      }
      const row = await getRow(projectId);
      if (row === undefined) return;
      const members = await folderMembers(ctx, row.folder_id);
      if (members === null) return;
      const owner = await projectOwner(ctx, actorOf(ctx)!, projectId, ownerFirst(members));
      if (owner === null) {
        ctx.logger.warn('projects_history_skipped', { projectId, reason: 'no-owner' });
        return;
      }
      const attribution: Attribution = {
        agentId: ctx.agentId,
        conversationId: ctx.conversationId ?? null,
        reqId: reqId ?? null,
      };
      const out = await history!.recordPass(ctx, row, { label: 'agent', owner, attribution });
      // Another pass held the project's lease, or the process was at its pass
      // cap: let this turn's second turn-end (or a later turn) try again.
      if (out.kind === 'locked') {
        turnsSeen.delete(key);
        ctx.logger.debug('projects_history_turn_skipped', { projectId, reason: 'locked' });
      }
    } catch (err) {
      if (projectGone(ctx, projectId, err)) return;
      ctx.logger.error('projects_history_turn_failed', { projectId, err: errOf(err) });
      await history!.recordGapQuietly(ctx, projectId, 'pass-failed');
    }
  }

  /** Remember a turn key; false when it was already seen. Oldest keys go first. */
  function firstSighting(key: string): boolean {
    if (turnsSeen.has(key)) return false;
    turnsSeen.add(key);
    if (turnsSeen.size > TURN_DEDUPE_MAX) {
      const oldest = turnsSeen.values().next().value;
      if (oldest !== undefined) turnsSeen.delete(oldest);
    }
    return true;
  }

  function versionOut(v: FileVersionRow): ProjectsFileHistoryOutput['versions'][number] {
    return {
      versionId: v.version_id,
      kind: v.kind,
      label: v.label,
      size: Number(v.size),
      tooLarge: v.too_large,
      authorUserId: v.author_user_id,
      authorAgentId: v.author_agent_id,
      conversationId: v.conversation_id,
      createdAt: v.created_at.toISOString(),
    };
  }

  /** A version that can't be read (wrong project, no bytes): the same message as an unknown project's. */
  function versionNotFound(hookName: string): PluginError {
    return fileRefusal(hookName, 'not-found');
  }

  function notRestorable(hookName: string): PluginError {
    return new PluginError({
      code: 'not-restorable',
      reasonCode: 'not-restorable',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${hookName}: this version can't be restored (it was a deletion, or too big to keep)`,
    });
  }

  async function runRetentionNow(): Promise<
    { kind: 'done'; versions: number; gaps: number } | { kind: 'locked' } | { kind: 'not-started' }
  > {
    if (history === undefined) return { kind: 'not-started' };
    return history.runRetention();
  }

  return {
    async runHistoryRetention() {
      return runRetentionNow();
    },

    async drainHistory() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },

    async shutdown() {
      shuttingDown = true;
      if (retentionStartTimer !== undefined) clearTimeout(retentionStartTimer);
      if (retentionTimer !== undefined) clearInterval(retentionTimer);
      retentionStartTimer = undefined;
      retentionTimer = undefined;
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },

    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'projects:create',
        'projects:list',
        'projects:get',
        'projects:update',
        'projects:delete',
        'projects:resolve',
        'projects:read-file',
        'projects:download-file',
        'projects:set-member',
        'projects:write-file',
        'projects:delete-file',
        'projects:create-folder',
        // W3d: file history.
        'projects:snapshot',
        'projects:file-history',
        'projects:read-version',
        'projects:restore-version',
        PROJECTS_BLOCK_HOOK,
      ],
      // NEVER conversations:*, and no declared sandbox:* edge. conversations
      // calls projects (`projects:resolve` on chat create), and bootstrap
      // rejects a plugin call-graph cycle (W3 §4.4) even through
      // optionalCalls, so every declared edge out of here must never lead back.
      //
      // `sandbox:read-shared-folder` (W3b) is therefore called UNDECLARED,
      // `bus.hasService`-guarded (`readFolder` / `projectContext`): declaring
      // it closed `@ax/sandbox-subprocess → @ax/ipc-server (ipc:start) →
      // @ax/conversations → @ax/projects → @ax/sandbox-subprocess`, and the
      // W3a acceptance stack failed to boot. Same precedent as shared-folders →
      // `sandbox:delete-shared-folder`. Without a reader: projects:read-file
      // answers unavailable, projects:download-file refuses 'unavailable', and
      // the project block carries no file context (its brief still lands).
      // W3c's `sandbox:change-shared-folder` (and `sandbox:delete-shared-folder`
      // for a failed create's rollback) follow the same rule: without a writer,
      // the change hooks refuse `files-unavailable` and a new project starts
      // with an empty folder. preset.test and this package's manifest test pin
      // the rule. W3d's `sandbox:scan-shared-folder` is the same again: without
      // a scanner no pass runs (host writes still record their versions).
      calls: [
        'database:get-instance',
        'agents:can-manage-sharing',
        'agents:resolve',
        'agents:list-for-user',
        'shared-folders:create',
        'shared-folders:delete',
        'shared-folders:get',
        'shared-folders:list',
        'shared-folders:authorize-mounts',
        // W3e: projects:set-member. shared-folders never calls projects.
        'shared-folders:grant',
        'shared-folders:revoke',
      ],
      optionalCalls: [
        {
          hook: 'teams:list-for-user',
          degradation:
            'projects:list cannot find team agents without the actor’s team ids, so it lists only projects of their personal agents.',
        },
        {
          hook: GET_USER_HOOK,
          degradation:
            "a new project's memory/log.md says \"Project created\" without the person's name.",
        },
        // W3d: versions' bytes live in the blob store, charged to the
        // project's owner. The blob backends call nothing, so no cycle.
        {
          hook: 'blob:put',
          degradation: 'no file history is recorded; History lists only what was recorded before.',
        },
        {
          hook: 'blob:get',
          degradation: 'a version can be listed but not previewed or restored.',
        },
      ],
      // W3d: `chat:turn-end` records an agent turn's changes; `agents:deleted`
      // and `conversations:purged` null a version's agent / chat (the
      // agent-keyed-tables guard); `blob:collect-refs` because versions hold
      // blob shas. Subscribing is no call edge, so conversations → projects
      // stays one-way.
      subscribes: [
        SHARED_FOLDERS_DELETED_HOOK,
        CHAT_TURN_END_HOOK,
        AGENTS_DELETED_HOOK,
        CONVERSATIONS_PURGED_HOOK,
        BLOB_COLLECT_REFS_HOOK,
      ],
    },

    async init({ bus: b }) {
      bus = b;
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      const { db: raw } = await b.call<unknown, { db: Kysely<unknown> }>('database:get-instance', initCtx, {});
      db = raw as Kysely<ProjectsDatabase>;
      await runProjectsMigration(db);
      history = createHistory({
        db,
        bus: b,
        pluginName: PLUGIN_NAME,
        ...(opts.historyNow !== undefined ? { now: opts.historyNow } : {}),
        readFile: async (ctx, folderId, relPath, limitBytes) => {
          const out = await readFolder(ctx, folderId, relPath, limitBytes, 1);
          return out.kind === 'dir' ? { kind: 'dir' } : out;
        },
      });

      // ---- create -------------------------------------------------------
      b.registerService<unknown, ProjectsCreateOutput>(
        'projects:create',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:create';
          const input = parseInput(CreateInputSchema, hook, rawInput);
          const actor = requireActor(ctx, hook);
          // Checked here first so a refusal writes nothing at all;
          // shared-folders:create checks again.
          if (!(await canManage(ctx, input.ownerAgentId))) {
            refuse(ctx, hook, 'forbidden', 'cannot-manage-owner-agent', { agentId: input.ownerAgentId });
          }
          const { folderId } = await b.call<{ ownerAgentId: string }, { folderId: string }>(
            'shared-folders:create',
            ctx,
            { ownerAgentId: input.ownerAgentId },
          );
          const projectId = mintProjectId();
          const description = input.description ?? null;
          try {
            await db!
              .insertInto('projects_v1_projects')
              .values({
                project_id: projectId,
                folder_id: folderId,
                name: input.name,
                description,
                created_by_user: actor,
              })
              .execute();
          } catch (err) {
            // Don't leave a folder no project points at.
            await rollbackCreate(ctx, folderId);
            throw err;
          }
          // Seed the layout (§6.2) in one change that also creates the folder.
          // No writer at all (no file storage on this deployment) is fine:
          // projects work without files (W3b). Anything else that fails rolls
          // the whole create back, so the person never gets a half-made project.
          const seeded: { path: string; content: Uint8Array }[] = [];
          try {
            const changes = layoutChanges({
              name: input.name,
              description,
              logLine: await creatorLogLine(ctx, actor),
            });
            const out = await changeFolder(ctx, folderId, changes, { projectId, hookName: 'projects:create' });
            if (out.kind === 'unavailable') {
              ctx.logger.info('projects_layout_skipped', { projectId, reason: 'files-unavailable' });
            } else {
              const refused = changes.find(
                (c, i) => out.results[i]?.outcome !== 'created' && out.results[i]?.outcome !== 'exists',
              );
              if (refused !== undefined) {
                throw new Error(`seeding ${refused.path} answered ${out.results.find((r) => r.path === refused.path)?.outcome ?? 'nothing'}`);
              }
              ensured.add(projectId);
              changes.forEach((c, i) => {
                if (c.op === 'write' && out.results[i]?.outcome === 'created') seeded.push({ path: c.path, content: c.content });
              });
            }
          } catch (err) {
            ctx.logger.error('projects_layout_seed_failed', { projectId, folderId, err: errOf(err) });
            await rollbackCreate(ctx, folderId, projectId);
            throw new PluginError({
              code: 'layout-failed',
              reasonCode: 'layout-failed',
              plugin: PLUGIN_NAME,
              hookName: hook,
              message: `${hook}: couldn't set up the new project's files, so the project wasn't created`,
              cause: err,
            });
          }
          await startHistory(ctx, actor, projectId, input.ownerAgentId, seeded);
          ctx.logger.info('projects_created', { projectId, folderId, ownerAgentId: input.ownerAgentId, actor });
          return { projectId, folderId };
        },
        { returns: CreateOutputSchema },
      );

      // ---- list ---------------------------------------------------------
      // The agents the actor can use → each one's folders → the project rows
      // on those folders. Each project lists only the actor's member agents.
      b.registerService<unknown, ProjectsListOutput>(
        'projects:list',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:list';
          parseInput(ListInputSchema, hook, rawInput);
          const actor = requireActor(ctx, hook);
          let teamIds: string[] = [];
          if (b.hasService('teams:list-for-user')) {
            const out = await b.call<{ userId: string }, { teams: { id: string }[] }>('teams:list-for-user', ctx, {
              userId: actor,
            });
            teamIds = out.teams.map((t) => t.id);
          }
          const { agents } = await b.call<{ userId: string; teamIds: string[] }, { agents: { id: string }[] }>(
            'agents:list-for-user',
            ctx,
            { userId: actor, teamIds },
          );
          const membersByFolder = new Map<string, ProjectMember[]>();
          for (const agent of agents) {
            let folders: SharedFoldersListOut['folders'];
            try {
              ({ folders } = await b.call<{ agentId: string }, SharedFoldersListOut>('shared-folders:list', ctx, {
                agentId: agent.id,
              }));
            } catch (err) {
              // The agent went away (or out of reach) between the two reads.
              if (isDenial(err)) continue;
              throw err;
            }
            for (const f of folders) {
              const list = membersByFolder.get(f.folderId) ?? [];
              list.push({ agentId: agent.id, role: f.role });
              membersByFolder.set(f.folderId, list);
            }
          }
          if (membersByFolder.size === 0) return { projects: [] };
          const rows = await db!
            .selectFrom('projects_v1_projects')
            .selectAll()
            .where('folder_id', 'in', [...membersByFolder.keys()])
            .orderBy('updated_at', 'desc')
            .orderBy('project_id', 'asc')
            .execute();
          const roleOrder = { owner: 0, editor: 1, viewer: 2 } as const;
          return {
            projects: rows.map((r) => ({
              projectId: r.project_id,
              name: r.name,
              description: r.description,
              updatedAt: r.updated_at.toISOString(),
              members: [...membersByFolder.get(r.folder_id)!].sort(
                (a, z) => roleOrder[a.role] - roleOrder[z.role] || a.agentId.localeCompare(z.agentId),
              ),
            })),
          };
        },
        { returns: ListOutputSchema },
      );

      // ---- get ----------------------------------------------------------
      b.registerService<unknown, ProjectsGetOutput>(
        'projects:get',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:get';
          const input = parseInput(GetInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const { row, members } = await loadUsable(ctx, hook, input.projectId);
          return {
            projectId: row.project_id,
            name: row.name,
            description: row.description,
            folderId: row.folder_id,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
            members: members.map((m) => ({ agentId: m.agentId, role: m.role })),
          };
        },
        { returns: GetOutputSchema },
      );

      // ---- update -------------------------------------------------------
      b.registerService<unknown, ProjectsUpdateOutput>(
        'projects:update',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:update';
          const input = parseInput(UpdateInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const { members } = await loadManaged(ctx, hook, input.projectId);
          const updated = await db!
            .updateTable('projects_v1_projects')
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              updated_at: sql<Date>`NOW()`,
            })
            .where('project_id', '=', input.projectId)
            .returningAll()
            .executeTakeFirst();
          // Deleted between the check and the write.
          if (updated === undefined) refuse(ctx, hook, 'not-found', 'unknown-project', { projectId: input.projectId });
          ctx.logger.info('projects_updated', { projectId: input.projectId, actor: ctx.userId });
          // Every member agent's prompt carries this project's block; live
          // sessions pick up the new one at their next turn (TASK-612).
          // `fire`, so a broken listener can't report a saved change as failed.
          for (const agentId of new Set(members.map((m) => m.agentId))) {
            await b.fire(AUGMENT_CHANGED_HOOK, ctx, { agentId });
          }
          return {
            projectId: updated.project_id,
            name: updated.name,
            description: updated.description,
            updatedAt: updated.updated_at.toISOString(),
          };
        },
        { returns: UpdateOutputSchema },
      );

      // ---- set-member (W3e §8) -----------------------------------------
      // The person manages the project (loadManaged); the change itself is
      // W2's grant / revoke on the project's folder, called AS the person, so
      // W2 decides "same owner only" and reaps sessions on a downgrade or a
      // removal. Every shared-folders refusal reads `forbidden` here (its log
      // line says which rule); the owner agent is refused before the call.
      b.registerService<unknown, ProjectsSetMemberOutput>(
        'projects:set-member',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:set-member';
          const input = parseInput(SetMemberInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const fields = { projectId: input.projectId, agentId: input.agentId };
          const { row, members } = await loadManaged(ctx, hook, input.projectId);
          if (members.some((m) => m.role === 'owner' && m.agentId === input.agentId)) {
            refuse(ctx, hook, 'forbidden', 'target-is-owner', fields);
          }
          let changed: boolean;
          try {
            if (input.role === null) {
              const out = await b.call<{ folderId: string; agentId: string }, { revoked: boolean }>(
                'shared-folders:revoke',
                ctx,
                { folderId: row.folder_id, agentId: input.agentId },
              );
              changed = out.revoked;
            } else {
              const out = await b.call<{ folderId: string; agentId: string; role: 'editor' | 'viewer' }, { changed: boolean }>(
                'shared-folders:grant',
                ctx,
                { folderId: row.folder_id, agentId: input.agentId, role: input.role },
              );
              changed = out.changed;
            }
          } catch (err) {
            // W2 wrote nothing (different owner, an agent the person doesn't
            // manage, the folder going away mid-call).
            if (isDenial(err)) refuse(ctx, hook, 'forbidden', 'member-change-refused', fields);
            throw err;
          }
          if (changed) {
            ctx.logger.info('projects_member_set', { ...fields, role: input.role, actor: ctx.userId });
            // The agent's prompt gains, loses or re-labels this project's
            // block; a live session rebuilds it at its next turn (TASK-612).
            // `fire`, so a broken listener can't report a saved change as failed.
            await b.fire(AUGMENT_CHANGED_HOOK, ctx, { agentId: input.agentId });
          }
          const fresh = await loadUsable(ctx, hook, input.projectId);
          return { members: fresh.members.map((m) => ({ agentId: m.agentId, role: m.role })) };
        },
        { returns: SetMemberOutputSchema },
      );

      // ---- delete -------------------------------------------------------
      // 1. shared-folders:delete tombstones the folder and reaps sessions.
      // 2. The row goes and projects:deleted fires — usually already done by
      //    our own shared-folders:deleted subscriber during step 1, in which
      //    case the DELETE below finds nothing and fires nothing.
      b.registerService<unknown, ProjectsDeleteOutput>(
        'projects:delete',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:delete';
          const input = parseInput(DeleteInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const { row } = await loadManaged(ctx, hook, input.projectId);
          try {
            await b.call('shared-folders:delete', ctx, { folderId: row.folder_id });
          } catch (err) {
            // Lost a race (access changed, or the folder went) — shared-folders
            // wrote nothing, and neither do we.
            if (isDenial(err)) refuse(ctx, hook, 'forbidden', 'folder-delete-refused', { projectId: input.projectId });
            throw err;
          }
          await deleteRowsWhere(ctx, 'project_id', input.projectId);
          return { deleted: true };
        },
        { returns: DeleteOutputSchema },
      );

      // ---- resolve ------------------------------------------------------
      b.registerService<unknown, ProjectsResolveOutput>(
        'projects:resolve',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:resolve';
          const input = parseInput(ResolveInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const res = await resolveProject(ctx, input.projectId, input.agentId);
          if (!res.ok) {
            refuse(ctx, hook, 'not-found', res.reason, { projectId: input.projectId, agentId: input.agentId });
          }
          return res.value;
        },
        { returns: ResolveOutputSchema },
      );

      // ---- read-file (W3b) ----------------------------------------------
      // A preview: a listing (≤ 500 entries) or a file's first 1 MiB, flagged
      // `truncated`. The person must be able to use the project (`loadUsable`,
      // so unknown and foreign are the same `not-found`) BEFORE any read.
      // Rebuilt field by field, so nothing the reader adds reaches the caller.
      b.registerService<unknown, ProjectsReadFileOutput>(
        'projects:read-file',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:read-file';
          const input = parseInput(ReadFileInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const { row } = await loadUsable(ctx, hook, input.projectId);
          let out = await readFolder(ctx, row.folder_id, input.path, READ_FILE_PREVIEW_MAX_BYTES, READ_FILE_MAX_ENTRIES);
          // The lazy layout sweep, from the root listing we already have.
          if (input.path === '' && out.kind === 'dir' && !ensured.has(row.project_id)) {
            const names = new Set(out.entries.map((e) => e.name));
            if (LAYOUT_TOP_LEVEL.every((n) => names.has(n))) {
              ensured.add(row.project_id);
            } else if (await ensureLayout(ctx, row)) {
              // Show the person the layout we just made.
              out = await readFolder(ctx, row.folder_id, '', READ_FILE_PREVIEW_MAX_BYTES, READ_FILE_MAX_ENTRIES);
            }
          }
          switch (out.kind) {
            case 'dir':
              return {
                kind: 'dir',
                entries: out.entries.slice(0, READ_FILE_MAX_ENTRIES).map((e) => ({
                  name: e.name,
                  kind: e.kind,
                  ...(e.size !== undefined ? { size: e.size } : {}),
                  ...(e.updatedAt !== undefined ? { updatedAt: e.updatedAt } : {}),
                })),
                truncated: out.truncated || out.entries.length > READ_FILE_MAX_ENTRIES,
              };
            case 'file': {
              const truncated = out.truncated || out.contents.length > READ_FILE_PREVIEW_MAX_BYTES;
              const contents = out.contents.subarray(0, READ_FILE_PREVIEW_MAX_BYTES);
              return {
                kind: 'file',
                contents,
                truncated,
                size: out.size,
                // The base hash for a save. A preview's hash isn't the file's, so none.
                ...(truncated ? {} : { sha256: sha256Hex(contents) }),
              };
            }
            case 'absent':
              return { kind: 'absent' };
            default:
              return { kind: 'unavailable' };
          }
        },
        { returns: ReadFileOutputSchema },
      );

      // ---- download-file (W3b) ------------------------------------------
      // The whole file, up to 10 MiB, or a refusal (`ProjectsDownloadRefusal`):
      // a bigger file is `too-large` and NEVER returned truncated. Same gate as
      // read-file.
      b.registerService<unknown, ProjectsDownloadFileOutput>(
        'projects:download-file',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:download-file';
          const input = parseInput(DownloadFileInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const { row } = await loadUsable(ctx, hook, input.projectId);
          const out = await readFolder(ctx, row.folder_id, input.path, DOWNLOAD_FILE_MAX_BYTES, 1);
          if (out.kind === 'unavailable') throw fileRefusal(hook, 'unavailable');
          if (out.kind === 'absent') throw fileRefusal(hook, 'not-found');
          if (out.kind === 'dir') throw fileRefusal(hook, 'not-a-file');
          if (out.truncated || out.contents.length > DOWNLOAD_FILE_MAX_BYTES || out.size > DOWNLOAD_FILE_MAX_BYTES) {
            throw fileRefusal(hook, 'too-large');
          }
          return { contents: out.contents, size: out.contents.length };
        },
        { returns: DownloadFileOutputSchema },
      );

      // ---- write-file / delete-file / create-folder (W3c §6) ----------------
      // The person must be able to use an editor or owner member agent
      // (`loadEditable`; unknown and foreign are the same `not-found`). Then
      // the rules: `sources/` is read-only, `instructions.md` and
      // `memory/status.md` can't be deleted, 10 MiB a file. Each attempt past
      // the access check logs one `project_file_changed` audit line.
      b.registerService<unknown, ProjectsWriteFileOutput>(
        'projects:write-file',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:write-file';
          const input = parseInput(WriteFileInputSchema, hook, rawInput);
          const actor = requireActor(ctx, hook);
          const path = changePath(hook, input.path);
          const { row, members } = await loadEditable(ctx, hook, actor, input.projectId);
          const change: LayoutChange = {
            op: 'write',
            path,
            content: input.content,
            ...(input.baseHash !== undefined ? { ifMatch: input.baseHash } : {}),
            ...(input.ifAbsent === true ? { ifAbsent: true as const } : {}),
          };
          if (isUnderSources(path)) refuseChange(ctx, hook, row.project_id, change, 'read-only-path');
          if (input.content.length > WRITE_FILE_MAX_BYTES) refuseChange(ctx, hook, row.project_id, change, 'too-large');
          const outcome = await applyChange(ctx, hook, row, change, { label: 'edit', actor, members });
          if (outcome === 'conflict') throw changeRefusal(hook, 'conflict');
          if (outcome === 'exists') throw changeRefusal(hook, 'exists');
          if (PROTECTED_PATHS.has(path)) {
            // Every member agent's prompt quotes this file (the project
            // block); live sessions rebuild it at their next turn.
            for (const agentId of new Set(members.map((m) => m.agentId))) {
              await b.fire(AUGMENT_CHANGED_HOOK, ctx, { agentId });
            }
          }
          return { sha256: sha256Hex(input.content) };
        },
        { returns: WriteFileOutputSchema },
      );

      b.registerService<unknown, ProjectsDeleteFileOutput>(
        'projects:delete-file',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:delete-file';
          const input = parseInput(DeleteFileInputSchema, hook, rawInput);
          const actor = requireActor(ctx, hook);
          const path = changePath(hook, input.path);
          const { row, members } = await loadEditable(ctx, hook, actor, input.projectId);
          const change: LayoutChange = { op: 'delete', path };
          if (isUnderSources(path)) refuseChange(ctx, hook, row.project_id, change, 'read-only-path');
          if (PROTECTED_PATHS.has(path)) refuseChange(ctx, hook, row.project_id, change, 'protected-path');
          const outcome = await applyChange(ctx, hook, row, change, { label: 'edit', actor, members });
          // Same message as an unknown project's, like download-file's.
          if (outcome === 'absent') throw fileRefusal(hook, 'not-found');
          return {};
        },
        { returns: DeleteFileOutputSchema },
      );

      b.registerService<unknown, ProjectsCreateFolderOutput>(
        'projects:create-folder',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:create-folder';
          const input = parseInput(CreateFolderInputSchema, hook, rawInput);
          const actor = requireActor(ctx, hook);
          const path = changePath(hook, input.path);
          const { row } = await loadEditable(ctx, hook, actor, input.projectId);
          const change: LayoutChange = { op: 'mkdir', path };
          if (isUnderSources(path)) refuseChange(ctx, hook, row.project_id, change, 'read-only-path');
          // 'created' or 'exists': either way the folder is there (mkdir -p).
          await applyChange(ctx, hook, row, change);
          return {};
        },
        { returns: CreateFolderOutputSchema },
      );

      // ---- file history (W3d §7) ------------------------------------------
      // `snapshot`: the orchestrator's pass before a writable project session
      // opens, called as the person (the ctx it resolved the project with), so
      // the person must be able to use the project. Changes it finds are
      // "Changed outside history". It answers within `snapshotBudgetMs`; a pass
      // that fails or runs past that leaves a gap, and the session opens anyway.
      b.registerService<unknown, ProjectsSnapshotOutput>(
        'projects:snapshot',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:snapshot';
          const input = parseInput(SnapshotInputSchema, hook, rawInput);
          const actor = requireActor(ctx, hook);
          const { row, members } = await loadUsable(ctx, hook, input.projectId);
          if (!history!.enabled()) return { recorded: 0, gap: false };
          const projectId = row.project_id;
          const owner = await projectOwner(ctx, actor, projectId, ownerFirst(members));
          if (owner === null) {
            ctx.logger.warn('projects_history_skipped', { projectId, reason: 'no-owner' });
            return { recorded: 0, gap: false };
          }
          type Settled = { kind: 'pass'; out: PassResult } | { kind: 'error'; err: unknown };
          const run: Promise<Settled> = history!
            .recordPass(ctx, row, { label: 'outside', owner, attribution: {} })
            .then(
              (out): Settled => ({ kind: 'pass', out }),
              (err: unknown): Settled => ({ kind: 'error', err }),
            );
          track(run);
          let timer: NodeJS.Timeout | undefined;
          const deadline = new Promise<'deadline'>((resolve) => {
            timer = setTimeout(() => resolve('deadline'), snapshotBudgetMs);
            timer.unref();
          });
          let settled: Settled | 'deadline';
          try {
            settled = await Promise.race([run, deadline]);
          } finally {
            clearTimeout(timer);
          }
          if (settled === 'deadline') {
            // The pass carries on in the background; what it finds is still recorded.
            ctx.logger.warn('projects_snapshot_slow', { projectId, budgetMs: snapshotBudgetMs });
            await history!.recordGapQuietly(ctx, projectId, 'snapshot-timeout');
            return { recorded: 0, gap: true };
          }
          if (settled.kind === 'error') {
            ctx.logger.error('projects_snapshot_failed', { projectId, err: errOf(settled.err) });
            await history!.recordGapQuietly(ctx, projectId, 'snapshot-failed');
            return { recorded: 0, gap: true };
          }
          const out = settled.out;
          if (out.kind !== 'done') return { recorded: 0, gap: false };
          return { recorded: out.recorded, gap: out.failed > 0 };
        },
        { returns: SnapshotOutputSchema },
      );

      // `file-history`, `read-version`: the same gate as read-file (any person
      // who can use the project, viewers included). The path is checked like a
      // change's, since only a file has history.
      b.registerService<unknown, ProjectsFileHistoryOutput>(
        'projects:file-history',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:file-history';
          const input = parseInput(FileHistoryInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const path = changePath(hook, input.path);
          const { row } = await loadUsable(ctx, hook, input.projectId);
          const [versions, gaps] = await Promise.all([
            history!.listVersions(row.project_id, path),
            history!.listGaps(row.project_id),
          ]);
          return {
            versions: versions.map(versionOut),
            gaps: gaps.map((g) => ({ at: g.at.toISOString(), reason: g.reason })),
          };
        },
        { returns: FileHistoryOutputSchema },
      );

      b.registerService<unknown, ProjectsReadVersionOutput>(
        'projects:read-version',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:read-version';
          const input = parseInput(ReadVersionInputSchema, hook, rawInput);
          requireActor(ctx, hook);
          const { row } = await loadUsable(ctx, hook, input.projectId);
          const v = await history!.getVersion(row.project_id, input.versionId);
          if (v === undefined || v.kind !== 'write' || v.too_large || v.blob_sha === null) throw versionNotFound(hook);
          const bytes = await history!.readBlob(ctx, v.blob_sha);
          if (bytes === null) throw versionNotFound(hook);
          return { contents: bytes, size: bytes.length };
        },
        { returns: ReadVersionOutputSchema },
      );

      // `restore-version`: the same gate and rules as write-file. The version's
      // bytes are written through `applyChange` (an overwrite, or a re-create
      // of a deleted file), recorded as "Restored by <person>".
      b.registerService<unknown, ProjectsRestoreVersionOutput>(
        'projects:restore-version',
        PLUGIN_NAME,
        async (ctx, rawInput) => {
          const hook = 'projects:restore-version';
          const input = parseInput(RestoreVersionInputSchema, hook, rawInput);
          const actor = requireActor(ctx, hook);
          const { row, members } = await loadEditable(ctx, hook, actor, input.projectId);
          const v = await history!.getVersion(row.project_id, input.versionId);
          if (v === undefined) throw versionNotFound(hook);
          if (v.kind !== 'write' || v.too_large || v.blob_sha === null) throw notRestorable(hook);
          const path = changePath(hook, v.path);
          const bytes = await history!.readBlob(ctx, v.blob_sha);
          if (bytes === null) throw notRestorable(hook);
          const change: LayoutChange = { op: 'write', path, content: bytes };
          if (isUnderSources(path)) refuseChange(ctx, hook, row.project_id, change, 'read-only-path');
          await applyChange(ctx, hook, row, change, { label: 'restore', actor, members });
          if (PROTECTED_PATHS.has(path)) {
            for (const agentId of new Set(members.map((m) => m.agentId))) {
              await b.fire(AUGMENT_CHANGED_HOOK, ctx, { agentId });
            }
          }
          return { sha256: sha256Hex(bytes) };
        },
        { returns: RestoreVersionOutputSchema },
      );

      // ---- the project block ---------------------------------------------
      // Optional provider, never `rules`. `brief` is the project's name and
      // description — written by people through the projects routes, never by
      // an agent — plus fixed text, so it reaches bootstrap mode too: an agent
      // still in its first-run chat otherwise answered a project chat as if
      // there were no project. `context` (W3b) is what's in the folder —
      // AGENT-WRITTEN, so never in `brief` — quoted (block.ts); it is left out
      // when the folder can't be read here, and a failed part says so.
      // Any failure is `{}` — W2's runner note (one line per mounted folder)
      // is the floor, so the model still learns where the folder is.
      b.registerService<SystemPromptAugmentInput, SystemPromptAugmentOutput>(
        PROJECTS_BLOCK_HOOK,
        PLUGIN_NAME,
        async (ctx) => {
          const projectId = ctx.projectId;
          if (typeof projectId !== 'string' || projectId === '') return {};
          try {
            const res = await resolveProject(ctx, projectId, ctx.agentId);
            if (!res.ok) {
              ctx.logger.warn('projects_block_skipped', { projectId, agentId: ctx.agentId, reason: res.reason });
              return {};
            }
            if (!isValidSharedFolderId(res.value.folderId)) {
              ctx.logger.warn('projects_block_skipped', { projectId, reason: 'malformed-folder-id' });
              return {};
            }
            const brief = renderProjectBlock(res.value);
            // Agent-written file text: `context`, never `brief` (W3 §13).
            let context: string | undefined;
            try {
              context = await projectContext(ctx, res.value.folderId);
            } catch (err) {
              ctx.logger.warn('projects_context_skipped', { projectId, reason: 'error', err: errOf(err) });
            }
            return context === undefined ? { brief } : { brief, context };
          } catch (err) {
            ctx.logger.warn('projects_block_skipped', { projectId, reason: 'error', err: errOf(err) });
            return {};
          }
        },
        { returns: SystemPromptAugmentOutputSchema },
      );

      // ---- shared-folders:deleted ----------------------------------------
      // Payload declared locally: `{ folderId }`. AT-LEAST-ONCE (W2's sweep
      // re-fires it for every tombstone), so this is idempotent: the second
      // fire finds no row and fires nothing. Never throws.
      b.subscribe<unknown>(SHARED_FOLDERS_DELETED_HOOK, PLUGIN_NAME, async (ctx, payload) => {
        const folderId = (payload as { folderId?: unknown } | null | undefined)?.folderId;
        if (typeof folderId !== 'string' || folderId.length === 0) {
          ctx.logger.warn('projects_folder_deleted_skipped', {
            reason: 'shared-folders:deleted payload has no non-empty string folderId',
          });
          return undefined;
        }
        try {
          await deleteRowsWhere(ctx, 'folder_id', folderId);
        } catch (err) {
          // The sweep re-fires the event, so a later pass retries this.
          ctx.logger.error('projects_folder_deleted_failed', { folderId, err: errOf(err) });
        }
        return undefined;
      });

      // ---- W3d: history ------------------------------------------------------
      // The end of an agent's turn: record what the turn changed. The project
      // is `ctx.projectId`, stamped by the IPC server from the session record,
      // never from the runner's frame. A turn fires twice (tool, then
      // assistant), so a pass runs once per (session, reqId). The payload is
      // runner-written: its ids are only a key and a label. A runner replaying
      // a reqId only skips its own session's pass; the next pre-spawn
      // snapshot or a person's save still catches what changed. In the background:
      // never blocks the turn, never throws.
      b.subscribe<unknown>(CHAT_TURN_END_HOOK, PLUGIN_NAME, async (ctx, payload) => {
        try {
          const projectId = ctx.projectId;
          if (typeof projectId !== 'string' || projectId === '' || shuttingDown) return undefined;
          if (!history!.enabled() || actorOf(ctx) === null) return undefined;
          const p = (payload ?? {}) as { reqId?: unknown; turnId?: unknown };
          const reqId = turnIdOf(p.reqId);
          const turnKey = reqId ?? turnIdOf(p.turnId);
          if (turnKey === undefined) return undefined;
          const key = `${ctx.sessionId}\u0000${turnKey}`;
          if (!firstSighting(key)) return undefined;
          track(turnEndPass(ctx, projectId, reqId, key));
        } catch (err) {
          ctx.logger.error('projects_history_turn_failed', { err: errOf(err) });
        }
        return undefined;
      });

      // An agent is gone: its versions stay, showing "a removed agent".
      b.subscribe<unknown>(AGENTS_DELETED_HOOK, PLUGIN_NAME, async (ctx, payload) => {
        const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          ctx.logger.warn('projects_history_agent_skipped', { reason: 'agents:deleted payload has no agentId' });
          return undefined;
        }
        try {
          await history!.forgetAgent(agentId);
        } catch (err) {
          ctx.logger.error('projects_history_agent_failed', { agentId, err: errOf(err) });
        }
        return undefined;
      });

      // Chats are purged: versions stay, without the link to the chat. A
      // payload we don't recognise is rejected WHOLE.
      b.subscribe<unknown>(CONVERSATIONS_PURGED_HOOK, PLUGIN_NAME, async (ctx, payload) => {
        const ids = (payload as { conversationIds?: unknown } | null | undefined)?.conversationIds;
        if (
          !Array.isArray(ids) ||
          ids.length > PURGED_IDS_MAX ||
          !ids.every((id): id is string => typeof id === 'string' && id.length > 0)
        ) {
          ctx.logger.warn('projects_history_purge_skipped', { reason: 'malformed conversations:purged payload' });
          return undefined;
        }
        try {
          await history!.forgetConversations(ids);
        } catch (err) {
          ctx.logger.error('projects_history_purge_failed', { count: ids.length, err: errOf(err) });
        }
        return undefined;
      });

      // We hold blob shas in our own rows, so we answer (never throws).
      b.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, PLUGIN_NAME, async (_ctx, payload) =>
        answerBlobCollectRefs(payload, PLUGIN_NAME, (shas) => history!.blobRefs(shas)),
      );

      // Retention, daily, under a try-lock (one replica runs it).
      const retentionIntervalMs = opts.historyRetentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
      if (retentionIntervalMs > 0) {
        const runRetention = (): void => {
          track(
            runRetentionNow().then(
              (out) => {
                if (out.kind === 'done' && out.versions + out.gaps > 0) {
                  initCtx.logger.info('projects_history_retention', { versions: out.versions, gaps: out.gaps });
                }
              },
              (err: unknown) => initCtx.logger.error('projects_history_retention_failed', { err: errOf(err) }),
            ),
          );
        };
        retentionStartTimer = setTimeout(() => {
          retentionStartTimer = undefined;
          runRetention();
          retentionTimer = setInterval(runRetention, retentionIntervalMs);
          retentionTimer.unref();
        }, opts.historyRetentionInitialDelayMs ?? DEFAULT_RETENTION_INITIAL_DELAY_MS);
        retentionStartTimer.unref();
      }
    },
  };
}
