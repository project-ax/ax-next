# TASK-192 — Fair reranker re-test (local cross-encoder + query expansion + full bodies)

**Epic:** strata-finish · **Branch:** `auto-ship/TASK-192-fair-reranker-retest`

## Problem

Our only reranker test (config B, hosted `zerank-2`) **lost** to BM25-only (−2.4pp, ~6× slower)
— but it ran *unfairly*: it reranked only BM25's `topK*3` candidate pool, over
**2000-char-truncated** bodies, with **no query expansion**. SmartSearch (arXiv 2603.15599)
reports a *local* cross-encoder (mxbai-rerank-large-v1, ~435M) + query expansion (PRF + entity
discovery) over **full** bodies reaching 88.4% LongMemEval-S. This spike settles whether a
**fair** reranker beats BM25-only before we commit to the heavier orchestrator path (TASK-191).

## Approach (decided in `decisions.md` 2026-06-29)

A **new** bench config `f-fair-rerank` that fixes all four unfairness levers, head-to-head with
A (BM25-only) and E (orchestrator+map). The local cross-encoder runs as a Python subprocess
(sentence-transformers `CrossEncoder`, mxbai-rerank-large-v1); CI stubs it. Query expansion is a
pure, CI-tested TS function. Ships a report renderer + a no-keys report stub (this build env has
no answer/judge API keys).

## Tasks (independent, testable)

### Task 1 — `expandQuery` (pure query expansion: PRF + entity discovery)
- New file `test/bench/query-expansion.ts`. `expandQuery(query, prfHits: {body}[], opts)` returns
  an expanded query string: original query + top-N PRF terms (frequency over the first-pass hit
  bodies minus a stopword list, minus terms already in the query) + discovered entities
  (capitalized multi-word spans + quoted phrases from the query).
- Pure, deterministic, no model. Unit tests: PRF term harvesting, entity extraction, stopword
  filtering, empty-hits passthrough, dedupe.
- **Test first.**

### Task 2 — Config F driver (`f-fair-rerank`)
- New file `test/bench/configs/f-fair-rerank.ts`, `createConfigF(opts)`.
  - First-pass BM25 over the WIDE pool (`bm25CandidateCount`, default 50) with the raw query.
  - `expandQuery` over the first-pass hit bodies → expanded query.
  - Second-pass BM25 over the wide pool with the **expanded** query (PRF re-query).
  - Build full-body candidate docs (NO truncation) and rerank via the injected `RerankClient`.
  - Return `topK` reranked docs; record `rerankTokens` + a new `rerankMs` on `RetrievalResult` so
    the report can isolate cross-encoder latency.
- Add `'f-fair-rerank'` to `ConfigName` (types.ts) and `rerankMs?: number` to `RetrievalResult`.
- Config tests (stubbed `RerankClient`): full bodies reach the reranker (not truncated), wide
  pool feeds it, expanded query is used for the second pass, ordering follows rerank scores.
- **Test first.**

### Task 3 — Local cross-encoder `RerankClient` (Python subprocess) + script
- `test/bench/rerank-local.ts`: `makeLocalCrossEncoderRerankClient({pythonBin, scriptPath, model})`
  spawns the python script, writes `{query, documents}` JSON on stdin, reads `{scores}` JSON on
  stdout, maps to `{reranked, tokens}`. Robust to non-zero exit / malformed output (throws with a
  clear message). `tokens` reported as 0 (local, untokenized cost — latency is the real metric).
- `test/bench/scripts/cross_encoder_rerank.py`: loads `sentence_transformers.CrossEncoder(model)`
  once, reads stdin JSON, prints `{scores}` JSON. Pure stdlib + sentence-transformers; documented
  install. Not run in CI.
- Unit test the TS client with a FAKE python script (a tiny node/sh stub) so the spawn+parse path
  is covered without the real model.
- **Test first.** Touches process spawn → run `security-checklist` (subprocess of a fixed,
  in-repo script with no untrusted args beyond the corpus text we already control).

### Task 4 — Report renderer `renderFairRerankReport` + stub
- `test/bench/fair-reranker-report.ts`: `renderFairRerankReport(input)` → markdown comparing
  A / E / F on accuracy + recall@5 + abstention + latency, a dedicated **cross-encoder per-query
  latency** line, and a **VERDICT** block (`does fair-F beat A by >=5pp accuracy?` →
  win / no-win / `needs-local-run`). `verdictMode: 'measured' | 'needs-local-run'`.
- Unit tests: win verdict (>=5pp), no-win verdict (<5pp), needs-local-run stub (no rows), latency
  line present, recall@5 surfaced.
- **Test first.**

### Task 5 — Wire F into the bench CLI + write the report doc
- `cli.ts`: add `f-fair-rerank` to `wantCfg`/`ConfigName`; build the local cross-encoder client
  from a `--rerank-python`/env override (falls back to a clear "config F skipped: no local
  cross-encoder configured" build failure so a key-free `--config all` run doesn't crash).
- Reuse `bench --config f-fair-rerank` (no new package script). Document the exact command in the
  report.
- Generate `docs/plans/2026-06-29-memory-strata-fair-reranker-report.md` via the renderer in
  `needs-local-run` mode (no keys here), embedding the exact local run command.

### Task 6 — Gate + review + ship
- `pnpm --filter @ax/memory-strata build && test`, repo `lint`, repo `build`/`test`.
- Self-review the whole diff (Phase 5 inline — no subagent in orchestrated mode).
- Open PR `[TASK-192] …`, drive CI green, hand off (do NOT merge).

## YAGNI pass
- No runtime wiring (out of scope). ✓ cut.
- No new package script (reuse `bench --config`). ✓ cut.
- `rerankMs` added (load-bearing: the card requires per-query cross-encoder latency). Keep.
- `tokens` from local reranker = 0 (no meaningful token cost locally). Keep simple.
