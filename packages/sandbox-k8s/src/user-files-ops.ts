import { randomUUID } from 'node:crypto';
import {
  PluginError,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import type {
  MountSpec,
  NfsMountSpec,
  ReadUserFilesInput,
  ReadUserFilesOutput,
  ResolveMountsInput,
  ResolveMountsOutput,
  UserFileDirEntry,
} from '@ax/sandbox-mount-protocol';
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
//                 (for the web UI) via a short-lived mount-and-read pod.
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
// apiserver buffers it). A larger file is reported but its bytes are omitted.
const READ_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
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

/** Locked-down security context shared by every one-shot pod (mirrors the
 *  runner's CONTAINER_SECURITY in pod-spec.ts). uid/gid 1000 matches the
 *  runner so it can write/read the per-agent subtree the runner created. */
const ONESHOT_CONTAINER_SECURITY = {
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
} as const;

interface OneshotPodInput {
  podName: string;
  mount: NfsMountSpec;
  /** Mount the export read-only (host-read) or read-write (cleanup). */
  exportReadOnly: boolean;
  /** Shell command run as `sh -c <command>`. SUBPATH is passed via env. */
  command: string;
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
          securityContext: ONESHOT_CONTAINER_SECURITY,
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

/** Create a one-shot pod, wait for it to terminate, return its exit info, then
 *  delete it (idempotent). The pod is short-lived; we poll its phase with the
 *  shared `watchPodExit`. On a non-zero exit we throw. */
async function runOneshotPod(
  api: K8sCoreApi,
  pod: Record<string, unknown>,
  podName: string,
  namespace: string,
  log: Logger,
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
    if (exit.code !== null && exit.code !== 0) {
      throw new PluginError({
        code: 'userfiles-oneshot-failed',
        plugin: PLUGIN_NAME,
        message: `user-files one-shot pod ${podName} exited code=${exit.code} reason=${exit.reason}`,
      });
    }
  } finally {
    await killPod({ api, podName, namespace, podLog: log }).catch(() => undefined);
  }
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
  try {
    assertSafeSubPath(mount.subPath);
    const podName = `ax-userfiles-rm-${randomUUID().slice(0, 8)}`;
    const cleanupLog = log.child({ podName });
    // rm -rf -- "$EXPORT/$SUBPATH". `--` stops option parsing; SUBPATH is an
    // env var (never spliced into the word) AND already validated as one safe
    // segment, so neither traversal nor injection is reachable. `-f` makes a
    // missing subtree (never written) a no-op success.
    const command = `set -eu; rm -rf -- "${EXPORT_MOUNT}/$SUBPATH"`;
    const pod = buildOneshotPod({
      podName,
      mount,
      exportReadOnly: false,
      command,
      config,
    });
    await runOneshotPod(api, pod, podName, config.namespace, cleanupLog);
    log.info('user_files_cleanup_done', { agentId: owner.agentId });
  } catch (err) {
    log.warn('user_files_cleanup_failed', {
      agentId: owner.agentId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// host-read — read an agent's subtree READ-ONLY via a one-shot pod.
//
// The pod mounts the export read-only and emits a single bounded line to
// stdout that the host parses from `pods/log`:
//
//   DIR <base64-json-of-entries>            (relPath is a directory)
//   FILE <base64-of-file-bytes>             (regular file ≤ READ_MAX_FILE_BYTES)
//   BIG                                     (regular file over the cap)
//   ABSENT                                  (path missing / not file-or-dir)
//
// base64 keeps binary file bytes intact over the text log channel; the cap
// bounds what the apiserver must buffer. A symlink at the target is treated as
// ABSENT (a read-only browser must not follow an agent-planted link).
// ---------------------------------------------------------------------------

/** Build the read script. `RELPATH` is passed via env (validated host-side as
 *  traversal-safe) so it's never spliced into a shell word. */
function buildReadCommand(): string {
  // POSIX sh. `target="$EXPORT/${RELPATH#/}"` — strip a leading slash defensively
  // (host already rejects absolute paths). Distinguish dir/file/symlink/missing.
  return [
    'set -eu',
    `target="${EXPORT_MOUNT}/$RELPATH"`,
    'if [ -L "$target" ]; then echo ABSENT; exit 0; fi',
    'if [ -d "$target" ]; then',
    // List immediate children with a type marker, JSON-encode, base64 it.
    // `find -maxdepth 1` includes the dir itself (.) — filter it out. Emit
    // name<TAB>kind lines; the host builds the JSON (keeps the pod script tiny
    // and avoids quoting hazards in-shell).
    '  out=""',
    '  for entry in "$target"/* "$target"/.*; do',
    '    [ -e "$entry" ] || continue',
    '    base=$(basename "$entry")',
    '    [ "$base" = "." ] && continue',
    '    [ "$base" = ".." ] && continue',
    '    if [ -L "$entry" ]; then continue; fi',
    '    if [ -d "$entry" ]; then out="$out$base\tdir\n";',
    '    elif [ -f "$entry" ]; then out="$out$base\tfile\n"; fi',
    '  done',
    '  printf "%b" "$out" | base64 | tr -d "\\n" | (printf "DIR "; cat); echo',
    '  exit 0',
    'fi',
    'if [ -f "$target" ]; then',
    `  size=$(wc -c < "$target")`,
    `  if [ "$size" -gt ${READ_MAX_FILE_BYTES} ]; then echo BIG; exit 0; fi`,
    '  printf "FILE "; base64 < "$target" | tr -d "\\n"; echo',
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
 * Realize `sandbox:read-user-files` for the k8s provider: run a one-shot pod
 * that mounts the export READ-ONLY and emits one bounded line for `relPath`,
 * read back from `pods/log`. Returns `{ kind: 'absent' }` when there's no mount
 * or the path is missing/over-cap/non-file-or-dir. NEVER grants write (the
 * volumeMount is `readOnly: true` AND the resolver realization is read-only).
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
  if (mount === undefined) return { kind: 'absent' };
  assertSafeSubPath(mount.subPath);
  const rel = safeRelPath(input.relPath);

  const podName = `ax-userfiles-read-${randomUUID().slice(0, 8)}`;
  const readLog = log.child({ podName });
  // The per-agent subtree IS the read root: $EXPORT/$SUBPATH, then $RELPATH
  // under it. We bake SUBPATH into RELPATH so the script's single $EXPORT/$RELPATH
  // join confines to this agent's subtree.
  const scopedRel = rel === '.' ? mount.subPath : `${mount.subPath}/${rel}`;
  const pod = buildOneshotPod({
    podName,
    mount,
    exportReadOnly: true,
    command: buildReadCommand(),
    config,
  });
  // Override the env so RELPATH carries the per-agent-scoped relative path.
  ((pod.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> })
    .containers[0]!.env) = [{ name: 'RELPATH', value: scopedRel }];

  await api.createNamespacedPod({ namespace: config.namespace, body: pod });
  try {
    await watchPodExit({
      api,
      podName,
      namespace: config.namespace,
      pollIntervalMs: ONESHOT_POLL_MS,
      podLog: readLog,
    });
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

/** Parse the one-shot read pod's single output line into a ReadUserFilesOutput. */
export function parseReadOutput(raw: string): ReadUserFilesOutput {
  // The script emits exactly one meaningful line; take the last non-empty one
  // (defensive against any leading container noise).
  const line =
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .pop() ?? '';
  if (line === 'ABSENT' || line === 'BIG' || line === '') {
    // BIG → the file exists but is over the cap; we report absent bytes rather
    // than streaming a huge payload. A consumer that needs large files uses a
    // streaming path (follow-up); the browser preview treats it as absent.
    return { kind: 'absent' };
  }
  if (line.startsWith('DIR ')) {
    const b64 = line.slice('DIR '.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    const entries: UserFileDirEntry[] = [];
    for (const row of decoded.split('\n')) {
      if (row.length === 0) continue;
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const name = row.slice(0, tab);
      const kind = row.slice(tab + 1);
      if ((kind === 'dir' || kind === 'file') && name.length > 0) {
        entries.push({ name, kind });
      }
    }
    return { kind: 'dir', entries };
  }
  if (line.startsWith('FILE ')) {
    const b64 = line.slice('FILE '.length);
    return { kind: 'file', contents: new Uint8Array(Buffer.from(b64, 'base64')) };
  }
  return { kind: 'absent' };
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
    },
  };
}
