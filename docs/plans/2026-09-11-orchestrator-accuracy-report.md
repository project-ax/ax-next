# Orchestrator accuracy — the bench was breaking the thing it measured

**Date:** 2026-09-11 / 2026-09-12
**Corpus:** LongMemEval-S, n=500 (full), the binding axis from the 2026-05-13 round
**Spend:** ~$71 across ten runs (see [Provenance](#provenance))

## Headline

The task was to measure orchestrator accuracy, which had never been measured for any model
we can actually run. The first answer this round produced was wrong, and the reason it was
wrong is the most useful thing in this document.

**The bench showed its planner a different memory map than production does.** The runtime
stores `system/map.md` as `## <category>/` + `- <slug>: ...` and then re-renders it for the
planner's prompt through `renderMapForOrchestrator` — flat and **fully qualified**, which is
the form `<load doc="...">` is matched against. The bench's map string *is* its prompt, and it
imitated the storage form. So the planner was shown ids it could not successfully copy back.

Nothing failed loudly. An unresolvable `<load>` is dropped and the BM25 fallback covers for
it, so every arm still produced a plausible number. What those numbers measured was **which
model guesses an undocumented prefix**.

Corrected, the result is the opposite of the one this report carried in its first draft:

| Config | planner | accuracy | recall@5 | correct-refusal | run $ | planner $ |
|---|---|---|---|---|---|---|
| A: BM25-only | — | 21.2% | 41.8% | 76.7% | $8.99 | — |
| E: Orchestrator + BM25 fallback | `claude-haiku-4-5` (**shipped**) | **33.2%** | **90.8%** | 76.7% | $4.75 | $1.2044 |
| E: Orchestrator + BM25 fallback | `z-ai/glm-5.3-flash:nitro` | **36.0%** | **94.4%** | **83.3%** | $5.16 | **$0.1609** |

**The orchestrator works, and the incumbent was never the problem.** Haiku beats BM25 by
**+12.0pp accuracy (z=4.26) and +49.0pp recall@5 (z=16.4)**. On the broken map the same model
scored 23.0% / 43.8% — statistically tied with BM25 — and a first draft of this report
concluded, wrongly, that the shipped orchestrator was a no-op.

## What the broken map cost

Same 40 questions, same models, only the map format changed:

| | planner returned nothing | recall@5 |
|---|---|---|
| haiku, storage-form map | **80.0%** | 40.0% |
| haiku, faithful map | 2.5% | **92.5%** |
| glm, storage-form map | 20.0% | 82.5% |
| glm, faithful map | 0.0% | **92.5%** |

Haiku lost four out of five plans to a missing `episodes/` prefix. It was picking the *same
documents* GLM picked — on question `6ade9755` both named `answer_9398da02`; GLM wrote
`episodes/answer_9398da02` and haiku wrote `answer_9398da02`. One resolved and one was
discarded in silence.

At n=500 the repair is worth **+10.2pp accuracy and +47.0pp recall@5** to haiku, and it makes
the arm *cheaper* ($9.91 → $4.75): a planner whose ops resolve loads 2–3 targeted docs instead
of falling through to BM25's ten, so the answer prompt shrinks.

## Model choice

| comparison | Δ accuracy | z | Δ recall@5 | z |
|---|---|---|---|---|
| A → E-haiku | +12.0pp | 4.26 | +49.0pp | 16.39 |
| A → E-glm | +14.8pp | 5.18 | +52.6pp | 17.84 |
| E-haiku → E-glm | +2.8pp | 0.93 (**ns**) | +3.6pp | 2.17 |

**On accuracy the two planners are tied** (+2.8pp, z=0.93). GLM takes recall@5 by a small but
real margin, and correct-refusal by 6.6pp. The planner line item is 7.5× cheaper on GLM
($0.16 vs $1.20 per 500 questions) — but that is not the whole bill: GLM requests a followup on
34.6% of questions against haiku's 2.2%, so it falls back to BM25 more, its answer prompt runs
**60% larger** (1.26M vs 784k input tokens), and its *run* total is higher ($5.16 vs $4.75).

**Recommendation: keep `anthropic/claude-haiku-4.5` as the default.** Accuracy is tied, the
whole-run cost is lower, and the documented reason it was chosen — a reproducible latency tail
against a 5s budget with a silent fallback, where GLM's p95 moved 1443 → 2758 → 4133ms across
runs — still stands and is not contradicted by anything here. A first draft of this report
recommended switching; that recommendation is withdrawn.

GLM remains the better pick for a surface that weights abstention (83.3% vs 76.7%
correct-refusal) or one where the planner's own token bill dominates.

## Against the historical record

The 2026-05-13 round reported E + Grok + rewritten map at 28.2% / 56.0%, "+7.6pp / +14.2pp
over BM25", and that headline has been quoted since despite its model id having been dead for
months (#515). Those runs used the same storage-form map, so **they were understated too** —
Grok was losing plans to the same prefix. The corrected architecture delta is roughly double
what was claimed: **+12 to +14.8pp accuracy, +49 to +52.6pp recall@5**. The May conclusion
(architecture works; map quality is load-bearing) was right, and more right than it knew.

## A second methodology defect: `--sample N` is a prefix, not a sample

LongMemEval-S is ordered by `question_type`. `--sample 40` returns 40 `single-session-user`
questions and nothing else; `--sample 100` gets 70 single-session + 30 multi-session. Every
small-n run in this repo's history therefore measured a type-biased slice — including the
n=100 rounds the May report calls misleading, which now have a concrete mechanism for having
misled. The n=500 runs here are the full corpus and are unaffected. **Not fixed in this
branch** — flagged, because fixing it changes the meaning of a flag other reports were
written against.

## Caveats

- **Accuracy at n=40 is unusable** for anything but the mechanistic plan-shape metrics, both
  because of the prefix defect above and because ±6pp is one question. The n=40 tables here
  are read only for "did the planner's ops resolve".
- **Latency in the first round's raw reports is contaminated** — six bench processes ran
  concurrently (see Provenance). The faithful runs were two-at-a-time, and their p50s (930ms
  haiku, 655ms GLM) are closer to real but still not a clean latency measurement. The
  `bench:latency` probe remains the instrument for that.
- **GLM emits a few reasoning tokens at `effort: 'minimal'`** — 8–34 on ~20% of calls. The
  flag is honored (the unflagged control measures p50 ~3.4s); the provider just doesn't floor
  to zero.
- **The map-rewrite cache is Grok-authored and four months old.** Both E arms consumed the
  same 19,195 summaries, which is what holds map quality fixed across arms — and leaves
  "densified by the model that will run in production" unmeasured.
- **The bench still isn't production.** This round fixed one divergence by delegating to the
  runtime's renderer, and found a second while writing the test: the bench's corpora use the
  category `episodes`, which the runtime's `parseDocId` allow-list does not contain. Harmless
  here (the bench resolves against its own `memoryTree`) but it is the same class of drift.
- Unpaired z-tests; the bench does not dump per-question verdicts. Pairing narrows intervals
  rather than widening them, so the significant results stay significant.

## Provenance

Ten n=500-equivalent runs, ~$71, and two process errors worth recording:

1. **Every arm in the first round ran twice** (~$50 instead of ~$25). A detached batch was
   misdiagnosed as dead — the `ps` pattern used to check it did not match the real cmdline —
   and a second batch was launched over the top. Both completed and wrote to the same `--out`
   paths. Accuracy and recall were unaffected (each file is one complete independent run);
   latency was not.
2. **That entire first round then had to be discarded anyway** for the map-format defect, and
   re-run. The contaminated reports are kept as
   `2026-09-11-orchestrator-accuracy-e-*-BROKEN-MAP-raw.md` — they are the evidence for the
   "what the broken map cost" table and should not be read as results.

The A arm needed no re-run: it has no planner, so the map format cannot reach it.

## Follow-ups

1. **Nothing to change in the runtime.** The shipped orchestrator and default model are both
   vindicated. This branch changes only the bench and the docs.
2. **Fix `--sample` to stratify** (or rename it `--first`), and re-read any small-n conclusion
   in `docs/plans/` in that light.
3. **Chase the answer stage.** E-glm now retrieves gold into the top 5 on 94.4% of questions
   and answers 36.0% correctly. Retrieval is emphatically no longer the bottleneck; ~58 points
   are lost after it. `MAX_INJECTED_BODY_CHARS = 2000` is the first suspect.
4. **Re-run the map rewrite with the production planner** — the last variable still held at
   its May value.
