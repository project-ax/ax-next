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

import { createHash } from 'node:crypto';
import { buildGitCredentialEnv, type ServiceDescriptorParsed } from '@ax/sandbox-protocol';
import type { ResolvedSandboxK8sConfig } from './config.js';

const K8S_LABEL_MAX_BYTES = 63;
const K8S_LABEL_HASH_SUFFIX_BYTES = 8;

/**
 * Coerce an arbitrary string into a valid k8s label VALUE that satisfies
 * `(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?` and ≤ 63 bytes.
 *
 * Rules:
 * 1. Replace any char outside `[A-Za-z0-9._-]` with `-` (so e.g. `/`
 *    inside a routine path stops being a validation error).
 * 2. Trim leading/trailing non-alphanumerics — the regex pins the first
 *    AND last char to `[A-Za-z0-9]`.
 * 3. If the result still exceeds 63 bytes, truncate to 54 chars and
 *    append `-<sha1(original)[:8]>`. The hash makes the truncation
 *    deterministic AND collision-resistant: two distinct inputs that
 *    happen to share a 54-char prefix get different label values.
 * 4. If sanitization leaves an empty string (caller passed all
 *    non-alphanumerics), fall back to the first 16 chars of sha1 — a
 *    valid label, deterministic, and unique per input.
 *
 * Used for `ax.io/session-id` which carries `input.sessionId`. The
 * underlying `AX_SESSION_ID` env keeps the ORIGINAL value — only the
 * k8s label surface is sanitized.
 */
function sanitizeLabel(value: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  if (slug.length === 0) {
    return createHash('sha1').update(value).digest('hex').slice(0, 16);
  }
  if (slug.length <= K8S_LABEL_MAX_BYTES) return slug;
  const hash = createHash('sha1')
    .update(value)
    .digest('hex')
    .slice(0, K8S_LABEL_HASH_SUFFIX_BYTES);
  // -1 reserves a byte for the `-` that joins head + hash.
  const headBudget = K8S_LABEL_MAX_BYTES - K8S_LABEL_HASH_SUFFIX_BYTES - 1;
  const head = slug.slice(0, headBudget).replace(/[^A-Za-z0-9]+$/, '');
  return `${head}-${hash}`;
}

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
  /**
   * Per-session proxy token for egress attribution (TASK-52). Stamped as
   * AX_PROXY_TOKEN; the runner embeds it as Proxy-Authorization Basic
   * userinfo. Attribution label only — never an authz input.
   */
  proxyAuthToken?: string;
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
  /**
   * Phase 1 (skill-install): installed skills to pass to the runner via
   * AX_INSTALLED_SKILLS_JSON. The runner reads this env var in main()
   * BEFORE the SDK spawns, materializes each skill's FILE TREE under
   * $CLAUDE_CONFIG_DIR/skills/<id>/ (SKILL.md + extra files), then chmods the
   * tree read-only. Capped at 96 KiB total payload — it's a single env-var
   * string subject to the kernel's per-exec-string limit (MAX_ARG_STRLEN,
   * ~128 KiB); throws if exceeded. Large reference data belongs in the
   * workspace, not the skill bundle.
   *
   * The env var is consumed BY THE RUNNER, not forwarded into the SDK
   * subprocess — it is NOT in ENV_ALLOWLIST.
   */
  installedSkills?: Array<{
    id: string;
    /**
     * JIT Phase 1a — the skill bundle as a FILE TREE (SKILL.md + extra files),
     * replacing the former single `skillMd` string. The runner materializes
     * each file under $CLAUDE_CONFIG_DIR/skills/<id>/ and re-validates every
     * path at its extract boundary (defense in depth).
     */
    files: Array<{ path: string; contents: string }>;
    /**
     * TASK-14 (CLI-1 part 2) — the skill's top-level allowedHosts + credential
     * slots, used to wire skill-declared credentials into `git`'s HTTP Basic
     * auth via host-scoped `url.<base>.insteadOf` rewrites (see
     * @ax/sandbox-protocol buildGitCredentialEnv). Optional + defaulted so
     * pre-TASK-14 callers (tests, ad-hoc) still build a valid spec.
     */
    allowedHosts?: string[];
    /**
     * TASK-86 — `slot` is the BARE env-var name; the optional `placeholder` is
     * the skill's OWN `ax-cred:<hex>` token, so per-skill git wiring uses the
     * skill's own credential even when another skill won the flat-env stamp for
     * the same bare slot name (see @ax/sandbox-protocol buildGitCredentialEnv).
     * The token is opaque (no real secret) and already rides the pod env via the
     * proxy envMap.
     */
    credentials?: Array<{ slot: string; kind: 'api-key'; placeholder?: string | undefined }>;
  }>;
  /**
   * TASK-151 — dev SERVICES the orchestrator folded from the agent's connector
   * capabilities. Each descriptor renders as a NATIVE k8s sidecar (an
   * `initContainers[]` entry with `restartPolicy: 'Always'`), NEVER a plain
   * `containers[]` entry — see `renderServiceSidecars` for why that distinction
   * is load-bearing (I1). The type is the wire-validated
   * `ServiceDescriptorParsed` from `@ax/sandbox-protocol`; the descriptor is
   * backend-agnostic (no k8s vocabulary, I1) and digest-pinned (I8) by the time
   * it reaches here.
   */
  services?: ServiceDescriptorParsed[];
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

/**
 * The locked-down container security context the runner, the sdk-scaffold init
 * container, AND every service sidecar all share (I5). A service image is
 * third-party and adjacent to the untrusted runner, so it gets the SAME locked
 * posture: non-root uid/gid 1000, no privilege escalation, read-only rootfs,
 * all linux capabilities dropped. Anything a service legitimately writes goes to
 * a per-service `emptyDir` mount (see `renderServiceSidecars`).
 */
const CONTAINER_SECURITY = {
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
} as const;

interface ServiceSidecarRender {
  /** The `initContainers[]` entries — one native sidecar per service. */
  initContainers: Record<string, unknown>[];
  /** The matching `emptyDir` volumes — one per service writable path. */
  volumes: Array<{ name: string; emptyDir: Record<string, never> }>;
}

/**
 * TASK-151 — render each declared service descriptor as a NATIVE k8s sidecar.
 *
 * The load-bearing distinction (I1): a service is a long-running process (a DB,
 * a broker). Rendered as a plain `containers[]` entry under the pod's
 * `restartPolicy: Never`, the pod NEVER reaches `Succeeded`/`Failed` (those
 * phases require ALL containers to terminate), so `watchPodExit`
 * (lifecycle.ts:192) loops until the 6h `activeDeadlineSeconds` — a pod leak.
 * Native sidecars (`initContainers` with `restartPolicy: Always`) do NOT count
 * toward pod completion: the pod completes when the runner (`containers[0]`)
 * exits, and the kubelet tears the sidecars down. So services MUST render here,
 * NOT in `containers[]`.
 *
 * Each sidecar gets:
 *  - the same locked `CONTAINER_SECURITY` as the runner (I5) — third-party,
 *    untrusted-adjacent, so no looser posture;
 *  - ONLY the descriptor's own `env` (I5/I1) — no AX_* / proxy / git env leak
 *    onto a third-party image; the egress lock (I4) is enforced at the NetworkPolicy
 *    layer, not via env, and the descriptor never encodes a bind address;
 *  - `ports` → `containerPort`s;
 *  - per-`writablePaths` `emptyDir` mounts (rootfs stays read-only, I5);
 *  - an optional `startupProbe` from the descriptor's `healthcheck` (I6) — under
 *    native-sidecar semantics the kubelet starts the main container once the
 *    sidecars' startup probes pass.
 *  - per-service resourcing from config (NOT a descriptor field — keeps the
 *    descriptor backend-agnostic, I1).
 */
function renderServiceSidecars(
  services: ServiceDescriptorParsed[],
  config: ResolvedSandboxK8sConfig,
): ServiceSidecarRender {
  const initContainers: Record<string, unknown>[] = [];
  const volumes: Array<{ name: string; emptyDir: Record<string, never> }> = [];

  for (const service of services) {
    // The descriptor `name` is constrained to ID_RE (lowercase alnum + dashes)
    // at the wire, so `svc-<name>` and `svc-<name>-<i>` are valid k8s
    // container/volume names without further sanitization. The index keeps a
    // service's multiple writable paths — and paths shared across services —
    // collision-free.
    const containerName = `svc-${service.name}`;

    const volumeMounts: Array<{ name: string; mountPath: string }> = [];
    service.writablePaths.forEach((mountPath, i) => {
      const volName = `svc-${service.name}-${i}`;
      volumeMounts.push({ name: volName, mountPath });
      volumes.push({ name: volName, emptyDir: {} });
    });

    const sidecar: Record<string, unknown> = {
      name: containerName,
      image: service.image,
      // Native-sidecar marker: a `restartPolicy: Always` init container is
      // treated by the kubelet as a sidecar — it starts before the main
      // container, stays running alongside it, and does NOT gate pod
      // completion. This is the whole point (I1).
      restartPolicy: 'Always',
      securityContext: CONTAINER_SECURITY,
      env: Object.entries(service.env).map(([name, value]) => ({ name, value })),
      ports: service.ports.map((containerPort) => ({ containerPort })),
      resources: {
        limits: { cpu: config.serviceCpuLimit, memory: config.serviceMemoryLimit },
        requests: { cpu: config.serviceCpuRequest, memory: config.serviceMemoryRequest },
      },
      volumeMounts,
    };

    if (service.healthcheck !== undefined) {
      // A startupProbe (not a readinessProbe) — under native-sidecar semantics
      // the kubelet holds the main container until the sidecars' startup probes
      // pass. Generous failureThreshold × periodSeconds so the kubelet's own
      // per-probe budget also covers JVM cold-start + image pull (I6); the
      // pod-level readiness budget in config scales separately.
      const probeBudget = { periodSeconds: 5, failureThreshold: 60, timeoutSeconds: 3 };
      sidecar.startupProbe =
        service.healthcheck.kind === 'tcp'
          ? { tcpSocket: { port: service.healthcheck.port }, ...probeBudget }
          : { exec: { command: service.healthcheck.command }, ...probeBudget };
    }

    initContainers.push(sidecar);
  }

  return { initContainers, volumes };
}

export function buildPodSpec(
  podName: string,
  input: BuildPodSpecInput,
  config: ResolvedSandboxK8sConfig,
): PodSpec {
  // Phase 1 (skill-install): encode installedSkills as JSON for the
  // AX_INSTALLED_SKILLS_JSON env var. The runner reads it before the SDK
  // spawns and materializes each skill's file tree under
  // $CLAUDE_CONFIG_DIR/skills/. Cap at 96 KiB. AX_INSTALLED_SKILLS_JSON is a
  // SINGLE env-var string, and the kernel bounds any single argv/env string fed
  // to execve at MAX_ARG_STRLEN (~128 KiB on Linux) — a larger value yields a
  // pod whose entrypoint can't exec (E2BIG), not a clean error. 96 KiB stays
  // safely under that with headroom for JSON overhead. (This is tighter than
  // the pre-bundle 256 KiB cap, which already exceeded the exec limit; bundles
  // legitimately need more files but each must stay small — large reference
  // data belongs in the workspace, not an env var.) Throw before building the
  // spec so the caller sees a clear error rather than a silent runtime failure.
  let installedSkillsEnv: EnvVar | undefined;
  if (input.installedSkills !== undefined && input.installedSkills.length > 0) {
    const encoded = JSON.stringify(input.installedSkills);
    if (Buffer.byteLength(encoded, 'utf-8') > 96 * 1024) {
      throw new Error(
        'AX_INSTALLED_SKILLS_JSON payload over 96 KiB — too large for env var transport',
      );
    }
    installedSkillsEnv = { name: 'AX_INSTALLED_SKILLS_JSON', value: encoded };
  }
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
  // I-P0-3 (skill-install Phase 0): HOME is now a writable, per-session
  // tmpfs mount at /home/runner (volume `home`, emptyDir Memory). This
  // gives the Claude Agent SDK's `'user'` setting source a real path to
  // walk for $HOME/.claude/skills/, isolated to the pod and discarded on
  // exit. The previous /nonexistent value made the SDK either ENOENT or
  // worse, fall through to whatever HOME the image ships with.
  // CLAUDE_CONFIG_DIR points the SDK's `'project'` setting source at
  // /home/runner/.ax/session/skills/ — also tmpfs, also ephemeral.
  // Phase 1 (skill materialization) writes there; Phase 0 leaves it empty.
  const gitParanoidEnv: EnvVar[] = [
    { name: 'GIT_CONFIG_NOSYSTEM', value: '1' },
    { name: 'GIT_CONFIG_GLOBAL', value: '/dev/null' },
    { name: 'GIT_TERMINAL_PROMPT', value: '0' },
    { name: 'HOME', value: '/home/runner' },
    { name: 'CLAUDE_CONFIG_DIR', value: '/home/runner/.ax/session' },
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
    { name: 'GIT_CONFIG_KEY_0', value: 'safe.directory' },
    { name: 'GIT_CONFIG_VALUE_0', value: '*' },
  ];

  // TASK-14 (CLI-1 part 2): wire skill-declared credentials into git's HTTP
  // Basic auth. For each credentialed allowedHost, stamp a host-scoped
  // `url.https://x-access-token:<placeholder>@<host>/.insteadOf` rewrite so
  // `git clone https://<host>/...` sends the proxy placeholder as a preemptive
  // Basic password (the proxy substitutes it). The entries append after the
  // safe.directory entry (index 0). The single GIT_CONFIG_COUNT is set once
  // below from the resulting total — `gitParanoidEnv` deliberately no longer
  // stamps its own count to avoid a duplicate env entry. Rides into the SDK
  // subprocess via proxy-startup.ts's GIT_ env-forwarding prefix, exactly like
  // GIT_SSL_CAINFO and the safe.directory config already do.
  const gitCredEnv: EnvVar[] = [];
  let gitConfigCount = 1; // index 0 is safe.directory
  if (input.proxyConfig !== undefined && input.installedSkills !== undefined) {
    const credEnvMap = buildGitCredentialEnv({
      installedSkills: input.installedSkills.map((s) => ({
        allowedHosts: s.allowedHosts ?? [],
        credentials: s.credentials ?? [],
      })),
      envMap: input.proxyConfig.envMap,
      baseCount: 1,
    });
    for (const [name, value] of Object.entries(credEnvMap)) {
      if (name === 'GIT_CONFIG_COUNT') {
        gitConfigCount = Number(value);
        continue;
      }
      gitCredEnv.push({ name, value });
    }
  }
  gitParanoidEnv.push({ name: 'GIT_CONFIG_COUNT', value: String(gitConfigCount) });

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
    // TASK-12: NODE_EXTRA_CA_CERTS / SSL_CERT_FILE only steer Node's TLS
    // (the SDK's undici fetch). The `git` binary the Bash tool spawns is
    // libcurl/OpenSSL-backed and reads NEITHER — it verifies the proxy's
    // MITM cert against GIT_SSL_CAINFO. Without this, `git clone` over the
    // credential proxy dies with `SSL certificate problem: unable to get
    // local issuer certificate` (the CLI-1 walk-fail). Stamp the SAME CA
    // path the Node vars use; the runner forwards GIT_SSL_CAINFO into the
    // SDK subprocess via the GIT_ prefix allowlist (see proxy-startup.ts).
    proxyEnv.push({
      name: 'GIT_SSL_CAINFO',
      value: '/var/run/ax/proxy-ca/ca.crt',
    });
    // TASK-62: Deno-compiled CLIs the Bash tool spawns (e.g.
    // `npx @schpet/linear-cli`, which ships a Deno binary) use rustls with a
    // bundled Mozilla root store and read NEITHER NODE_EXTRA_CA_CERTS nor
    // SSL_CERT_FILE — Deno honors only DENO_CERT (a PEM path added to its trust
    // anchors, the analogue of NODE_EXTRA_CA_CERTS). Without this the CLI's
    // HTTPS call to its API through the MITM proxy dies with
    // `invalid peer certificate: UnknownIssuer` — the "TLS certificate issue"
    // surfaced by the linear-cli skill. Stamp the SAME CA path the Node/git
    // vars use; the runner forwards DENO_CERT into the SDK subprocess
    // explicitly (see proxy-startup.ts).
    proxyEnv.push({
      name: 'DENO_CERT',
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
    if (pc.proxyAuthToken !== undefined) {
      // TASK-52: per-session proxy token for egress attribution. The runner
      // reads AX_PROXY_TOKEN and embeds it as Proxy-Authorization Basic
      // userinfo on the local bridge URL, so the host listener can attribute
      // egress (including blocked, allowlist-miss requests) to this session.
      proxyEnv.push({ name: 'AX_PROXY_TOKEN', value: pc.proxyAuthToken });
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
  // Session-scoped scratch tier (the `/ephemeral` emptyDir mounted below).
  // Stamped explicitly so the contract is observable in `kubectl describe
  // pod` AND so the runner can wire it into the SDK's additionalDirectories
  // + system prompt. The runner treats AX_EPHEMERAL_ROOT as optional with
  // NO default (see @ax/agent-claude-sdk-runner env.ts), so this stamp is
  // the only thing that turns the scratch tier on for k8s sessions.
  const RUNNER_EPHEMERAL_ROOT = '/ephemeral';
  const env: EnvVar[] = [
    { name: 'AX_SESSION_ID', value: input.sessionId },
    { name: 'AX_AUTH_TOKEN', value: input.authToken },
    { name: 'AX_WORKSPACE_ROOT', value: RUNNER_WORKSPACE_ROOT },
    { name: 'AX_EPHEMERAL_ROOT', value: RUNNER_EPHEMERAL_ROOT },
    { name: 'AX_RUNNER_BINARY', value: input.runnerBinary },
    { name: 'AX_RUNNER_ENDPOINT', value: input.runnerEndpoint },
    ...(input.requestId !== undefined
      ? [{ name: 'AX_REQUEST_ID', value: input.requestId }]
      : []),
    ...gitParanoidEnv,
    ...gitCredEnv,
    ...proxyEnv,
    // Phase 1: installed skills — only present when non-empty so the env
    // list has no `: undefined` entries and kubectl describe stays clean.
    ...(installedSkillsEnv !== undefined ? [installedSkillsEnv] : []),
    ...Object.entries(input.extraEnv ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  ];

  const containerSecurity = CONTAINER_SECURITY;

  // TASK-151 — native service sidecars. Rendered as `initContainers` with
  // `restartPolicy: 'Always'` (NEVER `containers[]`, I1 — see
  // `renderServiceSidecars`). When any service is present the pod also gains
  // `securityContext.fsGroup: 1000` so the per-service `emptyDir`s are
  // group-writable by the non-root sidecar (I5).
  const services = input.services ?? [];
  const sidecarRender = renderServiceSidecars(services, config);

  const spec: Record<string, unknown> = {
    // Userspace kernel (gVisor) — adds a second isolation layer between
    // sandbox code and the host kernel. Operators can opt out by setting
    // runtimeClassName: '' in config, in which case we warn at boot
    // (see plugin.ts). Default is ON.
    ...(config.runtimeClassName.length > 0
      ? { runtimeClassName: config.runtimeClassName }
      : {}),
    // TASK-151 (I5): pod-level fsGroup so the per-service `emptyDir` mounts are
    // owned by gid 1000 and writable by the non-root sidecars (their rootfs
    // stays read-only). Set ONLY when services are present — a service-less
    // runner pod keeps its existing (fsGroup-free) shape so this change is a
    // strict superset and nothing about the no-services path moves.
    ...(services.length > 0 ? { securityContext: { fsGroup: 1000 } } : {}),
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
          // I-P0-3: per-session HOME on tmpfs. Mounted on both the main
          // container AND the sdk-scaffold init container (the init step
          // creates the .ax/session/skills/ directory before the SDK
          // walks for it). The volume is defined as `emptyDir: Memory`
          // below — tmpfs keeps it fast + ephemeral and never touches
          // the node's disk.
          { name: 'home', mountPath: '/home/runner' },
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
    // I-P0-3/4 (skill-install Phase 0): the sdk-scaffold init container
    // runs before the main runner container and prepares the $HOME
    // skill-discovery shape the Claude Agent SDK's `'user'` source walks
    // ($CLAUDE_CONFIG_DIR/skills). It is restricted to /home/runner
    // (the tmpfs HOME mount) on purpose: writing into /permanent here
    // collides with the runner's `git clone` of the materialized
    // workspace bundle (clone refuses a non-empty target). The
    // `.claude/skills → ../.ax/draft-skills` symlink the SDK's `'project'`
    // source needs is created by the runner main AFTER materialize, in
    // `git-workspace.ts`'s `scaffoldWorkspaceSkillSurface`.
    initContainers: [
      {
        name: 'sdk-scaffold',
        image: config.image,
        command: ['/bin/sh', '-c'],
        args: ['set -eu && mkdir -p /home/runner/.ax/session/skills'],
        // Invariant #5 (capabilities minimized): the init step only runs
        // a single mkdir, which does not read any GIT_* var or expand
        // $HOME (the snippet uses an absolute path). The 7
        // gitParanoidEnv vars stay on the MAIN container where git
        // actually runs. We still stamp HOME — it's not load-bearing
        // today, but (a) it documents the init's awareness of the new
        // tmpfs HOME location, and (b) if a future maintainer adds a
        // `$HOME/...` ref to the snippet, it expands to the right path
        // instead of an empty string + silent breakage.
        env: [{ name: 'HOME', value: '/home/runner' }],
        volumeMounts: [{ name: 'home', mountPath: '/home/runner' }],
        securityContext: containerSecurity,
      },
      // TASK-151 — service sidecars go AFTER sdk-scaffold (ordering: scaffold →
      // service sidecars → runner). `restartPolicy: 'Always'` makes each a
      // native sidecar (I1).
      ...sidecarRender.initContainers,
    ],
    volumes: [
      { name: 'tmp', emptyDir: {} },
      // I-P0-3: tmpfs HOME for the runner. emptyDir w/ medium: Memory
      // means the kubelet allocates an in-RAM tmpfs (no disk hit, no
      // persistence past pod termination, no cross-pod visibility). The
      // SDK's user-scope skill discovery walks $HOME/.claude/skills/
      // here; Phase 0 leaves it empty.
      { name: 'home', emptyDir: { medium: 'Memory' } },
      { name: 'permanent', emptyDir: {} },
      { name: 'ephemeral', emptyDir: {} },
      // TASK-151 — one emptyDir per service writablePaths entry (I5). Named
      // `svc-<service>-<i>` to match the sidecar's volumeMounts.
      ...sidecarRender.volumes,
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
        // sessionId surfaces as a label so a future operator can run
        // `kubectl get pod -l ax.io/session-id=...` to find a pod by
        // session. Labels are constrained to `[A-Za-z0-9._-]`, must start
        // and end with `[A-Za-z0-9]`, and cap at 63 bytes. The routines
        // plugin builds sessionIds like `routine-<agentId>-<routinePath>`
        // — both `/` and over-length are guaranteed to hit. `sanitizeLabel`
        // slugifies + truncates with a sha1 suffix so the label remains a
        // deterministic, collision-resistant function of the sessionId.
        // The original sessionId still rides in the `AX_SESSION_ID` env.
        'ax.io/session-id': sanitizeLabel(input.sessionId),
      },
    },
    spec,
  };
}
