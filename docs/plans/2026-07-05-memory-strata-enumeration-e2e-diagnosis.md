# memory-strata enumeration lever — e2e validation + diagnosis

**Date:** 2026-07-05
**Scope:** Post-merge validation of PR #379 (multi-session enumeration lever) against the 2026-07-02 post-snippet baselines, plus a per-question diagnosis of why the multi-session target was missed.
**Stack (all runs identical):** answer `claude-sonnet-4-6`, extraction `claude-haiku-4-5-20251001`, judge `x-ai/grok-4.3`. n=100 (multi-session n=30, unanswerable n=6).
**Reports:** `2026-07-04-memory-strata-e2e-report-orch.md`, `2026-07-05-memory-strata-e2e-report-bm25.md`.

## Verdict: success gate NOT met

Gate was **multi-session ≥ 65%**, overall ≥ baseline −1pt, correct-refusal ≥ 83%.

| metric | baseline (07-02) | new (enum) | Δ | gate |
|---|---|---|---|---|
| Orchestrator overall | 73.0% | 69.0% | −4.0 | ❌ |
| Orchestrator multi-session | 46.7% | 43.3% | −3.4 | ❌ |
| Orchestrator correct-refusal | 83.3% | 66.7% | −16.6 | ❌ |
| BM25 overall | 70.0% | 76.0% | +6.0 | ✅ |
| BM25 multi-session | 50.0% | 53.3% | +3.3 | ❌ |
| BM25 correct-refusal | 100.0% | 83.3% | −16.7 | ✅ (=83) |

The primary target (multi-session ≥ 65%) is missed on **both** paths. Orchestrator regressed on all three criteria; BM25 improved overall but multi-session barely moved.

**Noise caveat:** multi-session is n=30 (each question = 3.3pt); abstention is n=6 (each = 16.7pt). Every multi-session and correct-refusal delta here is ±1 question — within sampling noise. The only movement that clears noise is **BM25 overall +6pt**.

## Per-question flip analysis (JSONL diff: `e2e-snippet-*` → `e2e-enum-*`)

Confirmed the canonical baseline JSONLs reproduce the 07-02 reports exactly (snippet-orch 73.0%/46.7%, snippet-bm25 70.0%/50.0%).

| path | net | gained | lost | driver |
|---|---|---|---|---|
| Orchestrator | −3 | 8 | 11 | high churn, net negative |
| BM25 | +7 | 13 | 6 | **single-session +6**, multi-session +1 (noise) |

BM25's real gain is **single-session recall** — dated facts + `matchedFacts` help general lookup, an off-target win. Multi-session (the target) is flat on both.

## Root cause: aggregation quality, not retrieval recall

The two paths fail multi-session **differently**, but from one root cause.

**Orchestrator — early termination.** On the 5 multi-session questions it lost, tool-calls *dropped* 4.40 → 2.80 (fewer in 4 of 5):

| question | gold | enum answer | tool calls (base→enum) |
|---|---|---|---|
| bike expenses total | $185 | $65 (under) | 3→5 |
| game hours total | 140 | ~110 (under) | 5→**2** |
| babies born | 5 | 6 (over — added an adopted child) | 5→**1** |
| furniture items | 4 | 2 (under) | 5→4 |
| cuisines tried | 4 | 5 (over) | 4→**2** |

`matchedFacts` fills the *first* search result with many fact lines, so the answer model reads them, concludes it has the complete set, and stops after 1–2 searches instead of the 4–5 rounds that previously found all instances. On a counting question needing broad retrieval, that under-samples. Both directions appear: under-count (missed instances) and over-count (mis-aggregating / including a borderline instance the enrichment surfaced).

**This is NOT the op-cap `<fts>`-starvation (CTI-1) flagged in the PR review.** If it were, tool-calls would balloon into the 8-op cap — they went *down*. CTI-1 remains a valid latent issue but did not drive this regression; that hypothesis is falsified by the data.

**BM25 — over-retrieval, still mis-counts.** On its multi-session losses, tool-calls went *up* 4.00 → 5.50 (fewer in 0 of 4). It retrieved more and still mis-counted — pure aggregation error over the extra surfaced facts.

**Unifying finding:** `matchedFacts` improved *what gets surfaced* (BM25 overall +6), but the model's read-time job of counting/deduping over those facts stays error-prone — and on the orchestrator the fat enriched result *suppresses* the multi-round retrieval that used to compensate. No amount of better surfacing fixes read-time aggregation.

## Implication: the deferred `reflect` lever is now earned

The design pre-registered the condition:

> *reflect / write-time rollup docs … Re-evaluate only if read-time enumeration measures short.*

It measured short, and the diagnosis says why: **read-time aggregation is the wall.** Precomputing the count/list at write time (`reflect`) is the earned next lever — not more retrieval tuning.

## Recommendations (in order)

1. **Pick up `reflect`/rollup docs** — write-time aggregation is what these counting questions need. (New card.)
2. **Cheap orchestrator experiment first (optional, ~$27/5h):** the early-termination is partly a per-doc cap artifact — lower `MAX_FACTS_PER_DOC` so the first result does not *look* exhaustive, and/or strengthen the answer-loop coaching to force instance-term follow-ups before counting. Tests the hypothesis before committing to reflect.
3. **Downgrade the CTI-1 (op-cap fts-starvation) card** for this regression — still a valid latent issue, but falsified as the cause here.
4. **Kept wins:** BM25 overall +6 (single-session recall) is real — the dated-facts + matchedFacts levers are net-positive there and should stay. BM25 is currently the better default path (76% vs 69%).

## De-noising note

Multi-session at n=30 is noisy (±1 question = 3.3pt). An n=500 (`--full`) run puts multi-session at n≈150 before any large investment — ~5× cost/time.

## Update 2026-07-06: cheap orchestrator experiment ran — hypothesis confirmed, tweak ships

The recommended cheap experiment (Rec #2) was run: `MAX_FACTS_PER_DOC` 20→6, an
explicit per-doc **truncation marker** on `matchedFacts` when a doc has more
matching lines than shown, plus strengthened "don't count after one search"
coaching in `memory_search`'s descriptor and the bench answer loop. Orchestrator,
n=100, same stack. Report: `2026-07-06-memory-strata-e2e-report-orch-exp.md`.

| metric | snippet base | enum (#379) | **exp** | Δ vs enum |
|---|---|---|---|---|
| overall | 73.0% | 69.0% | **78.0%** | +9.0 |
| multi-session | 46.7% | 43.3% | **60.0%** | +16.7 |
| correct-refusal | 83.3% | 66.7% | **83.3%** | +16.6 |

**The early-termination hypothesis is confirmed, not falsified.** Every gained
multi-session question did *more* tool-calls than under enum (citrus 4→6, games
2→6, cuisines 2→4, babies 1→2) — exactly the "keep sampling before you count"
behavior the fat first result had suppressed. Read-time aggregation was **not**
the whole wall; early termination was a large, cheaply-recoverable part of it.
Multi-session lands at 60.0% (18/30) — ~2 questions shy of the 65% gate — while
overall reaches a new high and correct-refusal returns to baseline. Per the
pre-registered rule ("recovers toward ≥65% without hurting overall → ship the
tweak, reflect deferrable"), the tweak ships.

**`reflect` is downgraded from "the earned next lever" to a gap-closer.** The 12
remaining multi-session misses split into: true sum/aggregation over found
instances (luxury $2,500 total, driving hours, jogging 0.5h), off-by-one
undercounts (clothing 2/3, kits 4/5, food-delivery 2/3, weddings "at least 3"),
and pure retrieval misses/abstentions (properties viewed, bed time) that no
write-time rollup can reach. Only the first two groups (~5–7 questions) are in
reflect's scope — so reflect is still worth building to close the last ~5pt, but
it is no longer the primary fix.
