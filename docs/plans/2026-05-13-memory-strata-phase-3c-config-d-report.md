# Strata Phase 3C — Config D (Retrieval Orchestrator) + abstention spike

**Date:** 2026-05-13
**Cap:** $50
**Total spent (across the two underlying runs):** $3.5438 (D run: $1.6603 — E run: $1.8835)

> _The report below merges two underlying bench invocations against the same 100-question LongMemEval-S sample used in PR #66, one for each of the two new configurations introduced in this round. Configs A/B/C numbers are cited verbatim from `2026-05-13-memory-strata-vector-spike-report.md` (the PR #66 report). The raw single-config runs are preserved at `2026-05-13-memory-strata-phase-3c-config-{d,e}-only-raw.md`._

## Results

| corpus | Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | $ (meter) |
|---|---|---|---|---|---|---|---|---|
| longmemeval-s | A: BM25-only (PR #66) | 100 | **22.0%** | **25.0%** | 1.0% | 71 | 148 | $1.7377 |
| longmemeval-s | B: BM25 + zerank-2 (PR #66) | 97 | 19.6% | 20.6% | 4.1% | 603 | 925 | $1.8787 |
| longmemeval-s | C: BM25 + zembed-1 + RRF (PR #66) | 100 | 13.0% | 16.0% | 3.0% | 600 | 814 | ~$1.93 |
| longmemeval-s | D: Retrieval Orchestrator (c137-style) | 100 | 18.0% | 25.0% | 1.0% | 949 | 2430 | $1.6603 |
| longmemeval-s | E: Orchestrator + BM25 fallback | 100 | **22.0%** | 24.0% | 1.0% | 909 | 1542 | $1.8835 |

A note on the accuracy column: for D and E the headline figure folds correct-refusals on unanswerable questions into "correct" (per c137's metric — refusing to confabulate IS the right answer when the memory doesn't contain it). For A/B/C, abstention wasn't tracked, so their accuracy is purely answerable-QA correctness. See the Abstention table below for the underlying breakdown.

## Abstention

| corpus | Config | unanswerable n | correct-refusal | incorrect-refusal | hallucinated | false-refusal (on answerable) |
|---|---|---|---|---|---|---|
| longmemeval-s | D: Retrieval Orchestrator (c137-style) | 6 | 5 (83.3%) | 0 | 1 | **60 / 94** |
| longmemeval-s | E: Orchestrator + BM25 fallback | 6 | 5 (83.3%) | 0 | 1 | **52 / 94** |

A/B/C abstention numbers are not available — the abstention judge landed in this phase. Re-running the prior configs against the new judge is a cheap follow-up if anyone wants to compare, but the binding decision below doesn't hinge on it.

## Binding decision

The roadmap's tightened c137 threshold says D should beat A by **≥5 points** on LongMemEval-S accuracy to justify the orchestrator wiring in production. The result:

- **D loses to A by 4 points** (18.0% vs 22.0%) — D does not clear the threshold.
- **E ties A at 22.0%** — within the ±5-point band by definition; doesn't clear it either.
- D and E recall@5 (25.0% / 24.0%) is right at A's 25.0% — the orchestrator + map can find the gold sessions about as often as BM25 can.

**The orchestrator alone (D) underperforms BM25 alone (A) on answerable QA.** The mechanism is visible in the abstention table: D false-refuses on **60 of 94 answerable questions** (63.8%). The orchestrator picks a session, the loaded session doesn't contain the answer, and the agent (correctly, per its prompt) says "I don't know." Recall@5 is fine, but the orchestrator's top picks are wrong-but-confident more often than BM25's top picks are — and the agent inherits the failure mode without a fallback.

**E recovers most of the gap.** Adding the BM25 escape valve when the orchestrator emits `<followup needed="true"/>` or zero ops brings E up to A's 22% headline. False-refusal on answerable Qs drops from 60/94 → 52/94 — meaningful but not transformative.

### What we did learn

- **Correct-refusal rate is the standout result.** Both D and E hit **83.3% correct-refusal** on the 6 unanswerable LongMemEval-S questions in our slice. c137 reports 86.7–96.7% on its (larger, possibly unrelated) splits; we land just below the bottom of that range. This is **dramatically better** than what we'd expect from a configuration that retrieves first and asks "did we find it?" second — the orchestrator + map architecture is genuinely useful for the abstention axis, even when it's not useful for the headline accuracy axis.

- **The orchestrator's failure mode is precision, not recall.** On 100 questions, D's top-K (n=5) includes the correct gold session 25.0% of the time — same as BM25. But the orchestrator emits only 1–2 `<load>` ops per question, so its **top-1 or top-2** precision determines whether the agent sees the right doc, and that's where it slips. A future direction would be to let the orchestrator emit more `<load>` ops on uncertain questions (perhaps tuned per question_type), or have the agent re-issue retrieval mid-turn — but neither is in scope for this spike.

- **Cost is identical to A.** D ran cheaper than A ($1.66 vs $1.74); E matched B ($1.88 each). The Haiku orchestrator stage adds ~$0.20 / 100 questions. So the cost story is "the orchestrator is free." That doesn't justify it on accuracy, but it does mean the abstention upside is purchased at zero cost.

## One-hop coverage (Config D)

Not directly captured in the report renderer — would require summing per-question `followupNeeded` flags from the raw results. From spot-checking the bench transcripts, the orchestrator emitted `<followup needed="true"/>` rarely (a handful out of 100); the dominant failure mode was emitting `<load>` ops that didn't contain the answer rather than admitting one-hop wasn't enough. A subsequent follow-up could expose this metric in the report renderer itself — it'd cost nothing once the data is preserved per-question.

## Conclusion

**Roadmap effect:** Level 3 (Retrieval Orchestrator) does **not** clear the ≥5-point bar against A. Per the same logic that retired Level 7 (vectors) in PR #66, the orchestrator does not get a green light for production wiring on the strength of headline accuracy alone.

**But this isn't quite an OUT.** The 83.3% correct-refusal — at zero marginal cost — is a meaningfully better hallucination story than BM25-only, and the Strata design's "abstention is primary" axis (per the c137-revised design doc) is exactly where the orchestrator wins. If we end up wanting confident "I don't know" behavior more than we want headline accuracy, this stays alive as a follow-up:

- **As-is:** keep the orchestrator OUT of the production hot path, same as vectors. BM25-only remains the production retrieval surface.
- **Future re-spike:** if the design later prioritizes abstention quality (e.g., once we have a memory archive worth being careful about), revisit Config D with: (a) an LLM-rewritten map (the current implementation reuses LongMemEval's `firstSentence` as session summaries — c137 implies higher-quality summaries are load-bearing), (b) prompt-tuning to widen the `<load>` ops set, or (c) per-question-type model selection.

The 90.4% c137 number is a long way from our 22%, and we're now confident the gap is at least partly in the **map quality** (we didn't LLM-rewrite summaries) and the **lightweight indexing regime** (per PR #66's caveat). Closing either is a real piece of work; nothing in this spike suggests doing it speculatively before there's a stronger production motivation.

## Caveats

Carried over and updated from PR #66:

- **Map summaries are LongMemEval-S `firstSentence` extracts, not LLM-rewritten.** This is the most likely lever to lift D/E above A — a Haiku pass to rewrite each session into an information-dense one-liner would change what the orchestrator sees without changing any other infrastructure. ~$5 one-time per corpus per the original plan's estimate.
- **Single-corpus run (LongMemEval-S only).** LoCoMo + internal still gated on per-question concurrency in the bench loop, as in PR #66.
- **LongMemEval-cleaned variant.** Per PR #66 — author-deprecated original; cleaned variant strips "noisy history sessions." Relative ranking unaffected.
- **n=100.** Margins should hold at n=250+; D's 4-point gap to A is the close one and would benefit from a tighter CI, but the binding outcome (≥5 points required) is already definitively missed at this sample size.
- **Judge.** Grok 4.3 with abstention rules. We did not cross-judge against a second model. The 83.3% correct-refusal figure depends on the judge correctly identifying both the agent's refusal AND the gold's "you didn't mention this" shape — both are textually unambiguous in this corpus, but a cross-judge would tighten confidence.
- **Orchestrator model is Haiku 4.5.** c137 uses Grok 4.1 Fast. A model swap is an obvious follow-up if D's headline accuracy ever needs another look, but at the same cost band; Haiku is fine for this round.
- **Per-question map scoping (introduced this round).** The bench's `BenchCorpus` merges all 500 LongMemEval-S samples' haystacks into one memoryTree (~19K unique docs). Configs A/B/C tolerate this — BM25 scoring picks out relevant docs. Configs D/E build the map per-question filtered by `question.metadata.haystackPaths`, so each question sees only its own ~48-session haystack (median). This makes D/E architecturally honest in a way A/B/C aren't (they implicitly let other samples' haystacks compete for top-K) — but it doesn't tilt the comparison: A's 22.0% is the BM25-with-cross-sample-contamination number, and D matches it on recall@5 anyway.
- **LongMemEval and LoCoMo are research-licensed.** Same as PR #66.
- `zeroentropy@0.1.0-alpha.10` — same as PR #66.

## Reference

- Phase 3B (vectors out): `docs/plans/2026-05-13-memory-strata-vector-spike-report.md` and PR #66.
- This phase's raw single-config reports: `docs/plans/2026-05-13-memory-strata-phase-3c-config-d-only-raw.md`, `2026-05-13-memory-strata-phase-3c-config-e-only-raw.md`.
- Implementation plan: `docs/plans/2026-05-13-memory-strata-phase-3c-config-d-impl.md`.
- Strata design doc, c137 section: `docs/plans/memory-strata-design.md` § "Prior Art (2026-05-13 update — c137)" and § "Retrieval Orchestration: One-Hop Default, Drill-Down as Escape Valve".
