# TASK-168 — Template BackendConfig (SSE timeout) + host Service annotation into the chart

## Problem

The GCE Application LB defaults backend `timeoutSec=30`, which cuts long-lived SSE
chat streams ("Connection lost" mid-answer). The fix is a `BackendConfig`
(`cloud.google.com/v1`) with `timeoutSec: 3600` plus a
`cloud.google.com/backend-config: '{"default":"<bc-name>"}'` annotation on the host
Service. Today this is applied by hand via `kubectl` (GKE.md Step M7). Because it's
not in the chart, a `helm upgrade` that re-renders the host Service drops the
annotation and the timeout silently reverts to 30 s — SSE breaks again. It affects
both the Autopilot and Standard GCE-ingress paths.

## Approach

Mirror the established gated-GKE-resource pattern already in the chart
(`ingress.enabled`, `networkPolicies.lbHealthCheckCidrs`, `credentialProxy.tcp`):
add a values flag `ingress.backendConfig.enabled` (default **off**), render a
`BackendConfig` only when it's on, and conditionally stamp the annotation on the
host Service. Default-off keeps the GKE-only CRD out of non-GKE renders (kind). The
GKE overlay (`gke-values.yaml`) flips it on.

## Invariants / boundary review

No hooks, no plugin code, no IPC, no untrusted-input path — chart templates + a docs
edit only. No boundary review required (no hook surface). The render-test suite
(`__tests__/render.test.ts`) is the contract guard, consistent with how every other
chart behavior is pinned.

## Tasks (independent, testable)

### Task 1 — values + helper (schema)
- `values.yaml`: under `ingress:`, add
  ```yaml
  backendConfig:
    enabled: false
    timeoutSec: 3600
  ```
  with a comment explaining the GKE-only CRD and the SSE-timeout rationale.
- `_helpers.tpl`: add `ax-next.backendConfigName` →
  `<ax-next.hostComponentName>-bc`, truncation-safe (reserve the `-bc` suffix before
  the 63-char trunc, like `credentialProxyComponentName`).
- **Test:** none on its own (covered by Tasks 2/3 render assertions).

### Task 2 — BackendConfig template
- New `templates/host/backendconfig.yaml`, wrapped in
  `{{- if .Values.ingress.backendConfig.enabled }}`. `apiVersion: cloud.google.com/v1`,
  `kind: BackendConfig`, name = `ax-next.backendConfigName`, namespace =
  `ax-next.hostNamespace`, component labels, `spec.timeoutSec: {{ .Values.ingress.backendConfig.timeoutSec }}`.
- **Test (TDD, render.test.ts):**
  - enabled → a `BackendConfig` doc renders, name `<release>-host-bc`, `spec.timeoutSec === 3600`.
  - `timeoutSec` override (`--set ingress.backendConfig.timeoutSec=120`) → `spec.timeoutSec === 120`.
  - default (off) → no `BackendConfig` doc renders.

### Task 3 — host Service annotation
- `templates/host/service.yaml`: add a conditional `annotations` block; when
  `ingress.backendConfig.enabled`, emit
  `cloud.google.com/backend-config: '{"default":"<backendConfigName>"}'`.
- **Test (TDD, render.test.ts):**
  - enabled → host Service has the annotation, value parses to
    `{ default: "<release>-host-bc" }` and references the same name the BackendConfig renders with (cross-check).
  - default (off) → host Service has no `cloud.google.com/backend-config` annotation.

### Task 4 — gke-values.yaml + GKE.md
- `gke-values.yaml`: under `ingress:`, set `backendConfig.enabled: true` with a short
  comment (the SSE-timeout note).
- `GKE.md`: rewrite Step M7 from the `kubectl apply` + `kubectl annotate` step to a
  values note (`ingress.backendConfig.enabled: true`, configurable `timeoutSec`);
  remove the "applied via kubectl, drops on helm upgrade" caveat; update the
  migration-table "(new — Step M7)" row to reflect the chart value (no longer a
  cluster-scoped re-create). Keep the verification tip (`gcloud compute
  backend-services describe`).
- **Test:** none (docs/values only).

## Verification (Phase 4 gate)
`pnpm build && pnpm test --filter ./deploy/charts/ax-next` + repo lint. The chart
render suite gates on `helm` in PATH; run it where helm is available (CI's
helm-render lane sets `AX_REQUIRE_HELM=1`). Whole-branch `pnpm build && pnpm test` +
`pnpm lint`.

## YAGNI pass
- `timeoutSec` configurable: load-bearing — the card explicitly asks for it.
- `backendConfig.enabled` gate: load-bearing — without it the GKE-only CRD breaks kind.
- No fail-fast guard tying it to `ingress.enabled`: a BackendConfig is harmless
  without an Ingress (just an unused CRD object), and GKE always sets both together.
  Skip the guard — not load-bearing.
