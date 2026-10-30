# The dev NFS server on kind (`/memory` and `/files`)

On GKE, two things live on Filestore (Google's managed NFS):

- **`/memory`**: the facts-memory preset (`host.preset=memory`) writes a
  read-only copy of each agent's memory there, and runner pods mount it at
  `/memory`. It's a projection the host rewrites, so it lives on an
  `emptyDir` here.
- **`/files`**: every agent's home directory (`sandbox.filestore`). Runner
  pods mount their own agent's folder of it at `/files`, and the host mounts
  the whole export read-only at `/user-files` for the Files tab. This is the
  only copy of those files, so it lives on a PVC (`ax-next-files-nfs`) and is
  kept across NFS-pod restarts.

kind doesn't have Filestore, so this folder stands one server up inside the
cluster for both. It's dev-only: privileged, unauthenticated, and exported to
the node's address only. Please don't point anything real at it.

## Bring it up

TASK-576 made `host.preset: memory` (facts memory) the chart-wide default, and
folded this server's address into `kind-dev-values.yaml` itself — there is no
separate preset switch or overlay file to pass any more (the old
`kind-memory-values.yaml` overlay is kept only as a documented no-op, for a
script that still names it). TASK-992 made the `/files` home required: the
chart won't render without `sandbox.filestore.server`, and
`kind-dev-values.yaml` points that at this server too. So the only thing left
to do here is stand up this server BEFORE the chart installs or upgrades.

Assumes the kind cluster `ax-next-dev` is running (see `deploy/README.md`, or
run `make dev-kind-memory-nfs`, which does the same two steps below). Always
name the context: this machine's kubeconfig may also hold production
clusters, and a bare `kubectl` picks whichever one is current.

```bash
# 1. The NFS server image — built locally, loaded into kind, never pulled.
docker build -t ax-next/memory-nfs:dev deploy/kind/memory-nfs
kind load docker-image ax-next/memory-nfs:dev --name ax-next-dev

# 2. The server, its Service (pinned ClusterIP 10.96.200.49) and the /files PVC.
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
kubectl --context kind-ax-next-dev -n ax-next exec deploy/ax-next-memory-nfs -- exportfs -v
# /exports        10.244.0.1(sync,wdelay,hide,crossmnt,no_subtree_check,fsid=0,...)
# /exports/files  10.244.0.1(sync,wdelay,hide,no_subtree_check,fsid=1,...)
kubectl --context kind-ax-next-dev -n ax-next exec deploy/ax-next-host -c host -- \
  sh -c 'echo $AX_PRESET; mount | grep -E "memory-exports|user-files"'
# memory
# 10.96.200.49:/memory on /var/lib/ax-next/memory-exports type nfs4 (rw,...)
# 10.96.200.49:/files on /user-files type nfs4 (ro,...)
```

## Things that will bite

- **An upgrade with `--reuse-values` fails.** On a release installed before
  the `memory.facts` values existed, it fails with `nil pointer evaluating
  interface {}.storage`. On a release installed before TASK-992, it fails with
  `sandbox.filestore.server is empty`. Either way the reason is the same:
  `--reuse-values` keeps the OLD release's values and skips the new chart
  defaults. Pass the old values as a file instead (step 3).
- **The kernel has to have `nfsd`.** OrbStack and Docker Desktop VMs build it
  in. If the pod crash-loops on `mount -t nfsd`, your VM kernel doesn't.
- **Restart the NFS pod → restart the host pod, and expect an empty
  `/memory`.** The memory export lives in an `emptyDir`, so a new NFS pod
  starts with it empty and the host's mounts go stale until the host restarts
  (that restart also remounts the host's read-only `/user-files`). Delete the
  runner pods first, as for any host restart. Nothing is lost: the facts
  database on the host's PVC is the source of truth, and `/files` is on its
  own PVC. But the exporter only rewrites an agent's memory export when that
  agent's memory next changes (TASK-529), so `/memory` stays empty for
  everyone until then. Say something memorable to the agent, or edit a row on
  its Memory tab, to bring it back.
- **Wiping every agent's files on kind** takes the PVC, not the pod. Scale the
  server to zero, delete the PVC, then bring the server back (step 2 recreates
  the PVC empty):

  ```bash
  kubectl --context kind-ax-next-dev -n ax-next scale deploy/ax-next-memory-nfs --replicas=0
  kubectl --context kind-ax-next-dev -n ax-next delete pvc ax-next-files-nfs
  make dev-kind-memory-nfs
  ```

  Restart the host afterwards, as above. Note that deleting `nfs-server.yaml`
  as a whole (`kubectl --context kind-ax-next-dev delete -f ...`) deletes this
  PVC too.
- **The pod refuses to start: "refusing to serve agent homes from scratch
  space".** The entrypoint found no volume mounted at `/exports/files`, which
  means the running manifest is older than the `/files` PVC. Re-apply
  `nfs-server.yaml` (`make dev-kind-memory-nfs`).
- **The pod restarts with `Startup probe failed`.** The image is older than
  the manifest: it still listens on 2049 but never exports `/exports/files`.
  Left serving, it would put every agent's files on the `emptyDir` underneath
  the PVC, so the probe keeps it out of the Service instead. Rebuild and
  reload the image with `make dev-kind-memory-nfs` (it builds before it
  applies).
- **Only the node may mount.** The server exports both directories to its own
  default gateway (the node's address on the pod network), so kubelet's mounts
  work and a pod speaking NFS directly gets `Permission denied`. Runners reach
  `/memory` only through their read-only mount, and `/files` only through
  their own agent's folder; no runner can mount the whole `/files` export and
  read another agent's files.
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
