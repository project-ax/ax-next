import { randomBytes } from 'node:crypto';
import {
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
import { runProjectsMigration, type ProjectRow, type ProjectsDatabase } from './migrations.js';
import {
  CreateInputSchema,
  CreateOutputSchema,
  DeleteInputSchema,
  DeleteOutputSchema,
  DOWNLOAD_FILE_MAX_BYTES,
  DownloadFileInputSchema,
  DownloadFileOutputSchema,
  GetInputSchema,
  GetOutputSchema,
  ListInputSchema,
  ListOutputSchema,
  READ_FILE_MAX_ENTRIES,
  READ_FILE_PREVIEW_MAX_BYTES,
  ReadFileInputSchema,
  ReadFileOutputSchema,
  ResolveInputSchema,
  ResolveOutputSchema,
  SetMemberInputSchema,
  SetMemberOutputSchema,
  UpdateInputSchema,
  UpdateOutputSchema,
  type ProjectMember,
  type ProjectsCreateOutput,
  type ProjectsDeletedEvent,
  type ProjectsDeleteOutput,
  type ProjectsDownloadFileOutput,
  type ProjectsDownloadRefusal,
  type ProjectsGetOutput,
  type ProjectsListOutput,
  type ProjectsReadFileOutput,
  type ProjectsResolveOutput,
  type ProjectsSetMemberOutput,
  type ProjectsUpdateOutput,
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

export function createProjectsPlugin(): Plugin {
  let bus: HookBus | undefined;
  let db: Kysely<ProjectsDatabase> | undefined;

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
    const deleted = await db!
      .deleteFrom('projects_v1_projects')
      .where(column, '=', value)
      .returning('project_id')
      .execute();
    for (const { project_id } of deleted) {
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

  return {
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
      // preset.test and this package's manifest test pin the rule.
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
      ],
      subscribes: [SHARED_FOLDERS_DELETED_HOOK],
    },

    async init({ bus: b }) {
      bus = b;
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      const { db: raw } = await b.call<unknown, { db: Kysely<unknown> }>('database:get-instance', initCtx, {});
      db = raw as Kysely<ProjectsDatabase>;
      await runProjectsMigration(db);

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
          try {
            await db!
              .insertInto('projects_v1_projects')
              .values({
                project_id: projectId,
                folder_id: folderId,
                name: input.name,
                description: input.description ?? null,
                created_by_user: actor,
              })
              .execute();
          } catch (err) {
            // Don't leave a folder no project points at.
            try {
              await b.call('shared-folders:delete', ctx, { folderId });
            } catch (cleanupErr) {
              ctx.logger.error('projects_create_rollback_failed', { folderId, err: errOf(cleanupErr) });
            }
            throw err;
          }
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
          const out = await readFolder(ctx, row.folder_id, input.path, READ_FILE_PREVIEW_MAX_BYTES, READ_FILE_MAX_ENTRIES);
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
              return {
                kind: 'file',
                contents: out.contents.subarray(0, READ_FILE_PREVIEW_MAX_BYTES),
                truncated,
                size: out.size,
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
    },
  };
}
