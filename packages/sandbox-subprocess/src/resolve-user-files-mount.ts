import { promises as fs } from 'node:fs';
import {
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import type {
  MountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';

// ---------------------------------------------------------------------------
// resolve-user-files-mount — the subprocess provider's realization of the
// host-internal `sandbox:resolve-mounts` hook (design §4/§6).
//
// `sandbox:resolve-mounts` is listed in this provider's `optionalCalls`: when a
// mount-resolver plugin (`@ax/workspace-localdir` in the CLI preset) is loaded,
// we call it during session open and realize the mounts it returns. When no
// resolver is loaded, we degrade gracefully — no durable user-files mount, the
// runner behaves exactly as before (no AX_USERFILES_ROOT).
//
// The subprocess sandbox SHARES the host filesystem (there is no container
// boundary), so it can realize only the `localDir` kind — `mkdir -p hostPath`,
// the path is simply made to exist and is handed to the runner verbatim as
// AX_USERFILES_ROOT. An `nfs` (or any other) kind is NOT realizable here and is
// an EXPLICIT error, never a silent skip (design §4/§10) — a deployment that
// pairs the subprocess provider with the NFS resolver is a wiring bug we want
// to fail loud, not a session that quietly comes up without its durable mount.
// ---------------------------------------------------------------------------

const HOOK_NAME = 'sandbox:resolve-mounts';

/** The session owner shape `sandbox:resolve-mounts` keys off. */
export type ResolveMountsOwner = ResolveMountsInput['owner'];

export interface ResolvedUserFilesMount {
  /**
   * The path to stamp as `AX_USERFILES_ROOT` — the realized location of the
   * `role:'user-files'` mount. Undefined when no resolver is loaded or it
   * returned no user-files mount (graceful no-mount).
   */
  userFilesRoot?: string;
}

/**
 * Resolve + realize this session's durable per-agent mounts via the optional
 * `sandbox:resolve-mounts` hook. For the subprocess provider, realization is
 * `mkdir -p` of each `localDir` mount's `hostPath`. Returns the `AX_USERFILES_ROOT`
 * value (the realized path of the `role:'user-files'` mount), if any.
 *
 * - No resolver loaded → `{}` (no durable mount; pre-existing behavior).
 * - Resolver returns `[]` (e.g. anonymous, no agentId) → `{}`.
 * - An unrealizable `kind` (anything but `localDir`) → throws PluginError.
 */
export async function resolveUserFilesMount(
  ctx: AgentContext,
  bus: HookBus,
  owner: ResolveMountsOwner,
  pluginName: string,
  mkdir: (path: string) => Promise<void> = async (p) => {
    await fs.mkdir(p, { recursive: true, mode: 0o700 });
  },
): Promise<ResolvedUserFilesMount> {
  if (!bus.hasService(HOOK_NAME)) return {};

  const { mounts } = await bus.call<ResolveMountsInput, ResolveMountsOutput>(
    HOOK_NAME,
    ctx,
    { owner },
  );

  const result: ResolvedUserFilesMount = {};
  for (const mount of mounts) {
    // Narrow on `kind` and realize the kinds this provider supports; reject
    // anything else EXPLICITLY (design §4/§10). The `never` default forces a
    // compile error if a future MountSpec member is added without teaching the
    // subprocess provider how to handle (or explicitly reject) it.
    switch (mount.kind) {
      case 'localDir':
        await mkdir(mount.hostPath);
        if (mount.role === 'user-files') {
          // The subprocess shares the host FS — the realized path the runner
          // sees IS the `localDir` hostPath, not the logical `mountPath`.
          result.userFilesRoot = mount.hostPath;
        }
        break;
      case 'nfs':
        throw unrealizable(mount.kind, pluginName);
      default: {
        const _exhaustive: never = mount;
        throw unrealizable((_exhaustive as MountSpec).kind, pluginName);
      }
    }
  }
  return result;
}

function unrealizable(kind: string, pluginName: string): PluginError {
  return new PluginError({
    code: 'unrealizable-mount-kind',
    plugin: pluginName,
    hookName: HOOK_NAME,
    message:
      `subprocess sandbox cannot realize a '${kind}' mount ` +
      `(it shares the host filesystem and has no network-mount path). ` +
      `Load @ax/workspace-localdir for the subprocess/CLI preset instead of ` +
      `@ax/workspace-filestore.`,
  });
}
