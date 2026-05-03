# `deploy/` — Helm chart for k8s mode

This is how we put ax-next on a Kubernetes cluster. The chart lives at
`deploy/charts/ax-next/` and ships:

- A single-replica host Deployment (HPA + multi-replica is a follow-up PR).
- ServiceAccount + Role + RoleBinding scoped to a separate runner namespace,
  with the minimum verbs needed to spawn runner pods (`pods: create / delete /
  get / list / watch`). No `pods/exec`, no `pods/attach`, no cluster-scoped
  verbs.
- Two NetworkPolicies: one fences runner pods (no ingress, egress only to the
  host pod + DNS); one fences the host pod (ingress only from runner pods + the
  host's own namespace, egress only to postgres + k8s API + DNS + HTTPS).
- An optional embedded PostgreSQL (Bitnami subchart, pinned at `16.7.27`) — flip
  `postgres.external.enabled=true` to bring your own.
- A bootstrap Job that enables `pgvector` on the embedded postgres.

For the security walk: [`charts/ax-next/SECURITY.md`](charts/ax-next/SECURITY.md).

## What's NOT in this chart (yet)

These were intentionally cut from the v1 chart port. Don't add them back without
updating the security note.

- **Git server pod.** Legacy used a separate `ax-git-server` pod for multi-replica
  workspace storage. v2 is single-replica only this slice; `@ax/workspace-git`
  writes to a host-pod PVC. Multi-replica + a real git server is Week 10+.
- **Web proxy.** Legacy ran an HTTP forward proxy on the host pod for runner-pod
  egress. Week 10+.
- **Admin / OAuth templates.** Multi-tenant + auth slice is Week 9.5.
- **The agent image.** Built from `container/agent/Dockerfile` (see the
  step-by-step below). The same image is used for the host pod and for the
  per-session runner pods.

## Deploy to a local kind cluster

The kind path is the canary path — if the chart installs and the host pod is
healthy on kind, the chart's basic shape is sound. Real-cluster deploy is
covered in [`MANUAL-ACCEPTANCE.md`](MANUAL-ACCEPTANCE.md) once Task 21 lands.

```bash
# 0. Prereqs:
#    - docker
#    - kind: https://kind.sigs.k8s.io/docs/user/quick-start/
#    - helm 3: https://helm.sh/docs/intro/install/
#    - an Anthropic API key in $ANTHROPIC_API_KEY

# 1. Spin up a kind cluster.
kind create cluster --name ax-next-dev

# 2. Build and load the agent image. Same image powers the host pod
#    AND the per-session runner pods (bundled-runner-binary pattern).
#    See `packages/sandbox-k8s/SECURITY.md` for what the runner expects.
docker build -t ax-next/agent:dev -f container/agent/Dockerfile .
kind load docker-image ax-next/agent:dev --name ax-next-dev

# 3. Pull subchart deps. Helm caches them in `charts/ax-next/charts/`.
helm dependency update deploy/charts/ax-next

# 4. Create the runner namespace. The chart does NOT create it; the host
#    pod's RBAC binding scopes there.
kubectl create namespace ax-next-runners

# 5. Install. Generate the credentials key fresh — it encrypts secrets at
#    rest. Don't reuse keys across environments.
helm install ax-next deploy/charts/ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set credentials.key=$(openssl rand -base64 32) \
  --set anthropic.apiKey=$ANTHROPIC_API_KEY

# 6. Wait for the host pod and the postgres pod to come up.
kubectl rollout status deployment/ax-next-host
kubectl rollout status statefulset/ax-next-postgresql

# 7. Port-forward to the host pod and poke at it.
kubectl port-forward svc/ax-next-host 8080:80
```

To pick up code changes:

```bash
docker build -t ax-next/agent:dev -f container/agent/Dockerfile .
kind load docker-image ax-next/agent:dev --name ax-next-dev
kubectl rollout restart deployment/ax-next-host
```

## Linting and validating

```bash
helm lint deploy/charts/ax-next

# Render the full manifest — useful when sanity-checking RBAC, NetworkPolicies,
# or the runner namespace fences.
helm template ax-next deploy/charts/ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set credentials.key=dGVzdA== --set anthropic.apiKey=test
```

Schema validation (`kubeconform` or `kubeval`) is recommended but not bundled
in this repo's tooling yet. If you have either installed locally:

```bash
helm template ax-next deploy/charts/ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set credentials.key=dGVzdA== --set anthropic.apiKey=test \
  | kubeconform -strict
```

CI doesn't run `kubeconform` today; flagged as a follow-up.

## What you're agreeing to by installing

- The host pod gets a ServiceAccount with pod CRUD verbs in
  `namespace.runner`. If your cluster doesn't enforce
  `pod-security.kubernetes.io/enforce: restricted` on that namespace, a
  misconfigured workload there could blast wider than this chart can fence.
- Runner pods default to `runtimeClassName: gvisor`. Without gVisor on the
  cluster, pod creates fail loudly with `runtimeClassName not found`. Override
  to `""` only if you understand the trade-off (see SECURITY.md).
- NetworkPolicies need a CNI that enforces them (Calico, Cilium, native).
  Plain kind clusters don't enforce them. The kind-dev values disable the
  policies so it's clear they're off rather than silently rendered no-ops.
- `AX_CREDENTIALS_KEY` is required and never has a default. If you lose it,
  the secrets it encrypted become unrecoverable. Treat it like a database
  password.

## Credentials key rotation — please read before `helm upgrade`

This is the bit that bites people, so we want to be loud about it.

`AX_CREDENTIALS_KEY` encrypts every credential we store at rest. If we change
the key, every credential encrypted with the OLD key is immediately
unrecoverable. There is no recovery path. We've designed the chart to make
accidental rotation hard, but we still need help from the operator side.

**The rule:** stash the key somewhere durable on day one (a sealed-secret, an
external secrets manager, your own vault — whatever you trust), and pass the
SAME value to every `helm upgrade`. Re-running `openssl rand -base64 32` on
every upgrade silently bricks all stored credentials.

```bash
# DO THIS once, at install time, and save the output somewhere safe:
export AX_CREDENTIALS_KEY=$(openssl rand -base64 32)
helm install ax-next deploy/charts/ax-next \
  --set credentials.key="$AX_CREDENTIALS_KEY" \
  --set anthropic.apiKey=$ANTHROPIC_API_KEY \
  ...

# DO THIS for every upgrade — same key, every time:
helm upgrade ax-next deploy/charts/ax-next \
  --set credentials.key="$AX_CREDENTIALS_KEY" \
  --set anthropic.apiKey=$ANTHROPIC_API_KEY \
  ...
```

The chart's `hook-secret.yaml` template has a belt-and-suspenders guard: if
the Secret already exists with a `credentials-key`, we keep that value and
ignore whatever `--set credentials.key=...` was passed. So passing a fresh
random value on `helm upgrade` is a no-op rather than a disaster. But:

- This guard only fires when the existing Secret is reachable from the cluster
  Helm is talking to. GitOps tools that render manifests offline (Argo CD with
  `helm template`, Flux's `HelmRelease`, plain `helm template | kubectl apply`)
  do NOT see the existing Secret and WILL overwrite the key on the next sync.
- If you delete the Secret (e.g., manually, or via `helm uninstall` without
  `--keep` — note that `resource-policy: keep` already protects it on
  uninstall), the guard can't help. The key is gone.

If you genuinely need to rotate the key, do it deliberately: re-encrypt every
credential with the new key first, then update the Secret. We do not have a
built-in command for this yet (flagged as a follow-up). Until we do, treat
rotation as a manual operation under careful supervision.

See [`packages/credentials/SECURITY.md`](../packages/credentials/SECURITY.md)
for the threat model around the key itself.
