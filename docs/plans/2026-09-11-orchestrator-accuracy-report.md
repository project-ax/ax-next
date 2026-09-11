# Orchestrator accuracy — the incumbent measured at last, and a new default

**Date:** 2026-09-11
**Corpus:** LongMemEval-S, n=500 (full), the binding axis from the 2026-05-13 round
**Spend:** $50.07 across six runs (see [Provenance](#provenance) — every arm ran twice)

## Headline

Two claims have been load-bearing in this repo since May, and neither survives measurement:

1. **"The orchestrator beats BM25 by +7.6pp accuracy / +14.2pp recall@5."** That figure was
   measured against `x-ai/grok-4.1-fast`, an id that has been 404ing for months (#515). It
   does not transfer to either model we can actually run today.
2. **The incumbent orchestrator model — Haiku — had never been measured at n=500 at all.**
   Measured now, **it does not beat BM25 on accuracy**: 23.0% vs 21.2%, a +1.8pp delta that
   is statistically indistinguishable from zero (z=0.69). Recall@5 is the same story
   (+1.8pp, z=0.58). On the two headline axes, the orchestrator we ship has been a
   no-op against plain BM25.

The new result is that **the replacement model is not a like-for-like swap — it is a large
accuracy win**, and it is the first configuration to clear the ≥5-point bar on live models:

**`z-ai/glm-5.3-flash:nitro` + minimal reasoning: 32.4% accuracy, 77.2% recall@5** —
**+11.2pp accuracy and +35.4pp recall@5 over BM25**, and +9.4pp / +33.6pp over the
incumbent. It also beats the retired Grok configuration's best-ever numbers (28.2% / 56.0%),
while costing ~37% less per run than Haiku.

## Results

| Config | orchestrator model | n | accuracy | recall@5 | correct-refusal | $ |
|---|---|---|---|---|---|---|
| A: BM25-only | — | 500 | 21.2% | 41.8% | 76.7% | $8.99 |
| E: Orchestrator + BM25 fallback | `claude-haiku-4-5-20251001` | 500 | 23.0% | 43.8% | **86.7%** | $9.91 |
| E: Orchestrator + BM25 fallback | `z-ai/glm-5.3-flash:nitro` | 500 | **32.4%** | **77.2%** | 73.3% | $6.24 |

Historical rows for context (2026-05-13 report, all against the now-dead Grok id):

| Config | orchestrator model | n | accuracy | recall@5 |
|---|---|---|---|---|
| A: BM25-only (May) | — | 500 | 20.6% | 41.8% |
| E + LLM-rewritten map (May) | `x-ai/grok-4.1-fast` | 482 | 28.2% | 56.0% |

**The May baseline reproduces exactly.** A's recall@5 is 41.8% in both rounds — BM25 is
deterministic, so an identical figure four months later is the check that says the corpus,
retrieval path, and scoring are unchanged, and that today's E rows are comparable to the
historical ones. A's accuracy moved 20.6% → 21.2%, which is answer/judge nondeterminism.

### Significance

Unpaired two-proportion z-tests at n=500 (a paired McNemar's on the same question set would
be strictly stronger; the bench does not currently dump per-question verdicts):

| comparison | Δ accuracy | z | verdict |
|---|---|---|---|
| A → E-haiku | +1.8pp | 0.69 | **not significant** |
| A → E-glm | +11.2pp | 4.00 | significant (p < 0.0001) |
| E-haiku → E-glm | +9.4pp | 3.32 | significant (p < 0.001) |

| comparison | Δ recall@5 | z | verdict |
|---|---|---|---|
| A → E-haiku | +1.8pp | 0.58 | **not significant** |
| A → E-glm | +35.4pp | 11.40 | significant |
| E-haiku → E-glm | +33.6pp | 10.86 | significant |

## Abstention

| Config | unanswerable n | correct-refusal | hallucinated | false-refusal (answerable) |
|---|---|---|---|---|
| A: BM25-only | 30 | 23 (76.7%) | 7 | 273 / 470 (58.1%) |
| E-haiku | 30 | 26 (**86.7%**) | 4 | 267 / 470 (56.8%) |
| E-glm | 30 | 22 (73.3%) | 8 | **232 / 470 (49.4%)** |

This is the one axis where Haiku is genuinely the best of the three: 86.7% correct-refusal is
the highest figure ever recorded on this corpus, and the fewest hallucinations on unanswerable
questions (4). It is a real property, and it is worth naming plainly because it is the only
thing the incumbent does better than plain BM25.

GLM trades some of that away (73.3%, below even BM25's 76.7%) — it is more willing to answer.
That same willingness is why its false-refusal rate on *answerable* questions is the lowest of
the three by a wide margin (49.4% vs 56.8% / 58.1%): it finds the content and uses it. With
n=30 unanswerable questions, the correct-refusal column moves ±3.3pp per question, so the
73.3% vs 76.7% gap is one question wide and should not be over-read. The false-refusal column
(n=470) is the sturdier of the two.

## What this settles, and what it doesn't

**Settled:** the orchestrator architecture works, but *entirely* through the model in the
planner slot. Same code, same map, same corpus, same agent, same judge — swapping only the
orchestrator model moves accuracy 23.0% → 32.4% and recall@5 43.8% → 77.2%. The architecture
was never the variable; the planner's quality was, exactly as c137's premise predicted and as
the May round already suspected when Haiku-as-orchestrator misled the original n=100 binding.

**Settled:** GLM + minimal reasoning is the default to ship. It wins on accuracy, wins
decisively on recall, and costs less ($6.24 vs $9.91 per 500-question run — the orchestrator
line item, not the agent's).

**Not settled — the bottleneck has moved.** E-glm retrieves the gold document into the top 5
on **77.2%** of questions but only answers **32.4%** correctly. Retrieval is no longer the
limiting stage: roughly 45 points of correct-context is being dropped somewhere after it. The
bench's answer stage truncates every injected body to 2000 chars (`MAX_INJECTED_BODY_CHARS`)
and caps the answer at 512 tokens, which is the first place to look. Until that gap is
understood, further orchestrator tuning is optimizing the stage that is already winning.

**Not settled — latency.** See caveats.

## Caveats

- **The latency columns in the raw reports are not usable.** Six bench processes ran
  concurrently against the same APIs (see Provenance), so every p50/p95 in this round reflects
  self-inflicted queueing, not model speed. The clean figure for GLM is the one from the
  single-process n=3 smoke and the TASK-349 latency probe: **p50 ~865ms**, against the
  orchestrator's 5s budget. Treat this round's 13035ms p95 for E-glm as an artifact.
- **GLM emits a few reasoning tokens even at `effort: 'minimal'`.** 97 of 500 calls logged
  `reasoning_tokens` between 13 and 34. The flag is being honored (the control arm measured
  ~3.4s p50 without it); the provider simply does not floor to zero. Not material at this size,
  but the bench's warning text reads as an alarm and will keep firing.
- **The map-rewrite cache is Grok-authored and four months old.** Both E arms consumed the
  same 19,195 LLM-rewritten summaries written in May by the now-dead model. That is the
  correct choice for this comparison — it holds map quality fixed so the orchestrator model is
  the only variable — but it means "E-glm with a GLM-rewritten map" is an unmeasured and
  plausibly better configuration.
- **Judge nondeterminism** is visible in A's 20.6% → 21.2% drift on identical retrieval. Read
  sub-2pp accuracy deltas as noise; that is why E-haiku's +1.8pp is reported as a null result
  rather than a small win.
- Unpaired z-tests are used above because the bench does not dump per-question verdicts.
  Pairing would narrow the intervals, not widen them, so the significant results stay
  significant.

## Provenance

Every arm ran **twice**. The first batch was launched detached, misdiagnosed as dead (the
`ps` pattern used to check did not match the real process cmdline), and a second batch was
launched over the top of it; both completed and both wrote to the same `--out` paths, so for
each arm the file on disk is whichever finished last. Consequences, stated plainly:

- **Spend was $50.07, roughly double what the run needed.**
- **Accuracy and recall are unaffected.** Each report file is one complete, independent
  500-question run; nothing is averaged or interleaved.
- **Latency is affected** (six-way concurrency — see caveats).
- One accidental benefit: E-haiku was measured twice and both runs are known. Accuracy
  **23.0% in both**; recall@5 43.6% vs 43.8%. Run-to-run noise on this harness is ~0.2pp on
  recall, ~0pp on accuracy at n=500 — which is itself the tightest reproducibility estimate
  we have.

Raw per-arm reports carry the `**Orchestrator model:**` header stamp added in this branch, so
each one says which model produced it — the thing whose absence let a dead model id headline
this repo for four months.

## Recommended follow-ups

1. **Switch the shipped orchestrator default to `z-ai/glm-5.3-flash:nitro` + minimal
   reasoning.** The runtime path (TASK-191) still selects the incumbent.
2. **Correct the stale claims in place.** `docs/plans/memory-strata-design.md` and
   `.claude/memory/decisions.md` still advertise +7.6pp / +14.2pp as live findings.
3. **Chase the 77.2% → 32.4% gap.** Almost certainly the highest-value open question in
   Strata right now, and it is an answer-stage question, not a retrieval one.
4. **Re-run the map rewrite with GLM** and re-measure E-glm — the last held-fixed variable.
