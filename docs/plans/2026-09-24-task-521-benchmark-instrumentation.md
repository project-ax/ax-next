# TASK-521 — instrument the memory-product benchmark harness

Harness only (`scripts/memory-product-e2e*.mjs`). No product, prompt, model or scoring
change, and no paid run. Why: TASK-497's recall p95 failure is time-clustered in the last
12 banks, and the frozen harness cannot say why (see the card and
`.claude/memory/decisions/2026-09-24-TASK-521.md`).

## Tasks

1. **Trace module** (`scripts/memory-product-e2e-trace.mjs`, new). It holds:
   - the real wall clock, captured before any corpus-clock swap;
   - `sanitizeError` (allowlisted `name`, fixed-enum `code`, HTTP `status`, and one cause level; never a message);
   - `openAttemptLog` (append-only `answer-<arm>.attempt-N.jsonl`, created `wx`);
   - `makeTokenSource` (async mint, refreshed only at untimed boundaries);
   - `startEnvironmentMonitor` (event-loop delay and wall-vs-monotonic clock gaps);
   - `tlsProbe` (TLS handshake only; no request and no credentials);
   - `latencyBreakdown` and `attemptStats` (descriptive; the gates are unchanged).

   Load-bearing: each piece answers one open question from the TASK-497 investigation.
2. **Turn capture in `answer()`**: an `onTurn` callback that records each request, response, tool call and final answer. Load-bearing (interrupted attempts).
3. **Stage spans**: extend the `registerService` wrapper to time `credentials:get`, `embeddings:*`, `memory:facts:recall` and `memory:recall`, and the metered fetch (status, headers-received time, end), attached to the current recall. Load-bearing.
4. **Token fix**: `credentials:get` never spawns `gcloud`; it reads a token minted beforehand. Load-bearing (a measurement artifact).
5. **Wiring in `main`**:
   - wall-clock `at` on ledger, recall and result rows;
   - a sanitized error on failed recalls;
   - `failure-NN.json` on abort, with stage + sanitized class;
   - environment events in `environment.jsonl`;
   - the report gains descriptive breakdown and interrupted-attempt lines;
   - identity covers the new module, and `checkResumeIdentity` refuses old runs.

YAGNI cuts: no replay tooling, no dashboard, no change to the p95 gate definition,
and no probe that costs money (the TLS probe sends no request).

Security: persisted diagnostics are allowlisted, never messages or bodies. The TLS probe
reaches only the four provider hosts the run already calls, and sends nothing after the handshake.
