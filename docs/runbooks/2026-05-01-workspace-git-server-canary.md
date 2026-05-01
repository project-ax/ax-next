# Runbook — workspace-git-server canary

**Audience:** operators rolling out Phase 1 of the workspace redesign (`@ax/workspace-git-server`) on a test cluster.

**Status:** experimental. Toggle defaults OFF; production path keeps using `@ax/workspace-git-http` until Phase 2 wires the host plugin.

---

## What this canary actually deploys

When you flip `gitServer.experimental.gitProtocol: true` (with `gitServer.enabled: true`), the chart adds three resources alongside the legacy git-server Deployment:

- A **StatefulSet** `<release>-git-server-experimental` with `replicas: <gitServer.shards>` (default 1), serving git smart-HTTP + a tiny REST CRUD on port `gitServer.port` (default 7780).
- A **headless Service** `<release>-git-server-experimental-headless` (`clusterIP: None`) so each shard pod gets stable per-pod DNS via the StatefulSet's pod-index label.
- A **NetworkPolicy** `<release>-git-server-experimental-network` permitting ingress from host pods only, egress empty.

Each shard gets its own PVC via `volumeClaimTemplates` (annotated `helm.sh/resource-policy: keep` — `helm uninstall` does NOT delete the bare repos).

The legacy `@ax/workspace-git-http` Deployment + ClusterIP + single-PVC keep running in parallel. **Production traffic is unaffected** because no host plugin registers against the new tier yet — that's Phase 2's PR.

---

## Pre-flip checklist

Before flipping `experimental.gitProtocol: true`:

- [ ] `helm template <release> deploy/charts/ax-next --set gitServer.enabled=true --set gitServer.experimental.gitProtocol=true --set gitServer.storage=10Gi --set credentials.key=$(openssl rand -base64 32)` renders cleanly. Spot-check the StatefulSet, headless Service, and NetworkPolicy.
- [ ] `helm template ... --set gitServer.experimental.gitProtocol=false ...` shows the legacy resources unchanged.
- [ ] `pnpm --filter @ax/workspace-git-server test` is green on the operator's checkout.
- [ ] `pnpm --filter @ax/chart-tests test` is green (helm CLI must be on PATH).
- [ ] `helm upgrade --dry-run <release> deploy/charts/ax-next ...` shows the expected diff (new STS, new Service, new NP) and **nothing else**.
- [ ] The image `ax-next/git-server:<tag>` has been built (`docker build -f container/git-server/Dockerfile -t ax-next/git-server:<tag> .` from the repo root) and pushed to whatever registry your cluster pulls from.
- [ ] You have the rollback `helm` command queued up in another window.

---

## Flipping the toggle

```bash
helm upgrade <release> deploy/charts/ax-next \
  --reuse-values \
  --set gitServer.experimental.gitProtocol=true \
  --set gitServer.shards=1 \
  --set gitServerImage.tag=<tag>
```

`--reuse-values` keeps everything else (postgres, host pod replica count, etc.) at whatever the operator already set.

After the upgrade:

```bash
kubectl get sts -n <ns> <release>-git-server-experimental
kubectl get pods -n <ns> -l app.kubernetes.io/component=git-server-experimental
kubectl logs -n <ns> <release>-git-server-experimental-0
```

Logs should show `[ax/workspace-git-server] listening on http://0.0.0.0:7780` on each shard pod.

Smoke test from inside the cluster:

```bash
kubectl run -n <ns> curl-test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -sf http://<release>-git-server-experimental-0.<release>-git-server-experimental-headless:7780/healthz
```

Should return `{"status":"ok"}` from each shard ordinal.

---

## Rollback

### Same-day rollback (canary surfaced a problem)

```bash
helm upgrade <release> deploy/charts/ax-next \
  --reuse-values \
  --set gitServer.experimental.gitProtocol=false
```

The new StatefulSet, headless Service, and experimental NetworkPolicy un-render. The PVCs persist (`helm.sh/resource-policy: keep`) so the bare repos survive for forensics — operators delete them manually if/when no longer needed:

```bash
kubectl get pvc -n <ns> -l app.kubernetes.io/component=git-server-experimental
kubectl delete pvc -n <ns> repo-<release>-git-server-experimental-0
```

Production keeps running on the legacy `@ax/workspace-git-http` path the whole time — there's no traffic switchover to undo (Phase 1 doesn't wire any).

### One bad shard

Phase 1 ships with no per-shard quarantine. If only one shard misbehaves, escalate to "flip the whole toggle off" (above) and triage from the persisted PVCs. Phase 2's host plugin will gain a per-workspace shard-skip mechanism if real traffic surfaces the need.

### Data corruption suspicion

The new tier has been serving zero production traffic until Phase 2, so there's no "lost data" to recover from for non-canary workspaces. For canary workspaces:

- Keep the PVCs (the default `helm.sh/resource-policy: keep` ensures this).
- Inspect the bare repos via a debug pod that mounts the PVC read-only.
- If the canary workspace's bare repo is corrupt, treat it as lost — Phase 1's MVP scope explicitly defers DR (see `packages/workspace-git-server/SECURITY.md` "Known limits").

---

## Common-failure triage

### Shard pod CrashLoopBackOff at boot

Check logs. Most likely:

- `AX_GIT_SERVER_TOKEN is required` → the chart's `git-server-auth` Secret hasn't been created. The chart should generate one on first install via the lookup-or-generate pattern in `git-server-auth-secret.yaml`. If it's missing, run `helm upgrade` again — the lookup-or-generate fires on each upgrade.
- `AX_GIT_SERVER_REPO_ROOT is required` → the StatefulSet template's env wiring is broken. Check `kubectl get sts ... -o yaml` and confirm the env var is set to `/var/lib/ax-next/repo` (or whatever `gitServer.mountPath` is).
- `permission denied: /var/lib/ax-next/repo` → the PVC's filesystem ownership doesn't match the pod's `runAsUser: 1000`. The pod's `securityContext.fsGroup: 1000` should fix this on the first mount; if it persists, the CSI driver may not honor `fsGroupChangePolicy: OnRootMismatch`. Check the PVC's storage class and ask the cluster operator.

### Healthz fails from inside cluster

- NetworkPolicy too tight: confirm the curl test pod is in the same namespace as the git-server-experimental pod. If it's in a different namespace, the NetworkPolicy blocks it (host pods only). For triage, temporarily relabel the curl pod to match `app.kubernetes.io/component: host`, or run the curl from a real host pod's exec session.
- DNS not resolving: confirm the headless Service exists (`kubectl get svc -n <ns> <release>-git-server-experimental-headless`) and CoreDNS is healthy.

### `helm upgrade` reports `gitServer.storage is required`

You set `gitServer.experimental.gitProtocol=true` but didn't pass `gitServer.storage`. The chart's `required` template fires before render. Add `--set gitServer.storage=10Gi` and re-run.

### Push to a workspace fails with `non-fast-forward`

Working as designed. The bare repos are configured with `receive.denyDeletes=true` and `receive.denyNonFastForwards=true` at create time — this is the linear-history server-side enforcement. Clients should fetch + rebase + retry, not `--force`.

### One shard pod won't drain on rolling restart

Pod's `preStop` hook sleeps for ~25 seconds after sending SIGTERM, giving in-flight pushes time to finish. If pushes routinely take longer:

- Bump `gitServer.terminationGracePeriodSeconds` (default 60) to the worst-case push duration + 10s.
- Bump the `preStop` sleep value via the chart values (or accept that long-running pushes may be force-killed).
- Investigate why pushes are slow — large bare repos with no `git gc` are the usual cause.

---

## What this runbook does NOT cover

- **Multi-replica HA per shard.** Phase 1's MVP is single-replica per shard. See `packages/workspace-git-server/SECURITY.md` "Known limits".
- **Re-sharding.** Operator picks `gitServer.shards` at install time; changing it later requires manual workspace migration. Not automated in Phase 1.
- **Cross-region replication.** Out of scope for Phase 1.
- **Backup / DR.** Operator's responsibility — use the cluster's CSI snapshot mechanism or a `git bundle` cron to off-cluster object storage.

---

## When this runbook gets retired

When Phase 5 lands (decommission of `@ax/workspace-git-http`), this runbook gets folded into the canonical workspace runbook and the "experimental" toggle goes away. Until then, keep this file with the current Phase 1 caveats.
