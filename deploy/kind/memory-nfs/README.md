# Memory preset on kind (dev NFS server)

The facts-memory preset (`host.preset=memory`) writes a read-only export of
each agent's memory to an NFS share, and runner pods mount it at `/memory`.
On GKE that share is Filestore. kind doesn't have Filestore, so this folder
stands one up inside the cluster. It's dev-only — privileged, unauthenticated,
and backed by an `emptyDir`. Please don't point anything real at it.

## Bring it up

Assumes the kind cluster `ax-next-dev` is running and the chart is installed
with `kind-dev-values.yaml` (see `deploy/README.md`). Always name the context:
this machine's kubeconfig may also hold production clusters, and a bare
`kubectl` picks whichever one is current.

```bash
# 1. The NFS server image — built locally, loaded into kind, never pulled.
docker build -t ax-next/memory-nfs:dev deploy/kind/memory-nfs
kind load docker-image ax-next/memory-nfs:dev --name ax-next-dev

# 2. The server + its Service (pinned ClusterIP 10.96.200.49).
kubectl --context kind-ax-next-dev apply -f deploy/kind/memory-nfs/nfs-server.yaml
kubectl --context kind-ax-next-dev -n ax-next rollout status deploy/ax-next-memory-nfs

# 3. Switch the release to the memory preset. Keep the release's existing
#    values (dump them with `helm get values ax-next -n ax-next -o yaml`, or
#    use --reset-then-reuse-values on helm >= 3.14) so the credentials key
#    doesn't change — a new one bricks every stored credential.
helm --kube-context kind-ax-next-dev upgrade ax-next deploy/charts/ax-next -n ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  -f <your-previous-values.yaml> \
  -f deploy/charts/ax-next/kind-memory-values.yaml \
  --set memory.vertexProject=<a GCP project your Vertex token can call>
```

Check it took:

```bash
kubectl --context kind-ax-next-dev -n ax-next exec deploy/ax-next-host -c host -- \
  sh -c 'echo $AX_PRESET; mount | grep memory-exports'
# memory
# 10.96.200.49:/memory on /var/lib/ax-next/memory-exports type nfs4 (rw,...)
```

## Things that will bite

- **`helm upgrade --reuse-values` fails** with `nil pointer evaluating
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
- **The memory preset needs three credentials, not two.** Vertex
  (`provider:vertex`, embeddings) and Cohere (`provider:cohere`, reranking)
  degrade recall when missing. The observer's extraction model runs through
  OpenRouter (`provider:openrouter`) — without it, nothing is ever extracted
  from conversations and the host logs `memory_no_llm_credential`. OpenRouter
  goes in through the admin Provider keys screen; Vertex and Cohere have no
  UI path yet.
