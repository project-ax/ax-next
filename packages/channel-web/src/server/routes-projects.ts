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
  type ProjectFileHistoryResponse,
  type ProjectFileVersion,
  type ProjectFileVersionAuthor,
  type ProjectFileVersionLabel,
  type ProjectFileVersionPreview,
  type RestoreProjectFileVersionResponse,
  type ProjectConversationsResponse,
  type ProjectDetail,
  type ProjectMember,
  type ProjectMemberRole,
  type ProjectSummary,
  type SetProjectMemberResponse,
  type UpdateProjectResponse,
  type WriteProjectFileResponse,
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
//   PUT    /api/workspace/projects/:projectId/files/*       projects:write-file (W3c)
//   DELETE /api/workspace/projects/:projectId/files/*       projects:delete-file (W3c)
//   POST   /api/workspace/projects/:projectId/folders/*     projects:create-folder (W3c)
//   GET    /api/workspace/projects/:projectId/history/*     projects:file-history (W3d)
//   GET    /api/workspace/projects/:projectId/versions/:versionId          projects:read-version (W3d)
//   POST   /api/workspace/projects/:projectId/versions/:versionId/restore  projects:restore-version (W3d)
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
//
// A FILE ANSWER'S `sha256` (W3c) is the base hash a save sends back as
// `If-Match`. It is present ONLY when `body` is the whole file, byte for byte:
// not clipped, not truncated by the hook, and unchanged by the decode and the
// fence (a file with invalid UTF-8 or a stripped bidi control would come back
// different). So "has a sha256" is exactly "safe to edit as text" — a Save can
// never quietly rewrite bytes the person never saw. Project previews carry up
// to 1 MiB of body (the hook's preview), so a file that size can be edited.
//
// THE CHANGE ROUTES (W3c, W3 spec §6.3). Same order as the reads: auth →
// project id → hook loaded → path → preconditions → hook; the actor is the
// session's person. The write body is the file's raw bytes (≤ 10 MiB, the
// route's `maxBodyBytes`, so @ax/http-server answers 413 before we run).
// `If-Match: "<sha256>"` → `baseHash`; `If-None-Match: *` → `ifAbsent`; both,
// or a malformed one, is a 400. Refusals:
//
//   invalid-payload → 400 invalid-payload     conflict  → 409 conflict
//   not-found       → 404 (see below)         exists    → 409 exists
//   forbidden       → 403 forbidden (the person can use only viewer agents)
//   protected-path  → 403 protected-path      too-large → 413 file-too-large
//   read-only-path  → 403 read-only-path      files-unavailable → 503 project-files-unavailable
//
// A delete's `not-found` covers an unknown project, someone else's and a
// missing file alike, so it is one body (`file-not-found`), as the download's.
// A write or a new folder can only miss the project (`project-not-found`).
//
// THE HISTORY ROUTES (W3d, W3 spec §7.3). Same order again: auth → project id
// → hook loaded → path / version id → hook, as the session's person.
//
//   - history: any person who can use the project (viewers too). A file with
//     no history is an empty list, not a 404. Each version's author is
//     rebuilt here and NEVER carries a user id: "you", another person's display
//     name (`auth:get-user`, else unnamed), or an agent named only if it's on
//     this person's own agent list. A version's chat is linked only when it's
//     one of this person's own chats in the project (`conversations:list` is
//     user-scoped); anyone else's chat id is dropped.
//   - a version's preview: the read-file preview rules (1 MiB of text,
//     decoded and bidi-fenced; a binary body is `clipped: 'binary'` and no
//     bytes). JSON only, never the raw bytes, so nothing here hands a browser
//     agent-written content to interpret. `not-found` covers an unknown
//     project, someone else's, a foreign version and one with no bytes alike:
//     one body, `version-not-found`.
//   - restore: what a save needs. `not-restorable` (a delete, a too-large
//     version, bytes gone) → 409; every other refusal maps as a save's, with
//     `version-not-found` for the 404.
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
/**
 * The write route's body cap: `@ax/projects`' `WRITE_FILE_MAX_BYTES` (no
 * cross-plugin import). The hook re-checks and answers `too-large` itself.
 */
export const PROJECT_FILE_WRITE_MAX_BYTES = 10 * 1024 * 1024;
/**
 * How much of a project file a preview carries as text: the hook's own
 * preview (1 MiB), so a file up to that size can be edited whole (W3c).
 */
const PROJECT_FILE_PREVIEW_MAX_BYTES = 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** `@ax/projects`' bound on a version id; longer can only be unknown (404). */
const VERSION_ID_MAX_CHARS = 128;
/** The longest person or agent name the History sheet draws. */
const HISTORY_NAME_MAX_CHARS = 80;

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
  | { kind: 'file'; contents: Uint8Array; truncated: boolean; size: number; sha256?: string }
  | { kind: 'absent' }
  | { kind: 'unavailable' };
interface ProjectsDownloadFileOutput {
  contents: Uint8Array;
  size: number;
}
interface ProjectsFileHistoryOutput {
  versions: Array<{
    versionId: string;
    kind: 'write' | 'delete';
    label: ProjectFileVersionLabel;
    size: number;
    tooLarge: boolean;
    authorUserId: string | null;
    authorAgentId: string | null;
    conversationId: string | null;
    createdAt: string;
  }>;
  gaps: Array<{ at: string; reason: string }>;
}
interface ProjectsReadVersionOutput {
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
 * Map a refusal from one of the change hooks onto a status (the table at the
 * top). `notFound` is the 404 body: a delete's `not-found` may mean the file.
 * False for anything else — the caller rethrows it.
 */
function changeRefused(res: RouteResponse, err: unknown, notFound: string): boolean {
  if (!(err instanceof PluginError)) return false;
  switch (err.code) {
    case 'invalid-payload':
      res.status(400).json({ error: 'invalid-payload' });
      return true;
    case 'not-found':
      res.status(404).json({ error: notFound });
      return true;
    case 'forbidden':
    case 'protected-path':
    case 'read-only-path':
      res.status(403).json({ error: err.code });
      return true;
    case 'conflict':
    case 'exists':
      res.status(409).json({ error: err.code });
      return true;
    case 'too-large':
      res.status(413).json({ error: 'file-too-large' });
      return true;
    case 'files-unavailable':
      res.status(503).json({ error: 'project-files-unavailable' });
      return true;
    default:
      return false;
  }
}

/** `:versionId`, bounded, or `null` (the caller answers 404: an id we could never hold is unknown). */
function versionIdParam(raw: string | undefined): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= VERSION_ID_MAX_CHARS ? raw : null;
}

/**
 * A write's preconditions, from its headers, or `null` (the caller answers
 * 400). `If-Match` takes one strong entity tag naming a sha256 (quoted, as
 * HTTP spells it); `If-None-Match` takes only `*`. Never both.
 */
function writePreconditions(
  headers: Record<string, string>,
): { baseHash?: string; ifAbsent?: true } | null {
  const ifMatch = headers['if-match'];
  const ifNoneMatch = headers['if-none-match'];
  if (ifMatch !== undefined && ifNoneMatch !== undefined) return null;
  if (ifMatch !== undefined) {
    const m = /^"([0-9a-f]{64})"$/.exec(ifMatch.trim());
    return m === null ? null : { baseHash: m[1]! };
  }
  if (ifNoneMatch !== undefined) return ifNoneMatch.trim() === '*' ? { ifAbsent: true } : null;
  return {};
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
    const decoded = decodeFileBody(out.contents, PROJECT_FILE_PREVIEW_MAX_BYTES);
    const clipped = decoded.clipped === null && out.truncated ? 'too-large' : decoded.clipped;
    // The base hash only for a body that IS the file (see the top).
    const whole =
      clipped === null &&
      decoded.body !== null &&
      typeof out.sha256 === 'string' &&
      SHA256_HEX.test(out.sha256) &&
      Buffer.from(decoded.body, 'utf8').equals(Buffer.from(out.contents.buffer, out.contents.byteOffset, out.contents.byteLength));
    res.status(200).json({
      kind: 'file',
      path: relPath,
      name,
      body: decoded.body,
      // "The whole file" stays honest if the hook clipped what we decoded.
      clipped,
      size: out.size,
      downloadable: out.size <= PROJECT_FILE_DOWNLOAD_MAX_BYTES,
      ...(whole ? { sha256: out.sha256 } : {}),
    } satisfies AgentUserFilesResponse);
  }

  /** Auth → project id → hook loaded → path, shared by the three change routes and history. */
  async function changeTarget(
    req: RouteRequest,
    res: RouteResponse,
    loaded: boolean,
  ): Promise<{ userId: string; projectId: string; relPath: string } | null> {
    const userId = await authOr401(bus, initCtx, req, res);
    if (userId === null) return null;
    const projectId = projectIdParam(req, res);
    if (projectId === null) return null;
    if (!projectsLoaded(res, loaded)) return null;
    const relPath = projectFilePath(req.params['*'] ?? '', false);
    if (relPath === null) {
      res.status(400).json({ error: 'invalid-path' });
      return null;
    }
    return { userId, projectId, relPath };
  }

  /** Display names for the history's agents: only agents on this person's own list. */
  async function historyAgentNames(
    userId: string,
    versions: ProjectsFileHistoryOutput['versions'],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (!versions.some((v) => v.authorAgentId !== null)) return names;
    for (const a of await listAgents(userId)) {
      const name = fenceLine(a.displayName, HISTORY_NAME_MAX_CHARS);
      if (name !== null && name.length > 0) names.set(a.id, name);
    }
    return names;
  }

  /**
   * Display names for the OTHER people in the history, asked once per person.
   * Fail-soft: no `auth:get-user`, a miss or a throw leaves them unnamed
   * ("Someone"). Never logs who.
   */
  async function historyPersonNames(
    userId: string,
    versions: ProjectsFileHistoryOutput['versions'],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const others = new Set<string>();
    for (const v of versions) {
      if (v.authorAgentId === null && v.authorUserId !== null && v.authorUserId !== userId) others.add(v.authorUserId);
    }
    if (others.size === 0 || !bus.hasService('auth:get-user')) return names;
    let failed = false;
    await Promise.all(
      [...others].map(async (id) => {
        try {
          const u = await bus.call<{ userId: string }, { displayName?: string | null } | null>(
            'auth:get-user',
            initCtx,
            { userId: id },
          );
          const name = typeof u?.displayName === 'string' ? fenceLine(u.displayName, HISTORY_NAME_MAX_CHARS) : null;
          if (typeof name === 'string' && name.length > 0) names.set(id, name);
        } catch {
          failed = true;
        }
      }),
    );
    if (failed) initCtx.logger.warn('projects_history_person_name_failed', {});
    return names;
  }

  /**
   * The history's chats this person can open: their own chats in this project
   * (`conversations:list` is user-scoped), as conversationId → agentId. Any
   * other chat is left unlinked. Fail-soft: a failed read links nothing.
   */
  async function historyChats(
    userId: string,
    projectId: string,
    versions: ProjectsFileHistoryOutput['versions'],
  ): Promise<Map<string, string>> {
    const chats = new Map<string, string>();
    if (!versions.some((v) => v.conversationId !== null) || !bus.hasService('conversations:list')) return chats;
    try {
      const rows = await bus.call<{ userId: string; projectId: string }, ConversationRow[]>(
        'conversations:list',
        initCtx,
        { userId, projectId },
      );
      for (const r of rows) chats.set(r.conversationId, r.agentId);
    } catch (err) {
      initCtx.logger.warn('projects_history_chats_unreadable', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return chats;
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

    /**
     * PUT /api/workspace/projects/:projectId/files/* — save one file's bytes
     * (the raw body). `If-Match` / `If-None-Match` as at the top.
     */
    async writeProjectFile(req: RouteRequest, res: RouteResponse): Promise<void> {
      const target = await changeTarget(req, res, bus.hasService('projects:write-file'));
      if (target === null) return;
      const pre = writePreconditions(req.headers);
      if (pre === null) {
        res.status(400).json({ error: 'invalid-precondition' });
        return;
      }
      let out: { sha256: string };
      try {
        out = await bus.call<
          { projectId: string; path: string; content: Uint8Array; baseHash?: string; ifAbsent?: true },
          { sha256: string }
        >('projects:write-file', actorCtx(target.userId), {
          projectId: target.projectId,
          path: target.relPath,
          content: new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength),
          ...pre,
        });
      } catch (err) {
        if (changeRefused(res, err, 'project-not-found')) return;
        throw err;
      }
      res.status(200).json({ sha256: out.sha256 } satisfies WriteProjectFileResponse);
    },

    /** DELETE /api/workspace/projects/:projectId/files/* — a file or an empty folder. */
    async deleteProjectFile(req: RouteRequest, res: RouteResponse): Promise<void> {
      const target = await changeTarget(req, res, bus.hasService('projects:delete-file'));
      if (target === null) return;
      try {
        await bus.call<{ projectId: string; path: string }, unknown>('projects:delete-file', actorCtx(target.userId), {
          projectId: target.projectId,
          path: target.relPath,
        });
      } catch (err) {
        if (changeRefused(res, err, 'file-not-found')) return;
        throw err;
      }
      res.status(204).end();
    },

    /** POST /api/workspace/projects/:projectId/folders/* — a new folder (and any missing parents). */
    async createProjectFolder(req: RouteRequest, res: RouteResponse): Promise<void> {
      const target = await changeTarget(req, res, bus.hasService('projects:create-folder'));
      if (target === null) return;
      try {
        await bus.call<{ projectId: string; path: string }, unknown>(
          'projects:create-folder',
          actorCtx(target.userId),
          { projectId: target.projectId, path: target.relPath },
        );
      } catch (err) {
        if (changeRefused(res, err, 'project-not-found')) return;
        throw err;
      }
      res.status(204).end();
    },

    /**
     * GET /api/workspace/projects/:projectId/history/* — one file's versions,
     * newest first, plus the project's history gaps. Names and chat links as
     * at the top; never a user id.
     */
    async projectFileHistory(req: RouteRequest, res: RouteResponse): Promise<void> {
      const target = await changeTarget(req, res, bus.hasService('projects:file-history'));
      if (target === null) return;
      const { userId, projectId, relPath } = target;
      let out: ProjectsFileHistoryOutput;
      try {
        out = await bus.call<{ projectId: string; path: string }, ProjectsFileHistoryOutput>(
          'projects:file-history',
          actorCtx(userId),
          { projectId, path: relPath },
        );
      } catch (err) {
        if (projectRefused(res, err)) return;
        throw err;
      }
      const [agentNames, personNames, chats] = await Promise.all([
        historyAgentNames(userId, out.versions),
        historyPersonNames(userId, out.versions),
        historyChats(userId, projectId, out.versions),
      ]);
      const versions: ProjectFileVersion[] = out.versions.map((v) => {
        let author: ProjectFileVersionAuthor;
        if (v.authorAgentId !== null) {
          author = { kind: 'agent', displayName: agentNames.get(v.authorAgentId) ?? null, removed: false };
        } else if (v.label === 'agent') {
          // The agent was deleted since; its id was cleared with it.
          author = { kind: 'agent', displayName: null, removed: true };
        } else if (v.authorUserId === userId) {
          author = { kind: 'you' };
        } else if (v.authorUserId !== null) {
          author = { kind: 'person', displayName: personNames.get(v.authorUserId) ?? null };
        } else {
          author = { kind: 'none' };
        }
        const chat = v.conversationId === null ? undefined : chats.get(v.conversationId);
        return {
          versionId: v.versionId,
          kind: v.kind,
          label: v.label,
          size: v.size,
          tooLarge: v.tooLarge,
          author,
          chat: chat === undefined ? null : { conversationId: v.conversationId!, agentId: chat },
          createdAt: v.createdAt,
        };
      });
      res.status(200).json({
        versions,
        gaps: out.gaps.map((g) => ({ at: g.at })),
      } satisfies ProjectFileHistoryResponse);
    },

    /**
     * GET /api/workspace/projects/:projectId/versions/:versionId — one
     * version's text, as a file preview (JSON; never the raw bytes).
     */
    async projectFileVersion(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const projectId = projectIdParam(req, res);
      if (projectId === null) return;
      if (!projectsLoaded(res, bus.hasService('projects:read-version'))) return;
      const versionId = versionIdParam(req.params.versionId);
      if (versionId === null) {
        res.status(404).json({ error: 'version-not-found' });
        return;
      }
      let out: ProjectsReadVersionOutput;
      try {
        out = await bus.call<{ projectId: string; versionId: string }, ProjectsReadVersionOutput>(
          'projects:read-version',
          actorCtx(userId),
          { projectId, versionId },
        );
      } catch (err) {
        if (err instanceof PluginError && err.code === 'not-found') {
          res.status(404).json({ error: 'version-not-found' });
          return;
        }
        if (projectRefused(res, err)) return;
        throw err;
      }
      const decoded = decodeFileBody(out.contents, PROJECT_FILE_PREVIEW_MAX_BYTES);
      res.status(200).json({
        body: decoded.body,
        clipped: decoded.clipped,
        size: out.size,
      } satisfies ProjectFileVersionPreview);
    },

    /** POST /api/workspace/projects/:projectId/versions/:versionId/restore — write that version back. */
    async restoreProjectFileVersion(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const projectId = projectIdParam(req, res);
      if (projectId === null) return;
      if (!projectsLoaded(res, bus.hasService('projects:restore-version'))) return;
      const versionId = versionIdParam(req.params.versionId);
      if (versionId === null) {
        res.status(404).json({ error: 'version-not-found' });
        return;
      }
      let out: { sha256: string };
      try {
        out = await bus.call<{ projectId: string; versionId: string }, { sha256: string }>(
          'projects:restore-version',
          actorCtx(userId),
          { projectId, versionId },
        );
      } catch (err) {
        if (err instanceof PluginError && err.code === 'not-restorable') {
          res.status(409).json({ error: 'not-restorable' });
          return;
        }
        if (changeRefused(res, err, 'version-not-found')) return;
        throw err;
      }
      res.status(200).json({ sha256: out.sha256 } satisfies RestoreProjectFileVersionResponse);
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
  const routes: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    handler: RouteHandler;
    maxBodyBytes?: number;
  }> = [
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
    // W3c — changes. CSRF-gated like every write here (no `bypassCsrf`). The
    // write's body is the file itself, so it gets the file cap, not 1 MiB.
    {
      method: 'PUT',
      path: '/api/workspace/projects/:projectId/files/*',
      handler: h.writeProjectFile,
      maxBodyBytes: PROJECT_FILE_WRITE_MAX_BYTES,
    },
    { method: 'DELETE', path: '/api/workspace/projects/:projectId/files/*', handler: h.deleteProjectFile },
    { method: 'POST', path: '/api/workspace/projects/:projectId/folders/*', handler: h.createProjectFolder },
    // W3d — history. `history` is its own segment, like `download`, so no
    // file can collide with it. Restore is CSRF-gated like every write.
    { method: 'GET', path: '/api/workspace/projects/:projectId/history/*', handler: h.projectFileHistory },
    { method: 'GET', path: '/api/workspace/projects/:projectId/versions/:versionId', handler: h.projectFileVersion },
    {
      method: 'POST',
      path: '/api/workspace/projects/:projectId/versions/:versionId/restore',
      handler: h.restoreProjectFileVersion,
    },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>('http:register-route', initCtx, route);
    unregisters.push(result.unregister);
  }
  return unregisters;
}
