# TASK-151 — k8s backend: native-sidecar rendering + mounts + fsGroup + readiness budget

Epic: dev-services-in-sandbox · Slice S3 · Depends on TASK-150 (merged) · Half-wired window OPEN.

## Problem

The `services[]` field already exists on `OpenSessionInputSchema` (TASK-150). The k8s
backend ignores it. This slice renders each declared `ServiceDescriptor` as a **native
k8s sidecar** in the runner pod and scales the readiness budget to cover their cold-start.

**The load-bearing constraint (I1):** a service is a long-running process (a DB, a broker).
Rendering it as a plain `containers[]` entry under `restartPolicy: Never` (pod-spec.ts:410)
means the pod NEVER reaches `Succeeded`/`Failed` (those phases require ALL containers to
terminate), so `watchPodExit` (lifecycle.ts:192) loops until `activeDeadlineSeconds` (6h) —
a pod leak. Native sidecars (`initContainers` with `restartPolicy: Always`) do NOT count
toward pod completion: the pod completes when the runner (`containers[0]`) exits, and the
kubelet tears the sidecars down. So services MUST render as `initContainers`, never
`containers[]`, and the runner MUST stay `containers[0]`.

## Approach

`buildPodSpec`: for each `input.services[]`, append an `initContainers[]` entry
(`restartPolicy: 'Always'`) AFTER the existing `sdk-scaffold` init container. Ordering:
scaffold → service sidecars → runner. Each sidecar carries the locked `containerSecurity`,
the descriptor's `image`/`env`/`ports`→`containerPort`, an optional `startupProbe` from
`healthcheck`, and per-`writablePaths` `volumeMounts`. Add one `emptyDir` volume per
writable path. Set `spec.securityContext.fsGroup = 1000` **iff** services present.

`config.ts`: per-sidecar resourcing defaults + `perServiceColdStartMs` + a pure
`computeReadinessBudgetMs({ baseTimeoutMs, serviceCount, perServiceColdStartMs })`.
`open-session.ts` calls it where `input.services.length` is known and passes the result to
`waitForPodReady` as `timeoutMs`.

## Tasks (independent, testable)

### Task 1 — config.ts: per-service resourcing + readiness budget policy
- Add to `SandboxK8sConfig` + `ResolvedSandboxK8sConfig` + `resolveConfig`:
  `serviceCpuLimit` (default `'1'`), `serviceMemoryLimit` (`'1Gi'`),
  `serviceCpuRequest` (`'100m'`), `serviceMemoryRequest` (`'512Mi'` — JVM floor),
  `perServiceColdStartMs` (default `120_000`).
- Export pure `computeReadinessBudgetMs({ baseTimeoutMs, serviceCount, perServiceColdStartMs }): number`
  → `serviceCount <= 0 ? baseTimeoutMs : baseTimeoutMs + serviceCount * perServiceColdStartMs`.
- **Tests:** new defaults resolve; overrides honored; budget fn — 0 services = base, N
  services = base + N·perServiceColdStart, negative guarded to base.
- Model tier: cheap (single-file, mechanical).

### Task 2 — pod-spec.ts: render services[] as native sidecars + fsGroup + volumes
- Add `services?: ServiceDescriptorParsed[]` to `BuildPodSpecInput` (import the TYPE from
  `@ax/sandbox-protocol`).
- For each service, build an `initContainers[]` entry: `{ name: 'svc-<name>', image, ...,
  restartPolicy: 'Always', securityContext: containerSecurity, env: descriptor.env →
  [{name,value}], ports: descriptor.ports → [{containerPort}], volumeMounts:
  writablePaths → [{name:'svc-<name>-<i>', mountPath}], ...(healthcheck ? {startupProbe} : {}) }`.
  healthcheck `{kind:'tcp',port}` → `startupProbe.tcpSocket.port`; `{kind:'exec',command}`
  → `startupProbe.exec.command`. startupProbe gets generous failureThreshold/periodSeconds
  so the kubelet's per-probe budget also covers cold-start.
- Append service sidecars to `initContainers` AFTER `sdk-scaffold`.
- Append one `{ name:'svc-<name>-<i>', emptyDir:{} }` volume per writable path.
- `spec.securityContext = { fsGroup: 1000 }` iff `services.length > 0`.
- Runner stays `containers[0]`; zero service containers in `containers[]`.
- **Tests (TDD):** N services → N+1 initContainers (incl sdk-scaffold), each
  `restartPolicy:'Always'`, locked securityContext, one emptyDir mount per writablePath;
  ZERO extra `containers[]`, runner still `containers[0]`; fsGroup present iff services;
  tcp→tcpSocket, exec→exec; descriptor env stamped, NO AX_*/proxy env on sidecars;
  ports→containerPort. **I1 regression:** 2-service render keeps `containers.length === 1`.
- Model tier: standard (multi-concern single file).

### Task 3 — open-session.ts: thread services + scaled readiness budget
- Pass `input.services` into `buildPodSpec` (spread-when-present, mirror installedSkills).
- Compute `timeoutMs = computeReadinessBudgetMs({ baseTimeoutMs: config.readinessTimeoutMs,
  serviceCount: input.services?.length ?? 0, perServiceColdStartMs: config.perServiceColdStartMs })`
  and pass to `waitForPodReady`.
- **Tests:** open-session with 2 services renders sidecars (smoke via mock-k8s) and
  waitForPodReady receives the scaled timeout; service-less session keeps 60s.
- Model tier: standard.

### Task 4 — security-checklist + whole-branch review + PR
- Run `security-checklist` (sandbox boundary), paste note in PR.
- Half-wired window note: services arrive from the orchestrator (S2) but the subprocess
  backend (S4) doesn't render them yet — window OPEN, note it.

## YAGNI pass
- No per-service CPU/mem OVERRIDE in the descriptor — descriptor stays backend-agnostic
  (I1); resourcing is a config default. Load-bearing: defaults only.
- No `readinessProbe` separate from `startupProbe` — startupProbe alone gates main start
  under sidecar semantics. Cut the extra probe.
- No new IPC action / hook surface — pure internal rendering. No boundary review needed.

## ax-conventions / invariants
- No new hook surface (boundary review N/A). No cross-plugin runtime import (the
  ServiceDescriptor TYPE comes from the shared `@ax/sandbox-protocol` schema package, which
  is the existing pattern — already imported for `buildGitCredentialEnv`).
- I1/I4/I5/I6/I7/I8 enforced as described. I8 (digest-pin) already enforced by the schema at
  the wire; pod-spec trusts the parsed descriptor.
