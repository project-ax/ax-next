import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  PluginError,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import type {
  MountSpec,
  ReadUserFilesInput,
  ReadUserFilesOutput,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';

// ---------------------------------------------------------------------------
// user-files-host-ops — the subprocess provider's HOST-SIDE realizations of
// the two filestore-user-files deferred mechanisms (design §11):
//
//   1. host-read   — `sandbox:read-user-files` reads an agent's durable
//                    user-files subtree READ-ONLY, for the web UI.
//   2. cleanup     — an `agents:deleted` subscriber `rm -rf`s the agent's
//                    durable user-files subtree.
//
// Both reuse the EXISTING `sandbox:resolve-mounts` hook to learn WHERE an
// agent's files live (`subPath`/`hostPath` keyed off `owner.agentId`) — the
// design's "owner-keyed and reusable" promise. The subprocess sandbox shares
// the host filesystem, so realization is direct: read/delete the resolved
// `localDir` `hostPath`. (The k8s sibling realizes the same two mechanisms
// against an `nfs` export via a short-lived mount-and-rm/-cat job — see
// @ax/sandbox-k8s/user-files-ops.ts.) An `nfs` (or any other) kind is NOT
// realizable here and is an EXPLICIT error, never a silent skip (design §10).
//
// SECURITY (design §9 + §11):
//   - host-read NEVER opens a writable handle — it only `readFile`/`readdir`s,
//     so write access is never granted (design §11: "without granting write").
//   - The caller-supplied `relPath` is confined to the resolved mount subtree:
//     `..` segments + absolute paths are rejected, and the post-join path is
//     re-checked to be inside the mount root (defense in depth vs. a symlink
//     race). A path escape is an error, not a silent fallthrough.
//   - cleanup deletes ONLY the resolved `hostPath` (a single per-agent subtree
//     keyed off the validated agentId) — never a sibling agent's subtree
//     (cross-tenant safety, design §9). Resolving via the SAME validated
//     resolver is what guarantees the agentId can't widen the target.
// ---------------------------------------------------------------------------

const RESOLVE_HOOK = 'sandbox:resolve-mounts';

/** The session-owner shape both ops key the per-agent mount off. */
type Owner = ResolveMountsInput['owner'];

/**
 * Resolve the agent's durable user-files mount via the optional
 * `sandbox:resolve-mounts` hook and narrow it to the `localDir` `hostPath` this
 * provider can realize. Returns `undefined` when there's nothing to act on (no
 * resolver loaded, anonymous owner, or no `role:'user-files'` mount). Throws
 * `PluginError` for an UNREALIZABLE kind (e.g. an `nfs` mount paired with this
 * provider by a mis-wired preset) — never a silent skip (design §10).
 */
async function resolveUserFilesHostPath(
  ctx: AgentContext,
  bus: HookBus,
  owner: Owner,
  pluginName: string,
  readOnly: boolean,
): Promise<string | undefined> {
  if (!bus.hasService(RESOLVE_HOOK)) return undefined;
  const { mounts } = await bus.call<ResolveMountsInput, ResolveMountsOutput>(
    RESOLVE_HOOK,
    ctx,
    { owner, readOnly },
  );
  for (const mount of mounts) {
    if (mount.role !== 'user-files') continue;
    switch (mount.kind) {
      case 'localDir':
        return mount.hostPath;
      case 'nfs':
        throw unrealizable(mount.kind, pluginName);
      default: {
        const _exhaustive: never = mount;
        throw unrealizable((_exhaustive as MountSpec).kind, pluginName);
      }
    }
  }
  return undefined;
}

function unrealizable(kind: string, pluginName: string): PluginError {
  return new PluginError({
    code: 'unrealizable-mount-kind',
    plugin: pluginName,
    message:
      `subprocess sandbox cannot realize a '${kind}' user-files mount for ` +
      `host-read/cleanup (it shares the host filesystem and has no ` +
      `network-mount path). Load @ax/workspace-localdir for the ` +
      `subprocess/CLI preset instead of @ax/workspace-filestore.`,
  });
}

/**
 * Resolve `relPath` against `root`, REJECTING anything that escapes it.
 * `relPath` is caller-supplied (the web UI), so an absolute path, a `..`
 * segment, or a post-join path outside `root` all throw. An empty/`'.'`
 * `relPath` resolves to `root` itself.
 */
function safeJoin(root: string, relPath: string | undefined): string {
  const rel = relPath === undefined || relPath === '' ? '.' : relPath;
  if (path.isAbsolute(rel)) {
    throw new Error(`user-files relPath must be relative, got: ${rel}`);
  }
  if (rel.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new Error(`user-files relPath must not contain '..': ${rel}`);
  }
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, rel);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`user-files relPath escapes the mount root: ${rel}`);
  }
  return full;
}

/**
 * Realize `sandbox:read-user-files` for the subprocess provider: resolve the
 * agent's `localDir` user-files mount READ-ONLY and read one path under it.
 * Returns `{ kind: 'absent' }` when there's no mount or the path doesn't exist;
 * a regular file's bytes for a file; the immediate children for a directory.
 * Only files + dirs are listed (symlinks/specials are skipped). Never opens a
 * writable handle.
 */
export async function readUserFiles(
  ctx: AgentContext,
  bus: HookBus,
  pluginName: string,
  input: ReadUserFilesInput,
): Promise<ReadUserFilesOutput> {
  const root = await resolveUserFilesHostPath(
    ctx,
    bus,
    input.owner,
    pluginName,
    /* readOnly */ true,
  );
  if (root === undefined) return { kind: 'absent' };

  const target = safeJoin(root, input.relPath);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    // ENOENT (or any stat failure) → nothing to serve.
    return { kind: 'absent' };
  }
  // Reject symlinks at the target itself — a read-only browser must not follow
  // a link the (untrusted) agent planted that points outside its subtree.
  if (stat.isSymbolicLink()) return { kind: 'absent' };
  if (stat.isDirectory()) {
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries = dirents
      .filter((d) => d.isFile() || d.isDirectory())
      .map((d) => ({
        name: d.name,
        kind: (d.isDirectory() ? 'dir' : 'file') as 'file' | 'dir',
      }));
    return { kind: 'dir', entries };
  }
  if (stat.isFile()) {
    const contents = await fs.readFile(target);
    return { kind: 'file', contents: new Uint8Array(contents) };
  }
  // A socket/fifo/device — nothing a file browser should serve.
  return { kind: 'absent' };
}

/**
 * Realize the `agents:deleted` cleanup for the subprocess provider: resolve the
 * agent's `localDir` user-files `hostPath` and `rm -rf` it. Best-effort and
 * idempotent (`force: true` swallows ENOENT). Deletes ONLY the resolved
 * per-agent subtree — never a sibling's (the validated resolver guarantees the
 * agentId maps to exactly one confined segment, design §9).
 */
export async function cleanupUserFiles(
  ctx: AgentContext,
  bus: HookBus,
  pluginName: string,
  owner: Owner,
  log: Logger,
): Promise<void> {
  let hostPath: string | undefined;
  try {
    hostPath = await resolveUserFilesHostPath(
      ctx,
      bus,
      owner,
      pluginName,
      /* readOnly */ false,
    );
  } catch (err) {
    // A mis-wired preset (nfs kind here) or a resolver throw — log, don't
    // crash the (already-committed) delete.
    log.warn('user_files_cleanup_resolve_failed', {
      agentId: owner.agentId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (hostPath === undefined) return; // nothing durable to reclaim
  try {
    await fs.rm(hostPath, { recursive: true, force: true });
    log.info('user_files_cleanup_done', { agentId: owner.agentId });
  } catch (err) {
    log.warn('user_files_cleanup_failed', {
      agentId: owner.agentId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the minimal `owner` a resolver needs from an `agents:deleted` event.
 * The resolvers (filestore/localdir) read ONLY `owner.agentId`; the rest of the
 * owner triple is required by the shared `OpenSessionInput['owner']` type but
 * unused on this path, so we fill it with empty placeholders. Reusing the
 * owner-keyed resolver (rather than a second cleanup hook) is the design's
 * "owner-keyed and reusable" promise (§11).
 */
export function ownerFromAgentId(agentId: string, userId: string): Owner {
  return {
    userId,
    agentId,
    agentConfig: {
      displayName: '',
      systemPromptAugment: '',
      allowedTools: [],
      mcpConfigIds: [],
      model: '',
    },
  };
}
