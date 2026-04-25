# Manual acceptance — Week 7–9 (k8s deployment shape)

Automated CI exercises the postgres + workspace + session + eventbus plugin
chain via testcontainers (`presets/k8s/src/__tests__/acceptance.test.ts`). It
does NOT exercise a real runner pod. This file is the manual procedure for
proving the k8s preset can actually run a chat in a real cluster — kind for
dev verification, a real cluster for full acceptance.

We're a nervous crab. Don't ship without doing this.

## Prerequisites

- `kind` (or any k8s cluster you trust to receive a chart that creates pods).
- `kubectl`.
- `helm` 3.x.
- `docker` (running) for building the runner image.
- An Anthropic API key (we don't ship a default — you bring it).

## Goldenpath: kind

```bash
# 1. Build the runner image
#    Dockerfile.agent is a follow-up PR — bring your own image OR build a
#    minimal one that bundles both runner binaries:
#      @ax/agent-native-runner       → /opt/ax-next/agent-native-runner.js
#      @ax/agent-claude-sdk-runner   → /opt/ax-next/agent-claude-sdk-runner.js
docker build -t ax-next/agent:dev -f deploy/Dockerfile.agent .

# 2. Create a kind cluster + load the image
kind create cluster --name ax-next-dev
kind load docker-image ax-next/agent:dev --name ax-next-dev

# 3. Install the chart (into the ax-next namespace — every probe below
#    assumes that, including the new HTTP runner-IPC checks under "Known
#    gotchas").
helm install ax-next deploy/charts/ax-next \
  --namespace ax-next --create-namespace \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set image.repository=ax-next/agent \
  --set image.tag=dev \
  --set credentials.key="$(openssl rand -base64 32)" \
  --set anthropic.apiKey="$ANTHROPIC_API_KEY"

# 4. Wait for the host pod to be Ready (postgres init job runs first; the
#    host Deployment waits on it).
kubectl wait -n ax-next --for=condition=Ready pod \
  -l app.kubernetes.io/component=ax-next-host --timeout=180s

# 5. Port-forward the host service
kubectl port-forward -n ax-next svc/ax-next-host 8080:80 &

# 6. Send a chat from the local CLI pointing at the cluster
ax-next chat --endpoint http://localhost:8080 "list the files in /workspace"
```

## Acceptance criteria

Any failure here blocks merge.

### Functional
- [ ] Chat returns a response. The response references a bash tool execution
      whose output is the actual file listing of the runner pod's workspace
      (which is empty by default — `ls /workspace` returns no entries, the
      assistant should say so coherently).
- [ ] `kubectl get pods -n ax-next-runners -l app.kubernetes.io/component=ax-next-runner`
      shows a runner pod was created and (after the chat ends) terminated
      within ~60s of the chat finishing.
- [ ] No stuck runner pods: 60s after the chat ends, the runner-namespace pod
      count is back to zero.

### State persistence
- [ ] A row landed in `session_postgres_v1_sessions`:
      ```bash
      kubectl exec -n ax-next deploy/ax-next-host -- \
        psql -U ax-next -d ax-next \
        -c "SELECT count(*) FROM session_postgres_v1_sessions;"
      ```
      Returns `count > 0`.
- [ ] A row landed in storage (audit log + chat-event log both write here):
      ```bash
      kubectl exec -n ax-next deploy/ax-next-host -- \
        psql -U ax-next -d ax-next \
        -c "SELECT count(*) FROM storage_postgres_v1_kv;"
      ```
      Returns `count > 0`.
- [ ] A workspace version was minted:
      ```bash
      kubectl exec -n ax-next deploy/ax-next-host -- \
        ls /workspace-data/repo.git/refs/heads/main
      ```
      File exists.

### Logs / hygiene
- [ ] No `level >= warn` lines in `kubectl logs -n ax-next deploy/ax-next-host`
      other than the expected gVisor-disabled warning if you're on a kind
      cluster without gVisor (the kind values.yaml turns gVisor off — that
      warning is OK; nothing else should be).

### Cleanup
- [ ] `helm uninstall ax-next -n ax-next` completes successfully.
- [ ] 60s after uninstall: `kubectl get pods -n ax-next` and
      `kubectl get pods -n ax-next-runners` both show zero `ax-next-*` pods.

## Real-cluster acceptance

Same procedure as kind, but:
- Use a cluster with gVisor available (or accept the documented degradation —
  see `packages/sandbox-k8s/SECURITY.md`).
- Don't pass `kind-dev-values.yaml`; tune resources for the cluster.
- Use a real ingress (`--set ingress.enabled=true --set ingress.host=...`).
- Bring an external postgres (`--set postgres.embedded.enabled=false --set
  postgres.external.connectionString=...`) or accept the embedded subchart
  for first-pass verification only.

## Known gotchas

- **HTTP runner-IPC.** After install, verify the host pod is binding the
  IPC listener:

  ```bash
  kubectl logs -n ax-next deploy/ax-next-host | grep ipc-http
  # expect: [ax/ipc-http] listening on http://0.0.0.0:8080
  ```

  Then verify a runner pod can reach it from inside the cluster. The
  simplest probe: launch a one-shot debug pod in the runner namespace:

  ```bash
  kubectl run debug --rm -it -n ax-next-runners \
    --image curlimages/curl --restart=Never -- \
    curl -sS http://ax-next-host.ax-next.svc.cluster.local/healthz
  # expect: {"ok":true}
  ```

  The end-to-end "chat returns a response" criterion requires a
  user-facing entry point on the host pod (separate follow-up — the host
  pod's CLI `serve` subcommand isn't shipped yet) and a pre-built
  runner image (`Dockerfile.agent`, follow-up #4 in the Week 7-9
  followups doc). With those in place, kubectl-exec into the host pod
  and run a one-shot CLI chat; the runner pod gets created, connects
  back over HTTP, and returns.

- **`Dockerfile.agent` is not in this PR.** Pre-build any image bundling the
  two runner binaries; the chart only consumes it.

- **The embedded postgres** uses Bitnami's chart at version `16.7.27`. Bitnami
  recently moved many images from `bitnami/*` to `bitnamilegacy/*`. If image
  pulls fail, set `postgres.embedded.image.registry` accordingly. See
  `deploy/charts/ax-next/SECURITY.md` for the full note.

- **Network policies** can interfere with kind's default CNI. The kind dev
  values disable NPs (`networkPolicies.enabled=false`). Real-cluster deploys
  must run on a CNI that enforces NPs (Calico, Cilium, etc.) — verify before
  enabling in prod.

## When this passes, do
1. Update the PR description's acceptance section with the date + cluster
   used + a copy of the `psql` count outputs.
2. Mark Task 21 complete.
