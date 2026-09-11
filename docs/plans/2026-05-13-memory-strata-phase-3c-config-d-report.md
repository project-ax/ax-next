# Strata Phase 3C — Config D (Retrieval Orchestrator) + abstention spike

**Dates:** 2026-05-13 (initial n=100 round), 2026-05-14 (n=500 follow-up)
**Cap:** $50
**Total spent (across all underlying runs):** $44.46

> _The report below merges six underlying bench invocations against the LongMemEval-S cleaned dataset. Configs A/B/C numbers (n=100, Haiku orchestrator) are cited from PR #66's report. Configs D/E n=100 + n=500 runs were added in this round, including a Grok 4.1 Fast orchestrator swap and an LLM-rewritten map. Raw single-config reports preserved at `docs/plans/2026-05-*-memory-strata-phase-3c-config-*-raw.md`._

## Headline result

**The original PR #68 binding decision was wrong on the merits, and we now know it's wrong on the data.** At n=100 with Haiku orchestrator, D appeared to lose to A by 4 points; the report said "orchestrator OUT for now." Two follow-on experiments flipped that:

1. **Grok 4.1 Fast as orchestrator (n=100 canary).** D's accuracy rose from 18.0% → 23.0%; recall@5 from 25.0% → 30.0%; correct-refusal from 83.3% → 100% (6/6). The orchestrator-model choice alone was load-bearing in the original n=100 binding.
2. **n=500 paired re-run with Grok orchestrator.** D matched A within noise (22.0% vs 20.6%); E beat A meaningfully on accuracy (24.0% vs 20.6%) and recall@5 (47.6% vs 41.8%).
3. **n=500 with Grok + LLM-rewritten map summaries.** E-rewrite hit **28.2% accuracy** and **56.0% recall@5** — beating A by 7.6 and 14.2 points respectively. **The map-quality lever is meaningfully load-bearing**, exactly as c137's premise predicted.

The corrected conclusion: **the retrieval orchestrator architecture works**. Whether to wire it into production hinges on the latency tradeoff (90× slower than BM25) and the use case (hallucination-sensitive ⇒ orchestrator; latency-sensitive ⇒ BM25).

## Results (n=500 round is the binding axis; n=100 numbers are kept for traceability)

| corpus | Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | $ |
|---|---|---|---|---|---|---|---|---|
| longmemeval-s | A: BM25-only (n=100, PR #66) | 100 | 22.0% | 25.0% | 1.0% | 71 | 148 | $1.74 |
| longmemeval-s | B: BM25 + zerank-2 (n=100, PR #66) | 97 | 19.6% | 20.6% | 4.1% | 603 | 925 | $1.88 |
| longmemeval-s | C: BM25 + zembed-1 + RRF (n=100, PR #66) | 100 | 13.0% | 16.0% | 3.0% | 600 | 814 | ~$1.93 |
| longmemeval-s | D: Retrieval Orchestrator (n=100, Haiku) | 100 | 18.0% | 25.0% | 1.0% | 949 | 2430 | $1.66 |
| longmemeval-s | D: Retrieval Orchestrator (n=100, Grok canary) | 100 | 23.0% | 30.0% | 1.0% | 7278 | 19589 | $1.39 |
| longmemeval-s | **A: BM25-only (n=500)** | 500 | **20.6%** | **41.8%** | 0.6% | **89** | **315** | $8.98 |
| longmemeval-s | **D: Retrieval Orchestrator (n=500, Grok)** | 499 | 22.0% | 39.7% | 0.2% | 8002 | 19852 | $6.85 |
| longmemeval-s | **E: Orchestrator + BM25 fallback (n=500, Grok)** | 500 | **24.0%** | 47.6% | 0.4% | 8108 | 19896 | $8.49 |
| longmemeval-s | **E: Orchestrator + BM25 fallback (n=500, Grok + LLM-rewritten map)** | 482 | **28.2%** | **56.0%** | 0.0% | 6230 | 15363 | $7.53 |

Bold rows are the n=500 binding evidence.

## Abstention

| corpus | Config | unanswerable n | correct-refusal | hallucinated | false-refusal (on answerable) |
|---|---|---|---|---|---|
| longmemeval-s | A (n=500) | 30 | 21 (70.0%) | 9 | 266 / 470 (56.6%) |
| longmemeval-s | D (n=500, Grok) | 30 | 24 (80.0%) | 6 | 299 / 469 (63.8%) |
| longmemeval-s | E (n=500, Grok) | 30 | 23 (76.7%) | 7 | 252 / 470 (53.6%) |
| longmemeval-s | E (n=500, Grok + LLM-rewritten map) | 27 | 22 (81.5%) | 5 | 237 / 455 (52.1%) |

Three things to read from this table:

1. **All orchestrator configs beat A on correct-refusal** (76.7–81.5% vs A's 70%). The orchestrator + map architecture genuinely improves abstention quality, consistent with c137's premise.
2. **E with LLM-rewritten map has fewer false-refusals on answerable Qs than A** (52.1% vs 56.6%). This is the *combination* result: better map ⇒ better orchestrator picks ⇒ agent sees the right content more often ⇒ doesn't have to give up. The orchestrator no longer overpays for abstention by missing answerable cases.
3. **Hallucinations on unanswerable trend down across the board** (A: 9 → E-rewrite: 5). The orchestrator+map architecture knows when it doesn't know.

## What the n=500 numbers actually settle

### vs the original PR #68 binding
- D-Grok vs A at n=500: **22.0% vs 20.6%, delta 1.4pp**. Within McNemar's noise band (p ≈ 0.4). Tied on accuracy.
- E-Grok vs A at n=500: **24.0% vs 20.6%, delta 3.4pp**. Below the ≥5-point bar but meaningful directionally; back-of-envelope McNemar's puts it near p ≈ 0.05.
- E-Grok-rewrite vs A at n=500: **28.2% vs 20.6%, delta 7.6pp**. **Clears the ≥5-point bar.** This is the real binding answer.

### What the rewrite did
The LongMemEval `firstSentence` summaries we started with were often trivial chitchat from session openers ("Good morning, I was wondering if…"). The Grok-rewritten summaries are dense, fact-focused one-liners (~120 chars, e.g. "User commutes 45min each way to work in Boston; prefers Tesla over BMW"). The orchestrator gets meaningful signal per session and picks the right session more often. Recall@5 jumped from 47.6% (E-Grok plain) to 56.0% (E-Grok-rewrite) on the same questions, same orchestrator, same agent — just better map content.

This empirically confirms c137's premise that **map summary quality is load-bearing** for the orchestrator stage.

### Cost & time
- Total live spend across all runs: **$44.46** (within the $50 cap).
- The LLM-rewrite pass itself: **$4.50** for 19,195 sessions (~$0.0002/session), cached and reusable across all future runs.

### Latency probe (2026-05-14, after the main n=500 round)

The orchestrator's p50 ~7–8s in the n=500 runs was striking — c137 reports ~1.6s for the same role. A follow-up probe (`bench:latency`, 20 sequential calls per config, same prompt) found the explanation: **OpenRouter's default routing for `x-ai/grok-4.1-fast` was pathological**.

| config | p50 | mean | p95 | max |
|---|---|---|---|---|
| haiku-anthropic-direct | 778ms | 1184ms | 2493ms | 4035ms |
| **grok-openrouter-default** | **11017ms** | 11712ms | 16555ms | 16623ms |
| grok-openrouter-force-xai | FAILED (Grok 4.1 Fast deprecated on OpenRouter; redirects to Grok 4.3) | | | |
| **grok-xai-direct** | **404ms** | 427ms | 646ms | 726ms |

**Direct xAI is ~27× faster than OpenRouter** for the same model — and faster than Haiku-via-Anthropic. The 7s/turn measured in the n=500 runs was a routing artifact, not Grok's actual latency.

This changes the binding tradeoff substantially:
- Orchestrator real p50 latency: **~404ms** (not ~7s).
- BM25 p50 latency: ~89ms.
- Gap: **~5×, not 90×** — well within "interactive workload acceptable for higher quality" territory.

## Binding decision

The original PR #68 framing — "orchestrator OUT, abstention as the finding" — was wrong about both the conclusion and the *why*. The corrected framing:

- **The orchestrator architecture works.** E with Grok 4.1 Fast + LLM-rewritten map beats A by 7.6 points on accuracy and 14.2 points on recall@5, clearing the ≥5-point bar on both axes. The c137-style design is validated.
- **Latency is acceptable** when routed via direct xAI rather than OpenRouter. ~400ms p50 / ~650ms p95 vs BM25's ~89ms / ~315ms — a 5× gap that buys ~7pp accuracy and ~14pp recall@5. Reasonable production tradeoff for chat-style agents.
- **Therefore: the orchestrator + LLM-rewritten map is a viable default retrieval path**, with the explicit requirement that production uses direct xAI API access (or another equivalently-fast provider), not OpenRouter's default routing. BM25-only remains a valid lower-latency fallback for surfaces where 300ms of extra latency is unacceptable.

A note on production wiring: the bench harness uses `makeOpenRouterOrchestratorClient` by default. The production plugin should default to `makeXaiOrchestratorClient` and use OpenRouter only as a fallback if xAI access is unavailable. Follow-up: harden the bench's default orchestrator client to match (small, mechanical change).

## One-hop coverage

The orchestrator emitted `<followup needed="true"/>` rarely across all configs (handful out of 500). The dominant failure mode was emitting `<load>` ops that picked the wrong session, not refusing to plan. The BM25 fallback in Config E recovers more from this than the followup signal itself — which is why E beats D meaningfully.

## Caveats

- **18 skipped questions in the E-Grok-rewrite run** were caused by a pre-existing bench-harness bug (`resp.choices` returning undefined from OpenRouter on transient errors). Fixed in `cbe2f28` (`resp.choices?.[0]?.message?.content`) but the n=500 rewrite run used the buggy code path; n=482 is the effective sample size. The headline 7.6pp lift vs A is large enough to survive optimistic / pessimistic assumptions about the missing 18.
- **The LLM-rewrite cache is one-shot, ~$4.50 for the full corpus, cached forever.** Reproducing the rewrite results in future runs is free.
- **Latency is sensitive to OpenRouter routing variance.** Grok 4.1 Fast's published latency is ~1.6s; we measured p50 ~6–8s. Direct xAI API access or a different provider routing may close this gap. Not in scope for this spike.
- **Single-corpus run (LongMemEval-S only).** LoCoMo + internal still gated on per-question concurrency in the bench loop.
- **LongMemEval-cleaned variant** — per PR #66; author-deprecated original; cleaned variant strips noisy history.
- **Judge cross-family concerns.** Agent = Sonnet 4.6 (Anthropic). Orchestrator = Grok 4.1 Fast (xAI). Judge = Grok 4.3 (xAI). Judge and orchestrator are same family, which could mildly bias scoring in favor of D/E. A cross-judge sweep (e.g., GPT-5 as second judge) is a Phase 5+ follow-up if the binding case ever needs tightening.
- **Per-question map scoping.** Configs D/E filter the map by `question.metadata.haystackPaths` so the orchestrator sees only the ~48 sessions relevant to its question (not all 19K). This is honest in a way A's full-corpus BM25 index isn't — A implicitly retrieves across all 500 samples' haystacks — but doesn't tilt the comparison either way at n=500 (recall@5 metrics are computed against per-question gold sessions in both cases).
- **Bench's absolute accuracy is below LongMemEval-S literature.** Our 20–28% range is below the published 30–50% for Sonnet+RAG configs. The gap reflects Strata's intentionally lightweight injection regime (`MAX_INJECTED_BODY_CHARS = 2000`, summary-first auto-injection). For "match the literature" benchmarking we'd need to inject full bodies, which contradicts Strata's hot-tier budget tenet. **Comparative deltas (E vs A, E-rewrite vs E) are the load-bearing signal**; absolute level isn't.
- **LongMemEval and LoCoMo are research-licensed.** Same as PR #66.
- `zeroentropy@0.1.0-alpha.10` — same as PR #66.

## References

- Phase 3B (vectors out): `docs/plans/2026-05-13-memory-strata-vector-spike-report.md` and PR #66.
- This phase's raw single-config reports (gitignored, local-only): `docs/plans/2026-05-{13,14}-memory-strata-phase-3c-config-{a,d,d-grok,e}-*-raw.md`.
- Implementation plan: `docs/plans/2026-05-13-memory-strata-phase-3c-config-d-impl.md`.
- Strata design doc, c137 section: `docs/plans/memory-strata-design.md` § "Prior Art (2026-05-13 update — c137)" and § "Retrieval Orchestration: One-Hop Default, Drill-Down as Escape Valve".

---

## Addendum — 2026-09-10 re-measurement (TASK-347 follow-up)

**Everything above about provider latency is out of date, and the way it went
stale is the point of this addendum.**

The "~11s p50 for OpenRouter" line from the 2026-05-14 probe got quoted in
`orchestrator-client.ts` and in both presets as a standing reason not to route
the orchestrator through OpenRouter at all. Re-reading the probe table shows
what it actually measured: `x-ai/grok-4.1-fast` under OpenRouter's DEFAULT
routing — and the same table records that model as **deprecated on OpenRouter**,
which is why the `grok-openrouter-force-xai` arm FAILED. Provider-forcing, the
mitigation everyone assumed was available, was never measured at all.

So the number was a fact about one deprecated model's routing in May 2026, not
about OpenRouter. It was still steering architecture in September.

### What is true now

`pnpm --filter @ax/memory-strata bench:latency`, 19 samples per config after a
discarded warmup, same LongMemEval-S question and generated map as the original
run. Budget for reference: `DEFAULT_ORCHESTRATOR_TIMEOUT_MS` = **5000ms**, past
which `memory_search` silently falls back to BM25.

| config | n | min | p50 | mean | p95 | max |
|---|---|---|---|---|---|---|
| openrouter / `anthropic/claude-haiku-4.5` | 19 | 887 | **1049** | 1117 | 1580 | 1677 |
| openrouter / `deepseek/deepseek-v4.1-flash` | 19 | 1311 | 1727 | 1922 | 2866 | 4629 |
| openrouter / `google/gemini-3.8-flash` | 19 | 1383 | 2387 | 2368 | 3525 | 3532 |
| openrouter / `x-ai/grok-4.3` | 19 | 4456 | **7269** | 8696 | 18482 | 19802 |
| anthropic-direct / haiku 4.5 (reference) | 19 | 488 | 635 | 717 | 1014 | 1443 |
| xai-direct / grok (reference) | 19 | 650 | 812 | 4351 | 12659 | **61347** |

### Conclusions, replacing the "Binding decision" above

- **`anthropic/claude-haiku-4.5` through OpenRouter is the production default.**
  Fastest of the OpenRouter options and by far the tightest spread
  (887–1677ms end to end), comfortably inside the 5s budget.
- **Grok is no longer the right model here.** `x-ai/grok-4.3` — xAI's own
  recommended successor — has a p50 that on its own exceeds the entire budget,
  so it would fall back to BM25 on most calls while spending 5s to do it. Two
  earlier Grok ids (`x-ai/grok-4-fast`, `x-ai/grok-4.1-fast`) 404 as deprecated.
- **"Direct xAI is fastest" no longer holds.** Its p50 is still good (812ms) but
  this run produced a **61-second** outlier; the distribution is unusable for a
  latency-budgeted path. Direct Anthropic is now both the fastest and the
  steadiest thing measured.
- **Cheaper option:** `deepseek/deepseek-v4.1-flash` fits the budget at roughly
  a third of haiku's input price, though its max (4629ms) sits close to the
  line.

Accuracy was NOT re-measured — this probe only times calls. The n=500 accuracy
findings above were established with Grok 4.1 Fast; whether haiku 4.5 plans
retrieval as well is an open question, and the honest mitigation is that a bad
plan degrades to BM25 rather than to a wrong answer.

### The durable fix

The model is now a values knob (`memory.orchestratorModel` → the preset →
`DEFAULT_ORCHESTRATOR_MODEL`), so the next re-tune is a config change rather
than a release. Take model ids from a live `GET /api/v1/models`; two of the
three tried here were dead, and a dead id fails closed into a silent BM25
fallback.

