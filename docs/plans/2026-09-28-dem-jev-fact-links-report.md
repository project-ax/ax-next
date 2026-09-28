# DEM fact links with Jev

**Date:** 2026-09-28
**Question:** DEM's rung-4 knowledge-update and counting failures are pairs of stored facts
that nothing links. Can Jev link them — "B **updates** A", "same event" — precisely enough to
be worth an answer-level test?
**Code:** `dem-memory/bench/fact-links.ts` (question, request, candidate pairs; pinned by
`tests/fact-links.test.ts`), `dem-memory/bench/fact-links-eval.ts` (the run),
`dem-memory/bench/fact-link-labels.json` (120 hand labels). Measurement only; nothing under
`packages/` changed, and the banks are opened read-only.
**Cost:** phase 1 $0.68 (29,573 Jev calls); phase 2 $2.41, plus $0.35 of abandoned `max`-reasoning rows.
**Artifacts:** phase-2 rows, ledgers and manifest in `~/.cache/ax-memory-bench/fact-links-run-2026-09-28/`.

## Verdict

**Phase 1 passes.** At a threshold of **0.8**, every labelled link is correct: **28/28**
(20 `updates`, 8 `same_event`). At 0.7 precision is **90.4%** (47/52), and `same_event` is
still 17/17. Of the 9 rung-4 failure pairs, all 9 get the right label. 8 clear 0.7 and 6 clear
0.8; the miss is the follower-count pair, whose two facts carry the same date (p 0.49).

This is the opposite of the slot-normalizer result
(`2026-09-28-dem-jev-normalizer-report.md`: no clean threshold with coverage). The difference
is the question. Naming a profile slot from a relation alone asks Jev to guess. Comparing two
concrete facts with both values in view is a judgement it makes well.

**Phase 2 (answers): the links help where they reach the model and have not hurt a single
answer. The effect is too small to show at n=100.** Across 36 question pairs where a link
note reached the model, 4 wrong answers became right and 0 right answers became wrong. The
totals move +3 for each model (GLM 74 → 77, DeepSeek 76 → 79), but that is inside this
benchmark's noise, and the untouched pairs flip just as often by chance.

## Why this, and why now

The rung-4 product run (`2026-09-22-dem-rung4-product-report.md`) got 84 / 81 of 100 right.
Traced back to each bank's `facts.db`:

- **All 6 knowledge-update questions that failed (7 wrong answers) had both values stored,
  under different relations, unlinked.** `egg_stock` 30 dozen → `has_egg_stock` 20 dozen,
  Kauai → Oahu, three → five H&M tops, a 5K best of 27:12 → 25:50,
  `has_instagram_followers` 1250 → `has_follower_count` ~1300. None is one of the 8 profile
  slots, so no slot normalizer could ever have closed them. Knowledge-update was the weakest
  type with a real sample (80% / 73%).
- **One counting failure was duplication.** One sourdough loaf and one chocolate cake were each
  stored twice from two sessions, giving 6 bake rows for a gold count of 4. Sonnet said 6, GLM 5.

A link must be an **annotation, never a closure**. `07741c44` asks where the sneakers were
*initially* kept, and hiding the older fact would break that answer.

## Method

- **Stores:** the 100 rung-4 banks (`~/.cache/ax-memory-bench/task497-banks`): 32,486
  active facts, 12,364 about the user, 86.8% of all facts with a stored vector. Facts without a
  vector get no candidates, so the link rate is a floor.
- **Candidates**, as a write-time pass would see them: each user fact B against its **6
  nearest earlier** same-subject facts, cosine ≥ 0.8, giving 29,576 pairs (~2.4 per fact).
  Fact-to-fact cosines run high in this space; floors below 0.8 prune almost nothing. With
  these settings every failure pair is a candidate, 7 of 9 as B's single nearest earlier fact
  (the sneakers pair ranks 6th, hence k = 6).
- **Question:** one Jev `choice` per pair over `{A, B}` = `{when (date), about, relation,
  value}`. The options are `updates` / `same_event` / `both_true`, with the criteria in
  `LINK_QUESTION`.
- **Labels:** a seeded uniform sample of 120 of the 312 links at p ≥ 0.5, **labelled by
  Claude, not a human**. `updates` counts as correct only if B makes A no longer current;
  `same_event` only if both describe one event or item. Judgement calls are marked `arguable`,
  and the lenient column counts them as correct.

## Results

Link rate over 29,576 candidate pairs (12,364 user facts):

| threshold | `updates` | `same_event` | facts with any link |
|---|---|---|---|
| 0.5 | 201 | 111 | 272 (2.2%) |
| 0.6 | 138 | 78 | 199 (1.6%) |
| 0.7 | 83 | 48 | 122 (1.0%) |
| **0.8** | 46 | 30 | 69 (0.6%) |
| 0.9 | 17 | 19 | 34 (0.3%) |

Jev is conservative. 98.9% of candidate pairs are answered `both_true` or sit below 0.5, which
is the safe direction.

Precision on the labelled sample:

| threshold | labelled | strict | lenient | `updates` strict | `same_event` strict |
|---|---|---|---|---|---|
| 0.5 | 120 | 74.2% | 85.0% | 64.2% | 94.9% |
| 0.6 | 84 | 83.3% | 91.7% | 75.5% | 96.8% |
| 0.7 | 52 | 90.4% | 94.2% | 85.7% | 100% |
| **0.8** | 28 | **100%** | 100% | 20/20 | 8/8 |
| 0.9 | 17 | 100% | 100% | 11/11 | 6/6 |

28/28 is a sample of the 76 links at ≥ 0.8. A clean sample of 28 still leaves the true rate
plausibly as low as ~88%.

**What the wrong links look like** (all below 0.8): two plans for different trips
(`domestic trip` → `Japan trip`), a past event against a current state (`carb_loaded_at` →
`cutting_back_on_carbs`), a fact and a stronger fact that are both true (`dislikes cheese` →
`allergic to cheese`), and the persona again (`Principal Data Scientist` → a "Senior Data
Analyst" persona, 0.50).

**The known failure pairs:**

| question | pair | Jev |
|---|---|---|
| ed4ddc30 | `egg_stock` → `has_egg_stock` | updates 0.94 |
| 4b24c848 | `bought_items` → `owns_tops_from_hm` | updates 0.94 |
| 07741c44 | `stores_sneakers` → `plans_to_organize` | updates 0.84 |
| eace081b | `planning_trip` → `planning_birthday_trip` | updates 0.82 |
| 6a1eabeb | `achieved_personal_best` → `training_for_charity_5k` | updates 0.74 |
| a2f3aa27 | `has_instagram_followers` → `has_follower_count` | updates **0.49** — same date, so no order to go on |
| 0a995998 | `exchanged_boots_at_zara` ↔ `has_pending_pickup` | same_event 0.97 |
| 88432d0a | chocolate cake ×2 | same_event 0.93 |
| 88432d0a | dense sourdough ×2 | same_event 0.79 |

The follower pair isn't a Jev problem. Both facts carry the session date with no time of day,
so nothing says which came last. Keeping the within-day order (the store's `transaction_time`,
or the time of day) is a separate, deterministic fix.

## Phase 2 — do the links change answers?

**Design.** The 100 rung-4 questions, each answered twice from the same store: once with
`memory_recall`'s result exactly as the product renders it (`off`), once with link notes added
(`on`), using the 76 links at p ≥ 0.8 (`dem-memory/bench/fact-links.json`). A note sits on
every evidence row that is one end of a link, and names the other end, so a link can surface a
value retrieval missed. A one-line legend goes above the table when any note is present. Two
answer models, each paired against itself; grok-4.3 judges, as in rung 4. Code:
`scripts/memory-fact-links-e2e.mjs` (pure parts in `memory-fact-links-lib.mjs`, tests in
`scripts/__tests__/memory-fact-links.test.js`). Nothing under `packages/` changed.

| model | configuration |
|---|---|
| GLM | `z-ai/glm-5.3-flash:nitro`, minimal reasoning, 512 tokens (rung-4's answer config) |
| DeepSeek | `deepseek/deepseek-v4.1-flash`, **minimal** reasoning, 2,048 tokens, pinned to the first-party `DeepSeek` provider |

DeepSeek started at `max` reasoning. It averaged ~2,800 reasoning tokens per answer (too slow
for a chat turn), so it was stopped after 137 rows and re-run at minimal. The partial `max`
rows are archived beside the results and not counted (104/137 correct).

**Stores.** Each question's rung-4 store was copied, then **re-embedded** under the current
embedder (TASK-523's OpenRouter `gemini-embedding-001`). The store deletes the old Vertex
vectors on open, and without re-embedding the dense channel would silently be empty. Rerank
is now `voyage` rather than Cohere. So the baselines here are *not* rung-4's numbers (GLM
74 vs 81); only the within-model off/on comparison is the measurement. 9 of 1,730 answer-time
query embeddings hit an upstream 429, spread across all four arms.

**Results** (n=100 pairs per model):

| | GLM off → on | DeepSeek off → on |
|---|---|---|
| total correct | 74 → **77** | 76 → **79** |
| pairs where a note reached the model | 17: **+3 gained, 0 lost** | 19: **+1 gained, 0 lost** |
| pairs with no note (identical tool text; pure noise) | 83: +4 / −4 | 81: +3 / −1 |
| McNemar, all pairs | p = 0.55 | p = 0.38 |

The untouched pairs are the noise control, and they are the honest reason not to quote the
+3 totals. Identical tool text still flips 4–8 answers per model between two runs. What
separates signal from noise is the touched subset: **4 gains, 0 losses across 36 pairs**
(both models combined). Taken alone, that is suggestive (p = 0.125) but not proof.

**The rung-4 failure questions:**

| question | links at 0.8 | GLM off → on | DeepSeek off → on |
|---|---|---|---|
| 07741c44 sneakers (initial place) | 3 | ✗ → **✓** | ✗ → **✓** |
| 88432d0a bakes (count) | 4 | ✗ → **✓** | ✗ → ✗ (6 → 5; see below) |
| eace081b Hawaii trip | 2 | ✗ → **✓** | ✗ → ✗ (reading error) |
| 4b24c848 H&M tops | 2 | ✓ → ✓ | ✓ → ✓ |
| ed4ddc30 eggs | 1 | ✗ → ✗ (never searched) | ✓ → ✓ |
| 0a995998 clothing errands | 1 | ✗ → ✗ | ✗ → ✗ (an undercount) |
| 6a1eabeb, a2f3aa27 | 0 | treatment never applied | |

The touched pairs that did not flip are not link failures. GLM never called `memory_recall`
for the eggs question, so no note could reach it. `0a995998` is an *under*count: the duplicate
boots were counted once, as intended, but the third item was never retrieved. For the bakes,
DeepSeek counted the duplicate sourdough and cake once each (6 → 5) and then counted an apple
pie that was likely the assistant's suggestion. On the trip, DeepSeek cited Oahu and still
answered that it didn't know where the user was staying.

**Cost:** $2.41 (400 answers + judges + re-embedding), plus $0.35 for the abandoned `max` rows.

## What this does not show

- **A significant accuracy gain.** Only 17–19 of 100 questions ever see a note, and the effect
  lives there. A confirming run should either repeat the touched questions several times per
  arm, or use a benchmark slice built from knowledge-update and counting questions.
- **A human's labels.** 120 labels by Claude, with the arguable calls marked.
- **Links for assistant facts.** Only user-subject facts were paired; assistant duplicates
  (`recommended`, `listed`) weren't measured.
- **The rung-0 corpus.** Same stand-in as the normalizer report: the product's own banks.
