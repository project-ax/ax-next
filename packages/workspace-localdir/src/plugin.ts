import { join } from 'node:path';
import { PluginError, type Plugin } from '@ax/core';
import type {
  AuthorizeMountsInput,
  AuthorizeMountsOutput,
  LocalDirMountSpec,
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  MountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import { isValidSharedFolderId } from '@ax/sandbox-protocol';
import { isValidAgentId } from './agent-id.js';

const PLUGIN_NAME = '@ax/workspace-localdir';
const DEFAULT_MOUNT_PATH = '/files';

// Where a shared folder lives, under the SAME root as per-agent `/files`:
// `<root>/.shared/<folderId>`, labelled `/shared/<folderId>` inside the sandbox.
//
// These two are LOCAL copies of `SHARED_FOLDERS_DIR` / `SHARED_FOLDERS_MOUNT_BASE`
// from `@ax/sandbox-mount-protocol`: eslint's cross-plugin rule allows only
// `import type` from that package (invariant I2), and these are runtime values.
// `__tests__/shared-folders.test.ts` asserts they equal the protocol constants,
// so drift fails a test rather than silently moving a mount.
const SHARED_FOLDERS_DIR = '.shared';
const SHARED_FOLDERS_MOUNT_BASE = '/shared';

const AUTHORIZE_HOOK = 'shared-folders:authorize-mounts';

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
   * `/files`. (For the subprocess provider — which shares the host FS —
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
 * durable per-agent `/files` WITHOUT a real NFS server.
 *
 * Returns `[]` (a graceful no-mount, never an error) when the session owner has
 * no usable `agentId` — an anonymous CLI session simply gets no durable mount.
 *
 * W2 shared folders: when the host asks for `sharedFolderIds`, the resolver
 * ALSO emits one `role:'shared-folder'` `localDir` mount per folder that
 * `shared-folders:authorize-mounts` (optional — `@ax/shared-folders`) returns,
 * AFTER the user-files mount, at `<root>/.shared/<folderId>`. It also registers
 * `sandbox:locate-shared-folder`, the grant-free lookup the provider uses to
 * DELETE a folder's bytes.
 */
export function createWorkspaceLocaldirPlugin(
  config: WorkspaceLocaldirConfig,
): Plugin {
  const mountPath = config.mountPath ?? DEFAULT_MOUNT_PATH;
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['sandbox:resolve-mounts', 'sandbox:locate-shared-folder'],
      calls: [],
      optionalCalls: [
        {
          hook: AUTHORIZE_HOOK,
          degradation:
            'without @ax/shared-folders no shared-folder mounts are emitted — a session that asks for sharedFolderIds still opens, with only its own /files',
        },
      ],
      subscribes: [],
    },
    init({ bus }) {
      // The one place a shared folder's host location + sandbox path is
      // spelled. `folderId` MUST already have passed `isValidSharedFolderId`
      // (`sf_` + base64url: one segment, no `/`, `.` or NUL) — that is what
      // keeps `<root>/.shared/<folderId>` from escaping `<root>/.shared`.
      const sharedFolderMount = (folderId: string, readOnly: boolean): LocalDirMountSpec => ({
        kind: 'localDir',
        mountPath: `${SHARED_FOLDERS_MOUNT_BASE}/${folderId}`,
        hostPath: join(config.root, SHARED_FOLDERS_DIR, folderId),
        readOnly,
        role: 'shared-folder',
        folderId,
      });

      bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
        'sandbox:resolve-mounts',
        PLUGIN_NAME,
        async (ctx, input) => {
          const agentId = input.owner.agentId;
          const requested = input.sharedFolderIds ?? [];
          if (!isValidAgentId(agentId)) {
            // No usable owner → no durable mounts of any kind, shared folders
            // included (they are authorized per-agent, and there is no agent).
            for (const id of requested) logDropped(ctx, id, 'no-agent');
            return { mounts: [] };
          }
          // Honor a host-read (readOnly) realization request (design §11). The
          // runner's session-open call omits `readOnly`, so the mount stays
          // writable as before; a host-read caller passes `true` to get a
          // read-only realization of the SAME per-agent subtree. We never widen
          // write access — only narrow it.
          const userFiles: MountSpec = {
            kind: 'localDir',
            mountPath,
            hostPath: join(config.root, agentId),
            readOnly: input.readOnly === true,
            role: 'user-files',
          };
          // The user-files mount is ALWAYS first and unchanged: consumers must
          // match mounts on `role`, but anything still reading `mounts[0]`
          // keeps getting the agent's own files.
          const mounts: MountSpec[] = [userFiles];
          if (requested.length === 0) return { mounts };

          // Only well-formed ids ever reach the authorizer or a path. Dedupe
          // (order-preserving) so one id yields at most one mount.
          const folderIds: string[] = [];
          for (const id of requested) {
            if (!isValidSharedFolderId(id)) {
              logDropped(ctx, id, 'invalid-id');
            } else if (!folderIds.includes(id)) {
              folderIds.push(id);
            }
          }
          if (folderIds.length === 0) return { mounts };

          if (!bus.hasService(AUTHORIZE_HOOK)) {
            // Plugin absent (a preset without @ax/shared-folders): degrade to
            // "no shared mounts", never to "mount them unchecked".
            ctx.logger.warn('shared_folder_mounts_dropped', {
              reason: 'no-authorizer',
              requested: folderIds.length,
            });
            return { mounts };
          }

          // A throw here PROPAGATES — the session open fails closed rather
          // than opening with a silently different (or unchecked) mount set.
          const authorized = await bus.call<AuthorizeMountsInput, AuthorizeMountsOutput>(
            AUTHORIZE_HOOK,
            ctx,
            { agentId, folderIds },
          );

          // Index the answer by id. Everything the host did NOT request is
          // ignored (the authorizer is a filter, not a source of mounts), and
          // only an explicit `readOnly: false` is writable — a missing or
          // duplicate entry can only ever narrow access.
          const readOnlyById = new Map<string, boolean>();
          for (const f of authorized.folders) {
            if (!folderIds.includes(f.folderId)) {
              ctx.logger.warn('shared_folder_mount_dropped', {
                folderId: clampForLog(f.folderId),
                reason: 'unrequested',
              });
              continue;
            }
            const ro = f.readOnly !== false || readOnlyById.get(f.folderId) === true;
            readOnlyById.set(f.folderId, ro);
          }

          // Emit in REQUEST order so the mount list is deterministic whatever
          // order the authorizer answers in.
          for (const folderId of folderIds) {
            const ro = readOnlyById.get(folderId);
            if (ro === undefined) {
              logDropped(ctx, folderId, 'not-authorized');
              continue;
            }
            mounts.push(sharedFolderMount(folderId, ro || input.readOnly === true));
          }
          return { mounts };
        },
      );

      // Where a folder's bytes live — for DELETION only
      // (`sandbox:delete-shared-folder`). There is deliberately NO grant check:
      // by the time a folder is deleted its grants are already gone, so there is
      // nothing to check. That makes this a location oracle, NOT an access path —
      // it is host-internal (never an IPC action), and it never mounts or reads
      // anything. The only safety property is confinement: an id that is not
      // exactly one `sf_<base64url>` segment is refused, so the answer is always
      // `<root>/.shared/<one safe segment>` and can never point at a per-agent
      // subtree, the root itself, or anywhere outside `.shared`.
      bus.registerService<LocateSharedFolderInput, LocateSharedFolderOutput>(
        'sandbox:locate-shared-folder',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const folderId: unknown = input?.folderId;
          if (!isValidSharedFolderId(folderId)) {
            throw new PluginError({
              code: 'invalid-folder-id',
              plugin: PLUGIN_NAME,
              hookName: 'sandbox:locate-shared-folder',
              message: 'folderId is not a valid shared-folder id',
            });
          }
          // Writable: the provider deletes through this spec.
          return { mount: sharedFolderMount(folderId, false) };
        },
      );
    },
  };
}

type LogCtx = { logger: { warn(msg: string, bindings?: Record<string, unknown>): void } };

/** Untrusted ids are logged bounded — never raw and unbounded. */
function clampForLog(id: unknown): string {
  return typeof id === 'string' ? id.slice(0, 80) : typeof id;
}

function logDropped(ctx: LogCtx, id: unknown, reason: string): void {
  ctx.logger.warn('shared_folder_mount_dropped', { folderId: clampForLog(id), reason });
}
