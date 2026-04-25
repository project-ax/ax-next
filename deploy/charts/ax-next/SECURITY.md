# Security — `deploy/charts/ax-next`

This Helm chart isn't application code, but it IS the perimeter that turns
`@ax/sandbox-k8s`'s in-pod hardening into a real security boundary. The
plugin sets the right pod-spec fields; the chart binds the right RBAC,
applies the right NetworkPolicies, and pins the right subchart. Misconfigure
either side and the isolation story collapses. This note captures the
`security-checklist` walk for the Week 7-9 chart landing.

## Security review (chart)

- **Sandbox:** Host pod's ServiceAccount gets a Role with exactly five verbs on
  `pods` (`create`, `delete`, `get`, `list`, `watch`) in ONE namespace
  (`.Values.namespace.runner`). No `pods/exec`, no `pods/attach`, no `pods/log`,
  no `patch`/`update`, no cluster-scoped reach. Two NetworkPolicies enforce the
  fence: runner pods have empty ingress + egress only to the host pod and DNS;
  the host pod ingresses from runner pods + its own namespace and egresses only
  to postgres / k8s API / DNS / HTTPS. Pod `securityContext` defaults
  (`runAsNonRoot`, drop ALL capabilities, read-only root, no SA token,
  `runtimeClassName: gvisor`) are inherited from `@ax/sandbox-k8s` —
  see `packages/sandbox-k8s/SECURITY.md`. The chart's job is to make sure those
  defaults are reachable at runtime, not to redeclare them.
- **Injection:** N/A. The manifests are static templates. No model output, no
  tool output, and no untrusted input flows into the chart at render time.
  Helm values are operator-provided; treat them like any other config file.
- **Supply chain:** One subchart dep, pinned exact: `bitnami/postgresql@16.7.27`
  (Apache-2.0). The Chart.lock digest is committed; subchart tarballs are not.
  Bitnami's own move from `bitnami/` to `bitnamilegacy/` images is a wrinkle
  worth flagging — see "Supply chain" below.

## Sandbox / RBAC

The chart's ONE RBAC grant is to the host pod's ServiceAccount. Everything
else flows from that.

### The Role — every verb justified

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "delete", "get", "list", "watch"]
```

That's it. Five verbs on one resource in one namespace.

- `create` — `@ax/sandbox-k8s` calls `createNamespacedPod` to spawn a runner
  for each session. Without it, no sessions.
- `delete` — `killPod` tears the pod down at session end (and as the safety
  net for `activeDeadlineSeconds` failures). Without it, runner pods leak
  forever.
- `get` — readiness polling reads pod status to learn `phase: Running` and
  the assigned `podIP` (which becomes the runner endpoint).
- `list` — used by the lifecycle code to enumerate active runner pods on
  startup recovery (e.g., after a host pod restart, sweep orphaned runners).
- `watch` — `watchPodExit` observes terminal pod phase (`Succeeded` /
  `Failed`) and routes that into `session:terminate`. Could be replaced with
  poll, but watch is cheaper at apiserver and we already handle disconnect
  cases.

### What we deliberately do NOT grant

The legacy v1 chart's Role granted `pods/exec`, `pods/attach`, `pods/log`,
and `patch`. We dropped all of them.

- `pods/exec`, `pods/attach`, `pods/portforward` — the host never enters a
  runner pod. All host↔runner traffic is HTTP over TCP via the runner pod's
  port (the `runnerEndpoint` returned by `sandbox:open-session`). Granting
  exec would mean a host-side compromise could shell into runners; we don't
  need it, so we don't have it.
- `pods/log` — no debugging via the API. If an operator needs to inspect a
  runner's stdout, they `kubectl logs` directly. The host has no use case
  that needs streaming pod logs through its own SA.
- `patch` / `update` — runner pods are immutable from the host's point of
  view. Need a different config? Make a new pod. There's no path that
  requires editing an existing one.
- `secrets`, `configmaps` — host doesn't read these via SA at runtime.
  Its own secrets come in via the kubelet at pod start.
- Any cluster-scoped resource — Role, not ClusterRole. The host's reach is
  scoped to the runner namespace and nothing else.

### What this means in practice

A complete host-pod compromise (someone runs arbitrary code with the host's
SA token in hand) yields:

- Pod CRUD in `.Values.namespace.runner` — the attacker can spawn pods,
  delete pods, watch their status. They cannot escalate to other namespaces.
- They cannot run code inside an existing pod via the API (no exec, no attach).
- They cannot read or modify Secrets / ConfigMaps via the API.
- They cannot touch nodes, RBAC, networking, or any other cluster resource.
- They CAN spawn pods that run whatever image they want, with whatever
  command — but those pods inherit the host's namespace's PodSecurity
  admission policy, which production deploys SHOULD pin to `restricted`.
  See "Known limits" below.

If the chart ever needs to grant additional verbs, the SECURITY.md walk
needs to be redone. Don't loosen this without a fresh threat-model pass.

## NetworkPolicies — what crosses

Two policies, both gated by `.Values.networkPolicies.enabled` (default
`true`). Default-on means a typo in values misses the perimeter; we accept
that over the alternative (default-off and an operator forgets to flip it).

### `sandbox-restrict.yaml` — runner pod fence

Applies to pods labeled `ax.io/plane: execution` in
`.Values.namespace.runner`.

- **Ingress:** empty list. `policyTypes: ["Ingress"]` with no rules denies
  everything. Nothing inside or outside the cluster can connect TO a runner
  pod. The host doesn't need to (runner connects out to host); other pods
  shouldn't be able to.
- **Egress allowed to:**
  - The host pod's HTTP port (cross-namespace match — host runs in
    `.Release.Namespace`, runners run in `.Values.namespace.runner`).
  - DNS (UDP/TCP 53) so cluster DNS resolves.
- **Egress denied to:** the broader cluster, the k8s apiserver, the public
  internet. Tools that need network reach (npm install, curl) WILL fail
  until the web-proxy lands in Week 10+. That's by design.

### `agent-runtime-network.yaml` — host pod fence

Applies to pods labeled `app.kubernetes.io/name: <release>-host` in
`.Release.Namespace`.

- **Ingress allowed from:**
  - Runner pods (cross-namespace) on the host's HTTP port — this is the
    inbound IPC connection.
  - Anything in the host's own namespace on the same port — covers ingress
    controllers, port-forwards, mesh sidecars.
- **Egress allowed to:**
  - Postgres (5432) — DB writes.
  - k8s API server (443 + 6443; the dual port covers Calico DNAT edge
    cases).
  - DNS.
  - HTTPS (443) — Anthropic API calls.

### What happens without a NetworkPolicy-enforcing CNI

NetworkPolicies are not self-enforcing. They're CRDs the cluster's CNI
either implements or ignores. Plain kind clusters ship with a CNI that
DOES NOT enforce them — the chart renders the policies, the apiserver
accepts them, and they silently no-op.

We handle this by setting `networkPolicies.enabled: false` in
`kind-dev-values.yaml` so kind installs don't render orphaned policies.
Production clusters are expected to use Calico, Cilium, or a comparable
CNI; the chart's README and NOTES.txt both flag the requirement.

## Pod hardening — the chart's role vs the plugin's

The chart does NOT set any pod `securityContext` fields. That's
`@ax/sandbox-k8s`'s job — see `packages/sandbox-k8s/SECURITY.md`. The
plugin sets:

- `runAsNonRoot: true`, `runAsUser: 1000`
- `allowPrivilegeEscalation: false`
- `capabilities: { drop: ['ALL'] }`
- `readOnlyRootFilesystem: true` with `emptyDir`-backed `/tmp` and
  `/workspace`
- `automountServiceAccountToken: false`
- `hostNetwork: false`
- `restartPolicy: 'Never'`
- `activeDeadlineSeconds: 3600`
- `runtimeClassName: <values.sandbox.runtimeClassName>` (gvisor by default)

The chart's contribution to that posture is feeding the `runtimeClassName`
through (`K8S_RUNTIME_CLASS` env on the host pod) and creating the
RoleBinding so the host's SA can do pod CRUD. If the plugin ever changes
the pod spec defaults, those changes happen in the plugin and the chart
re-reads them. The chart isn't trying to be a second source of truth for
runner pod security.

The HOST pod itself does NOT have a hardened `securityContext` on the
deployment template today. It needs to write to its workspace PVC and run
as whatever UID the agent image expects. Production hardening of the host
pod (non-root host, restricted SA, dedicated SCC) is a follow-up; flagged
in "Known limits."

## git-server pod

When `workspace.backend: http` and `gitServer.enabled: true`, the chart
ships a separate `<release>-git-server` Deployment that owns the bare git
repo on a dedicated PVC. Host pods read and write workspace state by
talking to it over HTTP. This is how multi-replica host scaling works
without two hosts racing each other for the same gitdir.

The protocol-level walk (wire schema, auth handshake, path validation,
token-rotation pain) lives in `packages/workspace-git-http/SECURITY.md` —
read that first if you're chasing how the bytes flow. This section is
the operator's view: what the chart actually deploys, how it's locked
down, and what we're on the hook for at install time.

### One replica, by design

The Deployment is pinned to `replicas: 1`. The per-repo mutex inside
`@ax/workspace-git-core` is in-process — running two server replicas
against the same PVC would race on `refs/heads/main` and silently corrupt
the workspace. The chart enforces single-writer by construction. If we
ever need horizontal scale here, it's an external-lock conversation, not
a `replicas: 2` toggle.

### Pod hardening

Unlike the host pod, the git-server pod IS hardened in the deployment
template (Task 15). The chart sets, on both pod and container
`securityContext`:

- `runAsUser: 1000`, `runAsNonRoot: true` — non-root, fixed UID.
- `allowPrivilegeEscalation: false` — no setuid surprises.
- `readOnlyRootFilesystem: true` — the only writable mount is the PVC
  (mounted at the bare-repo path) and a sized `/tmp` `emptyDir` (capped
  at 64Mi via `sizeLimit`).
- `capabilities: { drop: ['ALL'] }` — no Linux capabilities at all.

If the process gets popped, the attacker is a non-root user with no
shell, no writable rootfs outside one PVC mount and 64Mi of tmpfs, and
no caps. Combined with the NetworkPolicy below, the local blast radius
is small. The data blast radius is "every workspace's content," and we
discuss that in the package SECURITY note.

### NetworkPolicy: dual gate

`templates/networkpolicies/git-server-network.yaml` (Task 17) gates the
listener with two doors that both have to open:

- **Ingress:** allowed only from pods labeled as host pods
  (`app.kubernetes.io/component: host`) in the same namespace. Runner
  pods are NOT allowed — they don't speak workspace protocol and there's
  no legitimate reason for one to reach the git-server. If you ever see
  a runner trying to connect, that's the bug, not the policy.
- **Egress:** none. The git-server is a leaf service. It doesn't call
  out to anything — not DNS, not the apiserver, not HTTPS. Empty egress
  rules with `policyTypes: ["Egress"]` deny everything.

The full gate is "in-cluster network reach (NetworkPolicy) → bearer
token check (`crypto.timingSafeEqual` against the env-loaded service
token)." Both must succeed. The NetworkPolicy is the perimeter; the
bearer token is the wall behind it. Same posture as `@ax/ipc-http`,
same trade-off about NetworkPolicy enforcement requiring a real CNI
(see "What happens without a NetworkPolicy-enforcing CNI" above —
applies here too).

### Auth Secret

`<release>-git-server-auth`, key `token`. Two ways it gets populated:

- **Operator-provided** via `gitServer.auth.token` in values. Use this
  for GitOps-style deterministic deploys where the secret material lives
  in your secrets manager and the chart just renders it.
- **Lookup-or-generate** at install time when no override is set. The
  chart looks up the existing Secret and reuses its `token`; if there
  isn't one, it generates a fresh `randAlphaNum 48`. So `helm upgrade`
  doesn't rotate the token out from under a running host pod just
  because someone re-ran the install command.

The Secret carries `helm.sh/resource-policy: keep` so `helm uninstall`
doesn't nuke it either. We'd rather leave a Secret behind than rotate a
token under a running host's feet.

### PVC retention

The git-server PVC also carries `helm.sh/resource-policy: keep`. A
`helm uninstall` will NOT delete it. The bare repo is the single source
of workspace truth; we won't let `helm uninstall --purge` accidentally
end every session's history. Operators who actually want to wipe the
workspace store have to delete the PVC explicitly, on purpose, with
both hands on the wheel.

### Token rotation: real operational pain

The token lives in the Secret above. Rotating it means writing a new
value and rolling-restarting **both** Deployments:

1. The git-server Deployment, so the server's expected-token env
   updates.
2. Every host Deployment, so each host plugin reads the new token at
   process start.

During the rollout window, some pods will have the old token and some
the new one. Mismatched-token requests fail with 401, the host plugin's
retry budget exhausts, and workspace operations fail loudly until the
rollouts converge. We'd rather flag this than hide it: token rotation
in this slice is an operator-visible event, not a silent background
swap.

A future improvement is **dual-token acceptance**: the server accepts
`tokenOld OR tokenNew` for the rotation window, the operator rolls
hosts to `tokenNew`, then drops `tokenOld` from the server config.
That's not in this slice. Listed here so the next person who has to
rotate doesn't think they're missing something.

### Known limit: no disaster recovery

The git-server PVC is the **single source of workspace truth**. If the
PVC dies — node failure with non-replicated storage, accidental delete,
filesystem corruption, ransomware on the underlying volume — every
workspace is lost. The chart ships zero DR primitives. No backup, no
replication, no `git bundle` cron, no snapshot lifecycle.

This is operational, not theoretical. We're on the hook for storage-
class-level backup at the cluster layer, not at the chart layer.
Concrete options operators should pick at least one of:

- Volume snapshots via the cluster's CSI driver (e.g., AWS EBS
  snapshots, Longhorn snapshots, GCE PD snapshots).
- A storage class that replicates across zones or nodes (e.g., Longhorn
  with replica count > 1, cloud-provider regional volumes).
- A `git bundle` cron that ships the bare repo to off-cluster object
  storage on a schedule.

We're being upfront about this because "the workspace store is on one
PVC and there's no backup" is the kind of detail that's easy to miss
until the day it matters and impossible to retrofit afterward. If
nothing else, please pick one before this leaves canary status.

## Boundary review

- **Alternate impl this hook could have:** N/A — a Helm chart doesn't
  expose hooks. The chart's "API" is its values surface, and the design
  goal there is to keep `@ax/sandbox-k8s`-specific concepts out of values
  names. We have `runtimeClassName` (gVisor flavor; would still be
  meaningful for any sandbox provider that uses runtime classes), `replicas`
  (workload count), `namespace.runner` (tenancy), but no `podName`,
  `socketPath`, or `containerCommand` shapes. Values names don't leak the
  k8s sandbox over the bus surface; they're just operator config.
- **Payload field names that might leak:** N/A; no hook surface.
- **Subscriber risk:** N/A.
- **Wire surface:** N/A.

## Supply chain

One subchart dep. Pinned exact. The Bitnami image-rename move complicates
the picture — read past the version pin.

### `bitnami/postgresql@16.7.27`

- **License:** Apache-2.0.
- **Pin:** Exact (`version: "16.7.27"` in `Chart.yaml`). Chart.lock is
  committed; the digest
  (`sha256:9910a60709e53ddcd2457242238a314715d5a3ba61e56bd80531314ac2b38cbe`)
  is the supply-chain anchor. Subchart tarballs themselves are gitignored —
  the lockfile digest is the verification surface.
- **App version:** chart `16.7.27` ships PostgreSQL `17.6.0`.
- **Source:** `https://charts.bitnami.com/bitnami`, official Bitnami chart
  repository. Maintained by Bitnami (now part of Broadcom/VMware). Long-
  standing repo; well-trafficked.
- **Why this exact version:** named in the Week 7-9 plan as the cut to
  port (`postgresql-16.7.27.tgz`). It's the latest 16.x release at the time
  of pin; we deliberately pinned a stable 16.x rather than the 18.x line
  because legacy v1 also uses the 16.x line and we wanted minimum delta in
  the port. Bumping to 18.x is a future hardening pass.
- **Image pulled by the subchart:**
  - `docker.io/bitnami/postgresql:17.6.0-debian-12-r4` — primary container.
  - `docker.io/bitnami/os-shell:12-debian-12-r51` — init helper.
  - `docker.io/bitnami/postgres-exporter:0.17.1-debian-12-r16` — metrics
    sidecar (off by default in our values; we don't enable
    `metrics.enabled`).

### Known issues at the pinned version

We did not exhaustively audit CVE feeds for `bitnami/postgresql:17.6.0`
or for the chart at `16.7.27`. The Bitnami catalog is maintained, and
upstream postgres 17.6.0 is a current patch release; we'd be surprised to
find an unpatched critical at this revision. **But we're being honest:
we couldn't easily verify "no known CVEs at the pinned version" and we'd
rather flag it than fake confidence.** Production operators should check
their own CVE feeds before deploying.

There's also a **Bitnami repo migration** wrinkle worth knowing about:
upstream Bitnami announced in late 2025 that the historical
`docker.io/bitnami/*` image refs are being moved to
`docker.io/bitnamilegacy/*`, and the `bitnami/*` namespace will host a
slimmed-down "secure images" line going forward. The legacy chart used to
override images to `bitnamilegacy/postgresql` for that reason. The
`16.7.27` chart we pin still references `docker.io/bitnami/postgresql` in
its annotations; if Bitnami removes that tag in the future, pulls will
break. Operators who hit a pull failure should override:

```yaml
postgresql:
  image:
    registry: docker.io
    repository: bitnamilegacy/postgresql
    tag: 17.6.0-debian-12-r4
```

Flagged for re-review when Bitnami's transition completes.

### What's NOT a supply chain risk

- The chart itself adds no new application-code dependencies. `helm` is
  the only tool that touches it.
- We don't `helm repo add` from random forks; the only upstream is
  `https://charts.bitnami.com/bitnami`.
- Subchart tarballs are gitignored. We rely on Chart.lock's digest, not
  on a vendored copy. If we wanted a stronger guarantee, vendoring the
  tarball is a one-line change — flagged.

### What we'd add later

- Vendor the subchart tarball into the repo (commit
  `charts/postgresql-16.7.27.tgz`) so installs don't require a working
  chart-repo cache. Trade-off: extra repo size, fewer moving parts at
  install. Probably worth it before this leaves "kind canary" status.
- Pin chart values for the subchart's own resource limits, network
  policies, and persistence settings. Today we pass through Bitnami
  defaults; some of those defaults are debatable (e.g., the default
  resource requests are zero).
- Run `kubeconform` / `kubeval` in CI against `helm template` output to
  catch schema drift on chart upgrades. Today validation is local-only
  and not enforced.

## Known limits

- **Runner namespace not created by the chart.** The host's RoleBinding
  scopes to `.Values.namespace.runner`, but the chart doesn't `kubectl
  create namespace` it. Operators have to create it ahead of install
  (NOTES.txt and README.md both flag this). We could create it from a
  pre-install hook, but doing so would mean either `cluster-admin` at
  install time (bad) or a separate "operator" SA (more chart, more knobs).
  Today: operator does it.
- **PodSecurity admission not asserted.** The chart doesn't label its
  namespaces with `pod-security.kubernetes.io/enforce: restricted`. A
  misconfigured cluster could allow a privileged workload in the runner
  namespace, sidestepping the runner pod's `runAsNonRoot` defense (a
  different pod with `privileged: true` could run alongside). This is a
  cluster-policy concern, not the chart's, but a future hardening pass
  could add the label and let the chart fail loudly if the cluster's
  admission webhook isn't configured for it.
- **Host pod has no `securityContext` hardening.** The host needs to write
  to its workspace PVC and read its config; we didn't pin a specific UID,
  drop capabilities, or set `readOnlyRootFilesystem` on it. If the host
  pod is compromised, an attacker has whatever the agent image's default
  user can do, plus the SA token. The SA token is the bigger concern, and
  it's already minimum-verb; the in-container reach is secondary. Hardening
  the host pod itself is a follow-up.
- **No PDB (PodDisruptionBudget) for the host.** Single-replica + a node
  drain = downtime. Acceptable for this slice (HPA + multi-replica is a
  follow-up); not acceptable for a real production deploy. Chart doesn't
  ship a PDB template yet.
- **No pre-install hook to verify CNI / gVisor presence.** A `helm install`
  on a cluster without gVisor will succeed at install time and fail at
  first session creation (`runtimeClassName not found` from the apiserver).
  Not a security regression, but a confusing failure mode. Could be improved
  with a dry-run check in NOTES.txt or a pre-install Job that validates the
  cluster shape.
- **No subchart vendoring.** See supply chain above. Today the subchart
  tarball is gitignored and Chart.lock's digest is the pin. A determined
  attacker against `charts.bitnami.com` could in theory swap the artifact
  underneath the digest, but Helm's `verify` flag would catch a digest
  mismatch. We don't run `--verify` in CI.
- **No `kubeconform` or `kubeval` in CI.** Local validation only. A schema
  regression in a chart edit would land. Adding it is cheap; flagged.
- **Web proxy missing.** Runner pods can't reach the public internet at all
  today. Tools that need npm/pip/curl will fail. The web-proxy comes in
  Week 10+; until then, k8s mode is "agent can think but can't fetch."

## What we don't know yet

- Whether the kind-dev path (no NetworkPolicy enforcement, no gVisor) is
  going to confuse operators when they go to a real cluster. Smoke-testing
  on a Calico'd kind setup is worth doing once.
- Whether `pods: list` in the Role is actually used today, or whether it's
  load-bearing only for the "startup recovery" path that hasn't shipped.
  If unused, we should drop it. Tracked alongside the lifecycle hardening
  work in `@ax/sandbox-k8s`.
- How operators will rotate `AX_CREDENTIALS_KEY`. The chart marks the
  Secret `helm.sh/resource-policy: keep`, so a `helm uninstall` doesn't
  nuke it, but there's no chart-side rotate flow. Operators today: set a
  new value in the Secret manually, restart the host pod, re-set
  credentials. Not great. The credentials plugin's SECURITY.md flags this
  as a Week 13+ KMS-backed concern.
- Whether `Recreate` strategy on the host Deployment (PVC is RWO) is going
  to bite during in-place upgrades. With one replica + Recreate, a deploy
  takes the host down briefly. Acceptable for now, not for production.
- Whether the postgres init Job's `bitnami/postgresql:16` image tag is
  going to break after the Bitnami repo migration. We haven't pinned a
  digest there; it's a moving tag. Flagged.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it
on Hacker News. Please email `vinay@canopyworks.com`.
