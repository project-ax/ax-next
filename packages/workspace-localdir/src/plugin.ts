import { join } from 'node:path';
import type { Plugin } from '@ax/core';
import type {
  MountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import { isValidAgentId } from './agent-id.js';

const PLUGIN_NAME = '@ax/workspace-localdir';
const DEFAULT_MOUNT_PATH = '/workspace';

export interface WorkspaceLocaldirConfig {
  /**
   * Absolute path to a real, persistent directory on the dev host under which
   * each agent gets its own `<root>/<agentId>` subtree. Capabilities are scoped
   * to this directory only. The subprocess sandbox provider `mkdir -p`s the
   * per-agent subtree on session open and stamps it as `AX_USERFILES_ROOT`.
   */
  root: string;
  /**
   * Where the durable mount appears inside the sandbox. Defaults to
   * `/workspace`. (For the subprocess provider — which shares the host FS —
   * the realized path IS `<root>/<agentId>`; this `mountPath` is the logical
   * label the runner advertises.)
   */
  mountPath?: string;
}

/**
 * CLI / single-host dev workspace-mount resolver. The local-FS sibling of
 * `@ax/workspace-filestore` (NFS) — exactly one of the two loads per
 * deployment, mirroring the `@ax/workspace-git` ↔ `@ax/workspace-git-server`
 * preset-swap. Registers the host-internal `sandbox:resolve-mounts` hook and
 * emits ONE per-agent `localDir` mount so the canary + local dev loop get a
 * durable per-agent `/workspace` WITHOUT a real NFS server.
 *
 * Returns `[]` (a graceful no-mount, never an error) when the session owner has
 * no usable `agentId` — an anonymous CLI session simply gets no durable mount.
 */
export function createWorkspaceLocaldirPlugin(
  config: WorkspaceLocaldirConfig,
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
          // read-only realization of the SAME per-agent subtree. We never widen
          // write access — only narrow it.
          const mount: MountSpec = {
            kind: 'localDir',
            mountPath,
            hostPath: join(config.root, agentId),
            readOnly: input.readOnly === true,
            role: 'user-files',
          };
          return { mounts: [mount] };
        },
      );
    },
  };
}
