# Jev fact links on all 500 questions — pre-registration

**Written 2026-09-28, before any answer in this run exists.** This fixes the question, the
design, the metric and the decision rule, so the result cannot choose them. Any deviation
from it gets reported as a deviation.

**Question:** do Jev fact links, shown as notes in `memory_recall`'s evidence table, improve
DEM's *overall* answer accuracy on LongMemEval-S, for GLM and for DeepSeek?

Background: `2026-09-28-dem-jev-fact-links-report.md`. The unforked n=100 run saw +3 for both
models; where a note reached the model, 4 answers were fixed and 0 broken over 36 pairs. That
is too small to separate from noise.

## Materials

- **Stores:** one per question, all 500, built by `scripts/memory-bench-build-banks.mjs`
  through the product's memory slice (extraction `z-ai/glm-5.3-flash:nitro`, embeddings
  `google/gemini-embedding-001:nitro`). Stored at `~/ax-bench-data/dem-lme500/`.
- **Links:** `dem-memory/bench/fact-links-eval.ts --complete-only --k 6 --lexical-k 6
  --min-cosine 0.8`, one Jev (`typesafe/jev-1.13`) choice per pair, **threshold 0.8**.
  - The lexical channel is new in this run. Under the new embedder the sneakers update pair
    ranks 12th by cosine, so vector neighbours alone miss it; shared rare words catch it
    (checked on one rebuilt store).
- **Answer models:**
  - GLM: `z-ai/glm-5.3-flash:nitro`, minimal reasoning, 512 tokens (rung-4's config).
  - DeepSeek: `deepseek/deepseek-v4.1-flash`, minimal reasoning, 2,048 tokens, pinned to
    the first-party `DeepSeek` provider.
- **Judge:** `x-ai/grok-4.3` with the rung-4 rubric.

## Gate before answering: link precision on the new stores

The earlier 28/28 was measured on different facts. Before any answer is run, I (Claude) label a
seeded sample of **60 links at p ≥ 0.8** from the new stores, using the same rule as before.
**Proceed only if strict precision is ≥ 90% (54/60).** Otherwise stop and report; no answer arm.

## Design: forked, repeated, paired

- Each (question, model) is answered **3 times**, each on a fresh copy of that question's
  store.
- Each answer runs `off` until the first `memory_recall` whose result would carry a note.
  There it **forks**: one branch continues with the plain tool text, one with the annotated
  text, from the identical prefix.
- A run that never reaches a note is unaffected by construction. It is answered and judged
  once and counts as 0 change.
- Code: `scripts/memory-fact-links-e2e.mjs --all --fork 3`; the fork logic is
  `answerForked` in `scripts/memory-fact-links-lib.mjs`, with tests.

**Why 3 repeats.** In the unforked run ~18% of questions saw a note, and the fixed-to-broken
rate there was about 11% (4/36). If that holds, the expected overall effect is about
+2 points. With forking, only post-fork sampling adds noise, and 3 repeats over 500 questions
give ~270 forked runs per model, enough to put a 95% interval of roughly ±1.5 points around
+2. Five repeats would cost ~$30 of answering against ~$18 for three, for a modest gain in
precision.

## Metrics and decision rule

- **Primary, per model:** the change in overall accuracy, *on − off*, averaged over every
  (question, repeat), with unforked runs contributing 0. The 95% interval comes from a
  bootstrap that resamples **questions** (4,000 resamples).
  - **"Improves" for a model** means the interval's lower bound is above 0.
  - **"Harms"** means the upper bound is below 0.
  - Anything else is **"no detectable effect"**, reported with the interval.
- **Secondary:** the same change within knowledge-update and within multi-session; the counts
  of forked runs that gained and lost; and the fork rate.
- **Harm check:** every forked run that lost gets its answers read and its cause stated.
- **Judge noise:** 100 randomly chosen answers from the run are re-judged once. The flip rate
  gets reported beside the result as a floor on what the judge alone can move.

## Stop rules

- Spend cap: $40 for answering and judging, and $15 for links. A shard that hits its cap stops;
  the run reports on what finished and says so.
- If the link-precision gate fails, stop before answering.

## What this will not show

- Accuracy against rung 4's numbers. The stores, embedder and reranker all differ; only each
  model's own on-vs-off comparison is the measurement.
- Anything about a product version of links (a link store, UI). That comes after, and only if
  this says "improves".
