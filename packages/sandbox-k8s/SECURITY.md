# Security — `@ax/sandbox-k8s`

This package is the single biggest blast-radius surface in v2. It registers `sandbox:open-session` on the host-side bus and, on each call, asks the Kubernetes API to create a pod that will run untrusted runner code (and, transitively, untrusted model output and untrusted tool calls). Everything else in this codebase isolates ONE process from the rest of ONE host. This plugin isolates one tenant's untrusted code from your entire cluster. The defaults reflect that — gVisor on, no service-account token, all Linux capabilities dropped, read-only root, non-root UID, hard deadline. This note captures the `security-checklist` walk for the Week 7-9 landing.

## Security review (sandbox-k8s)

- **Sandbox:** Pods get gVisor (`runtimeClassName: 'gvisor'`) by default, run as UID 1000 with `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, all Linux capabilities dropped, root filesystem read-only (writes only to `emptyDir`-backed `/tmp` and `/workspace`), `automountServiceAccountToken: false` so a compromised runner has zero k8s API reach, and `activeDeadlineSeconds: 3600` so the kubelet kills the pod even if the host crashes. Pod-spec inputs are Zod-validated absolute paths; we never read `process.env[userInput]` and never interpolate caller strings into shell or argv.
- **Injection:** LLM and tool output never reach `buildPodSpec` — pod env is built from validated config plus three caller-supplied fields (`sessionId`, `workspaceRoot`, `runnerBinary`), all schema-checked before they hit any k8s API. This plugin produces an opaque `runnerEndpoint`; it does not parse model output, does not interpret tool results, and does not interpolate them into k8s API calls.
- **Supply chain:** One new runtime dep, pinned exact: `@kubernetes/client-node@1.4.0` (Apache-2.0, official kubernetes-client/javascript repo, ~8 years of releases). The package's own `prepare` script runs only at maintainer publish time; consumer install (npm/pnpm) does NOT execute it. Unpacked size is ~46 MB — the official client is large because it bundles generated types for the entire Kubernetes API, and that's a trade-off we accept over hand-rolling against the REST API.

## Sandbox escape / capability leakage

This is the heart of the review. There are four distinct escape axes — pod → node, pod → other pods, pod → control plane, and host plugin → host filesystem. We address them in that order.

### Pod-to-node (kernel escape)

The container is not the security boundary; the kernel is. A bug in the host kernel or in a Linux capability we forgot to drop is how you go from "owning a container" to "owning the node." Defenses, in layers:

- **gVisor by default.** `pod-spec.ts:112` sets `runtimeClassName: config.runtimeClassName` (default `'gvisor'`). gVisor is a userspace kernel — sandbox syscalls hit Sentry, not the host kernel directly. Most kernel CVEs that work against `runc` simply aren't reachable. **Opt-out exists.** Setting `runtimeClassName: ''` (empty string) drops the field, and the pod runs on the host kernel. We warn loudly at plugin init when this happens (`plugin.ts:45-54` writes a multi-line WARN to stderr at boot). Operators who flip this off had better know exactly why — single-tenant trusted-model deploys are the only place this is reasonable.
- **Non-root UID.** `securityContext.runAsNonRoot: true`, `runAsUser: 1000`, `runAsGroup: 1000` (`pod-spec.ts:99-101`). UID 0 inside the container is never granted; even a complete in-container compromise lands as an unprivileged user.
- **No privilege escalation.** `allowPrivilegeEscalation: false` (`pod-spec.ts:102`). `setuid` binaries can't escalate. Combined with `runAsNonRoot`, there's no path from "I executed code in the container" to "I'm root in the container."
- **All Linux capabilities dropped.** `capabilities: { drop: ['ALL'] }` (`pod-spec.ts:104`). No `CAP_NET_RAW`, no `CAP_SYS_ADMIN`, none of it. The default capability set varies by container runtime; we don't trust the default — we drop everything.
- **Read-only root filesystem.** `readOnlyRootFilesystem: true` (`pod-spec.ts:103`). The container image's filesystem is mounted read-only. Writes go to two `emptyDir`-backed mounts: `/tmp` and `/workspace` (`pod-spec.ts:145-148, 151-154`). An attacker can't drop a binary into `/usr/local/bin` and persist; everything writable is per-pod ephemeral and disappears when the pod terminates.
- **Resource limits.** CPU and memory are bounded (`pod-spec.ts:134-143`, defaults `cpuLimit: '1'`, `memoryLimit: '1Gi'`, `cpuRequest: '100m'`, `memoryRequest: '256Mi'` per `config.ts:73-76`). Requests prevent the scheduler from oversubscribing the node; limits prevent a runaway runner from taking down its neighbors. We do NOT set `ephemeral-storage` limits today — `emptyDir` defaults to node-disk-limited, so a misbehaving runner can fill `/tmp` until the kubelet evicts the pod. That's not an escape, but it IS a noisy-neighbor surface; flagged in "Known limits."
- **Hard deadline.** `activeDeadlineSeconds: 3600` (default, `config.ts:77`). The kubelet kills the pod after one hour even if our host crashes and loses its in-memory cleanup timers. This is the safety net for "host crashes mid-session, pod runs forever" — the kubelet has independent clocks.

If gVisor is enabled and an attacker breaks all the above, they're sitting in a userspace-kernel container with no capabilities, no setuid path, no writable rootfs, no SA token, no host network — and a kubelet that will kill the pod in at most an hour. That's the bar.

### Pod-to-pod (lateral movement)

A compromised runner pod CAN reach other pods over the cluster network unless the cluster denies it. We address this at the cluster level, not at the pod level — the Helm chart (Task 19) ships NetworkPolicies that allow runner pods to reach only the host pod (and DNS) and deny everything else. The pod spec itself sets `hostNetwork: false` (`pod-spec.ts:120`) so the pod doesn't share the host's network namespace, but the cross-pod fence is a NetworkPolicy concern. **This is a hard dependency on the deploy manifests.** Running this plugin without the matching NetworkPolicy is a security regression — the warning belongs in the deploy doc (Task 19b's SECURITY.md) and on the chart's README.

### Pod-to-control-plane (k8s API)

`automountServiceAccountToken: false` (`pod-spec.ts:119`). Runner pods get NO service account token mounted. There is no `/var/run/secrets/kubernetes.io/serviceaccount/token` for them to read, no in-cluster config they can use, no path to call the k8s API at all. A complete in-pod compromise CAN'T enumerate other pods, CAN'T list secrets, CAN'T create resources, CAN'T do `kubectl exec` into anything. The pod's network reach is to the host pod (and whatever NetworkPolicies allow), not to the apiserver.

The HOST pod is a different story — it MUST be able to create/read/delete pods to do its job. That capability lives in a separate ServiceAccount with a tightly-scoped Role:

- `pods: create, delete, get, list, watch` in ONE namespace.
- No cluster-scoped verbs.
- No `pods/exec`, no `pods/attach`, no `pods/portforward`.
- No `secrets`, no `configmaps`, no `nodes`, no `events`, no `deployments` or other workload kinds.

The exact RoleBinding lives in the Helm chart, not in this plugin. `k8s-api.ts:71-86` is the line where the host process gets its k8s client (in-cluster service-account token first, kubeconfig as fallback) — whatever cluster-side RBAC is bound to that identity is the cap. Misconfigured RBAC (e.g., binding `cluster-admin` to the host SA "for now") nullifies the entire isolation story.

### Pod safety net

If the host crashes, hangs, or otherwise fails to call `killPod`, the pod doesn't run forever. Two backstops:

- `activeDeadlineSeconds` (above) — kubelet-enforced.
- `restartPolicy: 'Never'` (`pod-spec.ts:115`) — once the runner exits, the pod doesn't get restarted. A crash-looping runner doesn't quietly retry forever.

`watchPodExit` (`lifecycle.ts:162-221`) ALSO runs host-side and, on observing terminal phase, calls `session:terminate` and then `killPod` (`open-session.ts:249-272`). Both `kill` paths are idempotent — `killPod` swallows 404 (`kill.ts:62-65`) so the host-side cleanup can race the kubelet GC and either path wins.

### Image pull

`imagePullSecrets` flows through from config (`pod-spec.ts:122-126`). We don't grant implicit access to any registry secret — operators specify which secret names to mount, and those secrets are read by the kubelet, not by this plugin. We never see the credential bytes; we just name them.

### Filesystem reach (host plugin side)

The host plugin doesn't touch the filesystem at all. `grep -nE 'fs\\.|node:fs' packages/sandbox-k8s/src/*.ts` returns nothing — no `readFile`, no `writeFile`, no `mkdir`, no `unlink`. Everything goes through the k8s API. The legacy v1 provider had filesystem reach for socket paths (`/tmp/<session>.sock`); v2's HTTP-over-TCP shape eliminates that surface.

### Caller-controlled inputs to the pod spec

Three fields cross from caller into pod env:

- `input.sessionId` — schema: `z.string().min(1)` (`open-session.ts:38`). Used as the value of `AX_SESSION_ID` and as the `ax.io/session-id` label on the pod. Labels have a 63-char limit; if `sessionId` exceeds 63 chars, the k8s API rejects the pod create with a clear validation error and we surface it as `pod-create-failed` (`open-session.ts:182-200`). We deliberately don't pre-truncate — truncation would risk session-id collisions, which would be a correctness bug worse than a noisy validation error.
- `input.workspaceRoot` — schema: `z.string().regex(/^\\//)` (`open-session.ts:39`). Must be an absolute path. Used as the value of `AX_WORKSPACE_ROOT` env. The runner inside the pod uses this; it never crosses into a host-side filesystem call.
- `input.runnerBinary` — schema: `z.string().regex(/^\\//)` (`open-session.ts:40`). Must be an absolute path. Used as `AX_RUNNER_BINARY` AND as the second argument to `command: ['node', input.runnerBinary]` (`pod-spec.ts:131`). The container's read-only rootfs only contains the bundled runner binaries; even if `runnerBinary` were attacker-controlled (which it isn't — it's host-side config), there's nothing else executable to point it at. `node` will fail with `Error: Cannot find module '<path>'` and the pod will exit `Failed`.

Pod env is built from VALIDATED values plus a fixed allowlist (`AX_SESSION_ID`, `AX_AUTH_TOKEN`, `AX_WORKSPACE_ROOT`, `AX_RUNNER_BINARY`, `AX_RUNNER_ENDPOINT`, optional `AX_REQUEST_ID`, plus a caller-supplied `extraEnv` map — see `pod-spec.ts:82-96`). There is no `process.env[userInput]` lookup anywhere in this plugin; `grep -n process.env packages/sandbox-k8s/src/*.ts` confirms zero matches.

`extraEnv` is for non-secret env layered on top (e.g., `AX_PROXY_UNIX_SOCKET` for the credential-proxy bridge). It does NOT validate values — a host-side caller passing `extraEnv` is trusted to pass non-secret strings. We chose not to validate here because the host plugin assembling the call IS the trust boundary; if a caller wanted to put `KUBECONFIG=...` in `extraEnv`, that's their bug, and the runner pod has no way to reach the host's kubeconfig regardless.

## Prompt injection / untrusted content

This plugin doesn't process model output or tool output directly. Everything that crosses the pod boundary is opaque bytes from the runner's perspective and opaque pod-status JSON from this plugin's perspective.

### LLM output never reaches `buildPodSpec`

`buildPodSpec` (`pod-spec.ts:62-176`) takes `BuildPodSpecInput` — `sessionId`, `workspaceRoot`, `runnerBinary`, `authToken`, `requestId`, `extraEnv`. None of those come from a model. `sessionId` and `workspaceRoot` come from the orchestrator (host-side); `runnerBinary` comes from plugin config (host-side); `authToken` comes from `session:create` (host-side, minted via `node:crypto.randomUUID`); `requestId` is `ctx.reqId` (host-side, request-scoped). LLM and tool output don't have a path here.

### Tool output round-trips through the runner

When a tool runs inside the pod, its output goes into the runner's IPC client and back to the host as opaque payload bytes. This plugin sees none of it — its only k8s API calls are `createNamespacedPod`, `readNamespacedPod`, `deleteNamespacedPod`, and `listNamespacedPod`, and the pod body is constructed BEFORE the pod ever runs. There is no point at which tool output is interpolated into a pod spec, a label, an annotation, or a kubectl-equivalent command.

### The container's `command`

`command: ['node', input.runnerBinary]` (`pod-spec.ts:131`). `runnerBinary` is host-validated to be absolute (regex `^\\//`). The container's read-only rootfs only contains the bundled runner binaries that ship in the image. Even in an alternate universe where `runnerBinary` were attacker-controlled, there is no shell — `command` is exec'd directly by the kubelet (no `/bin/sh -c`), so an attempt at argv injection (e.g., `runnerBinary: "/usr/bin/node; rm -rf /"`) would hand a literal string to `node` as `argv[1]`. Node would try to load it as a module path, fail, and exit. There's no shell metacharacter expansion at the kubelet boundary.

## Supply chain

One new runtime dependency. Pinned exactly. The transitive surface is the price of admission for talking to the k8s API at all.

### `@kubernetes/client-node@1.4.0`

- **License:** Apache-2.0.
- **Pin:** Exact (`"@kubernetes/client-node": "1.4.0"` in `package.json`). No caret, no tilde.
- **Maintainers:** `brendandburns` (Brendan Burns, Kubernetes co-founder, Microsoft) and `mbohlool` (Mehdi Bohlool, Google). Published from the official `kubernetes-client/javascript` GitHub repo, which is a Kubernetes SIG-API-Machinery sub-project. First version published 2017-12-16; 1.4.0 published 2025-10-03. Established maintainer set, ~8 years of releases.
- **Install hooks:** `npm view @kubernetes/client-node@1.4.0 scripts` shows a `prepare` script (`npm run build && husky`). `prepare` runs ONLY at publish time on the maintainer's machine and when installing from a git URL — it does NOT run when consumers `npm install` or `pnpm install` from the npm registry. The published tarball ships a pre-built `dist/`, and pnpm's default behavior (which we use) does not execute `prepare` for registry installs. There is no `preinstall`, `install`, or `postinstall` script. Confirmed by inspecting `node_modules/.pnpm/@kubernetes+client-node@1.4.0/.../package.json` — no `install`/`postinstall` keys.
- **Transitive surface (notable, from `npm view ... dependencies`):**
  - `node-fetch@^2.7.0` — HTTP client. The k8s API is REST-over-HTTPS; we need a client. node-fetch is established and audited.
  - `ws@^8.18.2` + `isomorphic-ws@^5.0.0` — WebSocket client. Used for `kubectl exec`-style streaming. We don't call those endpoints in this plugin (`createNamespacedPod`, `readNamespacedPod`, `deleteNamespacedPod`, `listNamespacedPod` are all REST), so the ws code path is unreachable from our usage even though the bytes are on disk.
  - `js-yaml@^4.1.0` — kubeconfig parsing. `loadFromDefault` reads `~/.kube/config` and parses YAML; `loadFromCluster` reads the in-cluster service account file and the in-cluster CA bundle (no YAML parse needed). YAML parsing is a known footgun for arbitrary-code-execution-via-tags (CVE-2013-0156-style); js-yaml's default `load` is the safe schema (no `!!js/function`, no class instantiation), and that's what kubeconfig uses.
  - `tar-fs@^3.0.9` — used by `cp` (in-pod file transfer). We don't call `cp`. CVEs in this dep land have a clean exploitability assessment because of that.
  - `openid-client@^6.1.3` — OIDC auth flow for kubeconfigs that use it. Reachable only from `loadFromDefault` when the user's kubeconfig has an OIDC user; not reachable from `loadFromCluster`.
  - `socks-proxy-agent@^8.0.4`, `hpagent@^1.2.0` — proxy support. Reachable when `HTTPS_PROXY` is set. We don't set it; if a host operator does, traffic flows through.
  - `form-data`, `stream-buffers`, `rfc4648`, `jsonpath-plus` — utility plumbing.

  Notably absent: `axios`. We were prepared to flag axios's transitive history, but the 1.x line of `@kubernetes/client-node` migrated off it. The HTTP client is `node-fetch`.

- **Bundle size.** ~46 MB unpacked from npm; ~53 MB on disk after pnpm extracts it. That's substantial. The reason: the package bundles generated TypeScript types and runtime models for the entire Kubernetes API surface (~600 types covering every resource kind in every API group). We use four methods. Most of the bundle is shape-of-k8s, not code we call. The trade-off: hand-rolling a four-method REST client against the k8s API is doable but means owning the auth flow (in-cluster SA token, kubeconfig OIDC, kubeconfig exec-credential plugin), the CA bundle, the proxy support, and the eventual schema drift when k8s adds fields. The official client ships security-relevant fixes (auth, TLS, proxy handling) through the dep chain, and we'd rather take the disk-space hit.

- **`pnpm why @kubernetes/client-node`** confirms: direct dependency of `@ax/sandbox-k8s` only. Nothing else in the monorepo pulls it in (yet — `@ax/preset-k8s` lands in Task 18 and will be the second consumer). Blast radius of a compromised version is contained to this one plugin until the preset wires it.

## Boundary review

- **Alternate impl this hook could have:** `@ax/sandbox-firecracker` — same `sandbox:open-session` service hook, same `OpenSessionResult` shape (an opaque `runnerEndpoint` URL plus `kill()`/`exited`), but backed by Firecracker microVMs instead of k8s pods. The `runnerEndpoint` would still be `http://<host>:<port>` from the orchestrator's perspective; the implementation behind it changes.
- **Payload field names that might leak:** none. `OpenSessionResult` exposes `runnerEndpoint` (opaque URL) and `handle` (`kill`, `exited`). No `pod`, `podName`, `namespace`, `runtimeClass`, `serviceAccount`, `nodeName`, `kubeconfig`, or other k8s-specific vocabulary appears on the hook surface. The `runnerEndpoint` happens to be `http://` today; we document it as opaque-from-caller's-perspective at the top of `pod-spec.ts`.
- **Subscriber risk:** no subscribers today on `sandbox:open-session` — it's a service hook, not a notification. If a future subscriber tried to parse `runnerEndpoint` as `http://<host>:<port>` and key off the host or port, they'd break the day a `unix://` or `vsock://` impl ships. Subscriber-hook docs (when they land) will spell this out.
- **Wire surface (IPC):** none. `sandbox:open-session` is host-side only; sandboxes don't open other sandboxes. The `runnerEndpoint` IS the wire surface, but its consumer is the orchestrator's IPC client, not a separate IPC handler.

## Known limits

- **Runner pods reach the host via a cluster Service URL.** `config.hostIpcUrl` is set by the preset (defaulted from the chart's `host.ipcUrl`); every runner pod gets it via `AX_RUNNER_ENDPOINT`. The runner's IPC client is the only thing that connects to the host's `@ax/ipc-http` listener; auth is `Authorization: Bearer ${AX_AUTH_TOKEN}` per request, validated server-side via `session:resolve-token`. Plain HTTP within the cluster — NetworkPolicy is the perimeter. mTLS is a documented future hardening; see `@ax/ipc-http/SECURITY.md` for the full security walk.
- **NetworkPolicies are a hard prerequisite.** The pod spec doesn't include NetworkPolicy fields (it can't — those are separate cluster resources). The Helm chart in Task 19 ships them. Running this plugin without the matching policies means runner pods can talk to anything in the cluster they can reach by IP. That's a regression vs. the documented threat model. Deploys MUST apply the chart's NetworkPolicies, or roll equivalents.
- **No `ephemeral-storage` limits set.** A runner that fills `/tmp` or `/workspace` (both `emptyDir`-backed) eats node disk. The kubelet eventually evicts the pod under disk pressure, but a coordinated set of pods could tip the node before eviction kicks in. This is a noisy-neighbor knob, not an escape; we'll add explicit `requests`/`limits` for `ephemeral-storage` in a future hardening pass.
- **No PodSecurity admission claim.** We set the right pod-spec fields, but we don't independently verify the cluster has `pod-security.kubernetes.io/enforce: restricted` (or stricter) on our namespace. A misconfigured cluster could let some other workload run privileged in our namespace, which is outside our blast radius but worth noting in the chart docs.
- **gVisor opt-out is a foot-gun.** Setting `runtimeClassName: ''` is intentional (single-tenant trusted-model deploys exist), and we warn at boot, but a stderr write at init time is easy to miss in containerized log pipelines that bury startup output. A future hardening pass might require an explicit `iAcknowledgeNoGvisor: true` config flag rather than an empty string.
- **Host SA RBAC scope is the chart's job.** This plugin can't audit its own RBAC at runtime — the Kubernetes API doesn't expose "what verbs am I allowed to call?" cleanly. We rely on the chart binding the host pod's SA to a Role with the documented minimum verbs (`pods: create/delete/get/list/watch` in one namespace). If the chart binds `cluster-admin`, the entire isolation story collapses. Task 19b's SECURITY.md is where the RBAC claim is enforced.

## What we don't know yet

- Whether gVisor is going to be available across the cluster runtimes operators care about. Most managed Kubernetes (GKE Sandbox, EKS) supports it via a node-pool flag; bare-metal kubeadm clusters need it installed explicitly. We default-on; deploys without gVisor available will fail pod creation with a clear `runtimeClassName not found` error rather than silently falling back. We haven't audited what each managed-k8s flavor reports in that error path.
- Whether the `extraEnv` map should validate against an allowlist of variable names. Today it's pass-through to the pod, on the theory that the caller is host-side and trusted. If we ever expose `sandbox:open-session` over IPC (we don't today; the `@ax/ipc-http` action allowlist doesn't list it), `extraEnv` becomes a vector for setting env vars the runner shouldn't see, and the allowlist becomes mandatory.
- How `activeDeadlineSeconds` interacts with long-running tasks. One hour is a guess that fits typical chat sessions; agentic builds that run for hours WILL get killed. The right answer might be a per-session deadline override — flagged for design when the first user complaint lands.
- Whether the pod-create / readiness path should use the k8s `Watch` API instead of polling. We chose polling because it's simpler to mock, resilient to apiserver disconnects, and the 250ms cadence is cheap. The legacy v1 provider used Watch and we hit edge cases on reconnect; we don't want those back. But Watch is the "k8s-native" answer and we may revisit if poll load shows up in apiserver metrics.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
