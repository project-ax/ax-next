# Deploying ax-next to GKE Autopilot

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
gcloud sql instances create ax-next-db \
  --project=$PROJECT_ID --region=$REGION \
  --database-version=POSTGRES_17 \
  --edition=ENTERPRISE --tier=db-custom-2-7680 \
  --storage-auto-increase \
  --network=projects/$PROJECT_ID/global/networks/$VPC \
  --no-assign-ip \
  --ssl-mode=ENCRYPTED_ONLY

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

### 1c. Enable pgvector (only if you'll use memory/strata plugins)

External Postgres **skips the chart's pgvector init job** — you enable the
extension yourself. The default chat path doesn't need it, but it's harmless to
run and saves a confusing failure later if you turn on memory features. This runs
a throwaway pod *inside* the cluster (the only thing that can reach the private IP
right now):

```bash
kubectl run pgvector-init -n default --rm -i --restart=Never \
  --image=postgres:17 --env="PGPASSWORD=$DB_PASSWORD" -- \
  psql "host=$DB_PRIVATE_IP user=ax_next dbname=ax_next sslmode=require" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
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
DSN="postgresql://ax_next:${DB_PASSWORD}@${DB_PRIVATE_IP}:5432/ax_next?sslmode=require"
kubectl create secret generic ax-next-db -n ax-next --from-literal=url="$DSN"
```

`sslmode=require` encrypts the connection without verifying the server cert —
fine to start, given it's a private IP inside your VPC. To verify the cert
(`verify-ca`/`verify-full`) you'd mount the Cloud SQL server CA; that's a
hardening step, not a launch blocker.

### 4b. The encryption + cookie keys (read this twice)

```bash
export AX_CREDENTIALS_KEY=$(openssl rand -base64 32)
export AX_HTTP_COOKIE_KEY=$(openssl rand -hex 32)
```

**Save both somewhere durable right now** (Secret Manager, a sealed-secret, your
vault). The rules:

- `AX_CREDENTIALS_KEY` encrypts every stored credential at rest. Lose it or
  change it and every stored secret is **unrecoverable**. There is no recovery
  path.
- `AX_HTTP_COOKIE_KEY` signs session cookies. Change it and every active session
  is invalidated.
- Pass the **same** values on **every** `helm upgrade`. The chart's Secret is
  lookup-stable, so if you forget, an in-cluster upgrade reuses the existing
  value — **but that safety net does NOT fire under GitOps** (Argo CD / Flux /
  `helm template | kubectl apply` render offline and can't see the existing
  Secret; they will overwrite the key on the next sync and brick every stored
  credential). If you use GitOps, source these keys from your secrets manager,
  not from a fresh `openssl rand`.

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

Open [`charts/ax-next/gke-values.yaml`](charts/ax-next/gke-values.yaml) and fill
in every `# >>> EDIT`: the image repo/tag, the domain (in `ingress.host`,
`http.allowedOrigins`, `onboarding.publicBaseUrl`), and confirm the static-IP /
cert names match Step 5.

Helm needs the (conditioned-off) Postgres subchart present in `charts/` before it
will render, so build dependencies once:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm dependency build deploy/charts/ax-next
```

Install:

```bash
helm upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next \
  -f deploy/charts/ax-next/gke-values.yaml \
  --set credentials.key="$AX_CREDENTIALS_KEY" \
  --set http.cookieKey="$AX_HTTP_COOKIE_KEY"
```

(If you'd rather not edit the file, override via flags instead, e.g.
`--set image.repository=$IMAGE --set image.tag=$TAG --set ingress.host=$DOMAIN`.)

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

Open `https://$DOMAIN/setup?token=ax_bs_<...>` (or the port-forward URL), then:

1. **Create your admin account** (name + email).
2. **Connect Anthropic** — paste a real API key. The backend validates it live
   against `api.anthropic.com` and, on success, atomically creates the credential
   + the Default Agent.
3. **Send the first chat** — `list the files in /workspace` is the canonical
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

---

## Disaster recovery (do not skip)

The host PVC holds both the workspace git repos **and** the blobs, and the chart
ships **zero** backup primitives. Pick at least one before real users arrive:

- **PD snapshots** via a `VolumeSnapshot` schedule (a `VolumeSnapshotClass` for
  pd.csi.storage.gke.io + a CronJob, or GCE's scheduled snapshots on the
  underlying disk).
- A `git bundle` cron that ships the bare repos to off-cluster storage.

Cloud SQL has its own automated backups — make sure they're enabled on the
instance (`--backup-start-time` / the console). That covers the database; it does
**not** cover the PVC.

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
Autopilot rounds requests up to its floors.

**LB returns 404 / 502; cert stuck `Provisioning`.** In order: (1) DNS must
resolve `$DOMAIN` to the reserved static IP (`dig $DOMAIN`); the cert never goes
Active otherwise. (2) The backend health check must pass — it auto-derives from
the host's `/health` readiness probe; `kubectl describe ingress -n ax-next` and
the backend-service health in the console tell you. (3) Confirm the Ingress
backend targets the `public-http` port (the chart now pins this; a stale render
pointing at `http` is the classic cause of a wired-but-dead backend).

**Host pod `CrashLoopBackOff` with a DB/SSL error.** The DSN or SSL mode is off.
If you see an SSL handshake failure, the instance's SSL setting
(`--ssl-mode=ENCRYPTED_ONLY`) and the DSN's `sslmode` disagree — try
`sslmode=require` (or `sslmode=no-verify` as a fallback; `@ax/database-postgres`
passes the URL straight to `pg`). If it's a connection refusal, re-check
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
- **Host-pod hardening** (securityContext, restricted SA) and a `PodDisruptionBudget`.
- **Automated image-publish CI.** Today the build is manual (Step 2).

---

## Design notes

For the *why* behind the stack choices (gVisor on Autopilot, the TCP proxy, local
workspace + fs blobs, private-IP Postgres, the ingress port-name fix and its
regression test), see the chart's [`SECURITY.md`](charts/ax-next/SECURITY.md) and
the overlay's inline comments. The two facts most likely to bite a newcomer:
external Postgres skips the pgvector init job (Step 1c), and the
`values.yaml` "GCS + Workload Identity" note for the S3 blob backend doesn't
actually work — which is why we park blobs on the PVC here.
