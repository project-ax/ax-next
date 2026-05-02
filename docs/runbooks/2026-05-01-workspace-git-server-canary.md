# Runbook — workspace-git-server canary

**Audience:** operators rolling out the workspace redesign (`@ax/workspace-git-server`) on a test cluster.

**Status:** experimental. Both toggles default OFF; production path keeps using `@ax/workspace-git-http` until an operator flips them.

> **Half-wired window: CLOSED in Phase 2** (PR linked here once opened).
>
> Phase 2 wires the host plugin (`@ax/workspace-git-server`'s `createWorkspaceGitServerPlugin`) into `@ax/preset-k8s` behind `workspace.backend=git-protocol`. Flipping `gitServer.experimental.gitProtocol=true` AND `workspace.backend=git-protocol` together now switches the host pod onto the new storage tier.

---

## What this canary actually deploys

The deployment now has two halves — the storage tier (Phase 1) and the host plugin wiring (Phase 2). They flip independently, so the canary posture has three states:

- **Both off:** legacy `@ax/workspace-git-http` Deployment + the host's legacy plugin. The boring, working state.
- **Storage tier on, backend still `http`:** flip `gitServer.experimental.gitProtocol: true` alone (with `gitServer.enabled: true`). The chart renders the new StatefulSet but no host traffic reaches it. Useful for watching the new tier idle before cutover.
- **Both on (`workspace.backend: git-protocol` + `gitServer.experimental.gitProtocol: true`):** the host pod boots with `AX_WORKSPACE_BACKEND=git-protocol` and the host's `@ax/workspace-git-server` plugin owns workspace ops, talking to the new StatefulSet via its ClusterIP Service. **Production traffic is now flowing through the new tier on this release.**

When `gitServer.experimental.gitProtocol: true` is set, the chart adds three resources alongside the legacy git-server Deployment:

- A **StatefulSet** `<release>-git-server-experimental` with `replicas: <gitServer.shards>` (default 1), serving git smart-HTTP + a tiny REST CRUD on port `gitServer.port` (default 7780).
- A **ClusterIP Service** `<release>-git-server-experimental` and a **headless Service** `<release>-git-server-experimental-headless` (`clusterIP: None`) so the host plugin gets a single stable DNS name and each shard pod gets stable per-pod DNS via the StatefulSet's pod-index label.
- A **NetworkPolicy** `<release>-git-server-experimental-network` permitting ingress from host pods only, egress empty.

Each shard gets its own PVC via `volumeClaimTemplates` (annotated `helm.sh/resource-policy: keep` — `helm uninstall` does NOT delete the bare repos).

When `workspace.backend: git-protocol` is **also** set, the chart additionally:

- Stamps `AX_WORKSPACE_BACKEND=git-protocol`, `AX_WORKSPACE_GIT_SERVER_URL=<experimental ClusterIP svc URL>`, and `AX_WORKSPACE_GIT_SERVER_TOKEN` (from the same `git-server-auth` Secret as the legacy tier) onto the host Deployment.
- Adds an egress rule on the host's NetworkPolicy permitting traffic to the experimental git-server pods. Without this rule, the host's plugin traffic would be denied at the CNI layer.

---

## Pre-flip checklist

Before flipping the toggles to switch traffic onto the new tier:

- [ ] Verify chart renders with toggle off (no resource churn vs. legacy state).
- [ ] Verify chart renders with both toggles on (`workspace.backend=git-protocol` + `gitServer.experimental.gitProtocol=true`).
- [ ] Verify `pnpm test --filter @ax/workspace-git-server` and `pnpm test --filter @ax/preset-k8s` pass.
- [ ] `helm upgrade --dry-run` shows the expected env-var diff on the host pod.
- [ ] Have the rollback `helm upgrade` command ready to paste.
- [ ] Pick a workspace to canary (one user, one agent) — note the derived `workspaceIdFor` value so you can `kubectl exec` into the storage tier pod and inspect `<workspaceId>.git/` if needed.

---

## Flipping the toggles

Phase 2 introduces a two-step canary path. We recommend taking it one step at a time:

**Step 1 — stand up the new tier, watch it idle.** Flip the storage tier toggle alone:

```bash
helm upgrade <release> deploy/charts/ax-next \
  --reuse-values \
  --set gitServer.experimental.gitProtocol=true \
  --set gitServer.shards=1 \
  --set gitServerImage.tag=<tag>
```

The new StatefulSet, Services, and NetworkPolicy render. `workspace.backend` is still `http`, so the host pod keeps using the legacy plugin. No traffic on the new tier yet — this is the canary-preflight posture.

**Step 2 — cut traffic over.** Once the new tier is healthy and idle, flip the host backend:

```bash
helm upgrade <release> deploy/charts/ax-next \
  --reuse-values \
  --set workspace.backend=git-protocol
```

The host Deployment rolls with `AX_WORKSPACE_BACKEND=git-protocol`, the host's `@ax/workspace-git-server` plugin loads, and workspace ops now flow through the new tier.

`--reuse-values` keeps everything else (postgres, host pod replica count, etc.) at whatever the operator already set. If you'd rather flip both toggles in one upgrade, combine them — the chart's validator (`_helpers.tpl: validateWorkspaceBackend`) makes sure you can't get into a half-flipped state via a single `helm upgrade` call.

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
  --set gitServer.experimental.gitProtocol=false \
  --set workspace.backend=http
```

This re-rolls the host Deployment with the legacy `AX_WORKSPACE_GIT_HTTP_*` env vars. The legacy `@ax/workspace-git-http` Deployment is the active storage tier again, and the host's legacy plugin owns workspace ops. The new StatefulSet, ClusterIP Service, headless Service, and experimental NetworkPolicy un-render.

The new STS PVCs persist (`helm.sh/resource-policy: keep`) so the bare repos survive for forensics — operators delete them manually if/when no longer needed:

```bash
kubectl get pvc -n <ns> -l app.kubernetes.io/component=git-server-experimental
kubectl delete pvc -n <ns> repo-<release>-git-server-experimental-0
```

**No data is migrated between the legacy `http` server and the new `git-protocol` tier.** If an operator deployed `git-protocol`, accumulated workspace state on the new STS PVCs, then rolled back to `http`, the cluster returns to the legacy server's older state — the new-tier accumulated work is preserved on the STS PVCs but unreachable via the legacy plugin. This is MVP-acceptable per the design doc Q#1; if your canary actually wrote real work to the new tier and you need it back on the legacy path, you'll be doing a manual `git clone <new-tier> && git push <legacy-tier>` per workspace. We're upfront about it because surprise data loss is the worst kind.

If you flipped only `gitServer.experimental.gitProtocol=true` (without `workspace.backend=git-protocol`), no host traffic reached the new tier, and rollback is just `--set gitServer.experimental.gitProtocol=false`. No data concern; no host roll.

### One bad shard

No per-shard quarantine ships in Phase 1 or Phase 2. If only one shard misbehaves, escalate to "flip the whole toggle off" (above) and triage from the persisted PVCs. A per-workspace shard-skip mechanism is on the future-work list if real traffic surfaces the need.

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

### Phase 2 toggle confusion

The two-toggle design — `gitServer.experimental.gitProtocol` for the storage tier and `workspace.backend` for the host plugin — gives operators a deliberate canary-preflight state, but it also gives them three ways to misconfigure. Here are the four most likely Phase 2 failure modes:

- **Operator flipped `gitServer.experimental.gitProtocol` but not `workspace.backend`.** Symptom: nothing visibly broken; new tier renders and idles, host still uses the legacy backend. This is **intentional** — it's the canary-preflight posture. If you're seeing this and didn't mean to, set `workspace.backend=git-protocol` to actually cut traffic over.
- **Operator flipped `workspace.backend` but not `gitServer.experimental.gitProtocol`.** Symptom: `helm upgrade` fails fast with `workspace.backend=git-protocol requires gitServer.experimental.gitProtocol=true` (the validator template in `_helpers.tpl`). Fix: add `--set gitServer.experimental.gitProtocol=true` to the same upgrade command. Both toggles must move together when cutting over.
- **Workspace ops fail with `connection refused` or `i/o timeout`.** Most likely cause: the host's NetworkPolicy egress rule for the experimental tier didn't render. Check that `networkPolicies.enabled=true` and that both `gitServer.enabled` and `gitServer.experimental.gitProtocol` are true on the host's view of the chart values (`kubectl get networkpolicy <release>-host-network -o yaml` should show an egress rule pointing at `app.kubernetes.io/component: git-server-experimental`). The egress rule landed alongside Phase 2; without it, the CNI denies the host's traffic to the new tier even though everything else looks healthy.
- **Workspace ops fail with `401 Unauthorized` or auth-shaped errors.** The host plugin's `AX_WORKSPACE_GIT_SERVER_TOKEN` is sourced from the same `git-server-auth` Secret as the experimental StatefulSet's `AX_GIT_SERVER_TOKEN` — they MUST match. Check that the Secret exists in the host's namespace (`kubectl get secret <release>-git-server-auth`) and that both pods reference the same `key: token`. If you rotated the token, both pods need a roll to pick up the new value (same pain as the legacy tier — see SECURITY.md "Token rotation is operationally painful").

---

## What this runbook does NOT cover

- **Multi-replica HA per shard.** MVP is single-replica per shard. See `packages/workspace-git-server/SECURITY.md` "Known limits".
- **Re-sharding.** Operator picks `gitServer.shards` at install time; changing it later requires manual workspace migration. Not automated.
- **Cross-region replication.** Out of scope.
- **Backup / DR.** Operator's responsibility — use the cluster's CSI snapshot mechanism or a `git bundle` cron to off-cluster object storage.
- **Migrating workspace data between the legacy `http` server and the new `git-protocol` tier.** No automated migration; see the rollback section.

---

## When this runbook gets retired

When the legacy `@ax/workspace-git-http` package is removed, this runbook gets folded into the canonical workspace runbook and the "experimental" toggle goes away. Until then, keep this file with the current Phase 1/2 caveats.
