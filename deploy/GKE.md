# Deploying ax-next to GKE Autopilot

## Optional Agent Sandbox lifecycle backend

AX can use the GKE Agent Sandbox controller to own runner lifecycle instead of
creating bare Pods. The default remains `sandbox.backend=pod`. Apply
[`gke-agent-sandbox-values.yaml`](charts/ax-next/gke-agent-sandbox-values.yaml)
after `gke-values.yaml` to select the controller backend on a staging deployment.

Before selecting it:

1. [Enable Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox)
   on the intended cluster and provision its gVisor nodes. The managed add-on
   currently requires GKE `1.36.3-gke.1767000` or later for `v1beta1`.
   This overlay does not install or upgrade
   the controller. For a self-managed controller, pin its release and image digests.
2. Confirm the served API version:
   `kubectl get crd sandboxes.agents.x-k8s.io -o jsonpath='{.spec.versions[?(@.served==true)].name}'`.
   The overlay uses `v1beta1`; the upstream `v0.4.6` controller serves `v1alpha1`,
   so set `sandbox.agentSandboxApiVersion=v1alpha1` for that release.
3. Confirm the runner nodes have `sandbox.gke.io/runtime=gvisor` and admit the
   matching `NoSchedule` toleration. Keep the TCP credential proxy and the
   chart's NetworkPolicies enabled. Helm rejects an unsafe combination; host
   startup checks that its service account can list the configured Sandbox API.

Use the existing image, credentials, storage, namespace and release arguments
from the install procedure below, with this additional values file last:

```bash
-f deploy/charts/ax-next/gke-agent-sandbox-values.yaml
```

This stage creates one fresh `Sandbox` per AX session. The same runner image,
session token, installed skills, service sidecars and mounts are supplied at
creation. Writable user-file ownership is prepared by a short-lived, fixed
`chown` pod before the non-root Sandbox starts; the preparation pod has only
`CAP_CHOWN`, the agent's own mount, and no session credentials. Read-only memory
mounts need no ownership preparation. File reads and agent-deletion cleanup
continue using their existing host-managed pods.

The runner connects out to AX IPC and the credential proxy. There is no Sandbox
Router, inbound Service, template, claim or warm pool. Direct Sandbox resources
use AX's existing network fence; do not add a policy permitting general internet
egress. NetworkPolicy allowances combine, so a permissive policy would open a
route around the credential proxy.

The resource and Pod each have a lifetime cap. Cancellation revokes the AX
token before deleting the parent Sandbox with foreground garbage collection and
a UID precondition. A missing or replaced backing Pod ends the AX session;
the host does not adopt a replacement as a continuation. Restarting the host
requires deleting Sandbox resources **before** deleting runner Pods; see
[the restart procedure](README.md#restarting-the-host-pod-delete-the-runner-pods-first).

Before promotion, walk both runners on GKE: chat plus a tool call, warm reuse
between turns, cancellation, Pod death, host restart, durable file writes,
read-only memory, service sidecars, and attempts to access another agent's files
or bypass the proxy. Measure first useful output, including workspace hydration.
Warm pools and process snapshots remain separate work: pooling needs an
authenticated session bootstrap, and snapshots must not restore stale tokens.

Validation for this stage: the package canary exercises both runner selections,
session revocation, rollback, replacement detection, mount preparation,
read-only memory and sidecar rendering with mocked cluster APIs. An isolated
kind cluster with upstream controller `v0.4.6` also passed real hook launch,
foreground parent/child deletion, and backing-Pod recreation detection. That
local lifecycle probe used a fixture process and a `gvisor` RuntimeClass backed
by `runc`; it does not establish gVisor isolation, GKE admission compatibility,
network enforcement, real model turns or startup performance. The GKE walk above
is still required before switching the production backend.

An isolated probe on GKE `1.36.4-gke.1247000` also passed managed `v1beta1`
admission, real gVisor execution (`4.19.0-gvisor`), UID 1000 execution without
a service-account token, cancellation with token revocation and parent/child
cleanup, and session termination after backing-Pod deletion. The first admission
attempt caught missing resource limits on `sdk-scaffold`; CPU and memory bounds
now cover that init container, with a regression test. The fixture became ready
in 4.4 s and 3.3 s on an existing node; these are fixture timings, not chat latency.
A temporary deny-all NetworkPolicy blocked an outbound TCP connection. The probe
used no production session credentials or persistent mounts, and its namespace
was removed. It did not test real model turns, AX proxy allowances, Filestore,
read-only memory, service sidecars, cross-agent isolation or host restart.

## Existing deployment procedure

This is the real-cluster companion to [`MANUAL-ACCEPTANCE.md`](MANUAL-ACCEPTANCE.md)
(which covers kind). It walks a first production-shaped deploy onto a **GKE
Autopilot** cluster, with the security posture the design actually targets:
gVisor-sandboxed runner pods, enforced NetworkPolicies, a TCP credential-proxy,
Cloud SQL for the database, and a Google-managed HTTPS certificate.

It pairs with the overlay at
[`charts/ax-next/gke-values.yaml`](charts/ax-next/gke-values.yaml). Anything
marked `# >>> EDIT` there (and every `<PLACEHOLDER>` below) is yours to fill in.

We're a nervous crab, so two things up front, honestly:

- **Some of this is wired but unwalked.** The TCP credential-proxy posture and
  the GCE-ingress path are unit-tested and templated, but nobody has run the
  whole chain end-to-end on a live gVisor cluster yet. If something here is going
  to surprise us, it's most likely one of those two. The
  [Troubleshooting](#troubleshooting) section names the failure modes we expect.
- **This is the lean-but-real path, not the fully-hardened one.** It gets you a
  working, HTTPS-fronted, sandboxed deployment. The things we deliberately left
  for a second pass (Workload Identity, GCS object storage, multi-replica,
  host-pod hardening, automated image CI) are listed under
  [What this does NOT cover](#what-this-does-not-cover). None of them block first
  light; all of them matter before you trust real users to it.

> **Seeing "the agent stopped unexpectedly" on the first chat after an idle
> spell?** That's Autopilot cold-start, not a bug in your install — there's no
> warm gVisor node, Autopilot takes longer than the runner's 60 s readiness
> budget to provision one, and the session gives up. The durable fix is a
> **Standard cluster with one always-on gVisor node**:
> [Migrating to a Standard cluster](#migrating-to-a-standard-cluster-with-a-warm-node-pool-fixing-runner-cold-start).

---

## Why Autopilot changes things (the short version)

Autopilot is opinionated, and that opinion intersects almost every choice here.
The good news is most of it works *in our favour*:

| Autopilot behaviour | What it means for us |
|---|---|
| Schedules `runtimeClassName: gvisor` pods automatically | No GKE Sandbox node pool to create or manage. Just ask for gvisor and Autopilot places it. (Needs GKE ≥ 1.27.4-gke.800 — any current Autopilot.) |
| `hostPath` is banned | We can't use the kind socket posture. The credential-proxy runs in **TCP mode** (a ClusterIP Service) instead. The overlay already sets this. |
| Runs Dataplane V2 (Cilium) | NetworkPolicies **actually enforce**. We leave them ON. The host egress policy already permits 5432/443/DNS, so Cloud SQL + Anthropic + DNS work unchanged. |
| Always VPC-native | GCE Ingress wires a NEG straight to the ClusterIP Service — no NodePort needed. Also a prerequisite for Cloud SQL private IP. |
| Adjusts resource requests to floors + a 1:1–1:6.5 CPU:mem ratio | We pin host requests == limits so nothing gets silently resized. Runner pods use the plugin's defaults and **will be rounded up** (≥ 0.25 vCPU / 0.5 GiB billed per session pod). |
| `HttpLoadBalancing` add-on can't be disabled | The managed Ingress controller is always there — exactly what we want. |

---

## Prerequisites

- An existing **GKE Autopilot** cluster. You'll point `kubectl` at it in Step 0
  below — don't assume your current context already is it. A local kind/minikube
  context is a classic mix-up, and every `kubectl` step here would then silently
  target the wrong cluster.
- `gcloud`, `kubectl`, `helm` 3.x, and `docker` with `buildx`.
- A **domain name** you control (for the managed certificate + DNS).
- Project IAM enough to create: Cloud SQL instances, Artifact Registry repos,
  global addresses, and (one-time) a VPC peering for private services access.
- The repo checked out locally (you build the image from it).

Set these once and reuse them throughout:

```bash
export PROJECT_ID=<your-project>
export REGION=us-central1            # your cluster's region
export VPC=default                   # the cluster's VPC network name
export DOMAIN=ax.example.com         # the hostname you'll serve on
export TAG=v0.0.1                    # an immutable image tag (NOT :latest)
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/ax-next/agent
```

---

## Step 0 — Point kubectl at the GKE cluster

Every `kubectl` step below targets your **current context** — so make it the GKE
cluster first. If you've been running ax-next on kind, your context is almost
certainly still pointed there, and the namespace/secret/install steps would land
on the wrong cluster.

```bash
gcloud container clusters get-credentials <cluster-name> --region $REGION --project $PROJECT_ID
kubectl config current-context   # sanity-check: should name your GKE cluster
```

---

## Step 1 — Cloud SQL (Postgres, private IP)

### 1a. One-time: private services access for your VPC

Private IP requires a peering range so Cloud SQL can attach to your VPC. Skip if
your VPC already has one.

```bash
gcloud compute addresses create google-managed-services-$VPC \
  --global --purpose=VPC_PEERING --prefix-length=16 --network=$VPC \
  --project=$PROJECT_ID

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-$VPC --network=$VPC \
  --project=$PROJECT_ID
```

### 1b. Create the instance, database, and user

```bash
export DB_PASSWORD=$(openssl rand -base64 24)   # SAVE THIS (goes in a Secret below)

# --edition=ENTERPRISE is REQUIRED to use a custom tier (db-custom-*). Without it,
# a project that defaults new instances to ENTERPRISE_PLUS rejects the custom tier
# ("Invalid Tier db-custom-2-7680 for ENTERPRISE_PLUS Edition"). Enterprise Plus
# only takes predefined db-perf-optimized-N-* machines. --storage-auto-increase
# (GA) grows the disk before it fills, so you never run out. To CAP that growth,
# --storage-auto-increase-limit=N is beta-only on create — add it later via
# `gcloud beta sql instances patch ax-next-db --storage-auto-increase-limit=N`
# or the Console. Storage only ever grows; it can't shrink in place.
#
# The last three flags are the database's side of "Backups and disaster recovery"
# below: a daily automated backup (on by default; we pin the time to 09:00 UTC and
# keep 14 of them instead of the default 7) plus point-in-time recovery, which
# is OFF unless you ask for it. Deletion protection is turned on later, by
# `deploy/gke/backups.sh enable`, so the delete-and-retry advice in
# Troubleshooting still works while you are building this.
gcloud sql instances create ax-next-db \
  --project=$PROJECT_ID --region=$REGION \
  --database-version=POSTGRES_17 \
  --edition=ENTERPRISE --tier=db-custom-2-7680 \
  --storage-auto-increase \
  --network=projects/$PROJECT_ID/global/networks/$VPC \
  --no-assign-ip \
  --ssl-mode=ENCRYPTED_ONLY \
  --backup-start-time=09:00 \
  --retained-backups-count=14 \
  --enable-point-in-time-recovery

gcloud sql databases create ax_next --instance=ax-next-db --project=$PROJECT_ID
gcloud sql users create ax_next --instance=ax-next-db --password="$DB_PASSWORD" --project=$PROJECT_ID

# Grab the private IP — you'll need it for the DSN. --no-assign-ip means the
# instance has ONLY a private address, so ipAddresses[0] is it.
export DB_PRIVATE_IP=$(gcloud sql instances describe ax-next-db --project=$PROJECT_ID \
  --format='value(ipAddresses[0].ipAddress)')
echo "Cloud SQL private IP: $DB_PRIVATE_IP"
```

> **Why private IP + a DSN, not the Auth Proxy?** The host Deployment template
> has no sidecar injection point today, so the Cloud SQL Auth Proxy (the
> Google-recommended pattern) would need a chart change. Private-IP + a DSN
> Secret works with the chart as-is. Moving to the Auth Proxy + Workload Identity
> + IAM auth is a documented follow-up (see [the bottom](#what-this-does-not-cover)).

> **Neither sizing choice locks you in.** Storage can be increased online with no
> downtime at any time (it only ever grows — you can't shrink in place without an
> export/migrate), and you can later do an in-place **Enterprise → Enterprise Plus**
> edition upgrade (sub-second downtime, keeps the same name / IP / DSN) if you
> need the data cache or more performance. So start small and grow.

### 1c. Enable pgvector

External Postgres **skips the chart's pgvector init job** — you enable the
extension yourself. The default chat path doesn't need it, but it's harmless to
run and saves a confusing failure later if you turn on memory features. This runs
a throwaway pod *inside* the cluster (the only thing that can reach the private IP
right now):

```bash
# NB: don't use `-i`/attach here. On GKE the apiserver→node streaming path
# (konnectivity) can briefly be unavailable right after Autopilot spins up a
# node, so attach/logs fail with "No agent available" even though the pod runs
# fine. Instead, run it detached and confirm via the pod's *status* phase, which
# comes through a different path. CREATE EXTENSION IF NOT EXISTS is idempotent,
# so a re-run after a streaming blip is harmless.
kubectl run pgvector-init -n default --restart=Never \
  --image=postgres:17 --env="PGPASSWORD=$DB_PASSWORD" --command -- \
  psql "host=$DB_PRIVATE_IP user=ax_next dbname=ax_next sslmode=require" \
     -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Succeeded = the extension was created. (If this times out, the SQL failed —
# `kubectl describe pod pgvector-init -n default` reads API events, unaffected
# by the streaming blip.)
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/pgvector-init -n default --timeout=120s
kubectl logs pgvector-init -n default 2>/dev/null || true
kubectl delete pod pgvector-init -n default
```

---

## Step 2 — Build and push the image

The host pod and every runner pod share one image. **Build for `linux/amd64`** —
Autopilot nodes are amd64, and an arm64 image (e.g. from an Apple-silicon Mac)
fails at runtime with `exec format error`.

```bash
gcloud artifacts repositories create ax-next \
  --repository-format=docker --location=$REGION --project=$PROJECT_ID

gcloud auth configure-docker $REGION-docker.pkg.dev

# From the repo root. buildx --push handles the amd64 cross-build + upload.
docker buildx build --platform linux/amd64 \
  -t $IMAGE:$TAG \
  -f container/agent/Dockerfile --push .
```

> There's no image-publish CI yet — this is a manual build. That's a flagged
> follow-up, not an oversight.

---

## Step 3 — Namespaces

The chart does **not** create the runner namespace (its RBAC binding is scoped to
it, and we don't want `helm uninstall` to take the namespace with it).

```bash
kubectl create namespace ax-next
kubectl create namespace ax-next-runners

# Defense-in-depth: enforce a PodSecurity baseline on the runner namespace so a
# stray privileged workload can't run alongside the sandboxed runners.
kubectl label namespace ax-next-runners \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/enforce-version=latest
```

> We say **baseline**, not `restricted`, on purpose. The runner pod spec is
> hardened (non-root, all caps dropped, no privilege escalation, read-only root)
> but does **not** currently set `seccompProfile: RuntimeDefault`, which the
> `restricted` profile requires — labelling the namespace `restricted` today
> would reject runner pod creation. Adding the seccomp field to `@ax/sandbox-k8s`
> and tightening to `restricted` is a hardening follow-up.

---

## Step 4 — Secrets

### 4a. The database DSN

```bash
DSN="postgresql://ax_next:${DB_PASSWORD}@${DB_PRIVATE_IP}:5432/ax_next?sslmode=no-verify"
kubectl create secret generic ax-next-db -n ax-next --from-literal=url="$DSN"
```

Use **`sslmode=no-verify`**, not `require`. `@ax/database-postgres` hands the URL
straight to `pg`, and current `pg`/`pg-connection-string` treats `require` (and
`verify-ca`) as `verify-full` — it tries to verify Cloud SQL's server cert against
a CA the pod doesn't carry, and the host crashes at boot with
`unable to verify the first certificate`. `no-verify` keeps the connection
encrypted but skips CA verification, which is fine over a private VPC IP. To
*verify* the cert instead (`verify-full`), mount the Cloud SQL server CA
(`gcloud sql instances describe ax-next-db --format='value(serverCaCert.cert)'`)
and add `sslrootcert=<path>` — a hardening step, not a launch blocker.

### 4b. The encryption + cookie keys (read this twice)

```bash
export AX_CREDENTIALS_KEY=$(openssl rand -base64 32)
export AX_HTTP_COOKIE_KEY=$(openssl rand -hex 32)
export AX_AUTH_SECRET=$(openssl rand -base64 32)
```

`AX_AUTH_SECRET` is the third key: `@ax/auth-better` uses it to encrypt stored OAuth
tokens at rest. The chart will happily auto-generate one for you if you leave
`auth.secret` empty — but generating + backing it up here, alongside the other two,
means you can always re-supply it later (the exact thing that turns a future cluster
migration from a `kubectl patch` dance into one `--set` flag — see
[Step M4](#step-m4--re-create-the-secrets)). A 32-byte base64 value is the same shape
the chart generates.

**Back all three up to Secret Manager right now** — IAM-controlled, versioned, and
off-cluster. (The chart does write them into the in-cluster `ax-next-secrets`
Secret with `resource-policy: keep`, so they survive `helm uninstall` — but that's
in-cluster state, not a backup. Lose the namespace/cluster and they're gone.) Use
`printf '%s'`, **not** `echo`, so no trailing newline is baked into the stored
value — a stray `\n` makes the retrieved key differ from what helm installed:

```bash
gcloud services enable secretmanager.googleapis.com --project=$PROJECT_ID

printf '%s' "$AX_CREDENTIALS_KEY" | gcloud secrets create ax-next-credentials-key \
  --data-file=- --replication-policy=automatic --project=$PROJECT_ID
printf '%s' "$AX_HTTP_COOKIE_KEY" | gcloud secrets create ax-next-http-cookie-key \
  --data-file=- --replication-policy=automatic --project=$PROJECT_ID
printf '%s' "$AX_AUTH_SECRET" | gcloud secrets create ax-next-auth-secret \
  --data-file=- --replication-policy=automatic --project=$PROJECT_ID
# The DB password from Step 1b belongs here too — same criticality.
printf '%s' "$DB_PASSWORD" | gcloud secrets create ax-next-db-password \
  --data-file=- --replication-policy=automatic --project=$PROJECT_ID
```

To re-fetch them before a later `helm upgrade` (command substitution strips the
trailing newline, so the value round-trips exactly):

```bash
export AX_CREDENTIALS_KEY=$(gcloud secrets versions access latest \
  --secret=ax-next-credentials-key --project=$PROJECT_ID)
export AX_HTTP_COOKIE_KEY=$(gcloud secrets versions access latest \
  --secret=ax-next-http-cookie-key --project=$PROJECT_ID)
export AX_AUTH_SECRET=$(gcloud secrets versions access latest \
  --secret=ax-next-auth-secret --project=$PROJECT_ID)
```

**One rule for this deploy: pass all three keys from Secret Manager on every
install and every upgrade** — `credentials.key`, `http.cookieKey` *and*
`auth.secret` — the same three `--set` flags you'll see in
[Step 6](#step-6--edit-the-overlay-and-install) and
[Step M6](#step-m6--install-with-the-same-chart). Before any upgrade of a cluster
that already has keys, run the
[Step 4c](#4c-before-every-upgrade-check-the-backup-matches-the-live-cluster) check
first.

When does the flag actually do anything? Honestly, most of the time it doesn't.
The chart's Secret is lookup-stable (`templates/hook-secret.yaml`): if the live
`ax-next-secrets` Secret already holds a key, an in-place `helm upgrade` keeps that
value and **ignores** `--set` for it (each of the three keys is checked on its
own). The flags are load-bearing only when there's no live key for the chart to
read:

- the **first install** of a cluster (Step 6, or a migration's
  [Step M6](#step-m6--install-with-the-same-chart));
- an **offline render** — GitOps or `helm template`, where `lookup` comes back
  empty (see the rules below);
- a **restore** after losing the namespace or the Secret.

We pass them anyway, every time, because then the one moment they matter is just
the same command you always run. Leave `auth.secret` off a first install and the
chart generates one — but then it lives **only** in-cluster, and you're back to the
`kubectl`-and-pray recovery path the moment you need a fresh cluster.

The rules:

- `AX_CREDENTIALS_KEY` encrypts every stored credential at rest. Lose it or
  change it and every stored secret is **unrecoverable**. There is no recovery
  path.
- `AX_HTTP_COOKIE_KEY` signs session cookies. Change it and every active session
  is invalidated.
- `AX_AUTH_SECRET` encrypts stored OAuth tokens at rest. Change it and everyone who
  linked Google/GitHub has to re-link. Same paranoia rules as `AX_CREDENTIALS_KEY`.
- Pass the **same** values on **every** `helm upgrade`. The chart's Secret is
  lookup-stable, so if you forget, an in-cluster upgrade reuses the existing
  value — **but that safety net does NOT fire under GitOps** (Argo CD / Flux /
  `helm template | kubectl apply` render offline and can't see the existing
  Secret; they will overwrite the key on the next sync and brick every stored
  credential). If you use GitOps, source these keys from your secrets manager,
  not from a fresh `openssl rand`.

### 4c. Before every upgrade: check the backup matches the live cluster

A backup you've never compared against the real thing is a hope, not a backup.
So before any `helm upgrade` that passes `--set auth.secret` (or the other two
keys), check that what Secret Manager holds is **byte-for-byte** what the
running cluster is actually using. Skip this on the very first install — there's
no live Secret yet.

This prints hashes only. No key ever reaches your terminal or shell history:

```bash
# The cluster whose keys are live. For a migration (Step M4) that's the OLD one.
KCTX=${KCTX:-$(kubectl config current-context)}
echo "comparing Secret Manager against cluster: $KCTX"

fp() { openssl sha256 | awk '{print $NF}'; }
EMPTY=$(printf '' | fp)

for pair in credentials-key=ax-next-credentials-key \
            http-cookie-key=ax-next-http-cookie-key \
            auth-secret=ax-next-auth-secret; do
  key=${pair%%=*}; gsm=${pair#*=}
  # The in-cluster Secret stores base64; decode it back to the raw value.
  live=$(kubectl --context "$KCTX" get secret ax-next-secrets -n ax-next \
    -o "jsonpath={.data.$key}" | base64 -d | fp)
  # Hash exactly what the export above would hand to --set.
  backup=$(printf '%s' "$(gcloud secrets versions access latest \
    --secret="$gsm" --project=$PROJECT_ID)" | fp)
  if [ "$live" = "$EMPTY" ] || [ "$backup" = "$EMPTY" ]; then
    echo "MISSING  $key  (live or backup unreadable; stop and look)"
  elif [ "$live" = "$backup" ]; then
    echo "match    $key"
  else
    echo "MISMATCH $key  (do NOT pass the Secret Manager value; read below)"
  fi
done
```

Three `match` lines and you're good to go. Anything else, **stop before you
upgrade**:

- **The live cluster wins.** It's the key that actually encrypted every stored
  credential and OAuth token. A mismatched backup is the thing that's wrong.
  (If you have a real reason to believe otherwise, that's a human call, not a
  script's.)
- **Fix the backup, don't overwrite the cluster.** Add a new Secret Manager
  version holding the live value, re-run the check until it says `match`, then
  disable the stale version. For `auth-secret`:

  ```bash
  kubectl --context "$KCTX" get secret ax-next-secrets -n ax-next \
    -o jsonpath='{.data.auth-secret}' \
    | base64 -d \
    | gcloud secrets versions add ax-next-auth-secret --data-file=- --project=$PROJECT_ID
  # Re-run the check above. Once it matches, retire the old version:
  gcloud secrets versions list ax-next-auth-secret --project=$PROJECT_ID
  gcloud secrets versions disable <OLD_VERSION> --secret=ax-next-auth-secret --project=$PROJECT_ID
  ```

  Same shape for the other two keys (swap the Secret key and the Secret Manager
  name). Then re-run the `export` lines above so your shell holds the fixed value.
- **The usual culprit is a skipped `base64 -d`**: the backup holds the base64
  *of* the key — the right key, encoded one time too many. That's exactly what
  we found on 2026-09-29 (a backup taken straight from `.data.auth-secret`
  without decoding it). You can spot it by length, but the right length depends
  on the key:

  | Key | Correct backup | Double-encoded |
  | --- | --- | --- |
  | `credentials-key`, `auth-secret` | 44 chars (base64) | 60 chars |
  | `http-cookie-key` | 64 chars (hex) | 88 chars |

  (`http-cookie-key` is hex, not base64 — it came from `openssl rand -hex 32` in
  Step 4b — so don't hold it to the 44/60 numbers.)

Why bother, if the upgrade is in place? Honest answer: on an **in-place**
`helm upgrade` the chart reuses whatever key the live Secret already holds and
quietly ignores `--set` (see `templates/hook-secret.yaml`). So a bad backup
won't bite you *today*. It bites the day you actually need it: a new cluster
([Step M4](#step-m4--re-create-the-secrets)), a GitOps render that can't see the
live Secret, or a restore after losing the namespace. Every one of those turns a
wrong backup into everyone's Google login breaking at once. Checking on each
upgrade is the cheap moment to notice.

---

## Step 5 — Static IP, DNS, and the managed certificate

### 5a. Reserve a global static IP

```bash
gcloud compute addresses create ax-next-ip --global --project=$PROJECT_ID
gcloud compute addresses describe ax-next-ip --global --project=$PROJECT_ID \
  --format='value(address)'
```

### 5b. Point DNS at it

Create an **A record** for `$DOMAIN` → that IP (in Cloud DNS or your registrar).
The managed certificate won't go Active until this resolves, so do it now.

### 5c. Create the ManagedCertificate

Google-managed certs attach via a CRD + an Ingress annotation — not a Kubernetes
TLS secret. Apply this (matches the names in the overlay):

```bash
cat <<EOF | kubectl apply -f -
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: ax-next-cert
  namespace: ax-next
spec:
  domains:
    - $DOMAIN
EOF
```

---

## Step 6 — Edit the overlay and install

Keep your real values **out of the tracked template.** Rather than editing
`gke-values.yaml` in place, put just the keys you're changing into a gitignored
override file and layer it on top. (`*.local.yaml` is gitignored, so your
project / domain / registry values never land in git.)

Create `deploy/charts/ax-next/gke-values.local.yaml`:

```yaml
image:
  # The host MUST be the REGIONAL Artifact Registry (<region>-docker.pkg.dev),
  # matching where you pushed — NOT the multi-region us-docker.pkg.dev.
  repository: us-central1-docker.pkg.dev/<PROJECT_ID>/ax-next/agent
workspace:
  storage: 100Gi                       # edit to taste; see the note below this block
ingress:
  host: your.domain.example            # also the A-record + ManagedCertificate domain
http:
  allowedOrigins:
    - https://your.domain.example      # MUST exactly match the origin, or the CSRF gate 403s
onboarding:
  publicBaseUrl: https://your.domain.example
# OPTIONAL (both-or-neither): gives runner pods a read-only /memory view.
# Facts memory renders and runs without it. See "Memory: facts memory is the
# default" below.
memory:
  exports:
    server: <your memory Filestore instance IP>
    exportPath: /memory_vol
# If you named the static IP / cert something other than ax-next-ip / ax-next-cert
# in Step 5, override ingress.annotations here too.
```

About `workspace.storage`: `100Gi` is a starting point, so edit it to taste. Blobs
(attachments and artifacts) share this volume with the agent workspaces, and the
per-person storage limit (default 1 GB, Settings > Storage) multiplies across
people, so size the volume for the number of people you expect.

Helm needs the (conditioned-off) Postgres subchart present in `charts/` before it
will render, so build dependencies once:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm dependency build deploy/charts/ax-next
```

Install — template first, your overrides second (later `-f` wins):

```bash
helm upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next \
  -f deploy/charts/ax-next/gke-values.yaml \
  -f deploy/charts/ax-next/gke-values.local.yaml \
  --set credentials.key="$AX_CREDENTIALS_KEY" \
  --set http.cookieKey="$AX_HTTP_COOKIE_KEY" \
  --set auth.secret="$AX_AUTH_SECRET"
```

### Lock down `/chat` (required with a public ingress)

The `serve` subcommand's raw **`POST /chat`** endpoint is open by default — fine
behind a port-forward, but with the public Ingress you're enabling it becomes a
public, unauthenticated **agent-execution** endpoint (anyone could POST a prompt
and burn your Anthropic tokens). The authenticated web UI uses `/api/chat`, a
different path, so gating `/chat` doesn't affect normal use.

Create a token Secret, back it up, and point the chart at it via `serve.existingSecret`:

```bash
SERVE_TOKEN=$(openssl rand -hex 32)
kubectl create secret generic ax-next-serve-token -n ax-next --from-literal=token="$SERVE_TOKEN"
printf '%s' "$SERVE_TOKEN" | gcloud secrets create ax-next-serve-token \
  --data-file=- --replication-policy=automatic --project=$PROJECT_ID
```

Then add to `gke-values.local.yaml` and re-run the install above:

```yaml
serve:
  existingSecret: ax-next-serve-token
```

After this, `/chat` callers need `Authorization: Bearer $SERVE_TOKEN`. (The
token's in a Secret, not your values/shell history — same posture as the DB DSN.)

---

## Memory: facts memory is the default

`host.preset` defaults to `memory` — an LLM observer (@ax/memory) extracts
durable facts from conversations into a sqlite-backed store, with semantic
recall over embeddings + reranking. It is the only memory now: the legacy
Strata memory (`host.preset: k8s`) was deleted in TASK-608, and setting
`host.preset: k8s` makes `helm template` fail with a pointer to the switch
runbook.

### Provision the NFS export

The host writes each agent's memory as an export on an NFS share and mounts
it read-only into runner pods at `/memory`. On GKE that share is a Filestore
instance. Provision a **dedicated** one — a second `gcloud filestore
instances create`, or a second share on an existing multi-share instance —
separate from any Filestore you point `sandbox.filestore.*` at. The chart
checks this: `helm template` fails if `memory.exports` and
`sandbox.filestore` ever end up naming the same server + export path.

```bash
gcloud filestore instances create ax-next-memory \
  --project=$PROJECT_ID \
  --zone=us-central1-a \
  --tier=BASIC_HDD \
  --file-share=name=memory_vol,capacity=1TB \
  --network=name=default
```

Read back the instance IP and put it in `gke-values.local.yaml` (already
sketched in Step 6 above):

```bash
gcloud filestore instances describe ax-next-memory \
  --project=$PROJECT_ID --zone=us-central1-a \
  --format='value(networks[0].ipAddresses[0])'
```

```yaml
memory:
  exports:
    server: <the IP from the command above>
    exportPath: /memory_vol
```

Both-or-neither: leave both empty and facts memory still renders and runs
(runners just get no `/memory` mount); set only one and `helm template` /
`helm install` fail loudly, naming both fields.

### The facts database PVC

`memory.facts.storage` (default `10Gi`) sizes a dedicated PVC for the
sqlite facts database. It's separate from the workspace PVC and keeps
`helm.sh/resource-policy: keep`, same as the workspace PVC — an `helm
uninstall` doesn't take it with it. Raise `memory.facts.storageClassName`
if you want faster storage than the cluster default.

### The one credential it needs

Facts memory needs exactly one credential: `provider:openrouter`, stored
through **Admin → AI model keys** after you're through the first-run wizard
(Step 8). It drives the extraction model, embeddings, and reranking. Without
it, nothing new is remembered — the host logs `memory_no_llm_credential` and
the Memory tab says "Memory is paused" — and recall still answers, lexically,
saying so (`degraded: ["semantic", "ranking"]`). There's no field for this in
the chart; the key lives in the credential store, not in values.

### Switching an existing deployment from Strata

Nothing in the code clears old memory (apart from Strata's Postgres search
index, which the host drops on boot). When an existing deployment moves from
`host.preset: k8s` (Strata) to facts memory and nobody needs the old data, follow
the one-time operator runbook **"Switching an existing deployment to facts memory"**
in [`deploy/README.md`](README.md). Read its warning first: the workspace step
deletes **every agent's workspace repos and files**, not just memory, and none of
it can be undone. On GKE the workspace backend is `local`, so there is no
git-server to reset. The runbook deletes the `ws-*.git` repos on the host PVC and
leaves `blobs/` alone, and it erases the Filestore memory-exports share if
`memory.exports` is set.

Keeping the legacy Strata memory is no longer an option: it was deleted in
TASK-608.

---

## Step 7 — Wait for it to come up

```bash
# Host pod rolls out.
kubectl rollout status deployment/ax-next-host -n ax-next

# The load balancer + cert take 15–60 min the first time. Watch the cert until
# Status is Active (Provisioning → Active). It will not go Active until DNS
# resolves to the static IP AND the LB is serving the domain.
kubectl get managedcertificate ax-next-cert -n ax-next -w
```

You don't have to wait for the cert to walk the wizard — you can port-forward
first:

```bash
kubectl port-forward -n ax-next svc/ax-next-host 9090:9090
# then use http://localhost:9090/setup below instead of https://$DOMAIN/setup
```

---

## Step 8 — Walk the first-run wizard

The detailed, screenshot-by-screenshot version is the **"First-use wizard"**
scenario in [`MANUAL-ACCEPTANCE.md`](MANUAL-ACCEPTANCE.md). The short form:

```bash
# Scrape the one-time bootstrap token from the host pod's stdout.
kubectl -n ax-next logs deploy/ax-next-host | grep -E 'token: ax_bs_|open:  http' | head -2
```

> **Token not in the logs?** It's printed **once**, only on the boot where the
> plugin first generates it (empty `bootstrap_state`). If the host pod has
> restarted since — very likely after a churny bring-up — that line is gone, and
> the current pod won't reprint (a `pending` row already exists). The token is
> stored *hashed*, so it can't be read back; **re-mint** it instead (runs inside
> the pod since the DB is private-IP):
>
> ```bash
> kubectl exec -n ax-next deploy/ax-next-host -- \
>   node /opt/ax-next/host/dist/main.js admin reset-bootstrap
> ```
>
> This prints a fresh `token: ax_bs_…` + the `open:` URL. No `--force` needed
> unless `bootstrap_state` is already `completed`. (If exec returns
> `No agent available`, that's a transient GKE konnectivity blip — retry.) To
> sidestep this entirely, set `onboarding.bootstrapToken` (a value you choose,
> ideally from a Secret) so the token never depends on ephemeral stdout.

Open `https://$DOMAIN/setup?token=ax_bs_<...>` (or the port-forward URL), then:

1. **Create your admin account** (name + email).
2. **Connect Anthropic** — paste a real API key. The backend validates it live
   against `api.anthropic.com` and, on success, atomically creates the credential
   + the Default Agent.
3. **Send the first chat** — `list the files in /files` is the canonical
   probe (it forces a runner pod to spawn and run a bash tool).

---

## Acceptance checks

Mirror the [`MANUAL-ACCEPTANCE.md`](MANUAL-ACCEPTANCE.md) criteria; the
GKE-specific ones:

```bash
# A runner pod spawned in the runner namespace, then terminated within ~60s.
kubectl get pods -n ax-next-runners \
  -l app.kubernetes.io/component=ax-next-runner

# It actually ran sandboxed under gVisor (not the host kernel).
kubectl get pods -n ax-next-runners \
  -o jsonpath=$'{range .items[*]}{.metadata.name}: {.spec.runtimeClassName}\n{end}'
# expect: ...: gvisor

# The host can reach Cloud SQL (a row landed in a session table).
kubectl exec -n ax-next deploy/ax-next-host -- \
  psql "$DSN" -c "SELECT count(*) FROM session_postgres_v1_sessions;"

# Cert is serving real HTTPS.
curl -sSI https://$DOMAIN/health   # expect HTTP/2 200
```

- [ ] Chat returns a response that references a runner-side bash execution.
- [ ] Runner pod ran with `runtimeClassName: gvisor` and cleaned up (~60s).
- [ ] `https://$DOMAIN/setup` returns **410 Gone** after the wizard (one-shot).
- [ ] No `level >= warn` host logs (the kind-only gVisor-disabled warning should
      be **absent** here — you're actually running gVisor).
- [ ] `bash deploy/gke/backups.sh status` exits 0, and one restore drill has passed
      and been written in the drill log
      ([Backups and disaster recovery](#backups-and-disaster-recovery-do-not-skip)).
      Do this before real users arrive, not after.

---

## Backups and disaster recovery (do not skip)

Three places hold data worth keeping. The database is a managed service and backs
itself up. The other two are ordinary Compute Engine disks, and **out of the box
nothing backs them up**: the chart ships no backup tooling, and the
`helm.sh/resource-policy: keep` annotation on their claims only stops *Helm* from
deleting them. It does not protect the disk.

One script, [`gke/backups.sh`](gke/backups.sh), turns the protection on, checks that
it is still working, and rehearses a restore. It finds the disks from the PVCs at
run time, so there is no project id, zone or disk name to edit. Every command that
writes takes `--dry-run`, and every one is safe to run twice.

### What is protected, and what a bad day costs

| Store | What is in it | Protected by | Worst-case data loss |
|---|---|---|---|
| **Cloud SQL** (`ax-next-db`) | accounts, conversations, encrypted credentials, agent settings | a daily automated backup (14 kept) and point-in-time recovery (7 days of logs) | Recovering to a moment in the last 7 days: minutes. We have not measured how far behind the log shipping runs, so we won't quote a number. With point-in-time recovery off: up to 24 hours. |
| **Workspace disk** (PVC `ax-next-workspace`) | every agent's git workspace, plus attachments, artifacts and skill bundles | a daily disk snapshot, kept 14 days | **Up to 24 hours** of changes. Up to 48 if one night's snapshot fails; `status` raises the alarm once a schedule has gone 36 hours without one. |
| **Facts disk** (PVC `ax-next-memory-facts`) | the memory database, `facts.db` | a daily disk snapshot, kept 14 days | **Up to 24 hours** of newly learned facts. There is no supported command that rebuilds them from chat history, so treat lost facts as lost. |

What is **not** covered, so nobody assumes it is:

- **Filestore.** If you enabled `sandbox.filestore` (durable user files) or
  `memory.exports`, that data lives on a Filestore share. Neither the schedule nor
  the drill touches it. Filestore has its own backup feature; we haven't set it up.
- **The keys.** A database backup restored without `AX_CREDENTIALS_KEY` cannot
  decrypt the stored credentials. Step 4b puts all three keys in Secret Manager;
  that is their backup.
- **Anything outside this project.** Snapshots live in the same project as the
  disks. Anyone who can delete disks there can delete the snapshots too, and a
  compromised account with that reach can take both. This is protection against
  mistakes and failures, not against a hostile insider.

Three things worth knowing about the disk snapshots themselves:

- **They are crash-consistent, not application-consistent.** A snapshot is what the
  disk looked like at one instant, like pulling the plug. SQLite (which recovers
  from its write-ahead log) and git (which writes objects before it moves a branch)
  cope with that, and the drill below checks that they do. A passing drill is
  evidence about *that* snapshot, not a promise about every future one.
- **The disks and the database are backed up separately.** Restore both and they
  may disagree by up to a day: a conversation in the database can point at
  workspace history the older disk never saw. Restore the disks from a snapshot,
  then restore Cloud SQL to the moment that snapshot was taken (point-in-time
  recovery lets you choose it), and they line up.
- **Deleting a claim deletes its disk.** The default storage class reclaims (deletes)
  the disk when its claim goes away. The schedule keeps the automatic snapshots
  even then (`keep-auto-snapshots`), and that is deliberate: it is the safety net for
  exactly this mistake. It also means they cost money until somebody deletes them.

### Turn it on

You need permission to create Compute Engine resource policies and to edit the Cloud
SQL instance, and `kubectl` must point at the GKE cluster (Step 0).

```bash
# 1. See the plan. Reads from the cluster and GCP, changes nothing.
bash deploy/gke/backups.sh enable --dry-run --project $PROJECT_ID

# 2. Do it. --snapshot-now also takes one snapshot of each disk right away, so you
#    have a restore point today instead of waiting for tonight's run.
bash deploy/gke/backups.sh enable --project $PROJECT_ID --snapshot-now

# 3. Check. Exits non-zero if anything is wrong.
bash deploy/gke/backups.sh status --project $PROJECT_ID
```

`--project` is a guard, not a setting: if the disks behind your current `kubectl`
context are in a different project, the script stops before it writes anything. It
also prints the context, project, zone and disk names first, so read that header.

What `enable` does, and nothing else:

1. Creates one snapshot schedule, `ax-next-daily`: **daily at 09:00 UTC** (overnight
   in the Americas), **keep 14 days**, in the disks' region. If it already exists it
   is left alone (a schedule can't be edited in place; to change the numbers, pass a
   new `--schedule-name`, attach that, and delete the old one).
2. Attaches it to the workspace disk and the facts disk. A disk takes only one
   schedule: if one is already attached that isn't ours, the script says so and
   leaves it.
3. Turns on Cloud SQL **deletion protection**, so `gcloud sql instances delete`
   fails until somebody turns it off on purpose. (If you ever do mean to delete the
   instance: `gcloud sql instances patch ax-next-db --no-deletion-protection`, and
   consider `--final-backup` first.)
4. Reports whether the database's own automated backups and point-in-time recovery
   are on, and exits non-zero with the fix if not. It never edits those settings.

`--snapshot-now` snapshots are **not** covered by the 14-day rule. Delete them
(`gcloud compute snapshots delete`) once you no longer need them.

The first scheduled snapshot lands at the next 09:00 UTC. Until then `status` says
the first one is still due; after a day, a schedule with no snapshot is a failure.
Run `status` now and then (before a release, or from a cron or CI job whose failure
somebody sees). A backup that quietly stopped working is worse than none.

### The restore drill

A backup nobody has restored is a hope. The drill restores the newest snapshot of
each disk **to scratch disks**, mounts them in a throwaway pod, and checks that the
workspace's git repos pass `git fsck` and that `facts.db` opens and passes SQLite's
`integrity_check`. It never attaches, reads or writes the production disks.

You need: at least one snapshot of each disk (`enable --snapshot-now` makes one) and
rights to create disks, namespaces and PersistentVolumes. The script waits up to 20
minutes for the checks (`--timeout` changes that). The scratch disks are billed only
for the minutes they exist.

```bash
# See exactly what it would create, including every manifest. Changes nothing.
bash deploy/gke/backups.sh drill --dry-run --project $PROJECT_ID

# Run it.
bash deploy/gke/backups.sh drill --project $PROJECT_ID
```

What it does, in order (so you can do it by hand if the script is unavailable):

1. Picks the newest snapshot of each disk (or the ones you name with
   `--workspace-snapshot` and `--facts-snapshot`) and prints when it was taken.
2. `gcloud compute disks create` a scratch disk from each, named
   `ax-restore-drill-<workspace|facts>-<timestamp>` and labelled `ax_restore_drill`.
3. Creates the namespace `ax-restore-drill` (Pod Security level `restricted`) unless
   it already exists, a ConfigMap holding
   [`gke/restore-drill-verify.sh`](gke/restore-drill-verify.sh), and for each scratch
   disk a PersistentVolume (pinned to the disk's zone, `Retain`) and a claim.
4. Starts one pod, running the same image as the host, as UID 1000 with a read-only
   root filesystem. The restored repositories were written by agents, so they are
   treated as untrusted: the pod gets a deny-all NetworkPolicy (it needs no network;
   the node pulls the image; both cluster types in this runbook run Dataplane V2, so
   it is enforced, but on a cluster that doesn't enforce policies it is a no-op),
   and every `git` call it makes switches off hooks,
   filesystem monitors and pagers. It runs the checks and exits.
5. Prints the pod's report and the verdict, deletes the pod, policy, claims, volumes
   and scratch disks, and prints how long each stage took.

**PASS** means: at least one `ws-*.git` repo, every one checked (up to 25, newest
first) passes `git fsck`; and `facts.db` opens, passes `integrity_check`, and has
rows. A valid but empty `facts.db` passes with a warning: if the live memory has
facts in it, an empty copy is wrong. **FAIL** exits 1 and the report says which
check.

If the drill dies half way (your laptop sleeps, you hit Ctrl-C twice), it may leave
scratch disks behind. `bash deploy/gke/backups.sh drill-cleanup` removes what the drill
made: disks and volumes only if they carry the drill's label *and* its name prefix,
and everything else only by the drill's label inside the drill's namespace. Nothing
else. Add `--project $PROJECT_ID` and it also works when the deployment (and so its
claims) no longer exists, which is exactly when forgotten scratch disks get expensive.
`drill --keep` skips the cleanup on purpose, if you want to poke at the restored
disks; run `drill-cleanup` (with the same `--drill-namespace`) when you're done.

Record every drill here, including the ones that fail:

| Date | Snapshot age | Restore to disks | Attach and check | Result | Notes |
|---|---|---|---|---|---|
| 2026-09-29 | ~3 min (on-demand snapshots) | 0m44s | 0m22s | PASS | First drill, on prod (`ax-next-std`), right after `backups.sh enable --snapshot-now`. Workspace disk (100 GB, 1 repo): fsck clean, `blobs/` present. Facts disk (10 GB): `facts.db` integrity_check ok; it held 0 fact rows because prod memory was empty at the time, so this drill did not prove a non-empty facts database restores. Cleanup 0m20s, total 1m26s. Not rehearsed yet: the copy-back step of a real restore, the Cloud SQL point-in-time clone, and Filestore (not backed up). |

### Restoring for real

The drill rehearses steps 2-4 below. Step 5 is the destructive one, and nobody has
rehearsed it as written, so read it twice, ideally with a second pair of eyes.

1. **Stop the writers.** The host is the only thing that writes to either disk:
   `kubectl -n ax-next scale deploy/ax-next-host --replicas=0`.
2. **Keep the evidence.** If the damaged disk still exists, snapshot it now
   (`gcloud compute disks snapshot`). A bad copy can still hold files the good one
   lacks.
3. **Choose the snapshot.**
   `gcloud compute snapshots list --filter="sourceDisk:<disk name>" --sort-by=~creationTimestamp`.
   Take the newest one from before the damage started. If you're not sure when that
   was, restore an older one too and compare.
4. **Restore it to a scratch disk and check it,** with the drill:
   `bash deploy/gke/backups.sh drill --keep --drill-namespace ax-next --workspace-snapshot <name> --facts-snapshot <name>`.
   `--keep` leaves the restored disks, volumes and claims in place. `--drill-namespace ax-next`
   puts the restored claims in the same namespace as the live ones, because a pod can
   only mount claims from its own namespace. (Restoring only one disk? The drill
   restores both anyway. Leave the other flag off, and ignore its scratch disk.)
5. **Copy the good data over the live claim.** Start one pod, as UID 1000 like the
   drill pod, that mounts the restored claim (`ax-restore-drill-workspace` or
   `ax-restore-drill-facts`) and the live claim (`ax-next-workspace` or
   `ax-next-memory-facts`). Empty the live one, then `cp -a` the restored files across.
   Copying, rather than swapping disks under the release, keeps the PVC, the
   PersistentVolume and the Helm release exactly as they are. The snapshot from
   step 2 is your undo.
6. **Start the host** (`kubectl -n ax-next scale deploy/ax-next-host --replicas=1`),
   open an agent, and check its files and the Memory tab. Then
   `bash deploy/gke/backups.sh drill-cleanup --drill-namespace ax-next`.

If the database also needs restoring, do it into a **new** instance, never over the
live one: for a moment in time,
`gcloud sql instances clone ax-next-db ax-next-db-restored --point-in-time=<UTC timestamp>`,
then point the `ax-next-db` DSN Secret (Step 4a) at the new instance's private IP.
We have not rehearsed the database half of a restore.

### Cloud SQL: one zone, on purpose

The instance runs in a single zone (no standby), and we're leaving it that way for
launch. The cluster, the host pod and both disks are also single-zone, so a standby
database alone would not keep the product up through a zone outage; it would only add
cost. The price of that choice is plain: **a zone outage takes the product down until
Google restores the zone, or until we rebuild in another zone from the backups above.**
We have not timed that rebuild, but it means a restored database, a new cluster and
restored disks, not a restart. Revisit this when the
cluster stops being single-zone, or when an outage of that length stops being
acceptable.

---

## Troubleshooting

**`gcloud sql instances create` returns `[INTERNAL_ERROR]` (but the instance is
fine).** The create can take ~5+ minutes; the CLI sometimes stops waiting and
surfaces a misleading `INTERNAL_ERROR` while the backend keeps going. **Don't
delete and retry** — check first: `gcloud sql instances list` will show
`ax-next-db` in `PENDING_CREATE`, and `gcloud sql operations list --instance=ax-next-db`
shows the CREATE op still `RUNNING` with no error. Wait it out
(`gcloud sql operations wait <op-id> --project=$PROJECT_ID`); it'll land
`RUNNABLE`. Only delete + retry if the operation actually ends with an error.

**Runner pod crashes at boot with `missing AX_PROXY_*`.** The TCP credential-proxy
isn't wired. Confirm the overlay has `credentialProxy.tcp.enabled=true` and
`sandbox.proxySocketHostPath=""`, that the `ax-next-proxy` ClusterIP Service
rendered (`kubectl get svc -n ax-next`), and that NetworkPolicies didn't get
disabled (the runner→proxy egress + host←proxy ingress rules only render when
`credentialProxy.tcp.enabled`). This is the least-walked path — start here.

**Runner pods stay `Pending` / never schedule.** Usually Autopilot provisioning a
gVisor-capable node (can take a minute on first session) or a resource-floor
rejection. `kubectl describe pod -n ax-next-runners <pod>` shows the real reason
in Events. Runner resources are the plugin's defaults and aren't a helm knob yet;
Autopilot rounds requests up to its floors. If this provisioning delay regularly
trips the runner's 60 s readiness budget — the user sees **"the agent stopped
unexpectedly"** and the host logs `sandbox-open-failed` — the fix isn't to wait
longer, it's to keep a node warm:
[migrate to a Standard cluster with an always-on gVisor node](#migrating-to-a-standard-cluster-with-a-warm-node-pool-fixing-runner-cold-start).

**Every chat dies after ~110s; runner pods exit code 2; runner logs show
`session.get-config failed: timeout` (GKE Sandbox / Standard).** The runner can't
reach the host IPC in time — but it's **DNS**, not connectivity. The runner dials
`ax-next-host.<ns>.svc.cluster.local` (4 dots); under the pod's default
`ndots:5` with ~6 `search` domains, that relative name triggers a search-domain
walk, and on gVisor those UDP search-miss lookups to kube-dns run ~1s each (~6s
total) — longer than the runner's **5s** `session.get-config` timeout, so it
never connects even though the name resolves fine. (Tell-tale: from a runner-
labelled gVisor pod, `curl http://<name>:80/` shows `time_namelookup` ≈ 6s, but
`curl http://<name>.:80/` *with a trailing dot* is instant; connecting by the
ClusterIP or pod IP is also instant.) **The chart fixes this** by emitting the
host/proxy URLs as absolute FQDNs (trailing dot) so resolution skips the search
walk — make sure you're on a chart build that includes that (the
`ax-next.hostIpcUrl` helper ends in `svc.cluster.local.`). Autopilot doesn't hit
this because its DNS path resolves the search-misses fast.

**Ingress `ADDRESS` stays empty for 10+ min; cert is `FailedNotVisible`; no LB
resources exist.** The GKE load-balancer controller (glbc) isn't acting on the
Ingress at all. Tell-tale: `kubectl describe ingress ax-next-host -n ax-next`
shows `Events: <none>` and no `Address`, and `gcloud compute forwarding-rules
list --global` shows nothing for your static IP (still `RESERVED`). The usual
cause is the **ingress class**: glbc keys off the legacy
`kubernetes.io/ingress.class: "gce"` **annotation**, and many GKE clusters have
**no IngressClass objects** (`kubectl get ingressclass` → "No resources found"),
so the `ingressClassName: gce` *field* references a class that doesn't exist and
glbc silently ignores the Ingress. The overlay uses the annotation + empty
`className` for this reason. If you previously installed with `ingressClassName`,
delete the stuck Ingress so it's recreated cleanly with the annotation:
`kubectl delete ingress ax-next-host -n ax-next` then re-run the install. Within
a minute you should see glbc events and `ADDRESS` populate.

**LB returns 404 / 502; cert stuck `Provisioning`.** In order: (1) DNS must
resolve `$DOMAIN` to the reserved static IP (`dig $DOMAIN`); the cert never goes
Active otherwise. (2) The backend health check must pass — it auto-derives from
the host's `/health` readiness probe; `kubectl describe ingress -n ax-next` and
the backend-service health in the console tell you. (3) With
`networkPolicies.enabled=true`, the host policy must admit the cloud LB
health-check ranges (`networkPolicies.lbHealthCheckCidrs`; the GKE overlay sets
GCP's `35.191.0.0/16` + `130.211.0.0/22`) or the backend shows UNHEALTHY despite
a healthy pod. (4) Confirm the Ingress backend targets the `public-http` port
(the chart pins this; a stale render pointing at `http` is the classic cause of a
wired-but-dead backend).

**Host pod crashes at boot with `@ax/storage-postgres init failed: unable to
verify the first certificate`.** The DSN uses `sslmode=require` (or `verify-ca`).
Current `pg`/`pg-connection-string` treats those as `verify-full` and tries to
validate Cloud SQL's server cert against a CA the pod doesn't have. Fix the DSN
in the `ax-next-db` Secret to `sslmode=no-verify` (encrypt, skip CA check) and
`kubectl rollout restart deployment/ax-next-host -n ax-next` so it re-reads the
Secret. (A Secret change does NOT roll the pod on its own — `DATABASE_URL` is
injected from it at pod start.) If instead it's a connection *refusal*, re-check
`$DB_PRIVATE_IP` and that the cluster's VPC is the peered one.

**`exec format error` in any pod.** The image is the wrong architecture. Rebuild
with `--platform linux/amd64`.

**`helm template`/`install` errors about the postgresql dependency.** Run
`helm dependency build deploy/charts/ax-next` (Step 6) — Helm requires the
subchart present in `charts/` even though it's conditioned off.

---

## What this does NOT cover

Deliberately deferred. Each is a real next step, not a gap we missed:

- **Cloud SQL Auth Proxy + Workload Identity + IAM auth.** Needs a host-pod
  sidecar hook + a `serviceAccount.annotations` hook in the chart. More secure;
  removes the DB password from the Secret entirely.
- **GCS object storage for blobs.** The S3 blob client can't authenticate to GCS
  with Workload Identity (the AWS SDK has no GCS credential provider), and the
  chart has no values path to feed GCS HMAC keys from a Secret. Wiring that is a
  small chart change. Until then, blobs live on the host PVC.
- **Multi-replica / HPA.** Chat streams SSE from an in-process buffer; the chart
  hard-pins `replicas: 1`. Horizontal scale is gated on a distributed stream
  broker that doesn't exist yet.
- **Backups that survive losing the project, and Filestore backups.** The disk
  snapshots and the database backups live in the same project as the data, and
  Filestore shares are not covered at all. Both are spelled out under
  [Backups and disaster recovery](#backups-and-disaster-recovery-do-not-skip).
- **Host-pod hardening** (securityContext, restricted SA) and a `PodDisruptionBudget`.
- **Automated image-publish CI.** Today the build is manual (Step 2).

---

## Migrating to a Standard cluster with a warm node pool (fixing runner cold-start)

Autopilot is lovely until the first chat after an idle stretch. Here's the
failure, plainly: when a session needs a runner pod and there's no gVisor-capable
node sitting idle, Autopilot has to *provision one* — and that takes longer than
the runner's 60 s readiness budget (`@ax/sandbox-k8s` `readinessTimeoutMs`, not a
helm knob). The session gives up with `sandbox-open-failed`, the user sees **"the
agent stopped unexpectedly,"** and to add insult, the brand-new node also pays a
one-time ~900 MB image pull. It's not a bug in the install — it's the cost model.
Autopilot optimizes for "pay only for pods you run," and a cold gVisor node is the
bill it sends for that.

The fix is boring and reliable: run a **Standard** cluster with **one always-on
gVisor node**. Autoscaling with `--min-nodes=1` keeps a sandboxed node warm, the
agent image stays cached on it, and a new runner pod schedules + goes Ready in a
handful of seconds — comfortably under the 60 s budget. You trade a little idle
spend for predictable warm starts. (Rough order of magnitude: an always-on
`e2-standard-4` is ~$100/month plus the smaller system pool — check the
[pricing calculator](https://cloud.google.com/products/calculator) for current
numbers, they drift.)

**The good news: your chart doesn't change.** The overlay
([`gke-values.yaml`](charts/ax-next/gke-values.yaml)) is cluster-agnostic — the
TCP credential-proxy, `runtimeClassName: gvisor`, the enforced NetworkPolicies,
and the GCE ingress all behave identically on Standard. This is a *migration of
the cluster underneath*, not a re-architecture. And **there's no in-place
conversion** — you can't flip an Autopilot cluster to Standard, and you can't add
a Standard node pool to an Autopilot cluster. You stand up a new Standard cluster
beside the old one and cut over.

### What carries over vs. what you re-create

Most of the expensive, stateful stuff is **project-scoped**, not cluster-scoped —
it survives the move untouched. Only the cluster-scoped objects get rebuilt.

| Reused as-is (project-scoped) | Re-created on the new cluster (cluster-scoped) |
|---|---|
| Artifact Registry image (`$IMAGE:$TAG`) | Namespaces + PodSecurity labels (Step 3) |
| Global static IP (`ax-next-ip`) | k8s Secrets: `ax-next-db`, the helm-managed `ax-next-secrets`, `ax-next-serve-token` (Step 4) |
| Cloud SQL instance + DB + user (**your data lives here**) | `ManagedCertificate` CRD (Step 5c) |
| Secret Manager secrets (keys, DB password) | The helm release — includes the SSE `BackendConfig` (chart-templated, Step M7) |
| DNS A record + the domain | — |
| `gke-values.local.yaml` | — |

Your **conversations, credentials, workspaces** are split between Cloud SQL (DB)
and the host PVC (git repos + blobs). Cloud SQL is reused, so DB state is safe.
The **host PVC does not migrate** — it's a new disk on the new cluster. If you
have workspace/blob state worth keeping, snapshot it and restore the snapshot into
a disk in the new cluster's zone, following
[Backups and disaster recovery](#backups-and-disaster-recovery-do-not-skip),
before you decommission the old cluster. (For a fresh-ish deployment with nothing precious on the PVC yet,
you can skip that and let the new cluster start clean.)

### Step M0 — Reuse your env vars

Everything from [Prerequisites](#prerequisites) still applies — same
`PROJECT_ID`, `REGION`, `VPC`, `DOMAIN`, `TAG`, `IMAGE`. Set them again in your
shell, then add one for the new cluster's name (pick something that won't collide
with the old one while both exist):

```bash
export STD_CLUSTER=ax-next-std       # the new Standard cluster's name
```

### Step M1 — Create the Standard cluster

We match the two Autopilot behaviours the rest of this guide depends on, but
spell them out because Standard makes you ask:

- `--enable-dataplane-v2` — Cilium, so NetworkPolicies **actually enforce**
  (Autopilot has this on always; the overlay leaves policies ON).
- `--enable-ip-alias` — VPC-native, required for both Cloud SQL private IP and the
  container-native NEG ingress (Autopilot is always VPC-native).

The default node pool created here is a **normal (non-sandbox)** pool — it runs
the host pod and GKE's system workloads. The gVisor pool comes next.

We use a **zonal** cluster (`--zone`, one zone) on purpose — see the cost note
below. Cloud SQL is regional, so a zonal cluster in the same region still reaches
its private IP fine.

```bash
export ZONE=us-central1-a            # a zone inside $REGION

gcloud container clusters create $STD_CLUSTER \
  --project=$PROJECT_ID --zone=$ZONE \
  --release-channel=regular \
  --enable-dataplane-v2 \
  --enable-ip-alias \
  --network=$VPC --subnetwork=$VPC \
  --machine-type=e2-standard-4 \
  --num-nodes=1
```

> **Zonal vs regional — this is a real cost decision on Standard.** Unlike
> Autopilot (pay-per-pod), on a Standard **regional** cluster `--num-nodes` /
> `--min-nodes` are **per-zone**, so `min-nodes=1` becomes one node in *each* of
> the region's ~3 zones — 3× the always-on bill, for both pools. Since the host is
> single-replica-locked anyway, zonal HA buys little; we go **zonal** to keep it to
> one system node + one warm gVisor node. Use `--region` only if you genuinely want
> multi-zone HA and accept the ~3× node count.
>
> The default pool carries the single host pod (requests `1 vCPU / 2 GiB`) + GKE's
> system daemons; `e2-standard-4` fits them with headroom. `e2-standard-2` *can*
> work but is tight once kube-system is accounted for — we hit `Pending` risk
> there, so `e2-standard-4` is the safe default. Workload Identity
> (`--workload-pool`) is still a deferred follow-up here, same as the Autopilot
> path — we keep parity.

### Step M2 — Add the warm gVisor node pool

This is the whole point of the migration. `--sandbox type=gvisor` installs gVisor
on the pool and makes GKE label the nodes `sandbox.gke.io/runtime=gvisor` and
**taint** them `sandbox.gke.io/runtime=gvisor:NoSchedule`. GKE's `gvisor`
`RuntimeClass` automatically adds the matching node affinity + toleration to any
pod with `runtimeClassName: gvisor` — which is exactly what `@ax/sandbox-k8s`
stamps on every runner. So runner pods land here automatically, and **nothing
else does** (the taint repels the host + system pods). That separation isn't
optional: GKE requires system workloads to run on a non-sandbox pool, which is
why Step M1's default pool exists.

```bash
gcloud container node-pools create gvisor-pool \
  --cluster=$STD_CLUSTER --project=$PROJECT_ID --zone=$ZONE \
  --image-type=cos_containerd \
  --sandbox type=gvisor \
  --machine-type=e2-standard-4 \
  --num-nodes=1 \
  --enable-autoscaling --min-nodes=1 --max-nodes=3
```

> **`--num-nodes=1` matters here.** With `--enable-autoscaling` but no
> `--num-nodes`, the pool is created at its **default initial size of 3** and the
> autoscaler then slowly drains it back to `--min-nodes` — you pay for 3 gVisor
> nodes for ~10 min and watch them disappear. `--num-nodes=1` starts it at the
> warm node directly. (If you skip it, `gcloud container clusters resize
> $STD_CLUSTER --node-pool gvisor-pool --num-nodes 1 --zone $ZONE` fixes it.)
>
> **`--min-nodes=1` is the warm node — the fix.** It keeps one gVisor node up at
> all times, so the agent image stays cached on it and the next runner schedules
> in seconds. Pick **at least 2 vCPUs** (gVisor adds per-Pod overhead and you want
> room for several concurrent sessions); `e2-standard-4` is a comfortable default.
> Runners are cheap to pack — each requests only `100m` CPU / `256Mi` memory
> (`@ax/sandbox-k8s` defaults), so an `e2-standard-4` (4 vCPU / 16 GiB) holds
> dozens at once; the autoscaler adds nodes (up to `--max-nodes`) under real load
> and drains back to 1 when idle.
>
> **First-runner caveat:** the *very first* runner after the pool scales up a
> fresh node still pays the one-time ~900 MB image pull. Because `min-nodes=1`
> keeps that node alive, the image stays cached and every subsequent runner is
> fast — you pay the pull once per node, not once per session like Autopilot. If
> even that first pull matters to you, a tiny image-prepull DaemonSet on the pool
> closes the gap; it's optional and not worth it for most.
>
> **Give the new pool a few minutes to converge before the first chat.** Right
> after the node pool comes up (and especially right after a resize), the gVisor
> node's Cilium datapath + DNS are still settling, and the first runner or two can
> fail to reach the host. It stabilises on its own within a few minutes — it is
> NOT the cold-start problem and NOT the DNS issue in
> [Troubleshooting](#troubleshooting); just don't judge the deploy by the first
> chat in the first five minutes.

### Step M3 — Point kubectl at the new cluster, then namespaces

```bash
gcloud container clusters get-credentials $STD_CLUSTER --region $REGION --project $PROJECT_ID
kubectl config current-context   # sanity-check: should name $STD_CLUSTER, NOT the old Autopilot one
```

Then re-run [Step 3 — Namespaces](#step-3--namespaces) verbatim against this
cluster (create `ax-next` + `ax-next-runners`, label the runner namespace
`baseline`). Namespaces are cluster-scoped, so they don't carry over.

### Step M4 — Re-create the Secrets

Cluster-scoped, so they're rebuilt — but every *value* is reused. The DB DSN
points at the **same** Cloud SQL private IP (`$DB_PRIVATE_IP` from
[Step 1b](#1b-create-the-instance-database-and-user); re-export it with the
`gcloud sql instances describe` one-liner there if it's not in your shell), and
the keys come straight back out of Secret Manager — **do not** `openssl rand` new
ones, or you'll orphan every stored credential and session:

```bash
export DB_PRIVATE_IP=$(gcloud sql instances describe ax-next-db --project=$PROJECT_ID \
  --format='value(ipAddresses[0].ipAddress)')
DSN="postgresql://ax_next:$(gcloud secrets versions access latest --secret=ax-next-db-password --project=$PROJECT_ID)@${DB_PRIVATE_IP}:5432/ax_next?sslmode=no-verify"
kubectl create secret generic ax-next-db -n ax-next --from-literal=url="$DSN"

export AX_CREDENTIALS_KEY=$(gcloud secrets versions access latest --secret=ax-next-credentials-key --project=$PROJECT_ID)
export AX_HTTP_COOKIE_KEY=$(gcloud secrets versions access latest --secret=ax-next-http-cookie-key --project=$PROJECT_ID)
export AX_AUTH_SECRET=$(gcloud secrets versions access latest --secret=ax-next-auth-secret --project=$PROJECT_ID)

# Reuse the same /chat serve token too (if you set one on Autopilot).
kubectl create secret generic ax-next-serve-token -n ax-next \
  --from-literal=token="$(gcloud secrets versions access latest --secret=ax-next-serve-token --project=$PROJECT_ID)"
```

(The `ax-next-secrets` Secret holding the keys is created *by helm* in Step M6
from the `--set` flags above — you don't create it by hand.)

**Before Step M6, run the
[Step 4c check](#4c-before-every-upgrade-check-the-backup-matches-the-live-cluster)
against the OLD cluster** (`KCTX=<old-autopilot-context>`). This is the one
upgrade where `--set` really is the source of truth: the new cluster has no live
Secret to fall back on, so whatever Secret Manager holds is what every stored
credential and OAuth token gets decrypted with from now on.

> **Carry over `auth-secret`, or every Google/OAuth login breaks.** `ax-next-secrets`
> holds a **third** key — `auth-secret` (`AX_AUTH_SECRET`), which `@ax/auth-better`
> uses to encrypt stored OAuth tokens at rest. A fresh cluster has no in-cluster
> Secret to "lookup", so without intervention it'd mint a **new** `auth-secret` and
> orphan every account that linked Google (their tokens were encrypted with the old
> cluster's secret) → broken logins. The `credentials-key` / `http-cookie-key` you
> pass via `--set` are unaffected; this is `auth-secret` specifically.
>
> The fix is the `AX_AUTH_SECRET` export above — re-fetched from Secret Manager like
> the other two keys (you backed it up in
> [Step 4b](#4b-the-encryption--cookie-keys-read-this-twice)). Pass it through to
> Step M6's `helm upgrade` as `--set auth.secret="$AX_AUTH_SECRET"` and the new
> cluster reuses the old secret — no post-install `kubectl patch`, no host restart.
>
> Older deploy that predates the Step 4b `auth-secret` backup? Grab the value from
> the **old** cluster's in-cluster Secret (it's stored base64-encoded there, so
> `base64 -d` it back to the raw value before storing — Secret Manager holds the
> decoded value, the same form `--set` expects) and back it up before you continue:
>
> ```bash
> kubectl --context <old-autopilot-context> get secret ax-next-secrets -n ax-next \
>   -o jsonpath='{.data.auth-secret}' \
>   | base64 -d \
>   | gcloud secrets create ax-next-auth-secret --data-file=- \
>       --replication-policy=automatic --project=$PROJECT_ID
> export AX_AUTH_SECRET=$(gcloud secrets versions access latest --secret=ax-next-auth-secret --project=$PROJECT_ID)
> ```

### Step M5 — Re-create the ManagedCertificate

The `ManagedCertificate` CRD is cluster-scoped — re-apply it on the new cluster
(same spec as [Step 5c](#5c-create-the-managedcertificate)). The static IP and DNS
A record are project-scoped and untouched.

```bash
cat <<EOF | kubectl apply -f -
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: ax-next-cert
  namespace: ax-next
spec:
  domains:
    - $DOMAIN
EOF
```

> It won't go **Active** until DNS resolves to whichever LB ultimately holds the
> static IP — which, if you're reusing the same IP, doesn't happen until the
> cutover in Step M8. That's expected; don't panic at `Provisioning`.

### Step M6 — Install with the same chart

Identical to [Step 6](#step-6--edit-the-overlay-and-install) — same overlay, same
gitignored `gke-values.local.yaml`, same three keys — including
`--set auth.secret="$AX_AUTH_SECRET"`, exactly as Step 6 passes it (that's the
[Step 4b](#4b-the-encryption--cookie-keys-read-this-twice) rule: every install,
every upgrade). On an in-place upgrade those flags are ignored, because the chart
reuses the live Secret. **Here they are not**: the new cluster has no
`ax-next-secrets` yet, so this command is what writes it. Helm refuses to install
without the other two keys, but a missing `auth.secret` fails **silently**: the
chart generates a fresh one that can't decrypt anyone's stored OAuth tokens (see
the Step M4 callout). The chart is otherwise cluster-agnostic, so nothing else in
your values changes for Standard.

```bash
helm dependency build deploy/charts/ax-next   # subchart must be present to render

helm upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next \
  -f deploy/charts/ax-next/gke-values.yaml \
  -f deploy/charts/ax-next/gke-values.local.yaml \
  --set credentials.key="$AX_CREDENTIALS_KEY" \
  --set http.cookieKey="$AX_HTTP_COOKIE_KEY" \
  --set auth.secret="$AX_AUTH_SECRET" \
  --set serve.existingSecret=ax-next-serve-token   # drop if you didn't gate /chat
```

### Step M7 — Raise the SSE backend timeout (BackendConfig)

You need this on **any** GCE-ingress deploy (Autopilot or Standard) — it tends to
bite right when you start a real streaming chat. The GCE Application Load Balancer
defaults its backend `timeoutSec` to **30 s**, and it applies that to the whole
response, not idle time. Chat replies stream over a long-lived SSE connection, so a
turn that takes longer than 30 s gets the connection cut out from under it — the UI
shows **"Connection lost"** mid-answer.

Good news: the chart handles it. `gke-values.yaml` already sets
`ingress.backendConfig.enabled: true`, which renders a `BackendConfig`
(`cloud.google.com/v1`) with a generous `timeoutSec` **and** stamps the
`cloud.google.com/backend-config` annotation on the host Service to bind the LB
backend to it. Both are templated, so they survive `helm upgrade` — no more
re-applying an annotation by hand that the next re-render quietly drops.

Tune the timeout if you expect very long single turns (it's in seconds, 1 h by
default):

```yaml
# gke-values.yaml (or gke-values.local.yaml)
ingress:
  backendConfig:
    enabled: true
    timeoutSec: 3600
```

> Confirm the LB actually took it: the backend service's `timeoutSec` should read
> `3600`, not `30`, in `gcloud compute backend-services describe <name> --global`
> (the name is auto-generated; find it via
> `kubectl describe ingress ax-next-host -n ax-next`). It can take a few minutes
> after the install/upgrade for glbc to push the new timeout to the LB.

### Step M8 — Cut over the static IP

The one genuinely fiddly bit. A **global static IP can attach to only one LB
forwarding rule at a time** — so while the old Autopilot cluster's Ingress holds
`ax-next-ip`, the new cluster's Ingress can't claim it and will sit with an empty
`ADDRESS`. Two ways through:

**Option A — reuse the same IP, short maintenance window (recommended, simplest).**

1. Bring the new cluster fully up first and **verify it before touching DNS** via
   a port-forward (the new Ingress has no public address yet, and that's fine):
   ```bash
   kubectl rollout status deployment/ax-next-host -n ax-next
   kubectl port-forward -n ax-next svc/ax-next-host 9090:9090
   # hit http://localhost:9090/health and walk a chat — confirm a runner pod spawns
   ```
2. When you're happy, **release the IP from the old cluster.** Switch kubectl to
   the *old* Autopilot context and delete its Ingress:
   ```bash
   kubectl config use-context <old-autopilot-context>
   kubectl delete ingress ax-next-host -n ax-next
   ```
3. Switch back to the new cluster. Within ~a minute glbc claims the freed IP for
   the new Ingress; the `ManagedCertificate` then provisions (15–60 min the first
   time). HTTPS is down for that window — that's the maintenance cost of reusing
   one IP. Watch it land:
   ```bash
   kubectl config use-context <new-std-context>
   kubectl get ingress ax-next-host -n ax-next -w               # ADDRESS should populate
   kubectl get managedcertificate ax-next-cert -n ax-next -w    # Provisioning → Active
   ```

**Option B — new IP + DNS flip, smaller gap (more moving parts).** Reserve a
second global static IP, point the new Ingress at it (override
`ingress.annotations` / `kubernetes.io/ingress.global-static-ip-name` in your
local values), lower your DNS A-record TTL a day ahead, then flip the record from
the old IP to the new one. The old cluster keeps serving until DNS propagates; the
new managed cert goes Active once Google sees the domain resolve to the new LB.
More graceful, but you're juggling two IPs and a DNS change — only worth it if a
maintenance window is genuinely unacceptable.

### Step M9 — Verify the cold-start is actually gone

```bash
# A gVisor node is always present (this is the warm node doing its job).
kubectl get nodes -l sandbox.gke.io/runtime=gvisor
# expect: at least one node, STATUS Ready

# Cold probe: with NO active session (give it a few minutes idle so no runner is
# warm), send the first chat — `list the files in /files` — and confirm the
# runner pod goes Ready and the answer returns WELL under 60 s. No
# "agent stopped unexpectedly", no sandbox-open-failed in the host logs.
kubectl get pods -n ax-next-runners -w
```

Then re-run the full [Acceptance checks](#acceptance-checks) — gVisor runtime
class, Cloud SQL reachable, HTTPS serving. They're cluster-agnostic; everything
that passed on Autopilot should pass here, minus the cold-start failure.

### Step M10 — Decommission the old Autopilot cluster

Once the new cluster has soaked and you've confirmed nothing precious is stranded
on the old host PVC (see the migration intro), delete the old cluster. The
project-scoped resources — static IP, Cloud SQL, Artifact Registry, Secret
Manager — are **not** owned by the cluster and stay put:

```bash
gcloud container clusters delete <old-autopilot-cluster> --region $REGION --project $PROJECT_ID
```

---

## Design notes

For the *why* behind the stack choices (gVisor on Autopilot, the TCP proxy, local
workspace + fs blobs, private-IP Postgres, the ingress port-name fix and its
regression test), see the chart's [`SECURITY.md`](charts/ax-next/SECURITY.md) and
the overlay's inline comments. The two facts most likely to bite a newcomer:
external Postgres skips the pgvector init job (Step 1c), and the
`values.yaml` "GCS + Workload Identity" note for the S3 blob backend doesn't
actually work — which is why we park blobs on the PVC here.
