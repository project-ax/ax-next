# DEM fact links with Jev — phase 1 (link quality)

**Date:** 2026-09-28
**Question:** DEM's rung-4 knowledge-update and counting failures are pairs of stored facts
that nothing links. Can Jev link them — "B **updates** A", "same event" — precisely enough to
be worth an answer-level test?
**Code:** `dem-memory/bench/fact-links.ts` (question, request, candidate pairs; pinned by
`tests/fact-links.test.ts`), `dem-memory/bench/fact-links-eval.ts` (the run),
`dem-memory/bench/fact-link-labels.json` (120 hand labels). Measurement only; nothing under
`packages/` changed, and the banks are opened read-only.
**Cost:** $0.68 (29,573 calls), plus $0.0004 for the hand-picked probe that motivated it.

## Verdict

**Phase 1 passes.** At a threshold of **0.8**, every labelled link is correct: **28/28**
(20 `updates`, 8 `same_event`). At 0.7 precision is **90.4%** (47/52), and `same_event` is
still 17/17. Of the 9 rung-4 failure pairs, all 9 get the right label. 8 clear 0.7 and 6 clear
0.8; the miss is the follower-count pair, whose two facts carry the same date (p 0.49).

This is the opposite of the slot-normalizer result
(`2026-09-28-dem-jev-normalizer-report.md`: no clean threshold with coverage). The difference
is the question. Naming a profile slot from a relation alone asks Jev to guess. Comparing two
concrete facts with both values in view is a judgement it makes well.

**Phase 2 — whether the links change answers — is not run yet.** Nothing here says accuracy
moves.

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

## What this does not show

- **That answers improve.** That is phase 2: re-answer the affected questions plus a control
  set, evidence with vs without link annotations, same banks and same answerer, paired.
  Rung-4's n=100 noise floor (±4–6pp) means only a paired design can see it.
- **A human's labels.** 120 labels by Claude, with the arguable calls marked.
- **Links for assistant facts.** Only user-subject facts were paired; assistant duplicates
  (`recommended`, `listed`) weren't measured.
- **The rung-0 corpus.** Same stand-in as the normalizer report: the product's own banks.
