# DEM slot normalizer — the Jev arm

**Date:** 2026-09-28
**Question:** can a decision model do what the embedding nearest-neighbour could not — map a
relation to a single-valued profile slot, and *refuse* one that isn't? (Rung-0 report §2 is
the embedding result this answers.)
**Model:** `typesafe/jev-1.13` (served as `typesafe/jev-1.13-20260917`) through OpenRouter's
Decisions API.
**Code:** `dem-memory/bench/jev.ts` (client + pure helpers, `tests/jev.test.ts`),
`dem-memory/bench/jev-normalizer-eval.ts` (the arm), `dem-memory/bench/jev-labels.json` (hand
labels). Nothing under `packages/` changed, and neither did the extraction prompt.
**Cost:** **$1.14** of a $5 cap, ~48k calls. The key's usage meter and the script's own
metered `usage.cost` agree to the cent.

## Verdict

| Check | Verdict |
|---|---|
| 1. Canonical spellings | **PASS.** Jev's choice is right on **32 of 32** synonym-table keys (embedding: 26/32). `first name` → name at 0.98, where the embedding said birthday. |
| 2. Known-bad gate | **PASS at ≥ 0.6, FAIL at 0.5.** All 22 come back `none` (15/15 in fact mode). But `works_on` sits on a knife edge at p ≈ 0.5, and in the sweep it flipped to `works_at` at 0.55. |
| 6. Determinism | **Stable choice, jittery probability.** 1/200 choices differ across three fresh runs, and the result replicated. But the chosen option's probability moves by up to 0.12, so a row near the bar can change slot on `reindex`. |
| 3/4. Precision | **FAIL.** No threshold with real coverage is clean. Jev-half precision is **55.3%** at 0.9 (relation only) and **73.5%** at 0.9 with context (fact mode). At 0.99 it is 5/6 and 5/5, over five predicates. |
| 5. Per-slot counts | `pronouns` stays dead (0 user facts). `language` gains 3–4 user rows, most of them wrong or arguable. |
| 7. Latency / cost | p50 **206 ms**, p95 **351 ms** per call; ~$0.000022 per call. |
| 8. Closure replay | **Not run.** The result isn't good enough to earn it, and the replay reads the rung-0 corpus, which wasn't available (see below). |

**Recommendation: keep synonym-only in production.** Don't ship Jev behind the pending/reindex
path either. Instead, use Jev offline as a **reviewer** that proposes synonym-table additions
for a human to accept line by line. Why, in the last section.

Jev is a real improvement on the embedding: 32/32 against 26/32, and 55–74% against 13–21%.
It also fails differently. The embedding *couldn't refuse*: eight slot descriptions carved the
predicate space into eight cells. Jev refuses fine — 22/22 known-bad come back `none`, and
`visited`, `recommended` and `interested_in` all score 1.00 for `none`. What it can't do is
tell *a role* apart from *text about a role*. A false positive closes a true fact, and 1-in-4
to 1-in-2 wrong is not a rate we ship.

---

## The corpus caveat — read this before quoting any number

The rung-0 corpus is extraction generation `f4752a79`: 130,779 facts and 84,561 predicates in
`dem-memory/bench/cache/extraction.json`. It is gitignored, and **it was not on the machine that
ran this**. A full-disk search found only 78-byte test fixtures. Re-extracting it is a ~$7,
~5 h cold run, over this task's cap. And it would not reproduce `f4752a79` byte for byte
anyway: the fingerprint moved to `06414f62` when `confidence` was removed.

So the sweep ran on a stand-in: every `facts.db` under
`~/.cache/ax-memory-bench/task497-banks`. That is 100 LongMemEval-S banks written by the
**product** extractor (`memory_facts_v1`: about / relation / value).

| | rung-0 corpus (`f4752a79`) | stand-in (task497 banks) |
|---|---|---|
| facts | 130,779 | 32,501 |
| distinct predicates | 84,561 | 23,591 |
| singletons | 86.8% | 87.5% |
| top predicates | stated, listed, provided_solution, recommended, interested_in | stated, listed, interested_in, provided_solution, … |
| subject rewrite (§3.2) | no (`user`) | yes (`user:<id>`) |

The two have the same shape, and the stand-in is arguably closer to production, since it *is*
the production extractor's output. But the precision and coverage figures below **do not
compare to rung 0 row for row**. They compare in kind: the same unit, rule, table and
counting rule, over a different draw of the same distribution.

**Checks 1, 2 and 6 don't depend on the corpus.** Only 6's corpus-drawn questions and 2's
fact-mode examples come from it. Whoever holds the `f4752a79` cache can re-run the precision
half exactly:

```
npx tsx bench/jev-normalizer-eval.ts --phase sweep --fingerprint f4752a79 --mode relation \
  --threshold 0.9 --labels bench/jev-labels.json
```

That costs ~$1.90 at one call per predicate. The labels file covers only the stand-in's
mappings, so new mappings print as `unlabelled`.

**Labels.** Rung 0's hand labels were never persisted; only their totals are in the report's
prose. So these labels are new: **212 (predicate, slot) pairs, labelled by Claude, not by a
human**, using rung 0's counting rule — *correct iff the relation genuinely is that
single-valued profile property of its subject*. Calls a reasonable labeller could flip are
marked `arguable`, and every precision figure is quoted strict and lenient. They live in
`bench/jev-labels.json`, so the next labeller can disagree line by line.

---

## 1. Calibration on known truth — 32/32

The table's own keys are canonical spellings, so the right answer is known without labelling.

| | embedding (rung 0) | Jev |
|---|---|---|
| right slot chosen | 26/32 | **32/32** |
| right slot at p ≥ 0.9 | — | 29/32 |
| right slot at p ≥ 0.95 | — | 24/32 |
| lowest-probability correct answers | — | `based in` 0.76, `language` 0.78, `works at` 0.80 |

Every one of the embedding's six misplacements is fixed: `first name` → name 0.98,
`born on` → birthday 0.99, `goes by` → name 0.94, `works as` → role 0.90.

The probabilities also say **the table must stay in front**. At a precision-safe threshold,
Jev would itself unmap `based in`, `language` and `works at`. Production already has this
shape (`deriveSlot` is table-first), and so does the arm (`assignSlotWithJev`).

## 2. Known-bad gate

Relation mode: **22/22 answered `none`.** Fact mode: **15/15** of the entries that occur in
the stand-in. The rest have no real fact to show, and a synthetic one would measure nothing
about context.

The rung-0 fixture's hardest cases are easy for Jev. `born_in` scores 0.779 against the
`lives_in` description, higher than `lives in` itself, and Jev answers `none` at 0.62.
`speaks_to` scores 0.761 toward `pronouns`; Jev says `none` at 0.71. `recommended`,
`visited`, `interested_in`, `owns` and `purchased` are all `none` at 1.00.

**The weak spot is `works_on` → `works_at`.** Its probabilities: gate run 1 `works_at` 0.50 /
`none` 0.55 / `none` 0.50; gate run 2 `none` 0.50 / 0.54 / `works_at` 0.55; the sweep
`works_at` 0.55. That's a coin flip, so a 0.5 threshold fails the gate some of the time. At
≥ 0.6 it never maps.

## 6. Determinism — run twice, and it replicated

The set was 200 questions: the 32 canonical keys, the 22 known-bad, and 146 seeded draws from
the stand-in's untabled relations. Each ran three times with the cache bypassed, and the whole
check ran twice.

| | run A | run B |
|---|---|---|
| choice differs across the 3 runs | 1/200 | 1/200 (same one: `works_on`) |
| chosen-option probability spread, p50 / p95 / max | 0 / 0.04 / 0.09 | 0 / 0.04 / 0.12 |
| slot **decision** differs at 0.6 / 0.7 / 0.8 / 0.9 / 0.95 | 0 / 0 / 1 / 2 / 2 | 0 / 0 / 1 / 2 / 2 |

Every decision flip at ≥ 0.6 is **probability jitter across the bar with the choice
unchanged**: `pronouns` 0.93 / 0.89 / 0.94 at 0.9, `works at` 0.77 / 0.77 / 0.80 at 0.8. All of
those happen to be canonical keys, which the table answers in production. So on this sample,
the population Jev would actually see had zero decision flips at ≥ 0.6. That is still not a
licence. With the spread reaching 0.12, **any answer within ~0.1 of the bar is a coin that
`reindex` re-tosses.** Since `reindex` re-derives slots and re-runs closure, a slot that comes
and goes means a row that closes and reopens.

**Batching.** Eight questions per call over a keyed state keeps the choice (199/200 and 200/200)
but moves the probabilities enough to change **4–7 of 200 decisions at 0.9**. At $0.00002 a
call batching saves nothing worth having, so the sweep ran one question per call.

## 3/4. Precision and the threshold sweep

The Jev half only. Synonym rows are correct by construction and are excluded, as at rung 0.

**Relation mode** — the relation alone, the same unit the embedding eval scores:

| threshold | mapped predicates (all) | mapped facts | Jev predicates | strict | lenient | by facts (strict) |
|---|---|---|---|---|---|---|
| 0.50 | 187 (0.79%) | 359 (1.10%) | 176 | 48 — 27.3% | 40.9% | 23.3% |
| 0.60 | 142 | 298 | 131 | 40 — 30.5% | 46.6% | 26.0% |
| 0.70 | 112 | 262 | 101 | 37 — 36.6% | 53.5% | 28.8% |
| 0.80 | 79 | 207 | 68 | 31 — 45.6% | 63.2% | 37.6% |
| **0.90** | 49 (0.21%) | 166 (0.51%) | 38 | **21 — 55.3%** | 65.8% | 40.0% |
| 0.95 | 31 | 129 | 20 | 15 — 75.0% | 80.0% | 78.3% |
| 0.99 | 17 | 113 | 6 | 5 — 83.3% | 83.3% | 85.7% |

**Fact mode** — `{about, relation, value}` for one representative fact per predicate (the
speaker's own fact when there is one):

| threshold | mapped predicates (all) | mapped facts | Jev predicates | strict | lenient | by facts (strict) |
|---|---|---|---|---|---|---|
| 0.80 | 68 | 195 | 57 | 36 — 63.2% | 78.9% | 51.7% |
| **0.90** | 45 (0.19%) | 161 (0.50%) | 34 | **25 — 73.5%** | 91.2% | 61.8% |
| 0.95 | 34 | 145 | 23 | 18 — 78.3% | 95.7% | 59.0% |
| 0.99 | 16 | 111 | 5 | 5 — 100% | 100% | 100% |

**The two samples collapse into one.** The brief asked for rung 0's uniform draw of 60 and top
60 by volume. At 0.9 only 49 predicates map in total, so both samples *are* the whole mapped
set, and the tables above are exhaustive rather than sampled. Every Jev mapping at ≥ 0.5 in
both modes is labelled.

**Where's the clean threshold?** There isn't one with coverage. 0.99 is clean in fact mode but
maps five predicates and five facts. Relation mode at 0.99 still admits `pilates_instructor`
→ role at 0.99, which is the user's instructor, not the user's job.

### The errors are classes, not noise

At 0.9 the wrong answers fall into four groups, and none of them is a threshold away from
fixed:

- **Text about a role.** `described_technology_role`, `described_biotechnology_role`,
  `described_wholesale_role`, `stated_government_role`, `clarified_role`,
  `defined_assistant_role`, all 0.91–0.95. The word "role" in a speech act pulls Jev in.
  Fact mode removes most of these, because `about: assistant` plus an essay-shaped value gives
  it away.
- **Somebody else's role.** `pilates_instructor` 0.99, `tour_guide` 0.96,
  `tennis_instructor_is` 0.95, `cover_designer` 0.91. The relation names a *relationship*
  ("the user's instructor is Mike"), and it's multi-valued. Fact mode doesn't reliably catch
  it: `character_is` → role at 0.95.
- **Type-of, not works-for.** `is_company` → works_at 0.94, `is_company_that` → works_at 0.94.
- **Near-properties.** `age` → birthday 0.92 (**10 facts**; an age isn't a date and goes stale
  every year), `located_in` → lives_in 0.96 in fact mode (**12 facts**; "US, Midwest region"),
  `speaks_turkish` → language 0.97 (a person speaks several), `gender` → pronouns 0.95.

Context helps: fact mode is +18pp at 0.9. Jev's refusal is also context-aware in the good
direction. `prefers_language` maps in relation mode but not in fact mode, where the example is
"Python over R". But context also *adds* errors (`located_in`, `character_is`). The net is
still a quarter of the Jev half wrong.

### What Jev gets right that the table cannot

Most of the correct Jev mappings are an **open class the table can't enumerate**: the value
folded into the relation. `is_senior_engineer`, `is_construction_lawyer`, `is_hr_executive`,
`is_male_model` and `is_senior_data_analyst` are all role, all correct, and none of them is a
synonym. The rest are ordinary spellings the table just doesn't have yet: `is_resident_of`,
`legal_name`, `real_name`, `prefers_name`, `has_birthday`, `turned_30_on`, `current_position`,
`primary_role`, `changed_name_to`, `lives_in_zip_code`.

## 5. Per-slot user-fact counts

Same shape as rung-0 §2.5. `userFacts` = rows `about = user` / `user:<id>`, which is what the
§4.1 profile block could render.

| slot | synonym-only | Jev relation @0.9 | Jev fact @0.9 | Jev fact @0.95 |
|---|---|---|---|---|
| name | 1 | 1 | 1 | 1 |
| pronouns | **0** | **0** | **0** | **0** |
| lives_in | 31 | 32 | 42 | 41 |
| works_at | 13 | 20 | 13 | 13 |
| role | 34 | 46 | 42 | 40 |
| timezone | 0 | 0 | 0 | 0 |
| language | **0** | 3 | 4 | 3 |
| birthday | 1 | 11 | 2 | 1 |
| **total** | **80** | **113** | **104** | **99** |

**`pronouns` doesn't come alive.** Nothing in 32k facts states a user's pronouns; the one
fact-mode `pronouns` mapping is FDR's `gender`, which is wrong. **`language` twitches**:
3–4 user rows, of which `requires_australian_english` and `speaks_and_requests_thai` are
arguable and `speaks_turkish` and `prefers_translation_language` are wrong. `timezone` stays
at zero. The relation-mode `birthday` jump from 1 to 11 is almost entirely `age` (10 facts),
which is wrong.

## 7. Latency and cost

- **p50 206 ms, p95 351 ms** per single-question call, over 23,419 fresh sweep calls. The
  gate runs measured 222–226 / 355–419 ms over 600 calls each.
- **~$0.000022 per call.** Totals: gate $0.017 + $0.016, relation sweep $0.52, fact sweep
  $0.59 — **$1.14 overall**. A full `f4752a79` sweep would be ~$1.90 per mode.
- On the write path this is one network round-trip per new relation, or per new *fact* in
  fact mode. That's the "embedder unavailable → `slot: pending`" failure surface §3.5 was
  built for, now with a third-party model behind it.

## 8. Closure impact — not run

The brief gates this on "if the result looks good", and it doesn't. It's also blocked outright:
`bench/supersession-replay.ts` reads the `f4752a79` extraction cache, not the fact banks.
Nothing here says what a Jev-derived slot map does to rows-per-closer. The honest prior is
that the maximum stays 1 — closure is one-at-a-time by construction — and that the harm sits
in *which* rows close (`age` closing a birthday, `located_in` closing a home), which a
rows-per-closer maximum can't see.

---

## Recommendation

**Keep synonym-only in production.** The gate for a normalizer was never "better than the
embedding". It was *precision is clean*, because a false positive closes a true fact and no
read path recovers it. Jev at 0.9 is wrong on 26–45% of what it maps, and the errors are
systematic. At 0.99 it's nearly clean but adds five predicates — coverage the table can
match by adding five lines.

**Don't ship it behind pending/reindex either.** That path makes an *unavailable* normalizer
safe, not an *imprecise* one. Two findings also argue against it specifically. `reindex`
re-derives slots, and Jev's probabilities move by up to 0.12 between identical calls, so every
row within ~0.1 of the bar is re-decided on each reindex. And fact mode — the variant with the
better precision — is per-row. That means a network call on the write path for every new fact,
and a slot that can differ between two rows with the same relation.

**The middle option worth doing: Jev as an offline reviewer for the synonym table.** Every
correct high-probability Jev mapping above is a candidate table line (`is_resident_of`,
`legal_name`, `real_name`, `prefers_name`, `has_birthday`, `current_position`,
`primary_role`, `changed_name_to`, …). A human accepting or rejecting a short, ranked list is
exactly the audit surface the table already is. It keeps production deterministic, offline
and 100% precise, and it spends Jev where it's strong: proposing, not deciding. The one class
it can't feed is the open `is_<occupation>` family. If that ever earns its keep, the right
tool is an extraction-prompt change that emits `role` with the title as the value, not a
normalizer guessing after the fact. That is also a separate, measured arm.

**What would change this verdict:** a re-run on `f4752a79` (or a human re-label) moving 0.9
fact-mode precision from 73.5% to clean, *and* a stable-probability story for reindex, e.g.
persisting the derived slot and re-deriving only on a model or prompt change. Neither is
expected.

## What was not measured, stated so nobody reads silence as evidence

- **The rung-0 corpus.** All precision and coverage figures are on the stand-in (above).
- **A human's labels.** 212 labels by Claude, with the arguable ones marked.
- **Fact mode per row.** Fact mode asked about one representative fact per predicate, not
  every fact. Production fact mode would ask once per row, and the same relation could get
  different slots on different rows. Not measured.
- **Closure impact** (§8).
- **Jev versions other than `jev-1.13-20260917`.** A router alias (`typesafe/jev-router`) also
  exists; its answers may differ.
