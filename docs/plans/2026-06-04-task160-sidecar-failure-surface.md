# TASK-160 — self-diagnosing dev-service sidecar startup failure

Epic: dev-services-in-sandbox. Make a failed dev-service sidecar SELF-DIAGNOSING: when a
service sidecar crashes on startup (commonly EROFS / permission-denied because a needed
dir isn't in `writablePaths`), surface an **author-facing, actionable** message naming the
service + the offending path/reason — instead of an opaque "session failed".

## Problem (as-built chain)

`sandbox:open-session` throws → orchestrator catch (orchestrator.ts:2275) →
`fireTurnError(ctx, reqId, 'sandbox-open-failed')` → `chat:turn-error` →
channel-web SSE `{ reqId, error: reason }` frame → client maps
`ERROR_LABELS[frame.error] ?? DEFAULT_TURN_ERROR` (transport.ts:831).

Two gaps:
1. **k8s** never even reaches the catch with a useful message: a service sidecar
   (`initContainers[]`, `restartPolicy: Always`, named `svc-<name>`) that crashloops keeps
   the pod in `Pending`, so `waitForPodReady` (lifecycle.ts) times out with a generic
   `pod-readiness-timeout` — the EROFS path that's right there in the sidecar's log is lost.
2. **client drops detail**: the `error` frame's `reason` is a stable code; any arbitrary
   string collapses to `DEFAULT_TURN_ERROR`. So the diagnosis needs its own carrier field.
   (subprocess already captures `composeUp` stderr into the inner error's `cause`, but the
   `PluginError` message is generic and nothing parses the service+path out of it.)

## Approach

- A neutral structured diagnosis `ServiceStartupDiagnosis { service: string; path?: string; reason: string }`
  produced by each backend at the failure site and attached to the thrown `PluginError`
  (new optional field `serviceDiagnosis`). No backend vocab leaks (`service`/`path`/`reason`
  only). The hook bus re-throws the original PluginError instance, and `sandbox:open-session`
  runs host-side in-process, so the field survives to the orchestrator catch.
- A bounded, untrusted-safe formatter turns the diagnosis into a one-line `detail` string
  ("service 'kafka' couldn't write /opt/kafka (read-only filesystem) — add it to writablePaths").
- The orchestrator fires `chat:turn-error` with a dedicated reason code `dev-service-failed`
  + the `detail`. channel-web forwards `detail` onto the SSE error frame; the client renders
  the mapped label + the detail line as untrusted text.

## Security (security-checklist runs in Phase 3)

Sidecar / compose logs are third-party/untrusted output. At the CAPTURE site: bound to a
small tail (≤ ~4 KB / ~20 lines, via k8s `tailLines` and a slice on compose stderr), scan
with a FIXED regex for the EROFS/permission path, EXTRACT the path (validated to look like
an absolute path), and a CURATED reason phrase — never interpolate the raw log into the
message. The detail string is truncated + control-chars stripped + rendered as plain text.

## Tasks (independent, testable; TDD)

### Task 1 — shared diagnosis type + untrusted-safe formatter (`@ax/sandbox-protocol`)
- Add `export interface ServiceStartupDiagnosis { service: string; path?: string; reason: string }`
  to `@ax/sandbox-protocol` (the shared, eslint-allow-listed schema pkg both backends + the
  orchestrator already depend on — no new cross-plugin edge).
- Add a pure `formatServiceDiagnosis(d: ServiceStartupDiagnosis): string` that emits the
  bounded, sanitized one-line author message. It STRIPS control chars, bounds `service`
  (already charset-bounded upstream but defense-in-depth) + `path` length, and only includes
  `path` when it looks like an absolute path (`/^\/[^\s]{0,256}$/`). NEVER includes a raw log.
- Add a pure `extractWritablePathFromLog(tail: string): { path?: string; reason: string }`
  helper: scan a bounded tail for the common shapes — `EROFS`, `read-only file system`,
  `permission denied`, `mkdir … : Read-only file system`, `EACCES` — and pull the first
  absolute path token on the matching line. Returns a neutral reason phrase
  (`'read-only filesystem'` / `'permission denied'`) and the path if found.
- **Tests:** formatter bounds + strips control chars + omits non-absolute path; extractor
  recognizes the EROFS/EACCES/read-only shapes and pulls the path; a benign tail → reason
  `'startup failed'` + no path; an injection tail (newlines, ANSI, fake "SYSTEM:" lines) →
  output is single-line, bounded, no ANSI. Model tier: standard (security-sensitive parsing).

### Task 2 — k8s detection (`@ax/sandbox-k8s`)
- `k8s-api.ts`: add `readNamespacedPodLog(req: { name; namespace; container; tailLines?; previous? }): Promise<string>`
  to the `K8sCoreApi` facade (CoreV1Api implements it structurally; RBAC already grants
  `pods` + `pods/log`). Update `mock-k8s.ts` with a `setLogResponse(container, text)` seam.
- `lifecycle.ts`: add `diagnoseServiceSidecars({ pod, namespace, podName, readLog }): Promise<ServiceStartupDiagnosis | undefined>`
  — scan `pod.status.initContainerStatuses[]` for entries whose name starts with `svc-`
  that are `waiting` (CrashLoopBackOff/Error) or `terminated` (exitCode !== 0); for the first
  such sidecar, derive `service` from the name (strip `svc-`), read a bounded `tailLines`
  log (try `previous: true` first for a crashlooped container, fall back to current), run
  `extractWritablePathFromLog`, and return the diagnosis. Bounded `tailLines` (e.g. 20).
- `open-session.ts`: in the `waitForPodReady` catch, BEFORE re-throwing, attempt
  `diagnoseServiceSidecars` (best-effort, swallow its own errors) only when
  `input.services?.length`; if it returns a diagnosis, attach it to a `PluginError`
  (`code: 'service-sidecar-failed'`, `serviceDiagnosis: d`) and throw that instead of the
  raw timeout error. Keep the existing rollback (killPod + session:terminate) intact.
- Extend `PodLike`/`MockPodStatus` with `initContainerStatuses` (waiting/terminated shapes).
- **Tests (lifecycle + open-session):** a pod stuck Pending with a `svc-kafka` initContainer
  in CrashLoopBackOff + a log tail naming `/opt/kafka … Read-only file system` →
  `diagnoseServiceSidecars` returns `{ service:'kafka', path:'/opt/kafka', reason:'read-only filesystem' }`;
  open-session surfaces a `PluginError` carrying that `serviceDiagnosis` (rollback still
  fires); a service-less timeout → no diagnosis, original timeout error unchanged; a sidecar
  failure with an unparseable log → diagnosis with reason but no path. Model tier: standard.

### Task 3 — subprocess detection (`@ax/sandbox-subprocess`)
- `compose.ts`: `composeUp` already throws with stderr in the message. Add
  `diagnoseComposeFailure(run, { projectName, composeJson, services, upError }): Promise<ServiceStartupDiagnosis | undefined>`
  — best-effort `docker compose -p <p> -f - logs --tail 20 --no-color` (bounded), pick the
  first service whose log/`upError` text matches the EROFS shapes, derive `service` + run
  `extractWritablePathFromLog`. If logs are empty, fall back to scanning the bounded
  `upError.message` tail. Returns undefined when nothing matches.
- `open-session.ts`: in the `services-up-failed` catch (step 7b), call
  `diagnoseComposeFailure` (best-effort) and, when it returns a diagnosis, attach
  `serviceDiagnosis` to the thrown `PluginError`. Keep the existing unwind intact.
- **Tests (compose + open-session-services, fake runner — no Docker):** a fake runner whose
  `up` exits nonzero and whose `logs` returns a tail naming `/var/lib/postgresql/data …
  Read-only file system` → the thrown `services-up-failed` PluginError carries
  `{ service:'postgres', path:'/var/lib/postgresql/data', reason:'read-only filesystem' }`;
  a generic up failure with no parseable log → no `serviceDiagnosis` (back-compat); the
  unwind (session:terminate / down -v) still fires. Model tier: standard.

### Task 4 — orchestrator surfacing (`@ax/chat-orchestrator`)
- In the `sandbox:open-session` catch (orchestrator.ts:2275), if the caught error is a
  `PluginError` carrying `serviceDiagnosis`, set `outcome.reason = 'dev-service-failed'` and
  pass the formatted `detail` (via `formatServiceDiagnosis`) to `fireTurnError`. Otherwise
  keep `'sandbox-open-failed'` + no detail (back-compat).
- Widen `fireTurnError(ctx, reqId, reason, detail?)` to fire `chat:turn-error` with the
  optional `detail`. (Pure widening of the FIRED payload — `chat:turn-error` is an undeclared
  subscriber event, no manifest/boundary change; `detail` is optional + neutral.)
- **Tests:** open-session that throws a PluginError with `serviceDiagnosis` →
  `chat:turn-error` fires with `reason:'dev-service-failed'` + the formatted detail
  (assert via a subscribed spy, mirroring services-canary.test.ts); a plain open-session
  throw → `reason:'sandbox-open-failed'`, no detail. Model tier: standard.

### Task 5 — channel-web surfacing (`@ax/channel-web`)
- `chat:turn-error` subscriber + SSE error frame: thread the optional `detail` through.
  Server `SseFrame` error variant gains `detail?: string`; the buffer's turn-error fill +
  replay carry it; `sse.ts` writes `{ reqId, error: reason, detail }`.
- Client `transport.ts`: when an `error` frame carries `detail`, render
  `${ERROR_LABELS[reason] ?? DEFAULT_TURN_ERROR}` + a newline + the `detail` (untrusted →
  plain text, already bounded server-side; client applies a final length clamp). Add a
  `'dev-service-failed'` label ("A dev service failed to start.").
- **Tests:** an error frame with `detail` renders label + detail; without `detail`, behaves
  exactly as today (DEFAULT_TURN_ERROR). Run the FULL `pnpm -F @ax/channel-web build` (it
  type-checks `__tests__`). Model tier: standard. (No new shadcn primitive — this is a
  string in the existing AgentStatus error row; invoke `shadcn` only if a component changes,
  which it should not.)

### Task 6 — canary + security-checklist + whole-branch review + PR
- Extend `services-canary.test.ts` (or add a sibling) so the existing dev-services canary
  also drives the failure path: a sidecar-failure PluginError → `chat:turn-error`
  `dev-service-failed` + detail (closes the loop end-to-end through the real orchestrator).
- Run `security-checklist` (untrusted log output + the k8s `pods/log` capability + the
  process-spawn `docker compose logs`); paste the note in the PR.
- Boundary review: no NEW service-hook signature (the `detail` widening is on the undeclared
  `chat:turn-error` subscriber event + the internal SSE frame; the `serviceDiagnosis` field
  is on a thrown error, not a hook payload). State this in the PR.

## YAGNI pass
- Pod events API — CUT for v1; the sidecar log tail names the path directly. (Possible
  follow-up if a class of failure leaves no log line.)
- Per-service retry / auto-add-writablePath — OUT OF SCOPE (the card is surface-only).
- A structured machine-readable card (vs a text detail line) — CUT; the error row is text.

## ax-conventions / invariants
- I1: `ServiceStartupDiagnosis` + the `detail` string carry NO backend vocab (`service`/
  `path`/`reason` only; the formatter never emits `pod`/`initContainer`/`compose`/`docker`).
- I2: the shared type lives in `@ax/sandbox-protocol` (already a dep of both backends + the
  orchestrator); no new cross-plugin runtime import.
- I5: k8s gains exactly one read-only API method (`pods/log`); subprocess reuses the existing
  `docker compose` spawn. Captured logs bounded + extract-don't-echo.
- Bug Fix Policy / TDD: every backend + the formatter + the surfacing get a test that would
  fail today (opaque message) and pass after (named service + path).
