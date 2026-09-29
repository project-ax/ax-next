# Memory preset on kind (dev NFS server)

The facts-memory preset (`host.preset=memory`) writes a read-only export of
each agent's memory to an NFS share, and runner pods mount it at `/memory`.
On GKE that share is Filestore. kind doesn't have Filestore, so this folder
stands one up inside the cluster. It's dev-only — privileged, unauthenticated,
and backed by an `emptyDir`. Please don't point anything real at it.

## Bring it up

TASK-576 made `host.preset: memory` (facts memory) the chart-wide default, and
folded this server's address into `kind-dev-values.yaml` itself — there is no
separate preset switch or overlay file to pass any more (the old
`kind-memory-values.yaml` overlay is kept only as a documented no-op, for a
script that still names it). So the only thing left to do here is stand up
this server BEFORE the chart installs or upgrades, since the chart now
expects it to be reachable by default.

Assumes the kind cluster `ax-next-dev` is running (see `deploy/README.md`, or
run `make dev-kind-memory-nfs`, which does the same two steps below). Always
name the context: this machine's kubeconfig may also hold production
clusters, and a bare `kubectl` picks whichever one is current.

```bash
# 1. The NFS server image — built locally, loaded into kind, never pulled.
docker build -t ax-next/memory-nfs:dev deploy/kind/memory-nfs
kind load docker-image ax-next/memory-nfs:dev --name ax-next-dev

# 2. The server + its Service (pinned ClusterIP 10.96.200.49).
kubectl --context kind-ax-next-dev apply -f deploy/kind/memory-nfs/nfs-server.yaml
kubectl --context kind-ax-next-dev -n ax-next rollout status deploy/ax-next-memory-nfs

# 3. Install or upgrade the chart, same as any other change — no separate
#    preset flag needed, `kind-dev-values.yaml` already carries it:
helm --kube-context kind-ax-next-dev upgrade --install ax-next deploy/charts/ax-next -n ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  -f <your-previous-values.yaml>
```

There is no going back to the legacy Strata preset: it was deleted in TASK-608,
and `--set host.preset=k8s` now fails `helm template` with a pointer to the
switch runbook in `deploy/README.md`.

Check it took:

```bash
kubectl --context kind-ax-next-dev -n ax-next exec deploy/ax-next-host -c host -- \
  sh -c 'echo $AX_PRESET; mount | grep memory-exports'
# memory
# 10.96.200.49:/memory on /var/lib/ax-next/memory-exports type nfs4 (rw,...)
```

## Things that will bite

- **An upgrade with `--reuse-values` fails** with `nil pointer evaluating
  interface {}.storage` if the release was installed before the `memory.facts`
  values existed. `--reuse-values` keeps the OLD release's values and skips the
  new chart defaults. Pass the old values as a file instead (step 3).
- **The kernel has to have `nfsd`.** OrbStack and Docker Desktop VMs build it
  in. If the pod crash-loops on `mount -t nfsd`, your VM kernel doesn't.
- **Restart the NFS pod → restart the host pod, and expect empty exports.**
  The export lives in an `emptyDir`, so a new NFS pod starts empty and the
  host's mount goes stale until the host restarts. Nothing is lost — the facts
  database on the host's PVC is the source of truth — but the exporter only
  rewrites an agent's export when that agent's memory next changes (TASK-529),
  so `/memory` stays empty for everyone until then. Say something memorable
  to the agent, or edit a row on its Memory tab, to bring it back.
- **Only the node may mount.** The server exports to its own default gateway
  (the node's address on the pod network), so kubelet's mounts work and a pod
  speaking NFS directly gets `Permission denied`. Runners reach the export only
  through their read-only `/memory` mount.
- **The memory preset needs one credential, and it is OpenRouter.**
  `provider:openrouter`, stored through Admin → AI model keys, drives the
  observer's extraction model, embeddings and reranking. Without it,
  nothing is extracted from conversations (the host logs
  `memory_no_llm_credential`, and the Memory tab says "Memory is paused") and
  recall answers lexically with `degraded: ["semantic", "ranking"]`.
- **Changing the embedding model wipes the stored vectors.** The fact store
  remembers which model made its vectors; on a mismatch it drops them all
  rather than compare two incompatible vector spaces, and re-embeds each
  agent's facts in the background after that agent's next successful memory
  write OR search (TASK-598 — an agent that only reads recovers too). The
  search that notices still answers lexical-plus-recency, and says so with
  `degraded: ["semantic"]`; the re-embed runs detached (up to 200 facts per
  pass), so a search a moment later is back to full strength. The Memory tab
  shows no notice for this: it heals itself, and there is nothing to fix.
  The same happens once, on the first boot after an upgrade that changes how
  vectors are made with the same model (TASK-590: stored facts are now embedded
  as documents rather than as queries). A walk after that upgrade should expect
  the FIRST recall per agent to say `["semantic"]` and a later one not to.
