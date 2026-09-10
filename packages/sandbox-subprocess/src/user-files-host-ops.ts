import { promises as fs } from 'node:fs';
import {
  PluginError,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import { readConfinedUserFiles } from '@ax/user-files-read';
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
//     Structurally, not by discipline: `@ax/user-files-read` has no write
//     entry point to reach for by mistake.
//   - The caller-supplied `relPath` is confined to the resolved mount subtree
//     by `@ax/user-files-read` — the ONE confined reader, shared with the k8s
//     provider's host-mounted realization. Read its header for the full walk:
//     lexical `..`/absolute rejection, realpath confinement of every
//     component (this is what catches an INTERMEDIATE symlink the agent
//     planted), `O_NOFOLLOW` on the final open, symlink children dropped from
//     listings, and caps on bytes + entries.
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
 * Realize `sandbox:read-user-files` for the subprocess provider: resolve the
 * agent's `localDir` user-files mount READ-ONLY and read one path under it.
 * Returns `{ kind: 'absent' }` when there's no mount or the path doesn't exist;
 * a regular file's bytes for a file; the immediate children for a directory.
 *
 * The read itself — the LEXICAL guard on the caller's relPath, the realpath
 * confinement that catches an intermediate agent-planted symlink, the
 * `O_NOFOLLOW` final open, the dropped symlink children, and the size/listing
 * caps — lives in `@ax/user-files-read` and is shared with the k8s provider's
 * host-mounted realization. It is a library rather than a copy on purpose:
 * path confinement is the load-bearing cross-tenant property on this surface,
 * and a second copy is a second place a fix has to land.
 *
 * What stays HERE is the part that is this provider's own: deciding which root
 * this request is entitled to, by resolving the mount through the same
 * owner-keyed `sandbox:resolve-mounts` the session path uses. That is where the
 * identity is, so that is where the ACL belongs.
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
  return readConfinedUserFiles(root, input.relPath);
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
      runner: '',
    },
  };
}
