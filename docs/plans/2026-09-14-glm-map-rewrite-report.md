# The GLM-authored map did not beat the Grok one

**Answers:** step 3 of `2026-09-14-orchestrator-glm-handoff.md` — "re-run the map
rewrite with the production planner", which it flagged as *not a footnote*
because map quality is the lever the c137 design rests on.
**Design:** one variable. Same planner (GLM 5.3 Flash, minimal reasoning), same
150 stratified questions, same 20,000-char answer-stage cap, same 120-char map
summary cap. Only the model that **authored** the map changed.
**Spend:** $7.45 for the measurement, plus ~$7.6 to regenerate the map (estimated
— that path was unmetered at the time, which is fixed in `90a64675`).

---

## The headline is a non-result, and it should be reported as one

| | Grok map (May) | GLM map (new) | Δ | |
|---|---|---|---|---|
| **accuracy** | **63.3%** | **55.3%** | −8.0pp | z=−1.41, **p=0.16** |
| recall@5 | 92.7% | 88.0% | −4.7pp | z=−1.37, p=0.17 |

**Neither difference is significant at n=150.** The honest statement is *"the
GLM-authored map did not improve on the Grok one"* — not *"it is 8 points
worse"*. For scale, step 1's A→E effect on the identical question set was
+32.7pp at z=5.67; this is a quarter the size with a tenth the confidence.

That matters because the trend points the *opposite* way from the obvious
expectation. GLM writes a visibly better map by the one property anyone would
check first — see below — and it still didn't win. Quoting −8pp as a finding
would be reading noise as a reversal.

## What did move, and it is not small

The planner's *behaviour* changed far more than its accuracy:

| | Grok map | GLM map |
|---|---|---|
| fell back to BM25 | 30.0% | **22.7%** |
| followup requested | 42.0% | **31.3%** |
| planner returned nothing | 0.7% | **0.0%** |
| retrieval p50 / p95 | 2,525 / 15,229 ms | **741 / 2,130 ms** |

The planner became **decisively more confident and 3.4× faster at p50** (7× at
p95) — it asked for fewer follow-ups, fell back to BM25 less, and never returned
an empty plan. Accuracy did not follow. *More decisive, not more correct* is the
result, and it has a candidate mechanism below.

## Why GLM's map ought to have won

Two properties of the map itself, measured with `bench:diag-map-truncation`
across all 19,195 entries:

| | Grok map | GLM map |
|---|---|---|
| lines with no selectable content | 2,617 (**13.6%**) | 51 (**0.3%**) |
| lines cut off mid-word at the 120 cap | 11,376 (59.3%) | 17,267 (**90.0%**) |

> **Corrected 2026-09-14.** This row first read 16.1% vs 3.8%, from a metric that
> simply searched for "no personal details". That overcounts: a rewriter with
> room writes informative lines that merely END with the clause. The corrected
> rule strips the clause and asks whether anything substantive remains
> (`isDeadLine`). The gap is **45×, not 4×** — the original numbers understated
> GLM's advantage, which sharpens rather than softens the puzzle below.

A line reading "No personal details shared by user" is **unselectable** — the
planner cannot route a question to that document at all. Grok emitted 2,617 of
them, so roughly **one document in seven was unreachable via the map in every
previously published E measurement**. GLM cuts that by **45×**, and the
replacements are substantive:

> **Grok:** "No personal details shared by user."
> **GLM:** "User is curious about marine biology—mussel predator defenses and
> toxins; finds toxin ecology \"really cool.\""

That is the improvement the decisiveness numbers are showing. It did not convert
into accuracy.

## The most likely reason, and it is testable

**GLM's map is 90.0% truncated where Grok's is 59.3%.** GLM writes longer — asked
for ≤120 chars it returns p50 157, p95 243, max 346, overshooting on 88% of
documents — so the same 120-char cap that trims Grok's lines *mutilates* GLM's.
`bench:diag-map-truncation --probe 60` measures **28.1% of the characters GLM
produces being discarded at the cut**.

So the two changes fought each other: **45× fewer dead entries** against 1.5×
more mutilated ones. That is consistent with everything above — a planner given
confident-looking but truncated lines commits faster (fewer follow-ups, fewer
fallbacks) on a weaker basis.

**This is a hypothesis, not a conclusion.** TASK-362 tests it directly by holding
the map's author fixed and moving only the cut: GLM map at 120 (this run, 55.3%)
versus GLM map at 400, where nothing GLM writes is cut at all (measured: 3 cut
lines out of 19,195, and 18 dead). If truncation is the explanation, that arm
should clear both numbers in this report.

## What not to conclude

- **Do not retire the Grok map on this.** The published E numbers were measured
  against it and it is preserved at
  `~/.cache/ax-memory-bench/longmemeval-s/map-rewrites.grok-may.json`.
- **Do not conclude the rewriter model does not matter.** The map properties
  moved enormously; only accuracy didn't, at a sample size that cannot resolve
  8 points. The instrument, not the lever, is the limit here.
- **n=150 resolves ~±11pp at this accuracy level.** If the map-author question
  needs a real answer after TASK-362, it needs a larger n, and the cost table in
  the handoff says what that costs.
