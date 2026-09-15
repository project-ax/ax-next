# Un-truncating the map bought nothing (TASK-362)

**Question:** the map's summary cap cut 59-90% of its lines off mid-word. The
answer stage's body cap had the same disease and raising it was worth **+24pp**.
Does the map cap cost accuracy the same way?

**Answer: no.** Removing truncation entirely moved nothing.

**Design:** one variable. Same rewriter (GLM 5.3 Flash), same planner, same 150
stratified questions, same 20,000-char answer-stage cap. Only the map summary cut
moved, 120 → 400. The prompt budget stayed at 120 deliberately, so this measures
*stop mutilating the line* and not *write a denser line*.

**Spend:** $7.85 for the arm, plus $7.03 to regenerate the map at the new cut.

---

## The result

| | GLM map @ cut 120 | GLM map @ cut 400 | Δ | |
|---|---|---|---|---|
| lines cut mid-word | 17,267 (**90.0%**) | 3 (**0.0%**) | — | the intervention landed |
| **accuracy** | 55.3% | 52.0% | −3.3pp | z=−0.58, **p=0.56** |
| recall@5 | 88.0% | 89.3% | +1.3pp | z=+0.36, p=0.72 |
| fell back to BM25 | 22.7% | 27.3% | | |
| followup requested | 31.3% | 37.3% | | |

The intervention unambiguously worked on the *map* — 90.0% of lines truncated
became 0.0%, with p50 length 120 → 159 and max 400. It moved the measurement not
at all. This is a clean negative result, not an underpowered one: the point
estimate is slightly **negative**, so there is no direction here to chase with a
bigger n.

## Why the body cap mattered and this one doesn't

The two caps look alike and are not. It comes down to one number that was already
in every report: **recall@5 was 88-93% in every orchestrator arm.**

- The **body** cap starved the *answer* stage. Retrieval was finding the right
  document and the agent was being shown the first 14% of it — on 17% of
  questions every gold answer token sat past the cut. The evidence was absent, so
  the agent refused. Restoring it was worth +24pp and collapsed false refusal
  51% → 19.6%.
- The **map** cap only affects *selection*, and selection was already close to
  its ceiling. A map line is a routing label, not evidence: once the planner
  picks a document, the full body is injected up to 20,000 chars. A truncated but
  topical line routes about as well as a complete one — "User is curious about
  marine biology—mussel predator defen…" gets the planner to the same document as
  the whole sentence would.

So the lever is not map fidelity. **With recall at ~90%, the remaining errors are
downstream of retrieval**, which is exactly what the temporal-reasoning triage
found independently: the failures are the agent picking the wrong event among
retrieved candidates, doing date arithmetic wrong, or the specific value never
having been extracted into memory at all.

## All three map variants, and what to conclude

| map | accuracy | recall@5 | dead lines | cut lines |
|---|---|---|---|---|
| **Grok @120** (May, the published baseline) | **63.3%** | 92.7% | 13.6% | 59.3% |
| GLM @120 | 55.3% | 88.0% | 0.3% | 90.0% |
| GLM @400 | 52.0% | 89.3% | 0.1% | 0.0% |

Pairwise, with three comparisons the Bonferroni threshold is α=0.0167:

| | Δ | p | |
|---|---|---|---|
| Grok@120 → GLM@120 | −8.0pp | 0.158 | not significant |
| Grok@120 → GLM@400 | −11.3pp | **0.047** | not significant after correction |
| GLM@120 → GLM@400 | −3.3pp | 0.563 | not significant |

**No map variant is distinguishable from another at this n.** The awkward part is
the trend: the *original* Grok map, the one with 13.6% unselectable lines and
59.3% truncation, scores highest — and the two properties anyone would fix first
were fixed (45× fewer dead lines, then truncation eliminated) without the number
moving up. Do not read −11.3pp as a finding; do read it as "the map properties we
know how to measure are not what separates these arms."

## What this buys

A negative result for ~$15 that stops a much larger investment. "Map quality is
the lever the whole c137 design rests on" is the premise the handoff carried
into step 3; across three maps spanning 13.6%→0.1% dead lines and 90%→0% mid-word
truncation, **the accuracy spread is inside the noise floor.** Densifying the map
further is not where the next point comes from, and TASK-361 (where the specific
value is lost — extraction or consolidation) is better motivated than ever.

## What was NOT tested

Raising the prompt **budget** — asking the rewriter for longer, denser lines
rather than merely declining to cut them. The probe says that is a real knob (asked
≤400 the model writes p50 279 vs 157 at ≤120). It is a different intervention and
this run holds it fixed at 120 on purpose. Given that un-truncating did nothing
and dead lines did nothing, the prior for density being the missing lever is
weak, and it should not be run without a reason beyond "we have not tried it".
