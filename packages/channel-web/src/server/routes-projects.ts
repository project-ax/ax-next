import {
  isRejection,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { fenceLine } from '../lib/fence-line.js';
import {
  AgentIdSchema,
  CreateProjectRequest,
  ProjectIdSchema,
  SetProjectMemberRequest,
  UpdateProjectRequest,
  type CreateProjectResponse,
  type ListProjectsResponse,
  type OwnerCandidatesResponse,
  type ProjectConversationsResponse,
  type ProjectDetail,
  type ProjectMember,
  type ProjectMemberRole,
  type ProjectSummary,
  type SetProjectMemberResponse,
  type UpdateProjectResponse,
} from '../wire/projects.js';
import {
  basenameOf,
  decodeFileBody,
  FILE_LABEL_MAX_CHARS,
  sendFileDownload,
  toUserFileEntry,
  UNREADABLE_FILE_NAME,
  USER_FILES_ENTRIES_MAX,
  type AgentUserFilesResponse,
  type DownloadRouteResponse,
} from './file-serving.js';
import { latestActivityByAgent, rankByRecentUse, activityStamp } from './recency.js';
import { listTeamIdsForUser, type RouteRequest, type RouteResponse } from './routes-chat.js';
import { workspaceFilePath } from './safe-path.js';

// ---------------------------------------------------------------------------
// @ax/channel-web project routes (W3a, W3 spec §4.8).
//
//   GET    /api/workspace/projects                          projects:list
//   POST   /api/workspace/projects                          projects:create
//   GET    /api/workspace/projects/owner-candidates         agents:list-for-user + agents:can-manage-sharing
//   GET    /api/workspace/projects/:projectId               projects:get (+ names, canManage)
//   PATCH  /api/workspace/projects/:projectId               projects:update
//   DELETE /api/workspace/projects/:projectId               projects:delete
//   GET    /api/workspace/projects/:projectId/conversations projects:get, then conversations:list
//   PUT    /api/workspace/projects/:projectId/members/:agentId projects:set-member (W3e)
//   DELETE /api/workspace/projects/:projectId/members/:agentId projects:set-member, role null (W3e)
//   GET    /api/workspace/projects/:projectId/files         projects:read-file (the folder root)
//   GET    /api/workspace/projects/:projectId/files/*       projects:read-file
//   GET    /api/workspace/projects/:projectId/download/*    projects:download-file
//
// THE ACTOR. Every `projects:*` hook (and `agents:can-manage-sharing`) takes
// its actor from `ctx.userId`, never from the payload. So each call here runs
// on `actorCtx(userId)`, built from the AUTHENTICATED session — never on the
// host init ctx (whose userId is a system id the hooks refuse) and never from
// anything in the request.
//
// STATUS MAPPING. `@ax/projects` answers `not-found` for an unknown project
// AND for one the actor can't use — they are indistinguishable here too (404
// `project-not-found`). It answers `forbidden` only once the actor CAN use the
// project but may not manage it (rename, delete), or may not manage the agent
// they asked to own a new one; their access to it is no secret from them, so
// that is a 403. `invalid-payload` is a 400. Anything else is a fault and
// propagates (500), never dressed up as a refusal.
//
// MEMBERS (W3e). `projects:set-member` refuses `forbidden` for the owner agent
// (target-is-owner), for a project the person can use but not manage, and for
// any change W2's shared folders refuse (an agent with a different owner, one
// the person doesn't manage) — all a 403 here, by the mapping above. The
// answer is the members after the change, named the way GET /:projectId names
// them; the hook never returns the folder, and the route rebuilds each member
// field by field regardless.
//
// CSRF: POST/PUT/PATCH/DELETE are gated by @ax/http-server's `http:request`
// subscriber before any handler runs; nothing here re-implements it.
//
// WITHOUT @ax/projects (a preset that doesn't load it): the list answers an
// empty list (true — there are no projects), owner-candidates still answers
// (it doesn't need projects), and every other route answers 503
// `projects-unavailable` — never a 404 that would read as "you lost access".
//
// THE FILE ROUTES (W3b) answer in the agent user-files shape
// (`AgentUserFilesResponse`, built by the same file-serving helpers), so one
// browser component reads both. The folder's id never reaches them — the hooks
// don't return it, and the handlers rebuild every response field by field.
// Order: auth → project id → hook loaded → path → hook. The path check runs
// BEFORE anything looks the project up, so its 400 is a function of the URL
// string alone — identical for a project you use, someone else's, and one that
// doesn't exist — and can't be used to probe for projects. (The agent routes
// check access first because there the access check lives in the route; here
// it lives in the hook, which takes the project and the path together and
// answers `not-found` for both kinds of missing project.)
//
//   read-file                      download-file
//   ---------                      -------------
//   dir / file    → 200 JSON       bytes         → 200 octet-stream attachment
//   absent        → 404 file-not-found            not-found  → 404 file-not-found
//   not-found     → 404 project-not-found         not-a-file → 400 not-a-file
//   unavailable   → 503 project-files-unavailable too-large  → 413 file-too-large
//   forbidden     → 403, invalid-payload → 400    unavailable → 503 project-files-unavailable
//
// A download's `not-found` covers an unknown project, someone else's and a
// missing file alike (the hook can't tell them apart on purpose), hence one
// 404 body there.
// ---------------------------------------------------------------------------

const ACTOR_AGENT_ID = '@ax/channel-web';
const PROJECT_CONVERSATION_TITLE_MAX_CHARS = 120;
/** `@ax/projects`' bound on a file path (its `RelPathSchema`); longer is a 400 here. */
const PROJECT_FILE_PATH_MAX_CHARS = 4096;
/**
 * Mirrors `@ax/projects`' `DOWNLOAD_FILE_MAX_BYTES` (no cross-plugin import).
 * Only decides the `downloadable` HINT on a file answer; the download hook
 * stays the gate and answers `too-large` (413) on its own.
 */
const PROJECT_FILE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

// --- duck-typed hook payloads (invariant 2 — no cross-plugin import) -------

interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}
interface ProjectMemberRow {
  agentId: string;
  role: ProjectMemberRole;
}
interface ProjectsListOutput {
  projects: Array<{
    projectId: string;
    name: string;
    description: string | null;
    updatedAt: string;
    members: ProjectMemberRow[];
  }>;
}
interface ProjectsGetOutput {
  projectId: string;
  name: string;
  description: string | null;
  folderId: string;
  createdAt: string;
  updatedAt: string;
  members: ProjectMemberRow[];
}
interface ProjectsSetMemberOutput {
  members: ProjectMemberRow[];
}
interface ProjectsCreateOutput {
  projectId: string;
  folderId: string;
}
interface ProjectsUpdateOutput {
  projectId: string;
  name: string;
  description: string | null;
  updatedAt: string;
}
interface AgentsListForUserOutput {
  agents: Array<{ id: string; displayName: string; createdAt?: unknown }>;
}
type ProjectsReadFileOutput =
  | {
      kind: 'dir';
      entries: Array<{ name: string; kind: 'file' | 'dir'; size?: number; updatedAt?: string }>;
      truncated: boolean;
    }
  | { kind: 'file'; contents: Uint8Array; truncated: boolean; size: number }
  | { kind: 'absent' }
  | { kind: 'unavailable' };
interface ProjectsDownloadFileOutput {
  contents: Uint8Array;
  size: number;
}
interface ConversationRow {
  conversationId: string;
  agentId: string;
  title: string | null;
  lastActivityAt?: string | null;
  createdAt: string;
}

export interface ProjectsHandlerDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

async function authOr401(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<string | null> {
  try {
    const r = await bus.call<{ req: RouteRequest }, AuthRequireUserOutput>('auth:require-user', ctx, { req });
    return r.user.id;
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

/** Parse a JSON body; `undefined` on malformed JSON (the caller answers 400). */
function readJson(req: RouteRequest): unknown {
  try {
    return req.body.length === 0 ? {} : (JSON.parse(req.body.toString('utf8')) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Map a refusal from `@ax/projects` onto a status. Returns false for anything
 * that is not a refusal — the caller rethrows it.
 */
function projectRefused(res: RouteResponse, err: unknown): boolean {
  if (!(err instanceof PluginError)) return false;
  switch (err.code) {
    case 'not-found':
      res.status(404).json({ error: 'project-not-found' });
      return true;
    case 'forbidden':
      res.status(403).json({ error: 'forbidden' });
      return true;
    case 'invalid-payload':
      res.status(400).json({ error: 'invalid-payload' });
      return true;
    default:
      return false;
  }
}

/**
 * Map a `projects:download-file` refusal onto a status (the table at the top).
 * False for anything else — the caller rethrows it.
 */
function downloadRefused(res: RouteResponse, err: unknown): boolean {
  if (!(err instanceof PluginError)) return false;
  switch (err.code) {
    case 'not-found':
      res.status(404).json({ error: 'file-not-found' });
      return true;
    case 'not-a-file':
      res.status(400).json({ error: 'not-a-file' });
      return true;
    case 'too-large':
      res.status(413).json({ error: 'file-too-large' });
      return true;
    case 'unavailable':
      res.status(503).json({ error: 'project-files-unavailable' });
      return true;
    case 'forbidden':
      res.status(403).json({ error: 'forbidden' });
      return true;
    case 'invalid-payload':
      res.status(400).json({ error: 'invalid-payload' });
      return true;
    default:
      return false;
  }
}

/**
 * The splat → a folder-relative path, or `null` (the caller answers 400).
 * `rawSplat` arrives undecoded; `workspaceFilePath` owns the single decode and
 * refuses traversal, absolute paths, empty/dot segments, NUL and bad escapes.
 * `''` is the folder root, allowed only where `allowRoot` says so (a listing,
 * not a download).
 */
function projectFilePath(rawSplat: string, allowRoot: boolean): string | null {
  if (rawSplat.length === 0) return allowRoot ? '' : null;
  const decoded = workspaceFilePath(rawSplat);
  if (decoded === null || decoded.length > PROJECT_FILE_PATH_MAX_CHARS) return null;
  return decoded;
}

function isDenial(err: unknown): boolean {
  return (
    (err instanceof PluginError && (err.code === 'forbidden' || err.code === 'not-found')) || isRejection(err)
  );
}

export function makeProjectsHandlers(deps: ProjectsHandlerDeps) {
  const { bus, initCtx } = deps;

  /** The authenticated person as the actor — the ONLY ctx a projects:* call runs on. */
  function actorCtx(userId: string): AgentContext {
    return makeAgentContext({
      sessionId: 'projects-surface',
      agentId: ACTOR_AGENT_ID,
      userId,
      workspace: initCtx.workspace,
    });
  }

  /**
   * 503 when @ax/projects isn't loaded. Returns false after writing it. Takes
   * the probe's RESULT, so every `hasService` names its hook as a literal (the
   * manifest-declarations guard reads them).
   */
  function projectsLoaded(res: RouteResponse, loaded: boolean): boolean {
    if (loaded) return true;
    res.status(503).json({ error: 'projects-unavailable' });
    return false;
  }

  /** `:projectId`, bounded, or a 404 (an id we could never resolve is just unknown). */
  function projectIdParam(req: RouteRequest, res: RouteResponse): string | null {
    const parsed = ProjectIdSchema.safeParse(req.params.projectId);
    if (!parsed.success) {
      res.status(404).json({ error: 'project-not-found' });
      return null;
    }
    return parsed.data;
  }

  /**
   * `:agentId`, bounded like every agent id here, or a 400. Not a 404: the
   * agent is what the person is ASKING to add, and the hook's own bound
   * answers `invalid-payload` for the same input.
   */
  function agentIdParam(req: RouteRequest, res: RouteResponse): string | null {
    const parsed = AgentIdSchema.safeParse(req.params.agentId);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid-payload' });
      return null;
    }
    return parsed.data;
  }

  /** Members as the project page shows them: names only for agents this person can see. */
  async function namedMembers(userId: string, members: ProjectMemberRow[]): Promise<ProjectMember[]> {
    const names = new Map((await listAgents(userId)).map((a) => [a.id, a.displayName]));
    return members.map((m) => {
      const displayName = names.get(m.agentId);
      return { agentId: m.agentId, role: m.role, ...(displayName !== undefined ? { displayName } : {}) };
    });
  }

  /**
   * The body behind PUT (add / re-role) and DELETE (remove) on a member.
   * Order: auth → project id → agent id → body → hook loaded → hook.
   */
  async function setMember(req: RouteRequest, res: RouteResponse, remove: boolean): Promise<void> {
    const userId = await authOr401(bus, initCtx, req, res);
    if (userId === null) return;
    const projectId = projectIdParam(req, res);
    if (projectId === null) return;
    const agentId = agentIdParam(req, res);
    if (agentId === null) return;
    let role: 'editor' | 'viewer' | null = null;
    if (!remove) {
      const parsed = SetProjectMemberRequest.safeParse(readJson(req));
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      role = parsed.data.role;
    }
    if (!projectsLoaded(res, bus.hasService('projects:set-member'))) return;
    let out: ProjectsSetMemberOutput;
    try {
      out = await bus.call<{ projectId: string; agentId: string; role: 'editor' | 'viewer' | null }, ProjectsSetMemberOutput>(
        'projects:set-member',
        actorCtx(userId),
        { projectId, agentId, role },
      );
    } catch (err) {
      if (projectRefused(res, err)) return;
      throw err;
    }
    res.status(200).json({ members: await namedMembers(userId, out.members) } satisfies SetProjectMemberResponse);
  }

  async function listAgents(userId: string): Promise<AgentsListForUserOutput['agents']> {
    const teamIds = await listTeamIdsForUser(bus, initCtx, userId);
    const out = await bus.call<{ userId: string; teamIds: string[] }, AgentsListForUserOutput>(
      'agents:list-for-user',
      initCtx,
      { userId, teamIds },
    );
    return out.agents;
  }

  /**
   * May this person manage `agentId`'s sharing? A denial (unknown agent,
   * someone else's) is `false`; a missing service is `false` too (nothing can
   * vouch for them). Any other failure propagates.
   */
  async function canManage(userId: string, agentId: string): Promise<boolean> {
    if (!bus.hasService('agents:can-manage-sharing')) return false;
    try {
      const out = await bus.call<{ agentId: string }, { allowed: boolean }>(
        'agents:can-manage-sharing',
        actorCtx(userId),
        { agentId },
      );
      return out.allowed === true;
    } catch (err) {
      if (isDenial(err)) return false;
      throw err;
    }
  }

  async function getProject(userId: string, projectId: string): Promise<ProjectsGetOutput> {
    return bus.call<{ projectId: string }, ProjectsGetOutput>('projects:get', actorCtx(userId), { projectId });
  }

  /**
   * The body behind both listing routes (root and splat) — one security order,
   * written once. See THE FILE ROUTES at the top for the order and mapping.
   */
  async function readProjectFilesPath(req: RouteRequest, res: RouteResponse, rawSplat: string): Promise<void> {
    const userId = await authOr401(bus, initCtx, req, res);
    if (userId === null) return;
    const projectId = projectIdParam(req, res);
    if (projectId === null) return;
    if (!projectsLoaded(res, bus.hasService('projects:read-file'))) return;
    const relPath = projectFilePath(rawSplat, true);
    if (relPath === null) {
      res.status(400).json({ error: 'invalid-path' });
      return;
    }
    let out: ProjectsReadFileOutput;
    try {
      out = await bus.call<{ projectId: string; path: string }, ProjectsReadFileOutput>(
        'projects:read-file',
        actorCtx(userId),
        { projectId, path: relPath },
      );
    } catch (err) {
      if (projectRefused(res, err)) return;
      throw err;
    }
    if (out.kind === 'unavailable') {
      // A fact about the deployment, not the folder — never an empty listing.
      res.status(503).json({ error: 'project-files-unavailable' });
      return;
    }
    if (out.kind === 'absent') {
      res.status(404).json({ error: 'file-not-found' });
      return;
    }
    const name = relPath === '' ? '' : (fenceLine(basenameOf(relPath), FILE_LABEL_MAX_CHARS) ?? UNREADABLE_FILE_NAME);
    if (out.kind === 'dir') {
      res.status(200).json({
        kind: 'dir',
        path: relPath,
        name,
        entries: out.entries.slice(0, USER_FILES_ENTRIES_MAX).map((e) => toUserFileEntry(relPath, e)),
        truncated: out.truncated || out.entries.length > USER_FILES_ENTRIES_MAX,
      } satisfies AgentUserFilesResponse);
      return;
    }
    const decoded = decodeFileBody(out.contents);
    res.status(200).json({
      kind: 'file',
      path: relPath,
      name,
      body: decoded.body,
      // The hook's preview (1 MiB) is longer than ours (128 KiB), so a clipped
      // preview is already `too-large` here; this only keeps "the whole file"
      // honest if those two bounds ever cross.
      clipped: decoded.clipped === null && out.truncated ? 'too-large' : decoded.clipped,
      size: out.size,
      downloadable: out.size <= PROJECT_FILE_DOWNLOAD_MAX_BYTES,
    } satisfies AgentUserFilesResponse);
  }

  return {
    /** GET /api/workspace/projects */
    async listProjects(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      if (!bus.hasService('projects:list')) {
        // True, not a shrug: a deployment without @ax/projects has none.
        res.status(200).json({ projects: [] } satisfies ListProjectsResponse);
        return;
      }
      const out = await bus.call<Record<string, never>, ProjectsListOutput>('projects:list', actorCtx(userId), {});
      const projects: ProjectSummary[] = out.projects.map((p) => ({
        projectId: p.projectId,
        name: p.name,
        description: p.description,
        updatedAt: p.updatedAt,
        members: p.members.map((m) => ({ agentId: m.agentId, role: m.role })),
      }));
      res.status(200).json({ projects } satisfies ListProjectsResponse);
    },

    /** POST /api/workspace/projects */
    async createProject(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const parsed = CreateProjectRequest.safeParse(readJson(req));
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      if (!projectsLoaded(res, bus.hasService('projects:create'))) return;
      const body = parsed.data;
      try {
        const out = await bus.call<Record<string, string>, ProjectsCreateOutput>(
          'projects:create',
          actorCtx(userId),
          {
            ownerAgentId: body.ownerAgentId,
            name: body.name,
            ...(body.description !== undefined ? { description: body.description } : {}),
          },
        );
        res.status(201).json({ projectId: out.projectId } satisfies CreateProjectResponse);
      } catch (err) {
        if (projectRefused(res, err)) return;
        throw err;
      }
    },

    /** GET /api/workspace/projects/owner-candidates */
    async ownerCandidates(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agents = await listAgents(userId);
      const allowed = await Promise.all(agents.map((a) => canManage(userId, a.id)));
      const managed = agents.filter((_, i) => allowed[i] === true);
      // The same recency `POST /api/workspace/route` ranks by: the newest
      // activity over the person's own conversations, per agent. One list
      // read; a failed read ranks everything as unused (creation order),
      // which is a worse default, never a wrong owner — every row is still
      // an agent they manage.
      let latest = new Map<string, number>();
      if (managed.length > 1 && bus.hasService('conversations:list')) {
        try {
          const rows = await bus.call<{ userId: string }, ConversationRow[]>('conversations:list', initCtx, {
            userId,
          });
          latest = latestActivityByAgent(rows);
        } catch (err) {
          initCtx.logger.warn('projects_owner_candidates_recency_unreadable', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      res.status(200).json({
        agents: rankByRecentUse(managed, latest).map((a) => ({ agentId: a.id, displayName: a.displayName })),
      } satisfies OwnerCandidatesResponse);
    },

    /** GET /api/workspace/projects/:projectId */
    async getProject(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const projectId = projectIdParam(req, res);
      if (projectId === null) return;
      if (!projectsLoaded(res, bus.hasService('projects:get'))) return;
      let project: ProjectsGetOutput;
      try {
        project = await getProject(userId, projectId);
      } catch (err) {
        if (projectRefused(res, err)) return;
        throw err;
      }
      // Names only for agents this person can see in their own list; an agent
      // they can't see stays an id (never a name they couldn't look up).
      const owner = project.members.find((m) => m.role === 'owner');
      const detail: ProjectDetail = {
        projectId: project.projectId,
        name: project.name,
        description: project.description,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        members: await namedMembers(userId, project.members),
        canManage: owner !== undefined && (await canManage(userId, owner.agentId)),
      };
      res.status(200).json(detail);
    },

    /** PATCH /api/workspace/projects/:projectId */
    async updateProject(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const projectId = projectIdParam(req, res);
      if (projectId === null) return;
      const parsed = UpdateProjectRequest.safeParse(readJson(req));
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      if (!projectsLoaded(res, bus.hasService('projects:update'))) return;
      const body = parsed.data;
      try {
        const out = await bus.call<Record<string, unknown>, ProjectsUpdateOutput>(
          'projects:update',
          actorCtx(userId),
          {
            projectId,
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
          },
        );
        res.status(200).json({
          projectId: out.projectId,
          name: out.name,
          description: out.description,
          updatedAt: out.updatedAt,
        } satisfies UpdateProjectResponse);
      } catch (err) {
        if (projectRefused(res, err)) return;
        throw err;
      }
    },

    /** DELETE /api/workspace/projects/:projectId */
    async deleteProject(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const projectId = projectIdParam(req, res);
      if (projectId === null) return;
      if (!projectsLoaded(res, bus.hasService('projects:delete'))) return;
      try {
        await bus.call<{ projectId: string }, unknown>('projects:delete', actorCtx(userId), { projectId });
        res.status(204).end();
      } catch (err) {
        if (projectRefused(res, err)) return;
        throw err;
      }
    },

    /** GET /api/workspace/projects/:projectId/conversations */
    async projectConversations(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const projectId = projectIdParam(req, res);
      if (projectId === null) return;
      if (!projectsLoaded(res, bus.hasService('projects:get'))) return;
      // The gate: a project this person can't use is a 404 BEFORE we ask for
      // chats, so the list can never confirm a project id they guessed.
      try {
        await getProject(userId, projectId);
      } catch (err) {
        if (projectRefused(res, err)) return;
        throw err;
      }
      // User-scoped by `conversations:list` itself: only this person's chats,
      // never another member's.
      const rows = await bus.call<{ userId: string; projectId: string }, ConversationRow[]>(
        'conversations:list',
        initCtx,
        { userId, projectId },
      );
      const conversations = [...rows]
        .sort((a, b) => activityStamp(b) - activityStamp(a))
        .map((c) => ({
          conversationId: c.conversationId,
          agentId: c.agentId,
          // A model may have written this title — fenced like every title.
          title: fenceLine(c.title, PROJECT_CONVERSATION_TITLE_MAX_CHARS) ?? null,
          lastActivityAt: c.lastActivityAt ?? c.createdAt,
        }));
      res.status(200).json({ conversations } satisfies ProjectConversationsResponse);
    },

    /** PUT /api/workspace/projects/:projectId/members/:agentId — add, or change the role. */
    async setProjectMember(req: RouteRequest, res: RouteResponse): Promise<void> {
      await setMember(req, res, false);
    },

    /** DELETE /api/workspace/projects/:projectId/members/:agentId — remove. */
    async removeProjectMember(req: RouteRequest, res: RouteResponse): Promise<void> {
      await setMember(req, res, true);
    },

    /** GET /api/workspace/projects/:projectId/files — the folder root. */
    async projectFiles(req: RouteRequest, res: RouteResponse): Promise<void> {
      await readProjectFilesPath(req, res, '');
    },

    /** GET /api/workspace/projects/:projectId/files/* — a folder listing or a file preview. */
    async projectFile(req: RouteRequest, res: RouteResponse): Promise<void> {
      await readProjectFilesPath(req, res, req.params['*'] ?? '');
    },

    /**
     * GET /api/workspace/projects/:projectId/download/* — one file's bytes,
     * whole (≤ 10 MiB) or not at all, with the same headers as every download
     * on this surface (`sendFileDownload`: octet-stream, attachment with a
     * sanitized name, nosniff). The folder is agent-written, so its bytes
     * never decide how a browser treats them.
     */
    async projectFileDownload(req: RouteRequest, res: DownloadRouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const projectId = projectIdParam(req, res);
      if (projectId === null) return;
      if (!projectsLoaded(res, bus.hasService('projects:download-file'))) return;
      const relPath = projectFilePath(req.params['*'] ?? '', false);
      if (relPath === null) {
        res.status(400).json({ error: 'invalid-path' });
        return;
      }
      let out: ProjectsDownloadFileOutput;
      try {
        out = await bus.call<{ projectId: string; path: string }, ProjectsDownloadFileOutput>(
          'projects:download-file',
          actorCtx(userId),
          { projectId, path: relPath },
        );
      } catch (err) {
        if (downloadRefused(res, err)) return;
        throw err;
      }
      sendFileDownload(res, relPath, out.contents);
    },
  };
}

/**
 * Register the project routes against @ax/http-server. The literal
 * `/owner-candidates` path is an exact match, which the router tries before
 * any `:projectId` pattern, so it can never be read as a project id.
 */
export async function registerProjectsRoutes(bus: HookBus, initCtx: AgentContext): Promise<Array<() => void>> {
  const h = makeProjectsHandlers({ bus, initCtx });
  type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;
  const routes: Array<{ method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; handler: RouteHandler }> = [
    { method: 'GET', path: '/api/workspace/projects', handler: h.listProjects },
    { method: 'POST', path: '/api/workspace/projects', handler: h.createProject },
    { method: 'GET', path: '/api/workspace/projects/owner-candidates', handler: h.ownerCandidates },
    { method: 'GET', path: '/api/workspace/projects/:projectId', handler: h.getProject },
    { method: 'PATCH', path: '/api/workspace/projects/:projectId', handler: h.updateProject },
    { method: 'DELETE', path: '/api/workspace/projects/:projectId', handler: h.deleteProject },
    { method: 'GET', path: '/api/workspace/projects/:projectId/conversations', handler: h.projectConversations },
    { method: 'PUT', path: '/api/workspace/projects/:projectId/members/:agentId', handler: h.setProjectMember },
    { method: 'DELETE', path: '/api/workspace/projects/:projectId/members/:agentId', handler: h.removeProjectMember },
    // The splats are a bare `*` as the FINAL segment — the only spelling
    // @ax/http-server's router recognises — and the remainder arrives under
    // `req.params['*']` UNDECODED (`projectFilePath` decodes it once). The
    // router tries every exact pattern before any splat, so `/files` is never
    // swallowed by `/files/*`. `download` is its own segment, not a name under
    // `files/`, so no file in the folder can collide with it.
    { method: 'GET', path: '/api/workspace/projects/:projectId/files', handler: h.projectFiles },
    { method: 'GET', path: '/api/workspace/projects/:projectId/files/*', handler: h.projectFile },
    {
      method: 'GET',
      path: '/api/workspace/projects/:projectId/download/*',
      // The download writes bytes through the real `HttpResponse`, a superset
      // of `RouteResponse` (the agent download routes are registered the same way).
      handler: h.projectFileDownload as unknown as RouteHandler,
    },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>('http:register-route', initCtx, route);
    unregisters.push(result.unregister);
  }
  return unregisters;
}
