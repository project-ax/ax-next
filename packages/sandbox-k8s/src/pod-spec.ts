// ---------------------------------------------------------------------------
// pod-spec — build the V1Pod manifest for a sandbox session.
//
// All defaults here are locked down. The runner is treated as untrusted
// model output (I5): no service-account token, gVisor as the container
// runtime, root filesystem read-only, all linux capabilities dropped,
// runs as a non-root UID. Anything a session legitimately writes lives
// under emptyDir mounts at /tmp and /workspace.
//
// The runner is purely an IPC client. The URL it reaches (the host pod's
// IPC listener — @ax/ipc-http) is fixed at preset-config time and stamped
// onto AX_RUNNER_ENDPOINT here.
// ---------------------------------------------------------------------------

import type { ResolvedSandboxK8sConfig } from './config.js';

export interface BuildPodSpecInput {
  sessionId: string;
  workspaceRoot: string;
  runnerBinary: string;
  authToken: string;
  /**
   * Cluster-internal URL the runner reaches the host's IPC listener at.
   * Threaded through from `ResolvedSandboxK8sConfig.hostIpcUrl`; stamped
   * onto the pod env as `AX_RUNNER_ENDPOINT`.
   */
  runnerEndpoint: string;
  requestId?: string;
  /**
   * Overrides for env vars the runner reads. The pod build always sets
   * AX_SESSION_ID, AX_AUTH_TOKEN, AX_WORKSPACE_ROOT, AX_RUNNER_ENDPOINT,
   * and AX_REQUEST_ID; callers can layer additional non-secret env on
   * top (e.g. AX_PROXY_UNIX_SOCKET pointing at the in-pod credential-
   * proxy socket).
   */
  extraEnv?: Record<string, string>;
}

interface EnvVar {
  name: string;
  value: string;
}

/**
 * V1Pod-shaped object. We intentionally don't import the official k8s
 * types into the public surface — the structural shape is enough, and
 * keeping types loose here means the builder can run against multiple
 * @kubernetes/client-node versions without a type bump.
 */
export interface PodSpec {
  apiVersion: 'v1';
  kind: 'Pod';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: Record<string, unknown>;
}

export function buildPodSpec(
  podName: string,
  input: BuildPodSpecInput,
  config: ResolvedSandboxK8sConfig,
): PodSpec {
  // Phase 3: the sandbox now spawns the in-image `git` binary to materialize
  // /permanent at session start and to bundle per-turn diffs at turn end.
  // These env vars are the locked-down rails — they prevent git-init from
  // reading user-global config, refuse interactive prompts, and pin commit
  // author/committer to `ax-runner` so the host bundler can verify
  // provenance before applying. See SECURITY.md for the threat-model walk.
  //
  // PATH is intentionally NOT pinned here: the sandbox image's ENTRYPOINT
  // composes PATH (Node + git on the locked-down image), and overriding it
  // from the pod-spec would force operators to know the image's bin layout.
  // The image is the trust root for binary lookup (I5).
  const gitParanoidEnv: EnvVar[] = [
    { name: 'GIT_CONFIG_NOSYSTEM', value: '1' },
    { name: 'GIT_CONFIG_GLOBAL', value: '/dev/null' },
    { name: 'GIT_TERMINAL_PROMPT', value: '0' },
    { name: 'HOME', value: '/nonexistent' },
    { name: 'GIT_AUTHOR_NAME', value: 'ax-runner' },
    { name: 'GIT_AUTHOR_EMAIL', value: 'ax-runner@example.com' },
    { name: 'GIT_COMMITTER_NAME', value: 'ax-runner' },
    { name: 'GIT_COMMITTER_EMAIL', value: 'ax-runner@example.com' },
  ];

  const env: EnvVar[] = [
    { name: 'AX_SESSION_ID', value: input.sessionId },
    { name: 'AX_AUTH_TOKEN', value: input.authToken },
    { name: 'AX_WORKSPACE_ROOT', value: input.workspaceRoot },
    { name: 'AX_RUNNER_BINARY', value: input.runnerBinary },
    { name: 'AX_RUNNER_ENDPOINT', value: input.runnerEndpoint },
    ...(input.requestId !== undefined
      ? [{ name: 'AX_REQUEST_ID', value: input.requestId }]
      : []),
    ...gitParanoidEnv,
    ...Object.entries(input.extraEnv ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  ];

  const containerSecurity = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };

  const spec: Record<string, unknown> = {
    // Userspace kernel (gVisor) — adds a second isolation layer between
    // sandbox code and the host kernel. Operators can opt out by setting
    // runtimeClassName: '' in config, in which case we warn at boot
    // (see plugin.ts). Default is ON.
    ...(config.runtimeClassName.length > 0
      ? { runtimeClassName: config.runtimeClassName }
      : {}),
    restartPolicy: 'Never',
    // The runner doesn't talk to the k8s API. Mounting a service-account
    // token would let a compromised runner enumerate the namespace, query
    // secrets, etc. — exactly what we don't want.
    automountServiceAccountToken: false,
    hostNetwork: false,
    activeDeadlineSeconds: config.activeDeadlineSeconds,
    ...(config.imagePullSecrets !== undefined && config.imagePullSecrets.length > 0
      ? {
          imagePullSecrets: config.imagePullSecrets.map((name) => ({ name })),
        }
      : {}),
    containers: [
      {
        name: 'runner',
        image: config.image,
        command: ['node', input.runnerBinary],
        env,
        resources: {
          limits: {
            cpu: config.cpuLimit,
            memory: config.memoryLimit,
          },
          requests: {
            cpu: config.cpuRequest,
            memory: config.memoryRequest,
          },
        },
        securityContext: containerSecurity,
        volumeMounts: [
          { name: 'tmp', mountPath: '/tmp' },
          // Phase 3: split the legacy /workspace mount in two. /permanent
          // is the git working tree (materialized at session start, the
          // source of every per-turn bundle). /ephemeral is caches and
          // scratch the runner doesn't want to round-trip through the
          // host. Splitting them keeps the storage tier bounded and gives
          // the runner an explicit "this won't survive" signal.
          { name: 'permanent', mountPath: '/permanent' },
          { name: 'ephemeral', mountPath: '/ephemeral' },
        ],
      },
    ],
    volumes: [
      { name: 'tmp', emptyDir: {} },
      { name: 'permanent', emptyDir: {} },
      { name: 'ephemeral', emptyDir: {} },
    ],
  };

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/component': 'ax-next-runner',
        // `ax.io/plane: execution` is the selector both NetworkPolicies
        // key off — runner egress restrict + host ingress allow. Without
        // it, runner pods bypass the egress allowlist AND can't reach
        // the host under enforced policy. See
        // deploy/charts/ax-next/templates/networkpolicies/.
        'ax.io/plane': 'execution',
        // sessionId is a label so a future operator using `kubectl get pod
        // -l ax.io/session-id=...` can find a pod by session. Labels have
        // a 63-char limit; AgentContext.sessionId is freeform but is
        // typically a UUID or short id — if it ever exceeds 63 chars,
        // k8s will reject the pod create with a clear validation error
        // (we don't pre-truncate; truncation would risk collisions).
        'ax.io/session-id': input.sessionId,
      },
    },
    spec,
  };
}
