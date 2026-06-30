# TASK-189 — End-to-end LongMemEval-S eval of the shipped Strata runtime

**Branch:** `auto-ship/TASK-189-longmemeval-e2e`
**Epic:** strata-finish (blocks TASK-190 / TASK-191 / TASK-192)

## Problem

The existing bench (`packages/memory-strata/test/bench/`) scores *retrieval configs*
(A–E) over the LongMemEval-S corpus with a generic agent + judge. It never exercises
the *shipped* plugin pipeline: Observer extraction (`chat:end`) → inbox →
consolidator (decay/cluster/dedup/promote) → `docs/` + `system/recent.md` →
`system-prompt:augment` injection → answer. So the product's true end-to-end accuracy
+ abstention behavior have never been measured against the published LongMemEval-S
anchor.

## Goal

A new harness **mode** that runs LongMemEval-S **through the real plugin**, per the
shipped CLI path (no `/agent` git tier): ingest each sample's haystack sessions via the
real Observer + consolidator into a throwaway per-question workspace, then answer the
question via the real inject + `memory_search` + answer-LLM path, judged for accuracy
**and** abstention. Emit a standalone report with absolute accuracy + correct-refusal /
false-refusal / hallucination rates, naming the answer-LLM + judge.

## Chosen approach (see decisions.md 2026-06-29)

- Drive the real plugin over a `HookBus`, NOT a new `ConfigDriver`. Per-question
  isolation = fresh `mkdtemp` workspace root (the `isolation.test.ts` pattern).
- Ingest = fire `chat:start` then one `chat:end {outcome:{kind:'complete',messages}}`
  per haystack session, `await settle(agentId)` (Observer) + `await
  settleConsolidation(agentId)` (Consolidator, with `consolidatorDebounceMs:0`).
- Answer = fire `system-prompt:augment` → compose the system prompt with the real
  injected block + expose `memory_search` (real BM25 over the consolidated sqlite
  index) to the answer-LLM; call the answer-LLM.
- Answer-LLM `claude-sonnet-4-6`; extraction LLM `claude-haiku-4-5-20251001`; judge
  `x-ai/grok-4.3`. All three named in the report.
- Default `--sample 100`, opt-in `--full` (500). CostMeter cap default `$25`
  (`--cap`). Resumable via per-run JSONL keyed by `questionId`.

## Tasks (independent, testable)

### Task 1 — e2e LongMemEval-S sample loader (`corpora/longmemeval-s.ts`)
Add `loadLongMemEvalSSamples(cache): Promise<LongMemEvalSample[]>` that returns the RAW
samples (haystack sessions intact) — the existing `loadLongMemEvalS` collapses them into
pre-digested docs, which the e2e path must NOT use. Reuse the existing download/cache.
Also fix the pre-existing `exactOptionalPropertyTypes` error on `metadata` (line 54) so
the bench typecheck is green (conditional-spread, the project's standard pattern).
**Test:** unit test over a tiny in-memory sample fixture (no network) asserting raw
sessions round-trip + `_abs` detection.

### Task 2 — real-plugin answer client (`e2e-answer.ts`)
A `makeAnthropicAnswerClient` that, given a composed system prompt + the question +
an optional `memory_search` tool callback, runs ONE answer turn (Anthropic
`claude-sonnet-4-6`, with tool-use loop bounded to a small N tool calls). Returns
`{ text, usage, toolCalls }`. Mirrors `agent.ts` retry/usage conventions.
**Test:** unit test with a stub Anthropic client driving a single tool-call round-trip
then a final text answer (no network).

### Task 3 — e2e driver (`e2e-driver.ts`) — the core
`runE2EQuestion({ sample, bus deps, clients, meter, ... }): Promise<E2EQuestionResult>`:
1. `mkdtemp` workspace; build a `HookBus`; register `agents:resolve` (returns the
   extraction model), a REAL `llm:call:anthropic` (calls Anthropic haiku for the
   Observer), `tool:register` stub; init `createMemoryStrataPlugin({ consolidatorDebounceMs:0, testHooks:{onObserverSettleReady,onConsolidationSettleReady} })`
   + `createMemoryStrataIndexSqlitePlugin({ databasePath })`.
2. `bus.fire('chat:start', ctx, {})`.
3. For each haystack session: `bus.fire('chat:end', ctx, { outcome })`; `await
   settleObserver(agentId)`; `await settleConsolidation(agentId)`. Meter the
   extraction usage. Cap-guard each session (abort the sample cleanly if it would
   exceed cap — the sample is dropped/skipped, never partially counted).
4. Answer: `bus.call('system-prompt:augment', ctx, {})` → compose prompt; run the
   answer client (wiring `memory_search` to `bus.call('tool:execute:memory_search')`).
5. Teardown: dispose plugins (sqlite shutdown), `rm` workspace.
Returns the answer text + token usage + injected-block stats (block chars, #docs
promoted, #memory_search calls) for the report.
**Test:** an integration test using a STUBBED `llm:call`/answer/judge (no network,
deterministic extraction JSON) over a 2-session fixture, asserting: a fact extracted
in session 1 is promoted to `docs/`, appears in the injected block (or is retrievable
via `memory_search`), the workspace is torn down, and per-question isolation holds
(two samples don't cross-contaminate).

### Task 4 — e2e report renderer (`e2e-report.ts`)
`renderE2EReport(input): string` → markdown with: header (answer-LLM, extraction-LLM,
judge NAMED), absolute accuracy, abstention table (unanswerable n / correct-refusal /
hallucinated / false-refusal-on-answerable), per-question-type breakdown, cost + cap,
ingest stats, skipped buckets, and a caveat comparing to the c137 90.4% anchor + the
spike's 20–28%. Reuse the abstention math shape from `report.ts`.
**Test:** unit test over synthetic results asserting the accuracy + abstention rows.

### Task 5 — wire `--mode e2e` into the CLI (`cli.ts`)
Add `--mode bench|e2e` (default `bench`, preserving today's behavior), `--cap`,
`--full`, `--resume`. In `e2e` mode: require `ANTHROPIC_API_KEY` + `OPENROUTER_API_KEY`
only (no zeroentropy); load raw samples; slice to sample size; open the JSONL resume
file; loop `runE2EQuestion` → `judgeAnswer` → record/append; write
`docs/plans/<date>-memory-strata-e2e-report.md`. The `bench` path is unchanged.
**Test:** the existing `configs.test.ts` / arg-parse coverage extended for the new
flags (pure `parseCliArgs`, no network).

### Task 6 — representative report + run docs
Produce the report from a bounded default-sample run **if** API keys are present in the
env; otherwise generate a clearly-labeled representative report from the deterministic
integration fixture so the "one command produces a report" acceptance is demonstrable
without an unbounded paid run. Document the exact command + env in the report header
and the package README/bench notes.

## Out of scope
- Changing the retrieval algorithm (TASK-190/191).
- LoCoMo / internal corpora e2e (LongMemEval-S only per the card).
- The `/agent` git-tier path (k8s). The shipped CLI path is local-FS; that's what we
  measure. (Noted as a follow-up.)

## YAGNI pass
- No new config-driver abstraction — the e2e mode is its own loop. ✓ load-bearing.
- `memory_search` tool wiring IS load-bearing (the shipped agent has it). ✓
- Per-question-type breakdown is cheap + load-bearing for 190/191 baselines. ✓
- Resume JSONL: load-bearing (card mandate). ✓

## Boundary review
No new hooks. The harness only *fires/calls* existing hooks (`chat:start`, `chat:end`,
`system-prompt:augment`, `tool:execute:memory_search`, `llm:call:anthropic`,
`memory:index:*`). No hook-surface change → no boundary-review entry required. It is a
test/bench-only addition.

## Security
Touches: a real LLM call path + reads a third-party dataset (LongMemEval-S) as
untrusted content fed into the Observer + answer prompt, and spawns no processes. The
existing bench already does the same (downloads the HF dataset, calls Anthropic). The
e2e mode adds no new trust boundary vs. the shipped runtime it measures — it IS the
shipped runtime. Run `security-checklist` to confirm (untrusted-content lens).
