import type { Plugin } from '@ax/core';
import type {
  MountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import { isValidAgentId } from './agent-id.js';

const PLUGIN_NAME = '@ax/workspace-filestore';
const DEFAULT_MOUNT_PATH = '/workspace';

export interface WorkspaceFilestoreConfig {
  /**
   * The shared NFS export this resolver hands out per-agent `subPath`s into.
   * `server` is the Filestore IP / DNS name; `exportPath` is the export path on
   * that server (e.g. `/vol1/agents`). The provider realizes the mount as an
   * inline `nfs:` pod volume `{ nfs: { server, path: exportPath } }`; the
   * per-agent `subPath` confines each agent to its own subtree.
   */
  backing: {
    server: string;
    exportPath: string;
  };
  /**
   * Where the durable mount appears inside the sandbox. Defaults to
   * `/workspace`. The provider exports this path as `AX_USERFILES_ROOT`.
   */
  mountPath?: string;
}

/**
 * Production / k8s workspace-mount resolver, backed by a shared Google Cloud
 * Filestore (managed NFS) export. The NFS sibling of `@ax/workspace-localdir`
 * (local FS) — exactly one of the two loads per deployment, mirroring the
 * `@ax/workspace-git` ↔ `@ax/workspace-git-server` preset-swap. Registers the
 * host-internal `sandbox:resolve-mounts` hook and emits ONE per-agent `nfs`
 * mount keyed off `owner.agentId` (the `subPath`).
 *
 * Returns `[]` (a graceful no-mount, never an error) when the session owner has
 * no usable `agentId`.
 */
export function createWorkspaceFilestorePlugin(
  config: WorkspaceFilestoreConfig,
): Plugin {
  const mountPath = config.mountPath ?? DEFAULT_MOUNT_PATH;
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['sandbox:resolve-mounts'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
        'sandbox:resolve-mounts',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const agentId = input.owner.agentId;
          if (!isValidAgentId(agentId)) return { mounts: [] };
          // Honor a host-read (readOnly) realization request (design §11). The
          // runner's session-open call omits `readOnly`, so the mount stays
          // writable as before; a host-read caller passes `true` to get a
          // read-only realization of the SAME owner-keyed subtree. We never
          // widen write access — only narrow it.
          const mount: MountSpec = {
            kind: 'nfs',
            mountPath,
            server: config.backing.server,
            exportPath: config.backing.exportPath,
            subPath: agentId,
            readOnly: input.readOnly === true,
            role: 'user-files',
          };
          return { mounts: [mount] };
        },
      );
    },
  };
}
