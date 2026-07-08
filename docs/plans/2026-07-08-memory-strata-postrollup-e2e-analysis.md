# Post-rollup e2e — WS1a + WS2 measurement (BM25 crosses over the orchestrator)

**Date:** 2026-07-08
**Runs:** two n=100 LongMemEval-S e2e runs on post-rollup `main` (TASK-199→201 merged Jul 7).
**Spend:** $28.76 (orch) + $28.82 (bm25) = **$57.58**.
**Executes:** WS1a (BM25 re-measure) + WS2's "e2e both paths, target ms ≥65%" from `2026-07-07-longmemeval-next-levers-brief.md`.

## Headline

**BM25 now beats the orchestrator on every axis and is the only path that clears the gate.** The mechanism is *not* rollup (investigated + falsified below — see "Root-cause investigation"): it's that exhaustive BM25 token-retrieval surfaces more instances than the orchestrator's 8-op planned retrieval, plus answer-side borderline-judgment variance. The orchestrator "−6.7pt" is within n=30 noise and is **not** an established rollup regression.

| Path (label) | overall | multi-session | correct-refusal | vs baseline (ms) |
|---|---|---|---|---|
| **BM25** `bm25-postfix` | **79.0%** | **66.7% (20/30)** ✅ | **100% (6/6)** | `e2e-enum-bm25` 53.3% → **+13.3** |
| Orchestrator `orch-postrollup` | 73.0% | 53.3% (16/30) ❌ | 66.7% (4/6) ❌ | `orch-exp-lowcap` 60.0% → **−6.7** |

Gate: ms ≥ 65%, overall ≥ baseline−1, correct-refusal ≥ 83%. **BM25 passes all three; orchestrator fails ms and correct-refusal.**

## Provenance (deltas are clean, with one caveat)

- Both baselines **predate** the rollup merge (rollup = Jul 7; `orch-exp-lowcap` Jul 6, `e2e-enum-bm25` Jul 5).
- `orch-exp-lowcap` is **post-WS-A**, so the orch −6.7pt **isolates the rollup effect** — but the orch path plans with grok (xAI), which is nondeterministic, so some of −6.7 (n=30, ±3.3pt/Q) could be run variance.
- `e2e-enum-bm25` is **pre-WS-A**, so BM25's +13.3pt **conflates WS-A-fix + rollup** — can't split, net strongly positive.

## Root-cause investigation (systematic-debugging)

7 multi-session questions are **orchestrator WRONG, BM25 RIGHT.** Initial hypothesis: *rollup summary short-circuit* — the planner loads a `rollup/*` doc, trusts its membership, stops enumerating raw docs → undercount. **Reading the full answer text of all 7 falsifies this** — not one answer references or counts from a rollup summary. Two other checks also rule out rollup mechanics: member counts range 3–7 (no hard cap at 3), and rollups are excluded from `recent.md`. Real partition:

| Q | question | gold | actual cause | evidence |
|---|---|---|---|---|
| 2ce6a0f2 | art events past month | 4 | **answer borderline-judgment** | orch *named* the Feb-24 guided tour, excluded it as borderline |
| gpt4_a56e767c | movie festivals | 4 | **answer borderline-judgment** | orch *named* Portland, excluded it as "volunteer not attendance" |
| c4a1ceb8 | citrus in cocktails | 3 | **answer borderline-judgment** | orch *named* lemon-in-Sangria, excluded it as "Sangria is wine not cocktail" |
| gpt4_f2262a51 | different doctors | 3 | **answer reasoning** | orch answered 3 but hedged "maybe 4" — failed to unify Dr. Patel = the ENT |
| 7024f17c | jogging+yoga hrs | 0.5h | **judge/answer variance** | orch & bm25 gave near-identical hedgy answers, judge split them |
| gpt4_d84a3211 | bike expenses YTD | $185 | **retrieval-recall gap** | orch missed the $120 helmet, found only the $65 service |
| gpt4_59c863d7 | model kits | 5 | **retrieval-recall gap** | orch missed the Revell F-15 Eagle, found 4 |

**Conclusion:** the orch losses split ~5 answer-side (borderline inclusion / hedge / judge variance — near-noise, path-independent) + 2 retrieval-recall gaps where the orchestrator's **8-op planned retrieval surfaced fewer instance docs than exhaustive BM25**. This is the opposite of the orchestrator's intended edge. The rollup is not implicated in any of the 7.

**Unresolved confound (needs a kept-workspace repro to settle):** each run does its *own* haiku ingest, which is nondeterministic — so the 2 "retrieval-recall gaps" (helmet, Revell F-15) could be **extraction loss in the orch run's ingest** rather than a retrieval failure. Distinguishing them requires re-running one question with the workspace kept and the orchestrator plan traced (near-free — WS1b mechanics). **Now settled — see next section.**

## WS1b repro result (2026-07-08) — extraction exonerated; one real, structural retrieval gap

Re-ran both "retrieval-gap" questions on the orch path with the workspace kept + planner traced (`test/bench/repro-orch-retrieval.ts`). The two split:

- **Q2 bike/helmet ($185) — was nondeterminism, not a gap.** Helmet captured in 4 docs; bullseye `memory_search` returns it (YES); **the orchestrator answered $185 correctly this run.** It missed it in the n=100 run — same question, same path, flipped. Pure run-to-run variance (haiku ingest + grok planner). *Not* a systematic deficiency.
- **Q1 model kits (5) — reproduced; a real retrieval gap rooted in consolidation granularity.** The Revell F-15 *is* extracted, but lands **only in the generic `decision/user.md` catch-all**, while the other 4 kits each got a dedicated doc. The planner loaded the 5 dedicated docs; a bullseye `"Revell F-15 Eagle model kit"` search returns **NO**. The orchestrator's **doc-level planned retrieval is blind to a fact buried in a catch-all doc**; BM25's full-text match still finds it inside `decision/user.md`. (Aside: the B-29 kit is *duplicated* across two docs — consolidation granularity is noisy in both directions.)

**Verdicts this locks in:**
- **Extraction (WS4) is not the bottleneck** — both facts were captured. WS1b routes *away* from WS4.
- **Rollup is exonerated a third way** — the traced Q1 plans loaded zero rollup docs.
- **The one real orchestrator disadvantage is architectural:** planned doc-level retrieval can't see facts consolidated into catch-all docs, which exhaustive BM25 full-text still matches. This is a concrete, mechanistic reason **BM25 ≥ orchestrator for enumeration** — and it's fixed for free by defaulting to BM25 (no planner change, no rollup change).

## Routing implications

- **WS1a answered → default path = BM25.** It wins outright post-rollup. The direct-xAI orchestrator is no longer the front-runner.
- **WS1b (extraction ceiling), partial:** for all 7 aggregation crossovers the facts **are captured** (BM25 retrieves + counts them). Extraction loss (WS4) is **not** the bottleneck for the aggregation bucket → routes away from WS4 for these.
- **WS2 verdict:** rollup is a **win (or neutral) on BM25**; on the orchestrator it is **not shown to help or hurt** (the −6.7 is noise-dominated and rollup-free per the investigation). If we default to BM25, rollup ships as-is.
- **The orchestrator has no recall edge for multi-instance enumeration** — arguably a deficit (planned 8-op retrieval misses instances BM25's exhaustive match catches), at higher cost + latency. This, not rollup, is why BM25 wins.

## Caveats / what's not yet proven

- **Gate margin is thin.** 20/30 = 66.7% vs a 65% gate is ~0.5 question of headroom — noise-thin against the *gate* (the +4-question gain vs baseline is more robust than the absolute margin). A `--full` (n=500, ms n≈150) run de-noises both the gate-pass and the "BM25 is default" call.
- Orch −6.7 partly confounded by grok nondeterminism.
- The clobbered `2026-07-08-memory-strata-e2e-report.md` reflects only whichever run wrote last; JSONLs (`orch-postrollup.jsonl`, `bm25-postfix.jsonl`) are the source of truth.

## Recommended next step

1. ~~Settle the retrieval-gap confound~~ **DONE** (see WS1b repro result): extraction exonerated; Q2 was variance; Q1 is a real planned-retrieval-vs-catch-all-doc gap that BM25 sidesteps.
2. **De-noise before committing:** one `--full` BM25 run (~$135, ~5–6h) to confirm BM25 ≥65% robustly at ms n≈150. This is the remaining paid decision before a code change.
3. If confirmed, **make BM25 the default retrieval path** (config/code change) and ship. The repro gives a mechanistic reason beyond the score: planned doc-level retrieval is blind to catch-all-doc facts.
4. **Do NOT** build a rollup-orchestrator fix — the investigation exonerates rollup three ways (no rollup in any failing answer; member counts 3–7 so no cap; traced plans loaded zero rollup docs). Answer-side borderline losses are near-noise.
5. *(Optional, only if we keep the orch path)* the real orch lever is **consolidation granularity** — facts like the F-15 landing in `decision/user.md` instead of a dedicated doc — plus a BM25-union fallback in the orchestrator's `memory_search`. Lower priority than just defaulting to BM25.

## Why 67% (not 90%) — full BM25 failure taxonomy

The "90%" anchors (incl. c137's 90.4%) are the **full LongMemEval-S 500** across ~5 question types (incl. easy preference/assistant-recall) on a different answer/judge stack. Our bench sample is **only 2 (hard) types** — 70 single-session-user + 30 multi-session. So the honest comparison is our **79% overall** (single-session-user 84%, multi-session 67%), not 67% vs 90%. That said, all 21 BM25 failures partition cleanly:

| Bucket | Count | Root cause |
|---|---|---|
| **Recall miss / false refusal** | **11 (52%)** | agent says "I don't have any record" (or lists too few) for a fact that should be there |
| **Aggregation counting** | **7 (33%)** | under *and* over: clothing 3→2, plants 3→2, game-hrs 140→115, furniture 4→2; **projects 2→7, weddings 3→5, cuisines 4→5** |
| **Answer-side bug** | **3 (14%)** | ethnicity hallucinated with **tools=0 (never searched)**; Alex-ribs misattribution; sister-gift over-specified |

**The dominant bucket is recall, and a kept-workspace repro (BM25 path) of 3 false-refusals split it into THREE distinct root causes:**

1. **Inbox stranding (yoga → "Serenity Yoga") — a real consolidation bug.** The fact is a clean inbox observation (`confidence 0.85`, factType preference) that was **never promoted to a doc**; there's no yoga/Sarah doc at all; `memory_search` (and a bullseye query) can't see it. In that workspace **9 facts sit stranded in the inbox — 8 of them above the 0.7 promotion threshold** (conf 0.85–0.95) and **8 of 9 are from the final session (`2023-05-30`)**. Some final-session facts *did* promote, so it's a *selective* promotion failure, not a missed pass. `decidePromotion()` returns `promote:true` for these (conf ≥ 0.7, not sensitive) — so they reach the write path yet the inbox file survives → **prime suspect: an Observer(fire-and-forget)/consolidation-flush race on the final session's fact batch, with no later pass to catch the remainder.**
2. **Answer-agent abstains too early (streaming → "Spotify") — recoverable variance.** The fact IS in `preference/user.md` and the bullseye returns it; **the repro answered "Spotify" correctly.** The n=100 run refused. Pure run variance / give-up-after-one-search.
3. **Extraction loss (move → "5 hours").** The specific duration isn't in any retrievable doc (a needle hit on `preference/user.md` was an unrelated "1–2 hours"). Haiku dropped the detail → WS4 extraction robustness.

**Implications for the roadmap (these reorder the brief):**
- **The biggest single lever is inbox stranding — and it is NOT in the brief's WS1–5.** If ~half our losses are recall and a large share of recall is stranded-inbox facts, fixing promotion/settle beats rollup (WS2), multi-hop (WS3), and hybrid-dense (WS5) for closing the gap.
- **Key open question that changes everything:** is the stranding a **production consolidation bug** (real lever — fixing it raises the true score) or a **bench-driver settle race** (the driver's `settleObserver` not fully awaiting the final session's Observer batch → our measured score is *artificially depressed*, i.e. the real score is **higher** than 79%)? Either way high-value; must be settled before investing in WS2/3/5. Needs a focused TDD debug on `consolidator.ts` promotion + `e2e-driver.ts` settle ordering, using the kept repro workspace as the fixture.
- Aggregation (33%) is real but **bidirectional** — rollups help undercount only; overcount (projects 2→7) is a boundary problem rollups won't touch.
- A few pure answer-side bugs (hallucinate-without-searching) are cheap prompt/guard fixes.

## ROOT CAUSE + FIX (2026-07-08) — the stranding is a bench-harness race, not a promotion-logic bug

Settled the "open question" above: it's a **bench-driver race**, so **our measured score is artificially depressed** (true memory quality is higher than 79%). Evidence:

- **Discriminator:** re-running `runConsolidation` on the kept yoga workspace with **zero code change** promoted all 8 stranded facts (`promoted:8`, `leftInInbox:1` = the one legit conf-0.6 fact). So the promote path is fine — the facts were simply never processed by a pass. `decidePromotion()` returns `promote:true` for them.
- **Mechanism (from the code):** `chat:end` fires two independent subscribers — Observer (fire-and-forget, writes inbox) and Consolidator (`debouncer.schedule`). With `consolidatorDebounceMs: 0` the pass is a `setTimeout(0)` macrotask; during the driver's `await settleObserver` (the Observer's real LLM call is a macrotask that yields), that 0ms pass fires **before the session's facts are written**. So each session's facts are consolidated by the *next* session's pass; the **final session has no next pass → stranded**. Confirmed general: the move-question workspace also stranded 4 final-session facts (all `2023-05-30`, conf ≥0.9).
- **Why the old `e2e-driver.test.ts` missed it:** its durable fact is in session 0 (swept up by session 1) *and* it uses an instant stub (no macrotask latency, so the race never triggers).

**Fix (`test/bench/e2e-driver.ts`):** raise `consolidatorDebounceMs` from `0` to `10 * 60_000` so the auto-timer never beats the ingest loop's explicit `flush()` (which already runs *after* `settleObserver`). flush() then consolidates every session — including the last — after its facts land. **Regression test** (`e2e-driver.test.ts` → "FINAL ingested session"): fact in the last session + a latency stub → FAILS on `0` (`search` returns `[]`), PASSES on the fix. All 12 driver tests green; package build clean.

**Consequence:** every prior e2e number (n=100 orch/BM25, the aborted n=500) under-measured by silently dropping each question's final-session facts. **Re-measure on the fixed harness** — expect an uplift concentrated in the recall bucket. The n=500 was aborted at 34 rows for this reason.

**Production follow-up (separate):** the shipped plugin has the same two-subscriber structure. Whether production strands the most-recent turn's facts on an "ask immediately after telling" depends on its real debounce window vs Observer latency; it self-heals on the next turn, but an ask-time drain guard may be worth a card. Not fixed here (scope = bench correctness).
