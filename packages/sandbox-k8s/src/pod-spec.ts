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

/**
 * Per-session credential-proxy blob (structurally — see
 * `chat-orchestrator/orchestrator.ts ProxyConfig` for the source). When
 * present, pod-spec injects the matching env vars and (if
 * `config.proxySocketHostPath` is set) mounts the proxy socket dir into
 * the runner at `/var/run/ax`.
 */
export interface PodProxyConfig {
  endpoint?: string;
  unixSocketPath?: string;
  caCertPem: string;
  envMap: Record<string, string>;
}

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
  /**
   * Per-session proxy config from `proxy:open-session`. When set,
   * pod-spec stamps the proxy env (AX_PROXY_*, NODE_EXTRA_CA_CERTS,
   * SSL_CERT_FILE, plus the placeholder envMap) onto the runner. The
   * mount of the proxy socket directory is gated by
   * `config.proxySocketHostPath` — without that, env stamps still
   * happen but the socket isn't reachable and the runner crashes when
   * the bridge tries to dial it.
   */
  proxyConfig?: PodProxyConfig;
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
    // Bypass git's "dubious ownership" guard for /permanent (and /tmp,
    // where the materialize bundle lands). The runner runs as UID 1000;
    // /permanent is an emptyDir whose mount point may end up owned by
    // root (the runner-side bridge can't chown it without privilege),
    // and modern git refuses to operate on a repo whose dir owner !=
    // the running uid. We can't relax the security context to fix
    // ownership; safe.directory=* is the documented escape hatch.
    // Sandbox isolation already constrains what git can reach inside
    // the pod — it sees only the explicit volume mounts.
    { name: 'GIT_CONFIG_COUNT', value: '1' },
    { name: 'GIT_CONFIG_KEY_0', value: 'safe.directory' },
    { name: 'GIT_CONFIG_VALUE_0', value: '*' },
  ];

  // Per-session credential-proxy env (Phase 1a, k8s side). The runner-
  // side `setupProxy()` keys off AX_PROXY_UNIX_SOCKET (k8s) or
  // AX_PROXY_ENDPOINT (subprocess) — exactly one. NODE_EXTRA_CA_CERTS +
  // SSL_CERT_FILE point at the proxy's MITM root cert so the SDK trusts
  // it. The placeholder envMap (e.g. ANTHROPIC_API_KEY=ax-cred:<hex>)
  // merges last so per-session credentials win over anything else.
  //
  // The CA cert path is `<config.proxySocketHostPath>/proxy-ca/ca.crt`
  // mounted at `/var/run/ax/proxy-ca/ca.crt` — the host's
  // `@ax/credential-proxy` writes it there at boot when caDir is set
  // to a path inside the shared dir. When `proxySocketHostPath` is
  // unset, no mount happens and the env stamps still resolve to the
  // expected runner-side path; the runner crashes when the bridge
  // can't dial the socket. That's the intended fail-loud posture.
  const proxyEnv: EnvVar[] = [];
  if (input.proxyConfig !== undefined) {
    const pc = input.proxyConfig;
    proxyEnv.push({
      name: 'NODE_EXTRA_CA_CERTS',
      value: '/var/run/ax/proxy-ca/ca.crt',
    });
    proxyEnv.push({
      name: 'SSL_CERT_FILE',
      value: '/var/run/ax/proxy-ca/ca.crt',
    });
    if (pc.endpoint !== undefined) {
      proxyEnv.push({ name: 'AX_PROXY_ENDPOINT', value: pc.endpoint });
      proxyEnv.push({ name: 'HTTPS_PROXY', value: pc.endpoint });
      proxyEnv.push({ name: 'HTTP_PROXY', value: pc.endpoint });
    }
    if (pc.unixSocketPath !== undefined) {
      // The host's socket lives at `pc.unixSocketPath` on the host
      // pod's filesystem (e.g. `/var/run/ax/proxy.sock`). The runner
      // pod sees the SAME path through the shared hostPath mount, so
      // we forward it verbatim — no path translation needed.
      proxyEnv.push({
        name: 'AX_PROXY_UNIX_SOCKET',
        value: pc.unixSocketPath,
      });
    }
    for (const [k, v] of Object.entries(pc.envMap)) {
      proxyEnv.push({ name: k, value: v });
    }
  }

  // The runner pod's filesystem namespace is its own — the host's
  // `input.workspaceRoot` (e.g. process.cwd() = `/opt/ax-next/host`) is
  // meaningless inside it AND lives under `readOnlyRootFilesystem: true`,
  // so any attempt to write the materialized bundle there fails with
  // EROFS at session start. The runner has /permanent as its writable
  // mount; that's where the workspace must live. Hardcode `/permanent`
  // here so the runner never sees the host's path. (env.ts already
  // defaults to /permanent if unset, but stamping it explicitly makes
  // the contract observable in `kubectl describe pod`.)
  const RUNNER_WORKSPACE_ROOT = '/permanent';
  const env: EnvVar[] = [
    { name: 'AX_SESSION_ID', value: input.sessionId },
    { name: 'AX_AUTH_TOKEN', value: input.authToken },
    { name: 'AX_WORKSPACE_ROOT', value: RUNNER_WORKSPACE_ROOT },
    { name: 'AX_RUNNER_BINARY', value: input.runnerBinary },
    { name: 'AX_RUNNER_ENDPOINT', value: input.runnerEndpoint },
    ...(input.requestId !== undefined
      ? [{ name: 'AX_REQUEST_ID', value: input.requestId }]
      : []),
    ...gitParanoidEnv,
    ...proxyEnv,
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
        // Surface the runner's last bytes of stderr in
        // `status.containerStatuses[0].state.terminated.message` when
        // the container exits non-zero. Without this, a fast-failing
        // runner leaves no diagnostic trace once the kubelet GCs the
        // pod (the cleanup-on-exit handler in open-session.ts deletes
        // the pod within seconds, racing `kubectl logs`). With it, the
        // host's `pod_exited` log line and any post-mortem `kubectl
        // describe pod` see the actual stderr message.
        terminationMessagePolicy: 'FallbackToLogsOnError',
        // `args` (not `command`) so the image's ENTRYPOINT (tini in
        // container/agent/Dockerfile) stays PID 1 and reaps any orphaned
        // grandchildren of the Claude SDK runner subprocess. K8s `command`
        // replaces ENTRYPOINT entirely; `args` only replaces CMD. The
        // image contract: ENTRYPOINT must be a process supervisor that
        // execs its argv (e.g. `tini --`) so `args` reaches node verbatim.
        args: ['node', input.runnerBinary],
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
          // Shared credential-proxy directory (Phase 1a, k8s side).
          // Conditionally mounted only when the host advertised a
          // `proxySocketHostPath` — without that, the volume entry below
          // is also skipped and the runner can't reach the proxy.
          // RW mount: connect(2) to a Unix socket needs write access to
          // the socket file (the kernel updates connection-side state).
          // A `readOnly: true` mount silently blocks the runner-side
          // bridge from dialing the proxy, the bridge falls through,
          // and the SDK's fetch sends the placeholder credential
          // straight to api.anthropic.com — which then 401s with
          // "Invalid API key" because the substitution never ran.
          // The runner is already inside the sandbox; granting RW on
          // its own per-pod mount of the proxy dir doesn't widen the
          // blast radius.
          ...(config.proxySocketHostPath.length > 0
            ? [{ name: 'proxy-socket', mountPath: '/var/run/ax' }]
            : []),
        ],
      },
    ],
    volumes: [
      { name: 'tmp', emptyDir: {} },
      { name: 'permanent', emptyDir: {} },
      { name: 'ephemeral', emptyDir: {} },
      // hostPath bridge between host pod's credential-proxy and the
      // runner pod. The host writes its Unix socket and CA cert PEM
      // into a directory backed by this same node-filesystem path; the
      // runner reads them through the mount. Only valid for kind /
      // single-node deployments — production should switch the proxy
      // to TCP listen mode + Service. See SECURITY.md.
      ...(config.proxySocketHostPath.length > 0
        ? [
            {
              name: 'proxy-socket',
              hostPath: {
                path: config.proxySocketHostPath,
                type: 'DirectoryOrCreate',
              },
            },
          ]
        : []),
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
