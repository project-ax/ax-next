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

## Fixed-harness re-measure (2026-07-09, n=100 both paths)

After the stranding fix, re-ran both paths (labels `*-postfix-drain`):

| Path | overall | multi-session | correct-refusal | vs buggy baseline |
|---|---|---|---|---|
| **BM25 fixed** | **82.5%** | 62.1% (18/29) | 100% (6/6) | overall +3.5 (79.0→82.5); ms −4.6 (noise) |
| ORCH fixed | 71.1% | 51.7% (15/29) | 4/6 | overall −1.9; ms flat |

- **The fix lifts OVERALL (single-session recall recovered: +5/−0 on single-session), but multi-session is unchanged-to-down and stays BELOW the 65% gate.** Multi-session has now printed 53/60/67/62% across runs — n≈30 is noise-dominated (±3.3pt/Q); the gate is genuinely unanswerable at n=30 (brief's warning confirmed). BM25 still clearly beats the orchestrator.
- (3 questions skipped per run on transient API errors → 97 scored.)

## Counting diagnosis (2026-07-09) — the multi-session wall needs two OPPOSITE fixes

Kept-workspace repro (`test/bench/repro-count-diag.ts`, BM25 path) of one overcount + one undercount:

- **Overcount — projects (gold 2, answered 7): boundary/definition, partly unwinnable.** Memory holds **20 "project" fact-lines** (engineering lead, data-clustering, data-mining *class* project, Nigeria water project, a *book*, *sculpting class* project, "binge-watching project"…) — all genuinely captured. The failure is the *set boundary* ("led/leading" as real work vs. anything called a project); the gold's "2" is one strict reading. Answer-side reasoning against ambiguous gold → **low ceiling**.
- **Undercount — food delivery (gold 3, answered 2): recall/extraction.** Only Uber Eats + Fresh Fusion are in the docs; the 3rd service isn't captured (even topK-20 enumeration didn't surface it). The agent counted correctly given what it had. **Recall problem, not counting logic.**
- Shipped rollup formed **wrong classes** here (`rollup/marketings` count 3, `rollup/uses` count 3) — noise, not signal.

**Design implication:** a read-time counting scaffold won't crack multi-session — undercount needs *recall*, overcount needs *boundary reasoning* (low, gold-bound ceiling). Undercount == the same recall problem as the single-session wins, so **recall/extraction completeness is the highest-EV lever** (lifts undercount + the 52% recall bucket). Decision: **measure the true multi-session number first** (n=500 BM25 on the fixed harness, label `bm25-full-fixed`) before investing — the n=30 gate is noise-bound.

## FINAL: n=500 BM25 on the fixed harness (2026-07-10) — gate PASSES; one structural outlier

`bm25-full-fixed.jsonl`, 488/500 scored (12 skipped on transient API errors), ~$143.

| Type | score | pct |
|---|---|---|
| single-session-user | 59/70 | 84.3% |
| single-session-preference | 21/30 | 70.0% |
| knowledge-update | 48/69 | 69.6% |
| temporal-reasoning | 91/132 | 68.9% |
| **multi-session** | **90/133** | **67.7%** ✅ (gate ≥65%) |
| **single-session-assistant** | **14/54** | **25.9%** ⚠️ |
| **OVERALL** | **323/488** | **66.2%** |
| correct-refusal | 22/25 | 88.0% ✅ (gate ≥83%) |

**Gates: multi-session 67.7% ≥65% PASS; correct-refusal 88.0% ≥83% PASS.** De-noised at n=133 multi-session (vs n=30), the earlier pessimism (53/60/62%) was confirmed noise — it settled *above* the gate. **The aggregation-counting lever and dense embeddings were NOT needed to pass the gate** — measuring first saved building both.

**Every type sits at 68–84% except one.** Type scores that looked weak at small n de-noised upward as their samples filled (temporal 62.5%→68.9%; knowledge-update 64.7%→69.6%). Only `single-session-assistant` stayed low — at n=54 that is structural, not variance.

### The dominant remaining gap: assistant-content is never stored

`single-session-assistant` asks what the *assistant* said ("remind me what color the Plesiosaur was", "what was the 7th job on that list", "what were CITGO's refining processes"). **35 of its 40 failures are abstentions**, and the answers share one signature — memory has the **topic** but not the **content**:

> "I can see we **did discuss** a children's book about dinosaurs, but I don't have that detail."
> "My memory **confirms we discussed** CITGO's three refineries (Lake Charles, Lemont, Corpus Christi) — but…"

**Root cause (`src/observer.ts`, prompt-level — NOT an input problem):** `formatTranscript` *does* feed assistant turns to the extraction LLM, but `EXTRACTION_PROMPT_SYSTEM` is entirely user-centric — "durable facts… likely to still matter to **this user**: preferences, decisions, deadlines, identities, project state" — and the factType taxonomy (entity/preference/decision/episode/general) has no slot for assistant-provided content. So the model reads the assistant's answer and dutifully writes "User is writing a children's book about dinosaurs," discarding "the Plesiosaur had a blue scaly body."

**Impact:** 54 questions = 11.1% of the benchmark, and **49% of ALL false refusals** in the run (35 of 71). Overall false-refusal rate is 14.5%.

| Lift single-session-assistant to | Δ questions | overall |
|---|---|---|
| 50% | +13 | 68.9% (+2.7pp) |
| 70% (parity with other types) | +24 | **71.1% (+4.9pp)** |
| 84% (best-type parity) | +31 | 72.5% (+6.4pp) |

### Recommended next lever: assistant-content extraction

Cheapest, largest, best-evidenced lever available — and **it is not in the brief's WS1–WS5**. It's an Observer prompt/taxonomy change (extend extraction to assistant-provided content: recommendations, lists, named entities, specifics the user may later ask to recall), not a new index dimension, not multi-hop, not embeddings. Guardrails: don't bloat memory with every assistant utterance (confidence/durability bar, dedup against user-side facts); watch that recall gains don't raise hallucination on the abstention set (correct-refusal is currently 88% and must stay ≥83%).

**De-prioritized by this data:** aggregation-counting (gate already passes; overcount is gold-ambiguous, low ceiling), dense embeddings/WS5 (no evidence lexical mismatch is the wall; would aggravate overcount), WS3 multi-hop (knowledge-update/temporal both de-noised to ~69%, no longer outliers).

## Assistant-content extraction — targeted result (2026-07-30, n=54)

The lever recommended above is **built and measured**. Design:
`docs/plans/2026-07-29-assistant-content-extraction-design.md`; plan:
`docs/plans/2026-07-29-assistant-content-extraction-plan.md`.

Targeted run on the 54 `single-session-assistant` questions (`assistant-extraction-v1.jsonl`,
BM25 path, fixed harness, $24.75, ~8h):

| | before (`bm25-full-fixed`) | after | |
|---|---|---|---|
| **score** | **14/54 = 25.9%** | **47/54 = 87.0%** | **+33 questions** |
| correct | 14 | 47 | |
| abstained-incorrectly | 35 | 7 | −28 |
| incorrect | 5 | 0 | −5 |

**87.0% is above the previous best type** (single-session-user, 84.3%) — the type went from the
sole structural outlier to the strongest. Pre-declared gate was ≥35/54; it cleared by 12.
Flips: +33 / −1 (`7a8d0b71`, DHL influencer budget, `correct → abstained-incorrectly`; n=1, noise-scale).

### What changed

`EXTRACTION_PROMPT_SYSTEM` now extracts two kinds of fact — USER facts (unchanged) and ASSISTANT
facts (new, `factType: 'answer'`) under four rules, each traceable to an observed failure:
attribute from the assistant's side; keep enumerated lists whole and ordered; keep the specific
value rather than the topic; skip anything the assistant hedged. `answer` maps to the **existing**
`docs/general` category — a separate `docs/answer/` would have split a subject's facts across two
docs and broken the co-location BM25 depends on.

Shipped alongside (a risk the change created): `MAX_EXTRACTION_TOKENS` 1024→2048 plus a salvage
parser, because a truncated JSON array previously returned `null` and **lost every fact in the
session, user facts included**. The pre-change diagnostic hit that failure once in ~300 sessions;
the post-change run hit it zero times.

### Live extraction evidence (`test/bench/repro-extract.ts`, ~$0.83)

Same three transcripts, before → after:

| question | before | after |
|---|---|---|
| Plesiosaur's colour | topic only | "Plesiosaur (**blue scaly body**, long neck…)" |
| Lake Charles processes | vague "catalytic cracking interest" | "1. Atmospheric distillation, 2. FCC, 3. Alkylation, 4. Hydrotreating" |
| 7th WFH job | "user is interested in WFH jobs" | "…6. Online survey taker, **7. Transcriptionist**, 8…" |

### The 7 survivors split cleanly — and route the next lever

- **6 = capture, not retrieval.** Fine-grained single values still dropped: a phone number
  (`+49 (0) 62 32 / 14 23 - 0`), a chord progression, a construction year, a `$2,000` line item.
  Consistent with the prompt's deliberate volume caps (≤5 assistant facts/transcript, ≤400 chars
  each) — a **tunable**, not a design flaw. Cheapest next experiment: relax the caps and re-run
  the 54 at ~$25.
- **1 = retrieval/trust** (`6ae235be`, CITGO). The repro proves extraction captured the Lake
  Charles process list verbatim, and the agent *still* abstained. This is the branch the
  `memory_search` descriptor-wording lever targets — held in reserve in the design.

### Caveats

- Per-type regression and correct-refusal are **not** settled by this run — that is the pending
  n=500 (`bm25-full-assistant`). More stored content = more chances to answer an unanswerable
  question, and correct-refusal must hold ≥83%.
- Throughput was ~10x slower than estimated (~9 min/question): the richer extraction slows every
  one of a question's ~135 haystack sessions. Budget wall-clock, not just dollars, for full runs.
- Watch item from review: `isDupe` (Jaccard 0.6) can collapse two *short* assistant facts on one
  subject — "…recommended Hotel Estherea in Amsterdam" vs "…Hotel Ambassade in Amsterdam" scores
  0.667 — and the mandated attribution prefix makes that likelier. Long list-facts are unaffected.
  No evidence it bit this run; re-check on the n=500.
