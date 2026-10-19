import { randomUUID } from 'node:crypto';
import {
  PluginError,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import { isValidSharedFolderId } from '@ax/sandbox-protocol';
import type {
  DeleteSharedFolderInput,
  DeleteSharedFolderOutput,
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  MountSpec,
  NfsMountSpec,
  ReadSharedFolderInput,
  ReadSharedFolderOutput,
  ReadUserFilesInput,
  ScanSharedFolderInput,
  ScanSharedFolderOutput,
  ReadUserFilesOutput,
  ResolveMountsInput,
  ResolveMountsOutput,
  UserFileDirEntry,
} from '@ax/sandbox-mount-protocol';
import {
  MAX_WALK_ENTRIES,
  readConfinedByWalk,
  readConfinedUserFiles,
  scanConfinedByWalk,
  splitRelPath,
  WalkPathError,
  WalkReadError,
} from '@ax/user-files-read';
import * as path from 'node:path';
import type { ResolvedSandboxK8sConfig } from './config.js';
import type { K8sCoreApi } from './k8s-api.js';
import { killPod } from './kill.js';
import { watchPodExit } from './lifecycle.js';

// ---------------------------------------------------------------------------
// user-files-ops — the k8s provider's realizations of the two
// filestore-user-files deferred mechanisms (design §11), against an `nfs`
// (Google Cloud Filestore) export:
//
//   1. cleanup  — an `agents:deleted` subscriber `rm -rf`s the agent's durable
//                 `/workspace` subtree (`subPath=<agentId>`) via a SHORT-LIVED
//                 mount-and-rm pod (design §11 "a short-lived job that mounts
//                 the export").
//   2. host-read — `sandbox:read-user-files` reads an agent's subtree READ-ONLY
//                 (for the web UI). TWO realizations, chosen by config:
//                   - `userFilesHostReadRoot` SET → a direct filesystem read
//                     under `<root>/<subPath>`, because the chart has mounted
//                     the export read-only into the host pod. Free.
//                   - UNSET → a short-lived mount-and-read pod. One pod per
//                     call: correct, but a create + poll + log-read + delete
//                     for every directory click and every file open.
//                 The registration is single-homed either way — two plugins
//                 racing to register one service hook would be load-order
//                 dependent, and picking pod-vs-host-mount is a k8s deployment
//                 detail this provider already owns.
//
// Both reuse the EXISTING `sandbox:resolve-mounts` hook to learn the agent's
// `server`/`exportPath`/`subPath` (keyed off `owner.agentId`) — the design's
// "owner-keyed and reusable" promise. The k8s sandbox has no host-FS share, so
// each op runs a one-shot pod that mounts the WHOLE export inline (the same
// `{ nfs: { server, path: exportPath } }` volume the runner uses) and operates
// on JUST the per-agent `subPath` subtree inside it.
//
// SECURITY (design §9 + §11):
//   - The one-shot pod carries `ax.io/plane: execution` so the existing
//     `sandbox-restrict` NetworkPolicy fences it exactly like a runner pod —
//     egress to ONLY the Filestore IP (NFS ports) + DNS, ingress denied. It
//     runs non-root (uid/gid 1000), no privilege escalation, read-only rootfs,
//     all caps dropped, no service-account token. Under gVisor when configured.
//   - The `subPath` is validated as a SINGLE safe path segment
//     (`^[A-Za-z0-9_-]+$`, no `/`/`.`/`..`) before it's interpolated into the
//     pod command, AND passed via an env var (never spliced into a shell word)
//     so a crafted value cannot widen the target or inject a command. Deleting
//     `/export/<subPath>` therefore touches EXACTLY one agent's subtree — never
//     a sibling's (cross-tenant safety).
//   - cleanup mounts the export read-WRITE (it must delete); host-read mounts it
//     read-only (`readOnly: true` on the volumeMount AND requested from the
//     resolver) so the web-UI path never gains write (design §11).
//   - An unrealizable kind (anything but `nfs`) is an EXPLICIT error (design
//     §10), never a silent skip.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/sandbox-k8s';
const RESOLVE_HOOK = 'sandbox:resolve-mounts';
const EXPORT_MOUNT = '/export';
// The one-shot pods use a tiny, dependency-free image with a POSIX shell +
// coreutils. We reuse the runner image (it bundles a shell) so no new image is
// pulled — the command only needs `sh`, `rm`, `find`, `base64`, `head`.
const ONESHOT_POLL_MS = 500;
const ONESHOT_DEADLINE_SECONDS = 120;
// Bound a host-read: never stream an unbounded file over `pods/log` (the
// apiserver buffers it). A larger file is served as its first
// READ_MAX_FILE_BYTES bytes — a PREFIX, which is what
// `@ax/user-files-read` (the host-mounted realization, and the subprocess
// provider) also does. The two realizations of one hook returning different
// amounts of the same file would be a browser nobody can reason about, so the
// number is duplicated here deliberately and pinned by a test.
const READ_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
// Same listing cap, same reason. Pinned against @ax/user-files-read by a test.
const READ_MAX_DIR_ENTRIES = 5000;
// A single safe path segment — the per-tenant subtree key. Mirrors the
// resolver's agentId gate (its OWN copy per I2). No `/`, `.`, `..`, whitespace.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** The session-owner shape both ops key the per-agent mount off. */
type Owner = ResolveMountsInput['owner'];

/**
 * Resolve the agent's durable user-files mount via `sandbox:resolve-mounts` and
 * narrow it to the `nfs` member this provider realizes. Returns `undefined`
 * when there's nothing to act on (no resolver, anonymous owner, no
 * `role:'user-files'` mount). Throws for an unrealizable kind (design §10).
 */
async function resolveNfsUserFilesMount(
  ctx: AgentContext,
  bus: HookBus,
  owner: Owner,
  readOnly: boolean,
): Promise<NfsMountSpec | undefined> {
  if (!bus.hasService(RESOLVE_HOOK)) return undefined;
  const { mounts } = await bus.call<ResolveMountsInput, ResolveMountsOutput>(
    RESOLVE_HOOK,
    ctx,
    { owner, readOnly },
  );
  for (const mount of mounts) {
    if (mount.role !== 'user-files') continue;
    switch (mount.kind) {
      case 'nfs':
        return mount;
      case 'localDir':
        throw unrealizable(mount.kind);
      default: {
        const _exhaustive: never = mount;
        throw unrealizable((_exhaustive as MountSpec).kind);
      }
    }
  }
  return undefined;
}

function unrealizable(kind: string): PluginError {
  return new PluginError({
    code: 'unrealizable-mount-kind',
    plugin: PLUGIN_NAME,
    message:
      `k8s sandbox cannot realize a '${kind}' user-files mount for ` +
      `host-read/cleanup (it has no host-FS share). Load ` +
      `@ax/workspace-filestore for the k8s preset instead of ` +
      `@ax/workspace-localdir.`,
  });
}

/** Validate the `subPath` is a single traversal-safe segment (defense in depth
 *  — the resolver already validated the agentId). Throws otherwise so a crafted
 *  value can never widen the deletion/read past one agent's subtree (§9). */
function assertSafeSubPath(subPath: string): void {
  if (!SAFE_SEGMENT_RE.test(subPath)) {
    throw new PluginError({
      code: 'unsafe-subpath',
      plugin: PLUGIN_NAME,
      message: `refusing to operate on unsafe user-files subPath: ${JSON.stringify(subPath)}`,
    });
  }
}

/** Locked-down security context for the READ pod (mirrors the runner's
 *  CONTAINER_SECURITY in pod-spec.ts). uid/gid 1000 matches the runner so it can
 *  read the per-agent subtree the runner created. */
const ONESHOT_CONTAINER_SECURITY = {
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
} as const;

/**
 * Security context for the RECLAIM pod (TASK-718). Root, with exactly two
 * capabilities. Read this before "hardening" it back to uid 1000.
 *
 * Why not uid 1000. The runner's root chown init container hands the per-agent
 * subtree `/export/<agentId>` to uid 1000, but the export ROOT stays root-owned
 * and is not writable by uid 1000. A uid-1000 `rm -rf` therefore removes the
 * agent's contents and is then refused the final unlink of the directory entry:
 * `rm: cannot remove '/export/<agentId>': Permission denied`, exit 1, an empty
 * directory left behind on every delete. Measured on prod (TASK-346 W8) and
 * reproduced with the prod image against a root-owned volume.
 *
 * Why these two capabilities and nothing else (same shape as the runner's
 * `buildUserFilesChownInit`: root, `drop: ALL`, add only what the one job needs;
 * the managed export is `no_root_squash`, which is what makes root effective):
 *   - DAC_OVERRIDE: write into and traverse directories owned by uid 1000,
 *     including ones the agent chmod'd (`chmod 000 dir` would otherwise defeat
 *     the reclaim for good).
 *   - FOWNER: unlink inside a sticky directory the agent planted (sticky needs
 *     owner-of-file, owner-of-dir or FOWNER, and root is neither).
 *
 * The reach did not grow in a way that matters: this pod already mounted the
 * WHOLE export read-write as uid 1000, and every tenant's tree is 1000-owned.
 * What is new is root's ability to touch root-owned entries, and the command is a
 * fixed script whose only input is one validated single-segment env var.
 */
const RECLAIM_CONTAINER_SECURITY = {
  runAsNonRoot: false,
  runAsUser: 0,
  runAsGroup: 0,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'], add: ['DAC_OVERRIDE', 'FOWNER'] },
} as const;

interface OneshotPodInput {
  podName: string;
  mount: NfsMountSpec;
  /** Mount the export read-only (host-read) or read-write (cleanup). */
  exportReadOnly: boolean;
  /** Shell command run as `sh -c <command>`. SUBPATH is passed via env. */
  command: string;
  /** Non-root and capability-free for a read; root plus two capabilities for a
   *  reclaim. Required, never defaulted, so a new caller has to choose. */
  securityContext: typeof ONESHOT_CONTAINER_SECURITY | typeof RECLAIM_CONTAINER_SECURITY;
  config: ResolvedSandboxK8sConfig;
}

/**
 * Build a one-shot pod manifest that mounts the WHOLE NFS export at
 * `/export` and runs `command` (with `SUBPATH` in the env). Locked-down +
 * `ax.io/plane: execution` so the existing NetworkPolicy fences its egress to
 * the Filestore IP only. `restartPolicy: Never` + a short `activeDeadline` so a
 * wedged op can't run forever.
 */
function buildOneshotPod(input: OneshotPodInput): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: input.podName,
      namespace: input.config.namespace,
      labels: {
        // A DISTINCT component label so the runner orphan-sweeper (which
        // label-selects `app.kubernetes.io/component=ax-next-runner`) never
        // sees, let alone deletes, a one-shot user-files pod.
        'app.kubernetes.io/component': 'ax-next-userfiles',
        // Same plane as a runner pod → the `sandbox-restrict` NetworkPolicy
        // applies: egress to ONLY the Filestore IP (NFS ports) + DNS.
        'ax.io/plane': 'execution',
      },
    },
    spec: {
      ...(input.config.runtimeClassName.length > 0
        ? { runtimeClassName: input.config.runtimeClassName }
        : {}),
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      hostNetwork: false,
      activeDeadlineSeconds: ONESHOT_DEADLINE_SECONDS,
      ...(input.config.imagePullSecrets !== undefined &&
      input.config.imagePullSecrets.length > 0
        ? { imagePullSecrets: input.config.imagePullSecrets.map((name) => ({ name })) }
        : {}),
      containers: [
        {
          name: 'userfiles',
          image: input.config.image,
          command: ['sh', '-c', input.command],
          env: [{ name: 'SUBPATH', value: input.mount.subPath }],
          terminationMessagePolicy: 'FallbackToLogsOnError',
          resources: {
            limits: { cpu: '500m', memory: '256Mi' },
            requests: { cpu: '50m', memory: '64Mi' },
          },
          securityContext: input.securityContext,
          volumeMounts: [
            {
              name: 'export',
              mountPath: EXPORT_MOUNT,
              readOnly: input.exportReadOnly,
            },
          ],
        },
      ],
      volumes: [
        {
          name: 'export',
          nfs: { server: input.mount.server, path: input.mount.exportPath },
        },
      ],
    },
  };
}

// How much of a failed pod's own output we carry into the error. It is the tail
// of what the container printed (kubelet copies it under
// `terminationMessagePolicy: FallbackToLogsOnError`), and it names files an agent
// chose the names of, so it is bounded, stripped of control characters and only
// ever LOGGED — never parsed, never interpolated into a command or a prompt.
const MAX_POD_OUTPUT_CHARS = 800;

/** Keep printable characters only (one space for every run of anything else). */
function printableOnly(raw: string): string {
  let out = '';
  let lastWasSpace = true;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const printable = code >= 0x20 && code !== 0x7f;
    if (printable && ch !== ' ') {
      out += ch;
      lastWasSpace = false;
    } else if (!lastWasSpace) {
      out += ' ';
      lastWasSpace = true;
    }
  }
  return out.trim();
}

/**
 * The last thing a FAILED one-shot container said, or `undefined`. Best effort:
 * this runs while reporting a failure, so it can never be allowed to raise a
 * second one. Read from the pod's status (no `pods/log` round trip, no extra
 * RBAC) — the message is only present because the pod spec asks for
 * `FallbackToLogsOnError`.
 */
async function readTerminationOutput(
  api: K8sCoreApi,
  podName: string,
  namespace: string,
): Promise<string | undefined> {
  try {
    const pod = (await api.readNamespacedPod({ name: podName, namespace })) as {
      status?: {
        containerStatuses?: Array<{ state?: { terminated?: { message?: unknown } } }>;
      };
    };
    const raw = pod.status?.containerStatuses?.[0]?.state?.terminated?.message;
    if (typeof raw !== 'string') return undefined;
    const cleaned = printableOnly(raw);
    if (cleaned.length === 0) return undefined;
    // Keep the TAIL: the script's own verdict is the last thing it prints.
    return cleaned.length > MAX_POD_OUTPUT_CHARS
      ? `...${cleaned.slice(-MAX_POD_OUTPUT_CHARS)}`
      : cleaned;
  } catch {
    return undefined;
  }
}

/** Create a one-shot pod, wait for it to terminate, then delete it
 *  (idempotent). The pod is short-lived; we poll its phase with the shared
 *  `watchPodExit`. A non-zero exit throws, carrying the pod's own output.
 *
 *  `requireExitCode`: for an operation whose SUCCESS must be positively known
 *  (a delete), a pod that vanished or reported no exit code is a failure, not a
 *  pass. A read leaves it off and lets its own output parser judge. */
async function runOneshotPod(
  api: K8sCoreApi,
  pod: Record<string, unknown>,
  podName: string,
  namespace: string,
  log: Logger,
  opts: { requireExitCode?: boolean } = {},
): Promise<void> {
  await api.createNamespacedPod({ namespace, body: pod });
  try {
    const exit = await watchPodExit({
      api,
      podName,
      namespace,
      pollIntervalMs: ONESHOT_POLL_MS,
      podLog: log,
    });
    if (exit.code === null && opts.requireExitCode === true) {
      throw new PluginError({
        code: 'userfiles-oneshot-unknown-exit',
        plugin: PLUGIN_NAME,
        message: `user-files one-shot pod ${podName} ended without an exit code (reason=${exit.reason}); cannot tell whether it finished`,
      });
    }
    if (exit.code !== null && exit.code !== 0) {
      const output = await readTerminationOutput(api, podName, namespace);
      throw new PluginError({
        code: 'userfiles-oneshot-failed',
        plugin: PLUGIN_NAME,
        message:
          `user-files one-shot pod ${podName} exited code=${exit.code} reason=${exit.reason}` +
          (output !== undefined ? ` output=${JSON.stringify(output)}` : ''),
      });
    }
  } finally {
    await killPod({ api, podName, namespace, podLog: log }).catch(() => undefined);
  }
}

/**
 * The reclaim script — exported so a shell test can run the SHIPPED text.
 *
 * Runs as `sh -c` inside the reclaim pod; `SUBPATH` arrives in the environment
 * (never spliced into a word) and the host has already validated it as one safe
 * segment (`assertSafeSubPath`). Everything below is a second lock on that door
 * and a way to make a failure say what failed:
 *
 *   - `: "${SUBPATH:?}"` — refuses an empty or unset value. `rm -rf -- "/export/"`
 *     would empty the whole export, every tenant's tree.
 *   - `rm -rf -- "/export/$SUBPATH"` — `--` stops option parsing; `-f` makes a
 *     subtree that was never written a no-op success; `rm` never follows a
 *     symlink the agent planted, it unlinks the link.
 *   - Three attempts, two seconds apart. A warm runner can still be writing into
 *     its mount for a moment after the delete, and `rm -rf` then loses the race
 *     with "Directory not empty". Bounded, well inside the pod's deadline.
 *   - The post-condition. TASK-718: the reclaim used to "succeed" or fail with
 *     the agent's directory still there; here the directory being GONE is the
 *     thing checked, and the message names it. Its stderr is what kubelet copies
 *     into the pod's termination message, which is what the operator's log line
 *     quotes.
 */
export function buildCleanupCommand(): string {
  const target = `${EXPORT_MOUNT}/$SUBPATH`;
  return [
    'set -eu',
    ': "${SUBPATH:?SUBPATH is empty}"',
    'attempt=1',
    `until rm -rf -- "${target}"; do`,
    '  if [ "$attempt" -ge 3 ]; then',
    `    echo "reclaim: could not remove ${target} after $attempt attempts" >&2`,
    '    exit 1',
    '  fi',
    '  attempt=$((attempt + 1))',
    '  sleep 2',
    'done',
    `if [ -e "${target}" ] || [ -L "${target}" ]; then`,
    `  echo "reclaim: ${target} still exists" >&2`,
    '  exit 1',
    'fi',
  ].join('\n');
}

/**
 * Run the reclaim pod: mount the export read-WRITE and `rm -rf` ONLY
 * `/export/$SUBPATH`. The CALLER must already have confined `mount.subPath`
 * (`assertSafeSubPath` for an agent, `assertSharedFolderSubPath` for a shared
 * folder). SUBPATH rides in an env var (never spliced into the shell word), so
 * neither traversal nor injection is reachable. Throws on any failure.
 */
async function runReclaimPod(
  api: K8sCoreApi,
  config: ResolvedSandboxK8sConfig,
  mount: NfsMountSpec,
  podName: string,
  log: Logger,
): Promise<void> {
  const pod = buildOneshotPod({
    podName,
    mount,
    exportReadOnly: false,
    command: buildCleanupCommand(),
    securityContext: RECLAIM_CONTAINER_SECURITY,
    config,
  });
  await runOneshotPod(api, pod, podName, config.namespace, log.child({ podName }), {
    requireExitCode: true,
  });
}

/**
 * Realize the `agents:deleted` cleanup for the k8s provider: run a one-shot pod
 * that mounts the export read-WRITE and `rm -rf`s ONLY `/export/$SUBPATH`.
 * Best-effort: a resolve failure / unrealizable kind / pod failure is logged,
 * never thrown (the delete already committed). Deletes EXACTLY this agent's
 * subtree (validated single segment), never a sibling's (§9).
 */
export async function cleanupUserFiles(
  ctx: AgentContext,
  bus: HookBus,
  api: K8sCoreApi,
  config: ResolvedSandboxK8sConfig,
  owner: Owner,
  log: Logger,
): Promise<void> {
  let mount: NfsMountSpec | undefined;
  try {
    mount = await resolveNfsUserFilesMount(ctx, bus, owner, /* readOnly */ false);
  } catch (err) {
    log.warn('user_files_cleanup_resolve_failed', {
      agentId: owner.agentId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (mount === undefined) return; // nothing durable to reclaim
  let podName: string | undefined;
  try {
    assertSafeSubPath(mount.subPath);
    podName = `ax-userfiles-rm-${randomUUID().slice(0, 8)}`;
    await runReclaimPod(api, config, mount, podName, log);
    log.info('user_files_cleanup_done', { agentId: owner.agentId });
  } catch (err) {
    // ERROR, not warn (TASK-718). By the time this runs the agent row is gone
    // and the user was told "deleted", so a failure here means their files are
    // still on disk with nobody's name on them. Everything an operator needs to
    // act is on this one line: which agent, which pod, which directory, and what
    // the pod itself said (the `err` carries its output).
    log.error('user_files_cleanup_failed', {
      agentId: owner.agentId,
      subPath: mount.subPath,
      exportPath: mount.exportPath,
      podName,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// sandbox:delete-shared-folder (W2 shared folders, design §3.7) — remove one
// shared folder's bytes with the same reclaim pod the agent cleanup uses.
//
// The location comes from the mount resolver's `sandbox:locate-shared-folder`
// (it owns the backing-store config), and is then confined HERE to EXACTLY
// `.shared/<folderId>` for the id we were asked about — a resolver that
// answered with any other subtree (another folder, an agent's `/files`, the
// `.shared` parent) is refused before a pod exists. This is a separate check
// from `assertSafeSubPath`, which stays single-segment for agents.
//
// Unlike `cleanupUserFiles` this THROWS on every failure: the caller
// (`@ax/shared-folders`) keeps its tombstone and retries, so a delete that did
// not happen must never look like one that did.
// ---------------------------------------------------------------------------

const LOCATE_SHARED_FOLDER_HOOK = 'sandbox:locate-shared-folder';
// Local copy of @ax/sandbox-mount-protocol's SHARED_FOLDERS_DIR (type-only
// import rule, I2).
const SHARED_FOLDERS_DIR = '.shared';

/** Exactly `.shared/<folderId>` — two clean segments, the second the id. */
function assertSharedFolderSubPath(subPath: string, folderId: string): void {
  const segments = subPath.split('/');
  if (
    !isValidSharedFolderId(folderId) ||
    subPath !== `${SHARED_FOLDERS_DIR}/${folderId}` ||
    segments.length !== 2 ||
    segments[0] !== SHARED_FOLDERS_DIR ||
    !SAFE_SEGMENT_RE.test(segments[1]!)
  ) {
    throw new PluginError({
      code: 'unsafe-subpath',
      plugin: PLUGIN_NAME,
      message: `refusing to delete a shared folder outside ${SHARED_FOLDERS_DIR}/<folderId>: ${JSON.stringify(subPath)}`,
    });
  }
}

export async function deleteSharedFolder(
  ctx: AgentContext,
  bus: HookBus,
  api: K8sCoreApi,
  config: ResolvedSandboxK8sConfig,
  input: DeleteSharedFolderInput,
  log: Logger,
): Promise<DeleteSharedFolderOutput> {
  const folderId = (input as { folderId?: unknown } | null)?.folderId;
  if (!isValidSharedFolderId(folderId)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'sandbox:delete-shared-folder',
      message: 'invalid shared folder id',
    });
  }
  if (!bus.hasService(LOCATE_SHARED_FOLDER_HOOK)) {
    throw new PluginError({
      code: 'no-mount-resolver',
      plugin: PLUGIN_NAME,
      hookName: 'sandbox:delete-shared-folder',
      message: 'no mount resolver is loaded, so the shared folder cannot be located for deletion',
    });
  }
  const located = await bus.call<LocateSharedFolderInput, LocateSharedFolderOutput>(
    LOCATE_SHARED_FOLDER_HOOK,
    ctx,
    { folderId },
  );
  const mount = (located as { mount?: unknown } | null)?.mount as MountSpec | undefined;
  if (mount === undefined || mount === null || typeof mount !== 'object') {
    throw new PluginError({
      code: 'invalid-return',
      plugin: PLUGIN_NAME,
      hookName: 'sandbox:delete-shared-folder',
      message: 'sandbox:locate-shared-folder returned no mount',
    });
  }
  if (mount.kind !== 'nfs') throw unrealizable(String(mount.kind));
  if (typeof mount.subPath !== 'string') {
    throw new PluginError({
      code: 'unsafe-subpath',
      plugin: PLUGIN_NAME,
      message: 'refusing to delete a shared folder with no subPath',
    });
  }
  assertSharedFolderSubPath(mount.subPath, folderId);
  const podName = `ax-shared-rm-${randomUUID().slice(0, 8)}`;
  try {
    await runReclaimPod(api, config, mount, podName, log);
  } catch (err) {
    log.error('shared_folder_delete_failed', {
      folderId,
      subPath: mount.subPath,
      exportPath: mount.exportPath,
      podName,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  log.info('shared_folder_deleted', { folderId });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// sandbox:read-shared-folder (W3b) — the host's read-only view of ONE shared
// folder, for @ax/projects (which checks the person can use the project
// first; this hook does no grant check, like sandbox:locate-shared-folder).
//
// Only the host-mounted realization exists: `<userFilesHostReadRoot>` is the
// user-files export mounted read-only into the host pod, and the folder is at
// `.shared/<folderId>` on it (the same layout constant the delete path above
// confines to — no need to ask the resolver). No pod-per-call fallback: every
// deployment that runs projects sets the root, and one without it answers
// `unavailable` (W3b plan, YAGNI).
//
// The read is `readConfinedByWalk`: the root is trusted configuration, and
// `.shared`, `<folderId>` and every caller component are opened one at a time
// relative to the previous descriptor with O_NOFOLLOW. A folder is written by
// agents, so a symlink at any depth, swapped in at any moment, is `absent` —
// never followed. Intermediates are opened O_PATH, which is what lets the host
// (uid 1000) pass through a root-owned `.shared` that the storage node keeps
// at 0711 (searchable, not listable).
// ---------------------------------------------------------------------------

const READ_SHARED_FOLDER_HOOK = 'sandbox:read-shared-folder';
const SHARED_TRAVERSE_FIX =
  `the host cannot traverse ${SHARED_FOLDERS_DIR} on the user-files export. The ` +
  `storage node sets ${SHARED_FOLDERS_DIR} to 0711 (on startup and on every ` +
  `prepare that mounts a shared folder); without the shared pool ` +
  `(sharedPool.enabled: false) nothing does, and project files stay unavailable.`;
const SHARED_READ_MAX_ENTRIES = READ_MAX_DIR_ENTRIES;

function invalidSharedRead(message: string, cause?: unknown): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    hookName: READ_SHARED_FOLDER_HOOK,
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Realize `sandbox:read-shared-folder` for the k8s provider. `walk` is
 * injectable for tests only (the real one needs Linux /proc).
 */
export async function readSharedFolder(
  config: ResolvedSandboxK8sConfig,
  input: ReadSharedFolderInput,
  log: Logger,
  walk: typeof readConfinedByWalk = readConfinedByWalk,
): Promise<ReadSharedFolderOutput> {
  // Decided before the path is consulted, so it is the same answer for every
  // folder and path and discloses nothing.
  if (config.userFilesHostReadRoot.length === 0) return { kind: 'unavailable' };
  const folderId: unknown = (input as { folderId?: unknown } | null)?.folderId;
  if (!isValidSharedFolderId(folderId)) throw invalidSharedRead('invalid shared folder id');
  let rel: string[];
  try {
    rel = splitRelPath(input.relPath ?? '');
  } catch (err) {
    if (err instanceof WalkPathError) throw invalidSharedRead(`invalid relPath: ${err.message}`, err);
    throw err;
  }
  const parts = [SHARED_FOLDERS_DIR, folderId, ...rel];
  try {
    const out = await walk(config.userFilesHostReadRoot, parts, {
      limitBytes: input.limitBytes,
      maxEntries: input.maxEntries ?? SHARED_READ_MAX_ENTRIES,
    });
    if (out.kind === 'absent') {
      // The reason is for us; the caller gets one undifferentiated absence
      // (a link vs. missing split would be an oracle over an agent's tree).
      log.debug('shared_folder_read_absent', { folderId, reason: out.reason });
      return { kind: 'absent' };
    }
    return out;
  } catch (err) {
    if (err instanceof WalkPathError) throw invalidSharedRead(`invalid path: ${err.message}`, err);
    if (err instanceof WalkReadError) {
      if (err.code === 'unsupported-platform') return { kind: 'unavailable' };
      // depth 0 opens `.shared` (search on the export root), depth 1 opens the
      // folder (search on `.shared`). EACCES there is the deployment, not the
      // folder: the same answer for every folder, so it is safe to say.
      if (err.code === 'EACCES' && (err.depth === 0 || err.depth === 1)) {
        log.warn('shared_folder_read_unavailable', {
          folderId,
          depth: err.depth,
          fix: SHARED_TRAVERSE_FIX,
        });
        return { kind: 'unavailable' };
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sandbox:scan-shared-folder (W3d) — a recursive, confined stat of ONE shared
// folder, for @ax/projects' file history (no grant check, like the read).
//
// Same realization as the read above: `scanConfinedByWalk` over the read-only
// `<userFilesHostReadRoot>`, from `[.shared, <folderId>]`, every directory
// opened relative to its parent's descriptor with O_NOFOLLOW. Files are only
// lstat'ed, never opened. Same `unavailable` rules (no root, EACCES while
// traversing `.shared`, no /proc).
//
// A folder that does not exist yet answers `done` with no files: a W3a
// project's folder is only created by its first write, and "nothing there"
// is the truth. A folder whose NAME is a link or a file is not: that is not a
// state the storage node ever leaves, so it throws rather than tell history
// that every file was deleted.
// ---------------------------------------------------------------------------

const SCAN_SHARED_FOLDER_HOOK = 'sandbox:scan-shared-folder';

function scanError(code: string, message: string, cause?: unknown): PluginError {
  return new PluginError({
    code,
    plugin: PLUGIN_NAME,
    hookName: SCAN_SHARED_FOLDER_HOOK,
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Realize `sandbox:scan-shared-folder` for the k8s provider. `walk` is
 * injectable for tests only (the real one needs Linux /proc).
 */
export async function scanSharedFolder(
  config: ResolvedSandboxK8sConfig,
  input: ScanSharedFolderInput,
  log: Logger,
  walk: typeof scanConfinedByWalk = scanConfinedByWalk,
): Promise<ScanSharedFolderOutput> {
  if (config.userFilesHostReadRoot.length === 0) return { kind: 'unavailable' };
  const folderId: unknown = (input as { folderId?: unknown } | null)?.folderId;
  if (!isValidSharedFolderId(folderId)) throw scanError('invalid-payload', 'invalid shared folder id');
  const maxEntries: unknown = input.maxEntries ?? MAX_WALK_ENTRIES;
  if (
    typeof maxEntries !== 'number' ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_WALK_ENTRIES
  ) {
    throw scanError('invalid-payload', `maxEntries must be an integer from 1 to ${MAX_WALK_ENTRIES}`);
  }
  try {
    const out = await walk(config.userFilesHostReadRoot, [SHARED_FOLDERS_DIR, folderId], {
      maxEntries,
    });
    if (out.kind === 'absent') {
      if (out.reason === 'missing') return { kind: 'done', files: [], truncated: false };
      log.warn('shared_folder_scan_refused', { folderId, reason: out.reason });
      throw scanError(
        'unsafe-shared-folder-location',
        `shared folder '${folderId}' is not a directory on the user-files export`,
      );
    }
    if (out.truncated) {
      log.info('shared_folder_scan_truncated', { folderId, files: out.files.length });
    }
    return out;
  } catch (err) {
    if (err instanceof WalkPathError) throw scanError('invalid-payload', `invalid path: ${err.message}`, err);
    if (err instanceof WalkReadError) {
      if (err.code === 'unsupported-platform') return { kind: 'unavailable' };
      // EACCES opening `.shared` or the folder: the deployment, not the folder.
      if (err.code === 'EACCES' && (err.depth === 0 || err.depth === 1)) {
        log.warn('shared_folder_scan_unavailable', {
          folderId,
          depth: err.depth,
          fix: SHARED_TRAVERSE_FIX,
        });
        return { kind: 'unavailable' };
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// host-read — read an agent's subtree READ-ONLY via a one-shot pod.
//
// The pod mounts the export read-only and emits a single bounded line to
// stdout that the host parses from `pods/log`:
//
//   DIR <base64-json-of-entries>            (relPath is a directory)
//   FILE <base64-of-first-(READ_MAX_FILE_BYTES+1)-bytes>  (regular file)
//   ABSENT                                  (path missing / not file-or-dir)
//
// The FILE line carries ONE byte more than the cap on purpose: its presence is
// what tells `parseReadOutput` that the file is longer than we will serve, and
// the byte is dropped there. `truncated` on the answer is that bit.
//
// base64 keeps binary file bytes intact over the text log channel; the cap
// bounds what the apiserver must buffer.
//
// SECURITY (cross-tenant isolation): the script REALPATH-CONFINES the target to
// the agent's OWN subtree (`$EXPORT/$SUBPATH`) before reading — `realpath`
// resolves EVERY intermediate component, so an agent-planted symlink anywhere on
// the path (e.g. `subdir -> /export/<other-agentId>` or `-> /`) cannot point the
// read at a sibling agent's files or the host FS. Confining to the per-agent
// subPath (not just `$EXPORT`) is load-bearing — a symlink could otherwise still
// cross into a sibling's subtree on the SAME export. The directory listing skips
// any symlink child (`[ -L ]`) so a listed name can never disclose a foreign
// path's contents on a follow-up read.
// ---------------------------------------------------------------------------

/** Build the read script. Exported for a test that runs it through a real
 *  POSIX shell — the quoting and the listing format are the parts of this file
 *  a type checker cannot see. `SUBPATH` (the agent's own subtree) and `RELPATH`
 *  (a host-validated relative path under it) are passed via env (never spliced
 *  into a shell word). The script confines the realpath'd target under
 *  `$EXPORT/$SUBPATH` before reading/listing. */
export function buildReadCommand(): string {
  // POSIX sh. `base` is this agent's subtree root; `target` the requested path.
  // realpath resolves all symlinks; we then require the result to be `base` or
  // strictly under `base/`. A missing path / dangling link → realpath fails →
  // ABSENT. The listing walk skips symlink children entirely.
  return [
    'set -eu',
    `base="${EXPORT_MOUNT}/$SUBPATH"`,
    'if [ "$RELPATH" = "." ]; then target="$base"; else target="$base/$RELPATH"; fi',
    // THE AGENT'S OWN SUBTREE ROOT IS RESOLVED FIRST, and a failure here is not
    // allowed to become an absence by default (TASK-403). It used to: `realpath
    // ... || true` swallows the errno, so a subtree the export would not answer
    // for — a stale NFS handle, a permission change — printed ABSENT and exited
    // 0, and the Files tab drew "this agent has written nothing" over it. The
    // host-mounted realization of this same hook throws in that case, and two
    // realizations of one hook disagreeing about whether a read failed is a
    // browser nobody can reason about.
    //
    // A `stat`-free POSIX shell cannot read an errno, so the discrimination
    // comes from the EXPORT's directory listing instead: a glob is a `readdir`
    // of the export and never stats our subtree, so the NAME is still there
    // when the subtree itself has gone stale, and is absent when the agent
    // simply never ran. Only our own `$SUBPATH` is ever compared or emitted —
    // no sibling's name leaves this script.
    'if ! realbase=$(realpath -- "$base" 2>/dev/null); then',
    `  if ! realpath -- "${EXPORT_MOUNT}" >/dev/null 2>&1; then echo FAILED; exit 1; fi`,
    '  found=0',
    `  for e in "${EXPORT_MOUNT}"/*; do`,
    '    if [ "$(basename -- "$e")" = "$SUBPATH" ]; then found=1; fi',
    '  done',
    '  if [ "$found" = 1 ]; then echo FAILED; exit 1; fi',
    '  echo ABSENT',
    '  exit 0',
    'fi',
    // Resolve ALL symlinks; bail to ABSENT if it can't resolve (missing/dangling).
    // This one stays an absence whatever the errno: it is the PATH-dependent
    // half, and a distinguishing answer there would be an oracle.
    'real=$(realpath -- "$target" 2>/dev/null || true)',
    'if [ -z "$real" ]; then echo ABSENT; exit 0; fi',
    // Confine: the resolved target MUST be the agent subtree root or strictly
    // under it. A symlink that escaped (to a sibling subPath or absolute path)
    // fails this case and yields ABSENT — never discloses foreign contents.
    'case "$real" in',
    '  "$realbase") : ;;',
    '  "$realbase"/*) : ;;',
    '  *) echo ABSENT; exit 0 ;;',
    'esac',
    'target="$real"',
    'if [ -d "$target" ]; then',
    // List immediate children with a type marker. Skip ANY symlink child
    // (`[ -L ]`) so a foreign-pointing link is never even named.
    //
    // EACH NAME IS BASE64'd INDIVIDUALLY, and that is the security-relevant
    // part of this format rather than a convenience. A filename is written by
    // the untrusted agent, and POSIX lets it contain a newline or a tab. An
    // earlier shape accumulated `name<TAB>kind` rows into one variable and
    // emitted them with `printf %b` — which both interprets backslash escapes
    // in the DATA and passes real newlines straight through, so a file named
    // `x<TAB>dir<NEWLINE>y` (or literally `x\tdir\ny`) forged extra rows in
    // the listing the host parsed back. Encoding the name removes every
    // delimiter from the payload, so no filename can invent an entry.
    //
    // A forged row was never a disclosure — a read through it still goes
    // through the realpath confinement and answers ABSENT — but a file browser
    // that can be made to show entries the directory does not contain is
    // lying, and it is the agent choosing the lie.
    '  n=0',
    '  {',
    '  for entry in "$target"/* "$target"/.*; do',
    // Same listing cap as @ax/user-files-read, for the same reason: one hook
    // must not return a different number of children depending on which
    // realization is loaded.
    `    [ "$n" -lt ${READ_MAX_DIR_ENTRIES} ] || break`,
    '    [ -e "$entry" ] || continue',
    '    base2=$(basename -- "$entry")',
    '    [ "$base2" = "." ] && continue',
    '    [ "$base2" = ".." ] && continue',
    '    if [ -L "$entry" ]; then continue; fi',
    '    if [ -d "$entry" ]; then kind=dir; elif [ -f "$entry" ]; then kind=file; else continue; fi',
    // `printf %s` (never %b) on the name, piped through base64 — so a
    // backslash in a filename stays a backslash and a newline cannot end a row.
    // The format string carries BACKSLASH escapes (`\\t`, `\\n`) for printf to
    // interpret, rather than literal control characters embedded in this
    // source — same output, but a tab you can see when you read the line.
    '    printf "%s\\t%s\\n" "$(printf "%s" "$base2" | base64 | tr -d "\\n")" "$kind"',
    '    n=$((n+1))',
    '  done',
    '  } | base64 | tr -d "\\n" | (printf "DIR "; cat); echo',
    '  exit 0',
    'fi',
    'if [ -f "$target" ]; then',
    // Redirect rather than pass the filename: no `--`/BusyBox-`head` argument
    // portability question, and no filename ever reaching argv.
    // ONE BYTE OVER THE CAP, deliberately — `parseReadOutput` uses the extra
    // byte to tell a file of exactly the cap from a file that is longer, then
    // drops it. A prefix that cannot say it is a prefix is a corrupt file that
    // looks like a whole one to whoever is handed it.
    '  printf "FILE "',
    '  exec 3>&1',
    '  file_status=$(',
    '    {',
    `      { head -c ${READ_MAX_FILE_BYTES + 1} < "$target" && printf h >&4; } |`,
    '      { base64 && printf b >&4; } |',
    '      tr -d "\\n" >&3',
    '    } 4>&1',
    '  ) || exit 1',
    '  exec 3>&-',
    '  case "$file_status" in hb|bh) : ;; *) exit 1 ;; esac',
    '  echo',
    '  exit 0',
    'fi',
    'echo ABSENT',
  ].join('\n');
}

/** Re-validate a caller-supplied relPath host-side: relative, no `..`, no
 *  absolute. Returns a normalized relPath (default `.`). Throws on escape. */
function safeRelPath(relPath: string | undefined): string {
  const rel = relPath === undefined || relPath === '' ? '.' : relPath;
  if (rel.startsWith('/')) {
    throw new PluginError({
      code: 'unsafe-relpath',
      plugin: PLUGIN_NAME,
      message: `user-files relPath must be relative: ${rel}`,
    });
  }
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new PluginError({
      code: 'unsafe-relpath',
      plugin: PLUGIN_NAME,
      message: `user-files relPath must not contain '..': ${rel}`,
    });
  }
  return rel;
}

/**
 * Realize `sandbox:read-user-files` for the k8s provider. Two realizations
 * behind one signature, chosen by `userFilesHostReadRoot`:
 *
 *   - SET   → a direct, confined filesystem read under `<root>/<subPath>`,
 *             because the chart mounted the export read-only into the host pod.
 *             No pod, no apiserver round-trip.
 *   - UNSET → a one-shot pod that mounts the export READ-ONLY and emits one
 *             bounded line for `relPath`, read back from `pods/log`.
 *
 * Returns `{ kind: 'unavailable' }` when this deployment resolves no durable
 * tier for the owner at all, `{ kind: 'absent' }` when it has one and the path
 * is missing/non-file-or-dir, and THROWS when the storage is there and would
 * not answer (the reader pod died, its output was unreadable). Those three
 * used to be one `absent` (TASK-403), so a Files tab over a broken export said
 * "nothing here" — a claim about the agent, made out of an infrastructure
 * failure. NEVER grants write, on either path: the volumeMount is
 * `readOnly: true`, the resolver realization is read-only, and
 * `@ax/user-files-read` has no write entry point.
 */
export async function readUserFiles(
  ctx: AgentContext,
  bus: HookBus,
  api: K8sCoreApi,
  config: ResolvedSandboxK8sConfig,
  log: Logger,
  input: ReadUserFilesInput,
): Promise<ReadUserFilesOutput> {
  const mount = await resolveNfsUserFilesMount(ctx, bus, input.owner, /* readOnly */ true);
  if (mount === undefined) return { kind: 'unavailable' };
  assertSafeSubPath(mount.subPath);
  const rel = safeRelPath(input.relPath);

  // The host-mounted realization, when the chart mounted the export read-only
  // into the host pod. Same subtree, same confinement, no pod: the export's
  // `<subPath>` directory is at `<hostReadRoot>/<subPath>` in this process's
  // own filesystem, which is structurally the same case @ax/workspace-localdir
  // already serves in dev.
  //
  // `subPath` has been validated as ONE safe segment above, so the join cannot
  // widen past this agent's subtree; the reader then realpath-confines
  // everything under it, which is what stops an agent-planted symlink from
  // crossing into a sibling's subtree on the same export.
  if (config.userFilesHostReadRoot.length > 0) {
    return readConfinedUserFiles(
      path.join(config.userFilesHostReadRoot, mount.subPath),
      rel,
    );
  }

  const podName = `ax-userfiles-read-${randomUUID().slice(0, 8)}`;
  const readLog = log.child({ podName });
  const pod = buildOneshotPod({
    podName,
    mount,
    exportReadOnly: true,
    command: buildReadCommand(),
    securityContext: ONESHOT_CONTAINER_SECURITY,
    config,
  });
  // The script confines the realpath'd target under `$EXPORT/$SUBPATH` (the
  // agent's OWN subtree), so SUBPATH and the relative RELPATH are passed
  // SEPARATELY — both via env, never spliced into a shell word. RELPATH is the
  // host-validated path relative to the agent subtree (default `.` = the root).
  ((pod.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> })
    .containers[0]!.env) = [
    { name: 'SUBPATH', value: mount.subPath },
    { name: 'RELPATH', value: rel },
  ];

  await api.createNamespacedPod({ namespace: config.namespace, body: pod });
  try {
    // THE EXIT CODE IS CHECKED, and it was not before. A failed FILE read
    // can leave a partial, parseable log; upstream completion is checked
    // explicitly because `set -eu` alone does not cover pipelines. A
    // dead reader answering "this agent has no files" is the TASK-403 lie with
    // a pod in front of it.
    const exit = await watchPodExit({
      api,
      podName,
      namespace: config.namespace,
      pollIntervalMs: ONESHOT_POLL_MS,
      podLog: readLog,
    });
    if (exit.code !== null && exit.code !== 0) {
      throw new PluginError({
        code: 'userfiles-read-failed',
        plugin: PLUGIN_NAME,
        message: `user-files read pod ${podName} exited code=${exit.code} reason=${exit.reason}`,
      });
    }
    const raw = await api.readNamespacedPodLog({
      name: podName,
      namespace: config.namespace,
      container: 'userfiles',
    });
    return parseReadOutput(raw);
  } finally {
    await killPod({ api, podName, namespace: config.namespace, podLog: readLog }).catch(
      () => undefined,
    );
  }
}

/**
 * Parse the one-shot read pod's single output line into a ReadUserFilesOutput.
 *
 * `ABSENT` is the script's own word for "not there", and it is the ONLY thing
 * that becomes an absence here. Silence is not: an empty log means the reader
 * produced nothing, which is a failure of ours, and it used to be reported as
 * the agent having no files (TASK-403). Same for a line in a shape this
 * function does not recognise — that is a reader and a parser that disagree,
 * and guessing "absent" is guessing in the one direction the reader cannot
 * tell is a guess.
 */
export function parseReadOutput(raw: string): ReadUserFilesOutput {
  // The script emits exactly one meaningful line; take the last non-empty one
  // (defensive against any leading container noise).
  const line =
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .pop() ?? '';
  if (line === 'ABSENT') {
    return { kind: 'absent' };
  }
  if (line === 'FAILED') {
    // The script could not resolve the agent's own subtree root even though
    // the export still lists it. It also exits non-zero, so this is the second
    // of two guards; both exist because the day one of them is bypassed is the
    // day the answer silently becomes "this agent wrote nothing".
    throw new PluginError({
      code: 'userfiles-read-failed',
      plugin: PLUGIN_NAME,
      message: "user-files reader could not resolve the agent's own subtree",
    });
  }
  if (line === '') {
    throw new PluginError({
      code: 'userfiles-read-no-output',
      plugin: PLUGIN_NAME,
      message: 'user-files read pod produced no output',
    });
  }
  // A bare `DIR` / `FILE` with nothing after it is an EMPTY directory or an
  // EMPTY file: base64 of no bytes is the empty string, the trailing space is
  // trimmed off with the rest of the line, and the marker arrives alone.
  //
  // These two lines are a bug fix, not defensiveness. Without them an empty
  // folder and a zero-byte file both fell through to `absent` — so the browser
  // said "not found" about a directory the agent had definitely created, which
  // is precisely the H7 lie this surface exists to avoid. The TypeScript
  // realization has always answered `{ kind: 'dir', entries: [] }` here, so
  // this is also the two realizations agreeing. Caught by running the script
  // through a real shell (`read-command-shell.test.ts`) — no amount of
  // grepping the generated text would have shown it.
  if (line === 'DIR') return { kind: 'dir', entries: [] };
  if (line === 'FILE') return { kind: 'file', contents: new Uint8Array(), truncated: false };
  if (line.startsWith('DIR ')) {
    const b64 = line.slice('DIR '.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    const entries: UserFileDirEntry[] = [];
    for (const row of decoded.split('\n')) {
      if (row.length === 0) continue;
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      // The NAME is base64 — see the note on `buildReadCommand`. A filename is
      // agent-authored and may contain a tab or a newline, so it is encoded
      // rather than delimited; decoding here is what keeps a crafted name from
      // forging extra rows in this loop.
      const name = Buffer.from(row.slice(0, tab), 'base64').toString('utf-8');
      const kind = row.slice(tab + 1);
      if ((kind === 'dir' || kind === 'file') && name.length > 0) {
        entries.push({ name, kind });
      }
    }
    return { kind: 'dir', entries };
  }
  if (line.startsWith('FILE ')) {
    const b64 = line.slice('FILE '.length);
    const bytes = Buffer.from(b64, 'base64');
    // The script reads `READ_MAX_FILE_BYTES + 1`; anything past the cap proves
    // the file is longer than what we can serve. The probe byte is dropped
    // here, so a caller still never receives more than the cap.
    const truncated = bytes.length > READ_MAX_FILE_BYTES;
    return {
      kind: 'file',
      contents: new Uint8Array(
        truncated ? bytes.subarray(0, READ_MAX_FILE_BYTES) : bytes,
      ),
      truncated,
    };
  }
  throw new PluginError({
    code: 'userfiles-read-unparseable',
    plugin: PLUGIN_NAME,
    message: 'user-files read pod emitted output this host could not parse',
  });
}

/**
 * Build the minimal `owner` a resolver needs from an `agents:deleted` event.
 * The resolvers read ONLY `owner.agentId`; the rest of the owner triple is
 * required by the shared type but unused here. Reusing the owner-keyed resolver
 * (rather than a second cleanup hook) is the design's "owner-keyed and
 * reusable" promise (§11).
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
