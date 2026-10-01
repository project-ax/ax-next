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
healthy on kind, the chart's basic shape is sound. Real-cluster acceptance
criteria live in [`MANUAL-ACCEPTANCE.md`](MANUAL-ACCEPTANCE.md); for a full
**GKE Autopilot** bring-up (gVisor runners, Cloud SQL, managed-cert ingress)
follow the step-by-step runbook in [`GKE.md`](GKE.md) with the
[`gke-values.yaml`](charts/ax-next/gke-values.yaml) overlay.

```bash
# 0. Prereqs:
#    - docker
#    - kind: https://kind.sigs.k8s.io/docs/user/quick-start/
#    - helm 3: https://helm.sh/docs/intro/install/
#
# Anthropic API key: NOT needed at install time. The first-run wizard
# collects one from you and stores it in the credentials table. Set
# anthropic.apiKey only if you want a host-wide shared key in env (which
# also enables auto-titling on the host pod).

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
kubectl --context kind-ax-next-dev create namespace ax-next-runners
kubectl --context kind-ax-next-dev create namespace ax-next

# 5. Bring up the dev NFS server (TASK-576: `host.preset: memory` — facts
#    memory — is the chart-wide default now, and `kind-dev-values.yaml`
#    points memory.exports at this server, so it has to exist before the
#    chart installs, or the host pod hangs on a mount it can't reach).
#    Equivalent to `make dev-kind-memory-nfs`. See `deploy/kind/memory-nfs/`
#    for what this stands up and why it's dev-only.
docker build -t ax-next/memory-nfs:dev deploy/kind/memory-nfs
kind load docker-image ax-next/memory-nfs:dev --name ax-next-dev
kubectl --context kind-ax-next-dev apply -f deploy/kind/memory-nfs/nfs-server.yaml
kubectl --context kind-ax-next-dev -n ax-next rollout status deploy/ax-next-memory-nfs

# 6. Install. Generate the keys fresh — they encrypt secrets / sign
#    cookies. SAVE the values somewhere safe; reusing them on every
#    upgrade is required (regenerating credentials.key bricks every
#    stored credential — see "Credentials key rotation" below).
export AX_CREDENTIALS_KEY=$(openssl rand -base64 32)
export AX_HTTP_COOKIE_KEY=$(openssl rand -hex 32)
helm --kube-context kind-ax-next-dev install ax-next deploy/charts/ax-next --namespace ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set credentials.key="$AX_CREDENTIALS_KEY" \
  --set http.cookieKey="$AX_HTTP_COOKIE_KEY"

# 7. Wait for the host pod and the postgres pod to come up.
kubectl --context kind-ax-next-dev -n ax-next rollout status deployment/ax-next-host
kubectl --context kind-ax-next-dev -n ax-next rollout status statefulset/ax-next-postgresql

# 8. Port-forward to the host pod and poke at it.
kubectl --context kind-ax-next-dev -n ax-next port-forward svc/ax-next-host 8080:80
```

To pick up code changes:

```bash
docker build -t ax-next/agent:dev -f container/agent/Dockerfile .
kind load docker-image ax-next/agent:dev --name ax-next-dev
kubectl --context kind-ax-next-dev rollout restart deployment/ax-next-host
```

Every `kubectl` / `helm` command in this section names `--context kind-ax-next-dev`
on purpose: on a machine that also talks to a real cluster your *default* context
is often not kind, and a bare `rollout restart` acts on whatever it is. (One did,
once, to a live host.) `make rollout` and friends are pinned the same way.

## Switching an existing deployment to facts memory (one-time operator runbook)

Facts memory (`host.preset: memory`) is the chart default, so a fresh install can skip this section.

The old Strata memory is gone from the code (TASK-608). `host.preset: k8s` now fails `helm template`, and `AX_PRESET=k8s` makes the host refuse to boot. Both errors point here. That's on purpose: quietly booting with no memory at all would be worse than a loud stop.

An **existing** deployment that ran the old Strata memory (`host.preset: k8s`, the default before TASK-576) still holds that old memory. The new memory never reads it. The host does drop Strata's Postgres search index on boot (step 3 explains), but **nothing in the code clears the rest or runs any of this for you.** We run these steps by hand, once per deployment, and only when the owner has decided that **no old data needs keeping**.

> ### ⚠ STOP — read this before running anything
>
> - **Every step below is irreversible.** There's no undo, and nothing is backed up for us. If in doubt, snapshot the volumes and the database first.
> - **Step 5 deletes ALL agent workspace repos and files, for EVERY agent** — not just memory. That includes identity files (`.ax/IDENTITY.md`, `.ax/SOUL.md`), Rules, notes, anything an agent or a person saved into a workspace, and all of its history. Every agent starts with an empty workspace.
> - Only use this runbook on a deployment where **none** of that data needs keeping.
> - Chats are down from step 2 until step 6. Announce a maintenance window.

The commands below assume release `ax-next` in namespace `ax-next`, which is what `deploy/README.md` and `deploy/GKE.md` install. If you named things differently, adjust the resource names (they follow the pattern `<release>-host`, `<release>-git-server-experimental`, …).

**The order matters.** First we switch, then we stop the host, then we erase everything, then we start it again. While the host is down, nothing can re-export or re-record stale memory in the middle of the reset.

**Check which cluster you are pointed at before step 1.** The blocks labelled **kind** already name `--context kind-ax-next-dev`. Every other command below (the shared ones, and the GKE ones) names no context, so it acts on your *current* one, and this runbook scales things to zero and deletes volumes. Run `kubectl config current-context` and read the answer. On kind, add `--context kind-ax-next-dev` to the shared commands; anywhere else, name the context of the cluster you mean. Do not run it against whatever your default happens to be.

### Step 1 — Switch the preset

Set `host.preset: memory` in your values file. It's the default, but pin it anyway, then run `helm upgrade` as usual. The chart now includes the facts store's PVC, `ax-next-memory-facts`.

### Step 2 — Stop the host (and the git-server, if there is one)

```bash
kubectl -n ax-next scale deploy/ax-next-host --replicas=0
kubectl -n ax-next wait --for=delete pod -l app.kubernetes.io/name=ax-next-host --timeout=180s
# Only when workspace.backend=git-protocol (kind dev):
kubectl -n ax-next scale statefulset/ax-next-git-server-experimental --replicas=0
kubectl -n ax-next wait --for=delete pod -l app.kubernetes.io/name=ax-next-git-server-experimental --timeout=180s
```

### Step 3 — Postgres: drop the Strata index, truncate the old facts table

This runs against the deployment's main database, `ax_next`, as user `ax_next`. On kind that's the in-cluster `ax-next-postgresql`; on GKE it's Cloud SQL.

- `memory_strata_index_v2_docs` is Strata's search index. It holds copies of the old memory text. Since TASK-608 the host drops it (and the older `memory_strata_index_v1_docs`) on every boot, so on a current image this line is belt-and-braces. It's harmless to run.
- `memory_facts_v1` is the old preset's facts table. It's usually empty.

```sql
DROP TABLE IF EXISTS memory_strata_index_v2_docs;
DO $$ BEGIN
  IF to_regclass('public.memory_facts_v1') IS NOT NULL THEN
    TRUNCATE TABLE memory_facts_v1;
  END IF;
END $$;
```

kind:

```bash
kubectl --context kind-ax-next-dev -n ax-next exec -i statefulset/ax-next-postgresql -- \
  sh -c 'PGPASSWORD="${POSTGRES_PASSWORD:-$(cat "$POSTGRES_PASSWORD_FILE")}" psql -U ax_next -d ax_next -v ON_ERROR_STOP=1' <<'SQL'
DROP TABLE IF EXISTS memory_strata_index_v2_docs;
DO $$ BEGIN
  IF to_regclass('public.memory_facts_v1') IS NOT NULL THEN
    TRUNCATE TABLE memory_facts_v1;
  END IF;
END $$;
SQL
```

GKE: Cloud SQL is only reachable from inside the cluster, so we use a throwaway pod, the same way as the pgvector step in `deploy/GKE.md`:

```bash
kubectl run memory-reset-sql -n default --restart=Never \
  --image=postgres:17 --env="PGPASSWORD=$DB_PASSWORD" --command -- \
  psql "host=$DB_PRIVATE_IP user=ax_next dbname=ax_next sslmode=require" -v ON_ERROR_STOP=1 \
    -c "DROP TABLE IF EXISTS memory_strata_index_v2_docs;" \
    -c "DO \$\$ BEGIN IF to_regclass('public.memory_facts_v1') IS NOT NULL THEN TRUNCATE TABLE memory_facts_v1; END IF; END \$\$;"
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/memory-reset-sql -n default --timeout=120s
kubectl delete pod memory-reset-sql -n default
```

### Step 4 — Facts store and memory exports

**(a) The facts store.** Under `host.preset: memory`, facts live in a SQLite file, `facts.db`, on the PVC `ax-next-memory-facts`. It is **not** in Postgres. All four of its tables (`memory_facts_v1`, `_fts`, `_vec`, `_embedding_meta`) are in that one file.

- **What we do:** delete the file (and its `-wal`/`-shm` siblings) and **keep the PVC.** When the host boots, it creates a fresh, empty store.
- **Why not delete the PVC:** it carries `helm.sh/resource-policy: keep`. If we deleted it, the host would sit in Pending until the next `helm upgrade` put the PVC back.

The erase runs in a throwaway pod that mounts the PVC. This only works because the host is down: the volume is ReadWriteOnce.

**(b) The memory-exports share.** Skip this if `memory.exports` isn't set. When it is set, it's the per-agent profile export on NFS. Two things mount it:

- the host, read-write, at `/var/lib/ax-next/memory-exports`;
- every runner pod, read-only, at `/memory`.

On **GKE** it's the Filestore share you set as `memory.exports.server` + `memory.exports.exportPath`. The throwaway pod mounts exactly that path, so the erase is scoped to the memory-exports share and nothing else on the instance. kubelet does the NFS mount from the node, so NetworkPolicies don't get in the way.

On **kind** it's the dev NFS server in `deploy/kind/memory-nfs/`, which is backed by an `emptyDir`. Deleting its pod empties it: the Deployment starts a new pod with a fresh, empty `emptyDir`, and the entrypoint recreates `/exports/memory`.

**GKE** (facts file and Filestore memory export in one pod; fill in your two values):

```bash
kubectl -n ax-next apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: memory-reset
spec:
  restartPolicy: Never
  containers:
    - name: reset
      image: busybox:1.36
      command: ["sh", "-c"]
      args:
        - |
          set -eu
          echo "facts files before:"; ls -la /facts
          rm -f /facts/facts.db /facts/facts.db-wal /facts/facts.db-shm
          echo "export entries before: $(find /exports -mindepth 1 | wc -l)"
          find /exports -mindepth 1 -maxdepth 1 -exec rm -rf {} +
          echo "export entries after: $(find /exports -mindepth 1 | wc -l)"
      volumeMounts:
        - { name: facts, mountPath: /facts }
        - { name: exports, mountPath: /exports }
  volumes:
    - name: facts
      persistentVolumeClaim: { claimName: ax-next-memory-facts }
    - name: exports
      nfs:
        server: <memory.exports.server>        # the memory Filestore IP, NOT sandbox.filestore
        path: <memory.exports.exportPath>      # e.g. /memory
YAML
kubectl -n ax-next wait --for=jsonpath='{.status.phase}'=Succeeded pod/memory-reset --timeout=180s
kubectl -n ax-next logs memory-reset
kubectl -n ax-next delete pod memory-reset
```

If you don't use `memory.exports`, drop the `exports` mount, the `exports` volume and the three `/exports` lines.

**kind:**

```bash
kubectl --context kind-ax-next-dev -n ax-next apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: memory-reset
spec:
  restartPolicy: Never
  containers:
    - name: reset
      image: busybox:1.36
      command: ["sh", "-c", "set -eu; ls -la /facts; rm -f /facts/facts.db /facts/facts.db-wal /facts/facts.db-shm"]
      volumeMounts:
        - { name: facts, mountPath: /facts }
  volumes:
    - name: facts
      persistentVolumeClaim: { claimName: ax-next-memory-facts }
YAML
kubectl --context kind-ax-next-dev -n ax-next wait --for=jsonpath='{.status.phase}'=Succeeded pod/memory-reset --timeout=180s
kubectl --context kind-ax-next-dev -n ax-next delete pod memory-reset

# The dev NFS export: deleting the pod empties its emptyDir.
kubectl --context kind-ax-next-dev -n ax-next delete pod -l app.kubernetes.io/name=ax-next-memory-nfs
kubectl --context kind-ax-next-dev -n ax-next rollout status deploy/ax-next-memory-nfs
```

### Step 5 — Reset workspace storage (⚠ deletes ALL agents' workspace repos and files)

Old memory also lives in each agent's workspace repo and its history (`memory/**`, `permanent/memory/facts/**`). We reset workspace storage as a whole. Which commands to use depends on `workspace.backend`.

**`workspace.backend: git-protocol` (kind dev).** The repos live on the git-server StatefulSet's volume. We delete its PVCs, one per shard, named after the `volumeClaimTemplate` called `repo`. When the StatefulSet scales back up, it recreates them empty.

```bash
kubectl --context kind-ax-next-dev -n ax-next get pvc -o name | grep '^persistentvolumeclaim/repo-ax-next-git-server-experimental-'
kubectl --context kind-ax-next-dev -n ax-next get pvc -o name | grep '^persistentvolumeclaim/repo-ax-next-git-server-experimental-' \
  | xargs kubectl --context kind-ax-next-dev -n ax-next delete
kubectl --context kind-ax-next-dev -n ax-next scale statefulset/ax-next-git-server-experimental --replicas=<gitServer.shards, default 1>
kubectl --context kind-ax-next-dev -n ax-next rollout status statefulset/ax-next-git-server-experimental
```

**`workspace.backend: local` (GKE and production; there is no git-server).** The repos are `ws-*.git` directories on the host's workspace PVC, `ax-next-workspace`. **Don't delete that PVC.** It also holds the blob store (`blobs/`, which has attachments, published artifacts and skill-bundle files; the old `skill-bundles/` directory is retired). Each person's share of this volume (repos plus blobs) is capped by the storage limit in Settings (`@ax/disk-quota`), so one person cannot fill it for everyone. We delete only the repos:

```bash
kubectl -n ax-next apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: workspace-reset
spec:
  restartPolicy: Never
  containers:
    - name: reset
      image: busybox:1.36
      command: ["sh", "-c"]
      args:
        - |
          set -eu
          cd /ws
          echo "repos before: $(ls -d ws-*.git repo.git 2>/dev/null | wc -l)"
          rm -rf ws-*.git repo.git
          echo "repos after: $(ls -d ws-*.git repo.git 2>/dev/null | wc -l)"
          ls -la /ws
      volumeMounts:
        - { name: ws, mountPath: /ws }
  volumes:
    - name: ws
      persistentVolumeClaim: { claimName: ax-next-workspace }
YAML
kubectl -n ax-next wait --for=jsonpath='{.status.phase}'=Succeeded pod/workspace-reset --timeout=180s
kubectl -n ax-next logs workspace-reset
kubectl -n ax-next delete pod workspace-reset
```

### Step 6 — Start the host again

```bash
kubectl -n ax-next scale deploy/ax-next-host --replicas=1
kubectl -n ax-next rollout status deploy/ax-next-host
```

### Step 7 — Check it worked

- `kubectl -n ax-next logs deploy/ax-next-host -c host | grep -iE 'error|fail'` shows nothing new.
- Open an agent. Its Files tab is empty, and the Memory tab has nothing remembered yet.
- Have one chat that states a fact. Wait about 5 minutes after the chat goes idle, then check that the Memory tab shows it.
- Rules went with the workspace, so re-enter any that are still wanted in the Memory tab.

### Facts memory that ran routines on an image older than TASK-616

Short version: run this runbook on an image at or after TASK-616 (PR #768), and there's nothing to do here.

Before TASK-616, when a routine ran, the facts memory stored its rows under the routine's own hidden conversation. Memory recall counts *distinct conversations* in its evidence, and the skill-reflection routine uses that count to decide whether a procedure really came up more than once (it wants at least 2). So each of those routine conversations can count as one extra conversation the person never had. From TASK-616 on, rows from a routine run carry no conversation, so new rows are fine. Old rows keep theirs.

There's no automatic cleanup for the old rows, and that's deliberate:

- **The facts store can't tell which rows came from a routine.** `facts.db` has no column that says so. Only the conversations table in Postgres knows that a conversation was opened by a routine (`origin = 'routine'`). Those are two different databases, so no single query can join them.
- **The window was about half a day.** Facts memory became the default in TASK-576 (PR #762), and TASK-616 landed the same day.
- **The damage is bounded.** A `conversation: shared` routine, like the default heartbeat, keeps one conversation, so it adds at most one per routine per agent. A `per-fire` routine adds one per fire. Skill-reflection is a per-fire routine. It stays off unless an operator switched it on, and it fires at most once a day per agent.
- **The Postgres facts table has nothing to fix.** Under `host.preset: memory` it has no writer (step 3 truncates it anyway).

So a deployment is affected only if it ran `host.preset: memory` on a pre-TASK-616 image **and** routines fired in that time. Usually the right move is to do nothing: it's a small over-count, and it doesn't grow. If the owner has already decided that **no memory needs keeping**, clearing it is steps 2, 4 and 6 above. That deletes **all** facts memory for **every** agent, and it can't be undone.

## Linting and validating

```bash
helm lint deploy/charts/ax-next

# Render the full manifest — useful when sanity-checking RBAC, NetworkPolicies,
# or the runner namespace fences.
helm template ax-next deploy/charts/ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set credentials.key=dGVzdA== --set http.cookieKey=$(printf '0%.0s' {1..64})
```

Schema validation (`kubeconform` or `kubeval`) is recommended but not bundled
in this repo's tooling yet. If you have either installed locally:

```bash
helm template ax-next deploy/charts/ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set credentials.key=dGVzdA== --set http.cookieKey=$(printf '0%.0s' {1..64}) \
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
- **Dev-services need Kubernetes 1.29+.** If you enable dev-services in the
  sandbox (`sandbox.devServices.enabled=true`), your cluster has to be 1.29 or
  newer. The chart refuses to install on anything older — see
  "Dev-services require Kubernetes 1.29+" below for why.

## Dev-services require Kubernetes 1.29+

Agents can declare "dev-dependency services" — a database, a message broker —
that run right next to the runner so a checked-out repo can reach them at
`localhost`. On Kubernetes we render each one as a *native sidecar*: an init
container with `restartPolicy: Always`.

That little `restartPolicy: Always` is doing a lot of work, and it only works on
**Kubernetes 1.29 or newer**. That's the release where the SidecarContainers
feature went GA (on by default). Before 1.29, the kubelet doesn't know what to do
with a restart policy on an init container, so it just... ignores it.

Here's the part that bites: when it's ignored, the service falls back to being a
plain, *blocking* init container. The kubelet waits for it to finish before it
starts the runner — but a database doesn't finish. It runs forever, which is its
whole job. So the pod sits in `Init` until the 6-hour deadline reaps it, the
session never starts, and there's no error to tell you why. Just a runner that
never shows up. Not fun to debug at 3am.

So we made the chart loud about it:

- `sandbox.devServices.enabled` defaults to `false`. Leave it there if you don't
  use dev-services — nothing changes.
- Flip it to `true` only on a 1.29+ cluster. The chart runs a preflight that
  fails `helm install` / `helm upgrade` if the cluster reports anything older,
  with a message that points right back here.
- One gotcha: `helm template` doesn't talk to your cluster, so it checks helm's
  built-in stub version instead of yours. To render the chart the way your
  cluster will see it, pass `--kube-version`:

  ```bash
  helm template ax-next deploy/charts/ax-next \
    --set sandbox.devServices.enabled=true \
    --kube-version 1.29.0 \
    --set credentials.key=dGVzdA== --set http.cookieKey=$(printf '0%.0s' {1..64})
  ```

- If you've confirmed your cluster is 1.29+ another way (or you're on a vendor
  distro whose version string doesn't sort cleanly under semver), you can bypass
  the preflight with `sandbox.devServices.skipKubeVersionCheck=true`. Do that
  deliberately — it hands you back the silent-hang footgun.

The full threat-model walk is in
[`charts/ax-next/SECURITY.md`](charts/ax-next/SECURITY.md).

## Restarting the host pod: delete the runner pods FIRST

The order is counter-intuitive, so here it is up front. (Both commands act on your *current* kube context: check it first with `kubectl config current-context`, or add `--context <name>` to each. On kind that is `--context kind-ax-next-dev`.)

```bash
# 1. Evict any live runner pods.
# For sandbox.backend=agent-sandbox, delete the PARENT resources first:
# kubectl delete sandboxes.agents.x-k8s.io -n ax-next-runners -l ax.io/sandbox-backend=agent-sandbox --wait=true
# Deleting only their Pods makes the controller recreate them.
kubectl delete pods -n ax-next-runners -l app.kubernetes.io/component=ax-next-runner

# 2. THEN restart the host.
kubectl rollout restart deployment/ax-next-host -n ax-next
```

Do it the other way round and the next turn fails in a way that looks like an
auth bug: a `403` on the call to `api.anthropic.com`, saying the host is "not in
any session allowlist". It isn't an auth bug, and it isn't Anthropic — our own
credential proxy short-circuits the request, which never leaves the cluster. So
don't go rotating provider keys; the problem is a pod, not a credential.

Here's why. A runner pod outlives the host that spawned it. In the default
`pod` backend it is a bare Pod with no ownerReference; in `agent-sandbox` mode
its Sandbox controller owns it. The conversation row still points at that pod's session, so the new
host happily routes the next turn into it. But the credential proxy keeps its
session allowlist **in the host's memory**, and the new host never registered a
session for a pod it didn't spawn. So the pod is alive, reachable, and holding a
token nobody will vouch for. Every outbound provider call gets refused.

We know about this and we're accepting it for now rather than papering over it.
The tempting fix — have a starting host evict every Running runner pod it has no
session for — is the wrong shape the moment the host runs more than one replica:
replica B would cheerfully murder replica A's in-flight turns. A correct
reconciler needs per-host pod ownership on the wire first, which is a bigger
change than this note.

What we *do* clean up automatically is the **terminal** case: the periodic
orphan sweep in `@ax/sandbox-k8s` reaps runner pods in `Succeeded` / `Failed`
that a failed delete left behind. Live pods are deliberately out of its scope,
for the replica reason above.

If you've already restarted in the wrong order, the recovery is the same two
commands — delete the runner pods, and the next turn spawns a fresh one.

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
export AX_HTTP_COOKIE_KEY=$(openssl rand -hex 32)
helm install ax-next deploy/charts/ax-next \
  --set credentials.key="$AX_CREDENTIALS_KEY" \
  --set http.cookieKey="$AX_HTTP_COOKIE_KEY" \
  ...

# DO THIS for every upgrade — same keys, every time:
helm upgrade ax-next deploy/charts/ax-next \
  --set credentials.key="$AX_CREDENTIALS_KEY" \
  --set http.cookieKey="$AX_HTTP_COOKIE_KEY" \
  ...
```

Both keys are lookup-stable in the chart: if you forget to pass them on
upgrade and the secret already exists, the existing values get reused.
But that's a safety net, not the primary contract — pass them explicitly
so the upgrade still works after the secret is recreated for any reason.

`anthropic.apiKey` is also lookup-stable now (and optional in the first
place, since the wizard collects one). Set it only if you wanted a
host-wide shared key in env.

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
