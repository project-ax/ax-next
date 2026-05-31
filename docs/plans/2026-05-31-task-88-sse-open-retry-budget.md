# TASK-88 — SSE cold-respawn 404 auto-recover (extend open-retry budget)

Client-only follow-up to TASK-84 (#241). Extend the SSE-open retry in
`packages/channel-web/src/lib/transport.ts` so a genuine cold runner spawn
recovers WITHOUT the manual Retry banner.

## Problem

TASK-84 retries `GET /api/chat/stream/:reqId` only `SSE_OPEN_MAX_ATTEMPTS = 4`
times over `SSE_OPEN_BACKOFF_MS = [150, 400, 900]` (~1.45s total). A cold pod
spawn + per-reqId bind can take several seconds, exceeding the 1.45s budget →
the loop throws → the runtime renders `CONNECTION_LOST` with a manual Retry
button. The GET is idempotent (replays a bounded per-reqId buffer; only POST
starts a turn), so it's safe to retry far longer than 1.45s.

## Scope (client-only — one PR)

- Replace the fixed 4-attempt / 3-element-backoff policy with a **budget-driven
  capped exponential backoff**: base 250ms, cap 2000ms, total wall-clock budget
  ~30s. Loop terminates when the NEXT backoff would push cumulative wait past
  the budget.
- Keep **fail-fast** on true client errors (401/403/400/413). Only the existing
  retryable set (404/425/429/5xx) + a network throw are retried. Unchanged.
- Keep abort-aware (existing behavior): an abort during a fetch or backoff wait
  stops the loop immediately.
- Hard ceiling: on budget exhaustion of a RETRYABLE failure, throw
  `new Error(CONNECTION_LOST)` so the runtime's onError renders the existing
  user-facing "Connection lost. Retry to continue." banner with its manual-retry
  button (the card's "fall back to the existing CONNECTION_LOST banner"). A
  fail-fast NON-retryable status (401/403/400/413) keeps its verbatim
  `chat-flow SSE open failed: <status>` message — it's a real client error, not a
  connection loss. (Distinguished by a `failFast` flag set only on the
  non-retryable break.)
- Surface progress during the wait: set the agent-status row to the
  `PHASE_LABELS['sandbox-starting']` label ("Starting sandbox…") via
  `agentStatusActions.show(...)` while retrying, so a multi-second cold boot is
  not a silent hang. The label naturally transitions: once the stream opens, the
  existing phase/content handlers overwrite it; on terminal failure the runtime's
  onError sets the error banner.

## Out of scope (follow-up, do NOT do here)

Hardening the server early-bind to be authoritative (retry the bind / 503 the
POST) so `active_req_id` is guaranteed before the 202.

## Tasks

### Task 1 — extend retry budget + surface status (transport.ts)
- Remove `SSE_OPEN_MAX_ATTEMPTS` + `SSE_OPEN_BACKOFF_MS` array. Add:
  - `SSE_OPEN_BACKOFF_BASE_MS = 250`
  - `SSE_OPEN_BACKOFF_CAP_MS = 2000`
  - `SSE_OPEN_TOTAL_BUDGET_MS = 30_000`
  with a doc comment explaining the cold-spawn rationale + idempotency safety.
- Rewrite `openSseStream` as a wall-clock-budget loop:
  - compute `delay = min(BASE * 2^attempt, CAP)`.
  - On a retryable status / network throw: if `elapsed + delay <= BUDGET`, set
    the "Starting sandbox…" status (once we're committed to waiting), wait, retry;
    else break → throw.
  - Fail fast on non-retryable status (unchanged).
- `sseBackoffWait` becomes a plain `wait(ms, abortSignal)` taking an explicit ms.

### Task 2 — tests (transport.test.ts)
- Update the existing budget-exhaustion test: assert it gives up after MANY more
  attempts than the old 4 (no longer hard-coded to 4), and surfaces
  `SSE open failed`.
- New: a persistent 404 that clears after ~10s (longer than the old 1.45s) now
  resolves to a streamed turn WITHOUT throwing (fake timers, advance ~10s).
- New: during the open-retry wait, `getAgentStatusSnapshot().text` ===
  "Starting sandbox…".
- Keep green: 403 fails fast with one attempt; abort during backoff stops the loop.

## Verification

`pnpm --filter @ax/channel-web test` + `pnpm build` + lint green.

## Boundary / security note

No hook-surface, IPC, plugin-loading, sandbox, or dependency change — internal
to one plugin. Retry decisions key only on numeric HTTP status, never on the
(untrusted) response body, so no injection surface. No boundary review or
security-checklist required.
