import {
  PluginError,
  SystemPromptAugmentOutputSchema,
  isOwnerlessId,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { publishArtifact } from '../handlers.js';
import { ARTIFACTS_AUGMENT_HOOK, createArtifactsAugmentHandler } from './augment.js';
import { can, isAgentMember, roleFor, type ArtifactAction } from './access.js';
import { describeMediaType, downloadFilename, mediaTypeForPath } from './media.js';
import type { ArtifactRow, ArtifactStore, VersionRow } from './store.js';
import { isShareCode, newShareCode } from './share-code.js';
import { normalizeArtifactTitle } from './title.js';
import {
  ArtifactsDeleteOutputSchema,
  ArtifactsGetOutputSchema,
  ArtifactsListOutputSchema,
  ArtifactsPublishOutputSchema,
  ArtifactsReadOutputSchema,
  ArtifactsResolveShareCodeOutputSchema,
  ArtifactsSetLinkOutputSchema,
  ArtifactsSummaryOutputSchema,
  type ArtifactDetail,
  type ArtifactSummary,
  type ArtifactsDeleteInput,
  type ArtifactsDeleteOutput,
  type ArtifactsGetInput,
  type ArtifactsGetOutput,
  type ArtifactsListInput,
  type ArtifactsListOutput,
  type ArtifactsPublishInput,
  type ArtifactsPublishOutput,
  type ArtifactsReadInput,
  type ArtifactsReadOutput,
  type ArtifactsRenameInput,
  type ArtifactsResolveShareCodeInput,
  type ArtifactsResolveShareCodeOutput,
  type ArtifactsRestoreInput,
  type ArtifactsSetLinkInput,
  type ArtifactsSetLinkOutput,
  type ArtifactsSummaryOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/attachments';

/** `artifacts:list` returns at most this many, newest first. */
export const ARTIFACT_LIST_MAX = 1000;
/** Longest `sourcePath` a publish accepts (UTF-16 code units). */
export const ARTIFACT_SOURCE_PATH_MAX = 1024;
/** An id longer than this is not one; it gets the same not-found as a missing one. */
const ID_MAX = 256;

type BlobGetOutput = { bytes: Uint8Array } | { found: false };

export interface ArtifactHookDeps {
  artifacts: ArtifactStore;
  bus: HookBus;
}

/** Optional: without it the share page says "an agent". */
export const AGENT_DISPLAY_NAME_HOOK = 'agents:get-display-name';
export const AGENT_DISPLAY_NAME_DEGRADATION = "the share page says 'an agent'";

function fail(hookName: string, code: 'not-found' | 'invalid-payload' | 'conflict', message: string): PluginError {
  return new PluginError({ code, plugin: PLUGIN_NAME, hookName, message });
}

/** Every access refusal, whatever the cause: one code, one message. */
function notFound(hookName: string): PluginError {
  return fail(hookName, 'not-found', 'artifact not found');
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX;
}

function isVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

/** Relative, non-empty, bounded, with no `..` and no empty segments. */
export function isPublishableSourcePath(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > ARTIFACT_SOURCE_PATH_MAX) return false;
  return v.split('/').every((seg) => seg.length > 0 && seg !== '..');
}

/** The non-person user ids a host-side ctx carries (`makeAgentContext` callers in init and background loops). */
const NON_PERSON_USER_IDS = new Set(['', 'system', 'init']);

/** Is a signed-in person behind this ctx? A share link is for people, never for host-side callers. */
function hasPerson(ctx: AgentContext): boolean {
  return typeof ctx.userId === 'string' && !NON_PERSON_USER_IDS.has(ctx.userId) && !isOwnerlessId(ctx.userId);
}

/** An agent id that names an agent, not an owner-less stand-in or a blank. */
function isRealAgentId(id: string): boolean {
  return id.length > 0 && !isOwnerlessId(id);
}

export function summaryOf(row: ArtifactRow): ArtifactSummary {
  const described = describeMediaType(row.current.mediaType);
  return {
    artifactId: row.artifactId,
    agentId: row.agentId,
    title: row.title,
    mediaType: row.current.mediaType,
    kind: described.kind,
    preview: described.preview,
    extension: described.extension,
    currentVersion: row.currentVersion,
    sizeBytes: row.current.sizeBytes,
    linkOn: row.shareCode !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** How a caller names an artifact: by id (members), or by its share code (link holders). */
type ArtifactRef = { artifactId: unknown } | { shareCode: unknown };

/**
 * The artifact, if the caller may take `action` on it; else the one not-found.
 * The single access path for every hook (§6.6):
 *
 * - By id: `agents:resolve` membership decides the role. An outage propagates
 *   as itself.
 * - By share code: a person must be behind ctx, and the code must have the
 *   minted shape (checked before any lookup), then match through the unique
 *   index. A match is the `link` role.
 *
 * A missing artifact, a foreign one, a malformed, wrong, turned-off or rotated
 * code, and a ctx with no person are indistinguishable.
 */
async function headFor(
  deps: ArtifactHookDeps,
  ctx: AgentContext,
  hookName: string,
  ref: ArtifactRef,
  action: (head: ArtifactRow) => ArtifactAction,
): Promise<ArtifactRow> {
  let head: ArtifactRow | null;
  let agentMember = false;
  let codeMatched = false;
  if ('shareCode' in ref) {
    if (!hasPerson(ctx) || !isShareCode(ref.shareCode)) throw notFound(hookName);
    head = await deps.artifacts.findByShareCode(ref.shareCode);
    if (head === null) throw notFound(hookName);
    codeMatched = true;
  } else {
    if (!isId(ref.artifactId)) throw notFound(hookName);
    head = await deps.artifacts.getHead(ref.artifactId);
    if (head === null) throw notFound(hookName);
    agentMember = await isAgentMember(deps.bus, ctx, head.agentId);
  }
  if (!can(roleFor({ agentMember, codeMatched }), action(head))) throw notFound(hookName);
  return head;
}

/**
 * `artifacts:publish` — the agent publishes a file from its files root. The
 * order is the contract: input checks, then the shared publish chain
 * (`publishArtifact`: owner gate, the caller's own agent, quota owner, blob
 * size, media type from the path, one store transaction).
 */
export function createArtifactsPublishHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:publish';
  return async (ctx: AgentContext, input: ArtifactsPublishInput): Promise<ArtifactsPublishOutput> => {
    const title = normalizeArtifactTitle(input.title);
    if (title === null) throw fail(hookName, 'invalid-payload', 'the title must be 1-200 characters of visible text');
    if (!isPublishableSourcePath(input.sourcePath)) {
      throw fail(hookName, 'invalid-payload', 'the file must be a relative path inside the files folder');
    }
    if (input.artifactId !== undefined && !isId(input.artifactId)) throw notFound(hookName);

    const result = await publishArtifact(deps, ctx, hookName, {
      conversationId: input.conversationId,
      sha256: input.sha256,
      sourcePath: input.sourcePath,
      title,
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      ...(isRealAgentId(ctx.agentId) ? { callerAgentId: ctx.agentId } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'unknown-artifact') throw notFound(hookName);
      throw fail(hookName, 'conflict', 'another artifact is already published from that file');
    }
    const { kind, extension } = describeMediaType(mediaTypeForPath(input.sourcePath));
    return { artifactId: result.artifactId, version: result.version, title: result.title, kind, extension };
  };
}

/** `artifacts:list` — an agent's artifacts, newest first, for any member (D7). */
export function createArtifactsListHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:list';
  return async (ctx: AgentContext, input: ArtifactsListInput): Promise<ArtifactsListOutput> => {
    if (!isId(input.agentId)) throw notFound(hookName);
    const agentMember = await isAgentMember(deps.bus, ctx, input.agentId);
    if (!can(roleFor({ agentMember, codeMatched: false }), 'list')) throw notFound(hookName);
    const rows = await deps.artifacts.listForAgent(input.agentId, ARTIFACT_LIST_MAX);
    return { artifacts: rows.map(summaryOf) };
  };
}

function versionInfo(v: VersionRow) {
  return { version: v.version, mediaType: v.mediaType, sizeBytes: v.sizeBytes, createdAt: v.createdAt.toISOString() };
}

/** `artifacts:get` — one artifact with its retained versions, newest first. */
export function createArtifactsGetHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:get';
  return async (ctx: AgentContext, input: ArtifactsGetInput): Promise<ArtifactsGetOutput> => {
    const head = await headFor(deps, ctx, hookName, { artifactId: input.artifactId }, () => 'view-any-version');
    const versions = await deps.artifacts.listVersions(head.artifactId);
    const artifact: ArtifactDetail = { ...summaryOf(head), versions: versions.map(versionInfo) };
    return { artifact };
  };
}

/**
 * `artifacts:read` — one version's bytes. By id: any retained version, the
 * current one by default; a pruned version is not-found. By share code: the
 * current version only.
 */
export function createArtifactsReadHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:read';
  return async (ctx: AgentContext, input: ArtifactsReadInput): Promise<ArtifactsReadOutput> => {
    const raw = input as { artifactId?: unknown; version?: unknown; shareCode?: unknown };
    let head: ArtifactRow;
    let version: VersionRow | null;
    if ('shareCode' in raw) {
      if (raw.version !== undefined || raw.artifactId !== undefined) {
        throw fail(hookName, 'invalid-payload', 'a share code reads the current version and takes nothing else');
      }
      head = await headFor(deps, ctx, hookName, { shareCode: raw.shareCode }, () => 'view-current');
      version = head.current;
    } else {
      const wanted = raw.version;
      if (wanted !== undefined && !isVersion(wanted)) {
        throw fail(hookName, 'invalid-payload', 'version must be a positive integer');
      }
      head = await headFor(deps, ctx, hookName, { artifactId: raw.artifactId }, (h) =>
        wanted === undefined || wanted === h.currentVersion ? 'view-current' : 'view-any-version',
      );
      version =
        wanted === undefined || wanted === head.currentVersion
          ? head.current
          : await deps.artifacts.getVersion(head.artifactId, wanted);
    }
    if (version === null) throw notFound(hookName);

    const got = await deps.bus.call<{ sha256: string }, BlobGetOutput>('blob:get', ctx, { sha256: version.sha256 });
    if ('found' in got && got.found === false) throw notFound(hookName);
    const bytes = (got as { bytes: Uint8Array }).bytes;
    const described = describeMediaType(version.mediaType);
    return {
      bytes,
      mediaType: version.mediaType,
      preview: described.preview,
      sizeBytes: bytes.byteLength,
      filename: downloadFilename(head.title, described.extension),
      version: version.version,
    };
  };
}

/** `artifacts:rename` — a person's title, which a later publish keeps (C5). Does not reorder the list. */
export function createArtifactsRenameHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:rename';
  return async (ctx: AgentContext, input: ArtifactsRenameInput): Promise<ArtifactsSummaryOutput> => {
    const title = normalizeArtifactTitle(input.title);
    if (title === null) throw fail(hookName, 'invalid-payload', 'the title must be 1-200 characters of visible text');
    const head = await headFor(deps, ctx, hookName, { artifactId: input.artifactId }, () => 'rename');
    const renamed = await deps.artifacts.rename(head.artifactId, title);
    if (renamed === null) throw notFound(hookName);
    return { artifact: summaryOf(renamed) };
  };
}

/** `artifacts:restore` — point the artifact at a retained version. Copies nothing (D5). */
export function createArtifactsRestoreHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:restore';
  return async (ctx: AgentContext, input: ArtifactsRestoreInput): Promise<ArtifactsSummaryOutput> => {
    if (!isVersion(input.version)) throw fail(hookName, 'invalid-payload', 'version must be a positive integer');
    const head = await headFor(deps, ctx, hookName, { artifactId: input.artifactId }, () => 'restore');
    const restored = await deps.artifacts.restore(head.artifactId, input.version);
    if (restored === null) throw notFound(hookName);
    return { artifact: summaryOf(restored) };
  };
}

/** `artifacts:delete` — the artifact and every version. */
export function createArtifactsDeleteHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:delete';
  return async (ctx: AgentContext, input: ArtifactsDeleteInput): Promise<ArtifactsDeleteOutput> => {
    const head = await headFor(deps, ctx, hookName, { artifactId: input.artifactId }, () => 'delete');
    if (!(await deps.artifacts.deleteArtifact(head.artifactId))) throw notFound(hookName);
    return { deleted: true };
  };
}

const LINK_ACTIONS: ReadonlySet<unknown> = new Set(['ensure', 'off', 'rotate']);

/**
 * `artifacts:set-link` — owner only. `ensure` (Copy link) mints a code on first
 * use and returns the same one after; two at once get the same code (one
 * conditional UPDATE). `rotate` (Get new link) replaces it and `off` clears it;
 * the old code stops resolving at once, since every resolve reads the index.
 */
export function createArtifactsSetLinkHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:set-link';
  return async (ctx: AgentContext, input: ArtifactsSetLinkInput): Promise<ArtifactsSetLinkOutput> => {
    const action = input.action;
    if (!LINK_ACTIONS.has(action)) throw fail(hookName, 'invalid-payload', "action must be 'ensure', 'off' or 'rotate'");
    const head = await headFor(deps, ctx, hookName, { artifactId: input.artifactId }, () =>
      action === 'ensure' ? 'copy-link' : 'set-link',
    );
    const shareCode = await deps.artifacts.setShareCode(head.artifactId, action, newShareCode);
    // Deleted between the check and the update.
    if (shareCode === null && action !== 'off') throw notFound(hookName);
    return { shareCode };
  };
}

/** The agent's display name for the share page, or null. Never fails the resolve. */
async function agentNameFor(deps: ArtifactHookDeps, ctx: AgentContext, agentId: string): Promise<string | null> {
  if (!deps.bus.hasService(AGENT_DISPLAY_NAME_HOOK)) return null;
  try {
    const out = await deps.bus.call<{ agentId: string }, { displayName?: unknown }>(AGENT_DISPLAY_NAME_HOOK, ctx, {
      agentId,
    });
    return typeof out.displayName === 'string' ? out.displayName : null;
  } catch (err) {
    // No code here: the lookup is by agent id.
    ctx.logger.warn('artifacts_share_agent_name_unavailable', { agentId, err });
    return null;
  }
}

/**
 * `artifacts:resolve-share-code` — what a signed-in link holder sees: the
 * current version's metadata, with no id, versions or code. Everything that
 * does not resolve is the same not-found as a missing artifact.
 */
export function createArtifactsResolveShareCodeHandler(deps: ArtifactHookDeps) {
  const hookName = 'artifacts:resolve-share-code';
  return async (
    ctx: AgentContext,
    input: ArtifactsResolveShareCodeInput,
  ): Promise<ArtifactsResolveShareCodeOutput> => {
    const shareCode = (input as { shareCode?: unknown } | null | undefined)?.shareCode;
    const head = await headFor(deps, ctx, hookName, { shareCode }, () => 'view-current');
    const described = describeMediaType(head.current.mediaType);
    return {
      artifact: {
        title: head.title,
        mediaType: head.current.mediaType,
        kind: described.kind,
        preview: described.preview,
        extension: described.extension,
        sizeBytes: head.current.sizeBytes,
        updatedAt: head.updatedAt.toISOString(),
        agentName: await agentNameFor(deps, ctx, head.agentId),
      },
    };
  };
}

/** The `artifacts:*` hooks and the augment, with their names in `registers` order. */
export const ARTIFACT_HOOKS = [
  'artifacts:publish',
  'artifacts:list',
  'artifacts:get',
  'artifacts:read',
  'artifacts:rename',
  'artifacts:restore',
  'artifacts:delete',
  'artifacts:set-link',
  'artifacts:resolve-share-code',
  ARTIFACTS_AUGMENT_HOOK,
] as const;

/** Register every hook in ARTIFACT_HOOKS, each with its `returns` schema. */
export function registerArtifactHooks(bus: HookBus, plugin: string, deps: ArtifactHookDeps): void {
  bus.registerService('artifacts:publish', plugin, createArtifactsPublishHandler(deps), {
    returns: ArtifactsPublishOutputSchema,
  });
  bus.registerService('artifacts:list', plugin, createArtifactsListHandler(deps), {
    returns: ArtifactsListOutputSchema,
  });
  bus.registerService('artifacts:get', plugin, createArtifactsGetHandler(deps), {
    returns: ArtifactsGetOutputSchema,
  });
  bus.registerService('artifacts:read', plugin, createArtifactsReadHandler(deps), {
    returns: ArtifactsReadOutputSchema,
  });
  bus.registerService('artifacts:rename', plugin, createArtifactsRenameHandler(deps), {
    returns: ArtifactsSummaryOutputSchema,
  });
  bus.registerService('artifacts:restore', plugin, createArtifactsRestoreHandler(deps), {
    returns: ArtifactsSummaryOutputSchema,
  });
  bus.registerService('artifacts:delete', plugin, createArtifactsDeleteHandler(deps), {
    returns: ArtifactsDeleteOutputSchema,
  });
  bus.registerService('artifacts:set-link', plugin, createArtifactsSetLinkHandler(deps), {
    returns: ArtifactsSetLinkOutputSchema,
  });
  bus.registerService('artifacts:resolve-share-code', plugin, createArtifactsResolveShareCodeHandler(deps), {
    returns: ArtifactsResolveShareCodeOutputSchema,
  });
  // Never fire system-prompt:augment-changed on publish: it would respawn the
  // publishing session (see augment.ts).
  bus.registerService(ARTIFACTS_AUGMENT_HOOK, plugin, createArtifactsAugmentHandler(deps), {
    returns: SystemPromptAugmentOutputSchema,
  });
}
