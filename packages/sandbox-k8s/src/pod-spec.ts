// ---------------------------------------------------------------------------
// pod-spec — build the V1Pod manifest for a sandbox session.
//
// All defaults here are locked down. The runner is treated as untrusted
// model output (I5): no service-account token, gVisor as the container
// runtime, root filesystem read-only, all linux capabilities dropped,
// runs as a non-root UID. Anything a session legitimately writes lives
// under emptyDir mounts at /tmp and /workspace.
//
// runnerEndpoint resolution:
//   The HOST chooses where the runner reaches it. We surface the runner
//   binary's port (default 7777) by setting `containerPort` and rely on
//   the orchestrator to use the resolved pod IP + that port (Task 15).
//   The runner itself doesn't bind anything — that's the job of the
//   future @ax/agent-pod-server (which mirrors @ax/ipc-server but over
//   HTTP-on-TCP). For now: pod creation succeeds, the URI shape is right,
//   the actual transport doesn't connect (the runner-side HTTP client
//   throws "not implemented yet" on http://; see Task 14b commit).
// ---------------------------------------------------------------------------

import type { ResolvedSandboxK8sConfig } from './config.js';

export const RUNNER_PORT = 7777;

export interface BuildPodSpecInput {
  sessionId: string;
  workspaceRoot: string;
  runnerBinary: string;
  authToken: string;
  requestId?: string;
  /**
   * Overrides for env vars the runner reads. The pod build always sets
   * AX_SESSION_ID, AX_AUTH_TOKEN, AX_WORKSPACE_ROOT, AX_RUNNER_ENDPOINT,
   * and AX_REQUEST_ID; callers can layer additional non-secret env on
   * top (e.g. AX_LLM_PROXY_URL once the pod-side proxy lands).
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
  // Runner endpoint is resolved by the caller AFTER pod IP is known
  // (Task 15). For pod env we inject a placeholder marker the runner
  // ignores — the real value reaches the runner via the host setting
  // it in pod env, but at SPEC-BUILD time we don't know the IP yet.
  // Setting it to `pending://await-pod-ready` documents the lifecycle:
  // open-session.ts overwrites this in the env array at the moment the
  // pod becomes Ready, then the runner reads it. This is a host-side
  // contract; the runner just sees the final string.
  //
  // (We could omit AX_RUNNER_ENDPOINT here entirely and patch the
  //  pod after Ready, but a patch races the runner reading env at
  //  startup. The simplest correct shape: declare the var here so
  //  there's a single env array, and let the open-session impl
  //  rewrite the value before createNamespacedPod fires. See
  //  open-session.ts step "build env".)
  const env: EnvVar[] = [
    { name: 'AX_SESSION_ID', value: input.sessionId },
    { name: 'AX_AUTH_TOKEN', value: input.authToken },
    { name: 'AX_WORKSPACE_ROOT', value: input.workspaceRoot },
    { name: 'AX_RUNNER_BINARY', value: input.runnerBinary },
    // Real value patched in by open-session.ts after pod IP resolves.
    { name: 'AX_RUNNER_ENDPOINT', value: 'pending://await-pod-ready' },
    ...(input.requestId !== undefined
      ? [{ name: 'AX_REQUEST_ID', value: input.requestId }]
      : []),
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
        ports: [{ containerPort: RUNNER_PORT, name: 'ipc' }],
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
          { name: 'workspace', mountPath: '/workspace' },
        ],
      },
    ],
    volumes: [
      { name: 'tmp', emptyDir: {} },
      { name: 'workspace', emptyDir: {} },
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
        // sessionId is a label so a future operator using `kubectl get pod
        // -l ax.io/session-id=...` can find a pod by session. Labels have
        // a 63-char limit; ChatContext.sessionId is freeform but is
        // typically a UUID or short id — if it ever exceeds 63 chars,
        // k8s will reject the pod create with a clear validation error
        // (we don't pre-truncate; truncation would risk collisions).
        'ax.io/session-id': input.sessionId,
      },
    },
    spec,
  };
}
