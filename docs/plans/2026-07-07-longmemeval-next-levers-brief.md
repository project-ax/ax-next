# LongMemEval next-levers — @ax/memory-strata

**Date:** 2026-07-07
**Purpose:** Session brief — five sequenced workstreams to push the LongMemEval-S e2e score past the current plateau. Paste the body into a fresh session to execute. Chosen by cost and by which *failure class* each hits.

READ FIRST, in order: `docs/plans/2026-07-05-memory-strata-enumeration-e2e-diagnosis.md` (incl. the 2026-07-06 Update), `docs/plans/2026-07-06-memory-strata-reflect-rollup-design.md`, `docs/plans/2026-07-03-memory-strata-multi-session-enumeration-design.md`. Use superpowers skills (brainstorming before any design/build, systematic-debugging, TDD, subagent-driven-development). Follow CLAUDE.md invariants + Bug Fix Policy (a fix that wasn't caught by a test gets a test first).

## Current state (all on main)

- **Orchestrator: 78.0% overall / 60.0% multi-session (18/30) / 83.3% correct-refusal** — after PR #380 (WS-A early-termination fix: `MAX_FACTS_PER_DOC` 20→6 + per-doc truncation marker on `matchedFacts` + strengthened "don't count after one search" coaching in `memory-search.ts` descriptor + `test/bench/e2e-answer.ts`). Report: `docs/plans/2026-07-06-memory-strata-e2e-report-orch-exp.md`.
- **BM25: 76.0% / 53.3%** — this is the PRE-WS-A (enum #379) number; BM25 was NOT re-measured with the WS-A fix, even though the fix is retrieval-agnostic (see WS1a).
- **Gate:** multi-session ≥ 65%, overall ≥ baseline−1pt, correct-refusal ≥ 83%. Multi-session is n=30 → **±3.3pt per question** (noisy — do not chase sub-noise deltas at n=30).
- Baseline JSONLs in `~/.cache/ax-memory-bench/longmemeval-s-e2e/`: `e2e-snippet-{orch,bm25}` (pre-#379), `e2e-enum-{orch,bm25}` (post-#379), `orch-exp-lowcap` (post-WS-A orch). JSONL keys: `questionId, questionType, unanswerable, verdict, toolCalls, question, goldAnswer, agentAnswer`.
- Reflect/rollup is already decomposed into **cards TASK-199 → 200 → 201** (To Do, "TO DO" board project-ax #1). Don't re-plan it; see WS2.

## The failure taxonomy (from the 2026-07-06 flip analysis — this is what routes the work)

The 12 remaining multi-session misses split into three DISJOINT buckets, and different levers hit different buckets:

1. **Aggregation/undercount over instances that ARE in memory** (clothing 2/3, kits 4/5, food-delivery 2/3, weddings "at least 3") → **reflect/rollup (WS2)**.
2. **Sum/arithmetic over found instances** (luxury $2,500, driving hours, jogging 0.5h) → reflect + its numeric-pre-sum follow-up.
3. **Retrieval miss / abstention** (properties viewed, bed-time-before-appointment; ~11.7% false-refusal = ~11 answerable Qs refused because the fact was never surfaced) → **multi-hop (WS3)** / **extraction (WS4)** / **hybrid (WS5)** — reflect CANNOT reach these.

## Shared bench mechanics + gotchas (every paid run)

```bash
cd ~/dev/ai/ax-next && git checkout main && git pull --ff-only
# edit + unit-test, then ALWAYS:
pnpm --filter @ax/memory-strata build            # CRITICAL: bench imports via dist/; stale dist = silent wrong result
set -a; source .env.walk; set +a                 # XAI_API_KEY SET = orchestrator path; run with it UNSET/empty = BM25 path
pnpm --filter @ax/memory-strata bench --mode e2e --sample 100 --cap 35 --resume <unique-label>
cp docs/plans/$(date +%F)-memory-strata-e2e-report.md docs/plans/$(date +%F)-memory-strata-e2e-report-<label>.md  # same-day filename OVERWRITES — copy aside
```

- ~$27 / ~4.5h per n=100 run. `--fixture` = free canned dry-run (does NOT exercise real changes). `--full` = n=500 (~5× cost, multi-session n≈150 — use to de-noise before a big investment).
- Diff new JSONL vs the baseline JSONLs for per-question flips (n=30 → ±1 Q = 3.3pt).
- Filtered repo test gate: `pnpm -r --filter '!@ax/credential-proxy' --filter '!ax-next' test` (known-unrelated failures: credential-proxy undici, one conversations race, Docker-dependent agents/auth-better).
- Parallel building agents: use git worktrees (never the shared main checkout — clobbers HEAD + `.claude/memory`). Commit `.claude/memory` updates with the work.

---

## WS1 — Measure what's free FIRST (near-zero build; gates everything else)

**Do this before building any lever.**

**1a. Re-run BM25 with the WS-A fix (~$27, decisive).** The cap+marker+coaching are retrieval-agnostic but BM25 was never re-measured. Run the bench with **`XAI_API_KEY` unset** (BM25 path), `--resume bm25-postfix`, vs the `e2e-enum-bm25` baseline (76.0%/53.3%). Deliverable: the true BM25 number + a call on **which path is the default** (orch 78 vs BM25 ?).

**1b. Ingest-recall probe (near-free — highest-leverage diagnostic).** The last orch run's logs were full of `memory_strata_observer_parse_error` (haiku extraction intermittently failing). Determine the CEILING: after ingest, for each question's gold instances, grep the consolidated `permanent/memory/docs/**` in the kept workspace to classify every miss as **never-captured** (extraction loss) / **captured-but-not-retrieved** (retrieval) / **retrieved-but-miscounted** (aggregation). Reuse the bench's ingest path with kept workspaces (see how the 2026-07-03 enum autopsy did its 5-question dump). Deliverable: a miss-partition table. **This routes WS3/4/5** — if extraction loss is material, WS4 jumps ahead of WS5; if capture is clean, retrieval levers win.

## WS2 — Reflect / write-time rollup docs (IN FLIGHT — cards TASK-199→201)

Design: `docs/plans/2026-07-06-memory-strata-reflect-rollup-design.md`. Targets buckets 1–2. **Do not re-design.** Either (a) run `/auto-ship` to drain TASK-199→201 (dep-ordered; serialized merges), or (b) build them via yolo-ship/subagent-driven-development. Hard constraints already in the cards: NO index/contract change; new `rollup` category needs 4 edits (`paths.ts`, `doc-store.ts`, `doc-id.ts` `VALID_CATEGORIES`, `types.ts`) + `recent.md` exclusion; GC MUST fire `memory:doc:deleted`→`memory:index:delete` (rollup GC is the first doc-deletion path — `reindex.ts` only upserts today); `writeRollupDoc` must fire `doc:written`; two-stage detection (deterministic Stage A + bounded LLM Stage B, membership verified vs real doc ids). After landing: e2e both paths, target multi-session ≥65%; then file the **numeric-pre-sum follow-up** (`## Total` in rollups) for bucket 2 if the sum questions stay red.

## WS3 — Consume `followupNeeded` (multi-hop retrieval)

The orchestrator already PARSES `<followup needed="true">` but never acts on it (verify current state in `packages/memory-strata/src/orchestrator.ts` — as of the 2026-07-03 enum design D3 it was "parsed-but-unconsumed"). Consuming it (one more retrieval round when the planner is unsure) is c137's documented escape valve (`memory-strata-design.md:1301`) for cross-doc aggregation, **overwritten-state** ("deadline before we changed it"), and the bucket-3 retrieval-miss abstentions. DESIGN FIRST (brainstorming). Complementary to reflect — different bucket. Bench both paths; watch that multi-hop doesn't reintroduce the WS-A early-termination cost balance or blow the op budget.

## WS4 — Extraction robustness (GATED on WS1b showing real loss)

If the probe shows gold instances lost at extraction: make the observer retry/repair on `memory_strata_observer_parse_error` instead of dropping the observation (look at the observer's parse path; consider a repair reprompt or a more lenient parser). Raises the ceiling for EVERY downstream lever. TDD with a fixture that currently parse-fails. Skip entirely if WS1b shows capture is clean.

## WS5 — Hybrid dense retrieval (LAST, heaviest)

Deferred "Level 7" (design doc). Semantic recall for the class-gap (`citrus`≠`lime`) and paraphrase mismatch that token/BM25 match structurally can't reach. Only after WS3 is exhausted AND WS1b says retrieval (not capture/aggregation) is the wall. Big build (new index dimension) — brainstorm + design doc + review before any code; keep the `memory:index:search` contract stable if possible or treat a contract change as an explicit, reviewed decision.

## De-prioritized (mention, don't build)

Abstention-threshold tuning (n=6, ±16.7pt, hallucination/false-refusal tradeoff) and answer-model/judge upgrades (lifts the absolute number but games the metric — the c137 90.4% anchor is a different stack).

## Sequencing

WS1 first (both parts — cheap, decisive, and WS1b routes 3/4/5). WS2 in parallel (already carded). Then, per WS1b's partition: WS3 (retrieval-miss/overwritten-state) and/or WS4 (extraction loss). WS5 only if the recall wall persists after WS3.

## Deliverables

Per workstream: measured before/after vs the named baseline JSONL, shipped-or-not with rationale, and the miss-partition kept current so the next lever is chosen by data, not gut.
