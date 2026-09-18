# DEM-first memory — rung 0 report

**Date:** 2026-09-18
**Ladder:** §8 of `docs/plans/2026-09-18-dem-first-memory-design.md`, rung 0 ("offline, $0, ~1 day").
**Facts:** every measurement is pinned to extraction fingerprint `f4752a79` — 19,195 sessions,
130,779 facts, the exact generation behind the 87.4% headline. The extraction prompt is
untouched.
**Cost:** ~$0.50 — ~$0.07 of Vertex embeddings (145k relation phrases, including ~60k lost
to the crash described in §5) and ~$0.40 of Cohere reranking (200 calls across two ablation
arms). **No LLM answer or judge calls.** Wall clock ~2.5 h, of which ~35 min is embedding.

**Gates, from the design:** *"`assistant | recommended` closes 0 rows under the slot design;
precision on the sample is acceptable to you and stated with the number."*

| Gate | Verdict |
|---|---|
| `assistant \| recommended` closes 0 rows under the slot design | **PASS.** 0 rows, in all three scopes and both orderings — it has no slot, so it closes nothing. And the headline is stronger than the gate asked for: **the maximum rows closed by any one statement is 1, everywhere**, against DEM's 622. |
| Normalizer precision on the hand-check sample | **FAIL as specified; PASS in a reduced configuration.** The embedding nearest-neighbour scores **13.2%** precision on a uniform random sample of mapped predicates (7 of 53) and **20.9%** on the top-60 by fact volume (9 of 43). It misplaces **6 of 32 canonical spellings** — `first name` → `birthday` at 0.834. The exact-synonym table it sits behind is 100% precise by construction and maps 442 facts (0.34%). |
| Graph-channel ablation decides drop-or-re-key | **Decided: DROP.** The channel returns any candidate on 2 of 100 questions, contributes 0–1 unique rows to 1,500, and removing it changes gold-session coverage by exactly zero in all three runs, under both rerankers. |

## Summary — and the recommendation

Rung 0 was meant to test three things cheaply. It did, and it found a fourth that matters more
than any of them.

1. **The supersession replay reproduces Appendix A.4 exactly** where A.4 was exact, corrects it
   where A.4 was approximate, and adds one number A.4's method could not have seen (§1).
2. **§3.4's closure rules work.** Keyed on a slot instead of a free-text predicate, the maximum
   rows closed by one statement drops from **622 to 1**, and the gate case closes nothing (§2.6).
3. **§3.3's embedding nearest-neighbour does not work, and the failure is structural.** Eight
   descriptions partition an 84,561-predicate space into eight attractor cells; `birthday`
   collects addresses, incomes and funerals, `pronouns` collects anything about identity. The
   threshold only chooses how much of each cell to admit, which is why precision is 13.2% where
   the rule maps anything and the rule maps nothing at all above 0.88 (§2).
4. **dem's retrieval is not reproducible**, and the cause is `retain.ts` minting `randomUUID()`
   where `recall.ts` breaks every ranking tie on the id. Same question, same facts, same
   everything: **12 of 12 questions get a different top-15, with a different set of rows** (§4.1).

**Recommendation — and this is a stop, not a pause.** The design's own ladder says any rung can
end it, and gate 2 failed as written. Three things should happen before rung 1 is worth paying
for:

- **Ship the normalizer as the synonym table alone** and drop the embedding stage, or hold it
  behind a threshold of 1.0. A negative result ships opt-in and off, as evidence depth and
  source anchors did; deleting it would invite someone to rebuild it in a month. The measured
  precision belongs in the doc comment of the constant, at the exact place a future reader
  considers lowering the bar.
- **Fix retrieval reproducibility first, as its own change with its own arms.** It is one line,
  it costs no new API calls, `bench/reproducibility-probe.ts` is already its regression test,
  and every measurement taken before it lands carries an unattributed noise component.
- **Then re-scope rung 1.** As specified it is 8 × n=500 runs to ask whether a change touching
  **0.34% of facts and closing 61 rows** moves a metric whose noise floor is 1.6pp. It cannot;
  the honest expected result is "no detectable difference", which is already the prior. Closure
  is *not* inert — the default recall path filters to `valid_end = INFINITY`, so a closed row
  does leave the candidate set — so a safety check has real content. But it is a ~61-row safety
  check, and it should be run **after** determinism lands, when a 1.6pp floor means what it says.

Nothing here argues against the DEM-first design. §3.4 is vindicated; §2.3's suspicion about the
graph channel is confirmed; §3.3's *vocabulary* holds and its *derivation mechanism* does not.

---

## 1. Supersession replay — `bench/supersession-replay.ts`

Appendix A.4 of the design was measured from a scratchpad while the document was being
written. It is now a committed script, and this is what it says.

### 1.1 The lifetime column reproduces A.4 exactly

|  | prefix (A.4 approx) | question (exact) | lifetime (validStart) | lifetime (session order) |
|---|---|---|---|---|
| banks | 11,140 | 500 | 1 | 1 |
| fact ingests | 130,779 | 162,147 | 130,779 | 130,779 |
| flagged `invalidatesPrevious` | 1,242 (0.95%) | 1,604 (0.99%) | 1,242 | 1,242 |
| flags with an exact prior | 105 | 161 | **372** | 379 |
| flags that found nothing | 91.55% | 89.96% | **70.05%** | 69.48% |
| rows closed | 158 (0.12%) | 258 (0.16%) | **5,587 (4.27%)** | 5,424 (4.15%) |
| rows per closer p50 / p90 / max | 1 / 2 / 28 | 1 / 3 / 6 | **2 / 23 / 622** | 2 / 26 / 447 |
| one-directional misses | 0 | 0 | 0 | **97** |

The bolded lifetime figures are A.4's, to the row. So are its cited examples:
`assistant | recommended` closes **360, 68 and 56** rows across its three closures (A.4 quotes
the 68); `user | interested_in` closes **40**; `assistant | provided_solution` closes 86, 81,
67 … **46** across 40 closures (A.4 quotes 46, 30, 23).

### 1.2 The per-conversation column does not reproduce, and should be retired

A.4 reports 102 flags-with-prior and 140 rows closed for its per-conversation column. Splitting
the session id at its **last** underscore gives 105 / 158; splitting at its **first** gives
205 / 1,218. Neither is 102 / 140, and A.4's own footnote already calls that column an
approximation ("grouping cache keys on session-id prefix, not the exact per-question
haystack").

The exact scope was available for free and is now computed: **one bank per LongMemEval
question**, membership read from `haystack_session_ids` — which is what `bench/run.ts` actually
builds (`bankId: sample.question_id`). It says the same thing more precisely: **0.16% of rows
closed, p90 3, max 6.** Quote this column; treat A.4's per-conversation figures as superseded.

### 1.3 A new number: the one-directional miss is real, and `validStart` ordering hides it

DEM's SQL closes priors with `valid_start <= ?` only. A prior dated *later* than the incoming
fact is skipped and both rows stay active — the gap §3.4's rule 2 (two-sided closure) exists to
fix. Sorting the bank by `validStart`, as A.4 did, makes that case **impossible by
construction**, so A.4's data could not have shown it.

Re-run in **session ingest order**, which is what ingestion actually does, it fires **97 times
out of 379 matched flags (25.6%)**. Backdating is not hypothetical: a prior measurement over
this same generation (2026-09-17, recorded in `.claude/memory/context.md`) found `validStart`
equal to the session date on 93.0% of rows, 1.9% after and **5.1% before**.

This is why the script takes `--order`, and why a `0` under `--order validstart` prints a
warning saying the zero is arithmetic rather than evidence.

### 1.4 Two things the lifetime column is *not*

**It is not one person's memory.** LongMemEval-S is 500 unrelated users' haystacks. Fusing them
puts every speaker under one `about: user` node, so `user | lives_in` closing 77 rows at once is
77 *different people's* cities, not one person moving 77 times. That is precisely the failure
§3.2's speaker rewrite (`about: user` → `about: user:<userId>`) exists to prevent — the lifetime
replay is an unintentional demonstration of what the corpus looks like without it.

Read the two scopes as a bracket. `question` is what per-person keying buys you (0.16%);
`lifetime` is what happens when one `about` value accumulates without bound (4.27%). **The
design needs both fixes**: the speaker rewrite on the subject axis and the slot key on the
relation axis. Neither alone gets from 4.27% to a defensible number, and the design doc's §3.3
discussion reads as though the slot key does all the work.

**Provenance immunity is untestable here.** Every cached fact is `provenance: extracted`, so
rule 3 is always equal-vs-equal in this data. The replay implements it and says so in its
output; it is pinned by unit test (`tests/supersession-replay.test.ts`), not by this
measurement.

---

## 2. Normalizer — `bench/normalizer-eval.ts`

§3.3 proposes deriving `slot` from the relation in two stages: a small exact-synonym table in
front, then an embedding nearest-neighbour against eight slot descriptions with a strict
threshold. **The synonym table works. The embedding nearest-neighbour does not, and no
threshold rescues it.**

### 2.1 The calibration that settles it, on truth that needed no hand-labelling

Before hand-checking anything, run the rule over the synonym table's own keys — phrases that
*are* canonical spellings of their slot, so the correct answer is known by construction:

> **The nearest slot agrees with the hand-assigned slot on 26 of 32 canonical spellings.**
>
> | phrase | should be | nearest | score |
> |---|---|---|---|
> | `first name` | name | **birthday** | 0.834 |
> | `last name` | name | **birthday** | 0.816 |
> | `full name` | name | **birthday** | 0.815 |
> | `born on` | birthday | **name** | 0.719 |
> | `goes by` | name | **timezone** | 0.658 |
> | `works as` | role | **name** | 0.647 |

If the rule cannot place `first name`, it cannot place `assigned_role`. And note *where* the
errors sit: `first name` scores **0.834** against the `birthday` description — higher than
almost every true positive in the corpus — so these are not a threshold away from being fixed.

### 2.2 Mapping rate, swept

| threshold | mapped predicates | mapped facts |
|---|---|---|
| 0.65 | 17,422 (20.60%) | 34,753 (26.57%) |
| 0.70 | 2,961 (3.50%) | 7,011 (5.36%) |
| 0.72 | 1,278 (1.51%) | 2,841 (2.17%) |
| 0.75 | 371 (0.44%) | 1,096 (0.84%) |
| 0.78 | 108 (0.13%) | 569 (0.44%) |
| 0.80 | 48 (0.06%) | 475 (0.36%) |
| 0.85 | 26 (0.03%) | 448 (0.34%) |
| **0.88 and above** | **22 (0.03%)** | **442 (0.34%)** |

At 0.88 the count is exactly the 22 synonym-table entries: **the embedding half maps nothing at
all above 0.88.** Everything it contributes lives between 0.65 and 0.88.

### 2.3 Precision on the hand-check samples — the number the gate asks for

At threshold **0.78** (108 predicates, 0.44% of facts), hand-checked:

| sample | synonym rows | embedding rows | embedding correct | **embedding precision** |
|---|---|---|---|---|
| uniform random draw of 60 mapped predicates | 7 | 53 | 7 | **13.2%** |
| top 60 mapped predicates by fact volume | 17 | 43 | 9 | **20.9%** |

*Counting rule, because a number carrying an argument needs one:* a mapping is **correct** when
the relation genuinely is that single-valued profile property of its subject. Three of the
random sample's rejects are arguable (`career_status`, `career_field`, `social_role` → `role`);
counting all three as correct raises the random-sample figure to 18.9% (10/53). The synonym rows
are correct by construction and are excluded from the precision figure rather than inflating it.

A sample of what the embedding half actually produces at 0.78:

```
0.811  birthday   home_address          0.826  timezone  day_of_week
0.813  birthday   death_date            0.799  birthday  annual_gross_income
0.796  birthday   country_of_birth      0.792  lives_in  has_nationality
0.801  birthday   college_graduation_date  0.791  lives_in  is_citizen_of
0.790  pronouns   grammar_characteristics  0.788  works_at  assigned_role
0.794  pronouns   described_narrator    0.785  works_at  annual_salary
0.814  pronouns   stated_pronunciation  0.790  name      name_meaning
```

**The mechanism is structural, not a wording accident.** Eight descriptions partition the whole
84,561-predicate space into eight nearest-neighbour cells, and the threshold only decides how
much of each cell to admit. `birthday` has become the cell for anything date- or number-shaped
about a person — addresses, incomes, graduations, deaths, funerals, phone numbers. `pronouns`
has become the cell for anything about identity or description. A slot cannot refuse a relation;
it can only be further away than another slot.

And the margin at 0.78 is razor-thin. The nearest rejects, all real and all wrong:
`born_in` → lives_in at **0.779** (7 facts), `is_friend_of` → name at 0.779 (10 facts),
`identifies_as` → pronouns at 0.778 (**18 facts**), `phone_number` → birthday at 0.772 (7 facts).

### 2.4 The known-bad list — and an honest caveat about it

`tests/fixtures/normalizer-known-bad.json` holds 22 entries, each with the measured cosine and
why it must not map. **All 22 are refused at threshold 0.78.** But three of them
(`speaks_to`, `named_pet`, `anniversary`) do not occur in this corpus's predicate space, so they
are refused *vacuously* — the run reports `nearest null`, which is the tell. **19 of the 22 are
real refusals.** The fixture is still worth keeping whole: rung 1's implementation must refuse
all 22, and the three absent ones are exactly the kind of relation a different corpus produces.

### 2.5 The configuration this recommends: synonym table only

At threshold ≥ 0.88 the normalizer *is* the synonym table — 22 predicates, **442 facts (0.34%)**,
precision 100% by construction and auditable line by line.

```
slot          predicates      facts  userFacts
name                 4         10          1
pronouns             0          0          0
lives_in             4        184        175
works_at             2         84         51
role                 5        150        118
timezone             2          3          1
language             1          1          0
birthday             4         10          2
```

`userFacts` is what §4.1's profile block could actually render, since it renders active slot
rows `about = user:<caller>`. Two things follow. **The profile block is not empty** —
`lives_in`, `role` and `works_at` carry 344 of the 348 user rows, and those are the three slots
a profile most needs. And **`pronouns` and `language` map zero user facts on this corpus**, so
two of the eight slots are currently dead weight; §3.3's claim that the slot list "is the
profile whitelist" holds, but only six of the eight entries are doing anything.

### 2.6 What the closure rules do once the slots are right

Replaying §3.4's rules over the synonym-only map — this is gate 1:

| scope / order | slotted ingests | rows closed | **rows per closer p50 / p90 / max** | two-sided self-closes |
|---|---|---|---|---|
| question, validStart | 565 (0.35%) | 70 (0.04%) | 1 / 1 / **1** | 0 (vacuous by construction) |
| question, session | 565 (0.35%) | 62 (0.04%) | 1 / 1 / **1** | **9** |
| lifetime, validStart | 442 (0.34%) | 348 (0.27%) | 1 / 1 / **1** | 0 (vacuous) |
| lifetime, session | 442 (0.34%) | 345 (0.26%) | 1 / 1 / **1** | **304** |

> **Corrected 2026-09-18, after implementing §3.4 in `src`.** These two session-order figures
> were first measured as 61 and 44, against the design's rule 2 *as literally written* — "if
> an **active** row has `R'.when > S.when`". Building it showed that reading is wrong: a row
> already bounded by a later successor can still SPAN the instant a new statement claims, and
> skipping it leaves two rows asserting the same slot over the same interval. Write Denver
> (Sep), then Boston (Jan), then Seattle (Jun), and an active-only rule leaves Boston claiming
> January-to-September beside Seattle's June-to-September; a query for July returns both.
> Both implementations now end every row whose interval is open at the new statement's start,
> which keeps the history a chain. **The rows-per-closer maximum — the number this section is
> about — is 1 either way.**

**`assistant | recommended` closes 0 rows in every scope and every ordering** — it does not
appear in the key table at all, because it has no slot. The keys that do close are
`user | lives_in`, `user | role`, `user | works_at`, `user | birthday` and `rachel | role`.

The headline is the **max** column. DEM's rule closes up to **622 rows on one statement**; the
slot rule's maximum is **1, everywhere**. The lifetime bank's `user | lives_in` closes 174 rows
across 174 separate closures — a chain, one row at a time, which is what supersession should
look like even when 500 people's cities are wrongly fused under one subject.

---

## 3. Graph-channel ablation — `bench/graph-ablation.ts`

§2.3 of the design suspected the graph channel of being "two giant nodes and noise", because
the co-occurrence graph is keyed on `subject` and `subject` is the speaker on 90.0% of rows. It
asked rung 0 to decide between dropping the channel and re-keying it on entities.

**Method.** The same n=100 spaced sample, ingested once per question, then recalled twice over
the *same* store: once through the facade's engine (graph as `retain` built it), once through a
second `RecallEngine` over the same repository holding an **empty** `CoOccurrenceGraph`. An
empty node list makes `matchEntities` return no seeds, so `graphChannel` short-circuits to `[]`
and RRF fuses three lists instead of four. Nothing else differs — same facts, same embeddings,
same reranker, same question, same `rrfK`/`channelLimit`/`rerankPool` defaults.

**Metric.** Gold-session coverage in the top-15: are the sessions the benchmark says hold the
answer represented in the table the answerer would see. No answer or judge calls.

| run | arm | coverage | fully covered | rows from gold | median first-gold rank |
|---|---|---|---|---|---|
| production (Cohere) | graph **on** | 100.0% (199/199) | 100/100 | 819 | 1 |
| production (Cohere) | graph **off** | 100.0% (199/199) | 100/100 | 819 | 1 |
| vertex (lexical), run 1 | graph **on** | 90.5% (180/199) | 86/100 | 481 | 1 |
| vertex (lexical), run 1 | graph **off** | 90.5% (180/199) | 86/100 | 481 | 1 |
| vertex (lexical), run 2 | graph **on** | 91.0% (181/199) | 88/100 | 469 | 1 |
| vertex (lexical), run 2 | graph **off** | 91.0% (181/199) | 88/100 | 469 | 1 |

**Read this table down the pairs, not across the runs.** Within every run the two arms are
identical in every cell, including per question type (run 1: multi-session 88.4% on and off,
temporal-reasoning 87.0% on and off; run 2: 85.5% and 89.9%, again on and off). *Between* runs
the absolute level moves — and that movement is §4.1, not the graph channel. The arm comparison
is paired inside one process over one ingested store, which is exactly why it survives a
retrieval path that is not reproducible across processes.

Direct measurements of the channel itself, which do not depend on the coverage metric at all:

- the graph channel returns **any** candidate on **2 of 100** questions;
- it proposes **1** row that no other channel proposed, across 1,500 top-15 rows (production),
  and **0** under the lexical reranker;
- `matchEntities` finds a mean of **0.02** entity seeds per question;
- the graph itself is tiny — **10–30 nodes and 15–65 edges** for a question's whole haystack
  (~48 sessions, ~330 facts), because `coOccur` draws edges only between *distinct* subjects
  inside one retain batch, and a batch whose facts are all `user`/`assistant` contributes
  exactly one edge.

Dropping it is a real subtraction, not a flag: `MemoryRepository.batches()` has exactly one
caller (the graph rebuild in `createDemMemory`) and `matchEntities` exactly one production
caller (`recall.ts`), so the whole of `src/graph/`, the `graph` parameter on `RecallEngine` and
`RetainEngine`, the rebuild in `setBank`, and the `graphNodes`/`graphEdges` fields of `stats()`
go with it.

**Is the metric saturated?** Under Cohere, yes — 100% leaves no room to improve. That is why the
lexical arm matters: at 90.5% / 86-of-100 there is ample headroom, and the arms are *still*
identical, cell for cell. The null is not a ceiling artifact.

**Decision: drop the channel.** Re-keying it on an entity list is a new feature with no evidence
behind it, and this project has twice measured a well-motivated mechanism to null (evidence
depth, counting directives). Dropping it also removes `co-occurrence-graph.ts`, `matchEntities`,
`MemoryRepository.batches()` and the graph rebuild in `setBank` from the engine's surface —
which is the kind of subtraction §2 is for. What this does **not** license is "a graph channel
cannot help": an entity-keyed graph is a different mechanism and remains unmeasured.

**A free corroboration.** Gold-session coverage at rank 15 is 90.5% with a *lexical* reranker
and 100% with Cohere. Retrieval is reaching the gold sessions on this sample; whatever is left
is downstream of retrieval — the same conclusion the memory-strata map-fidelity work reached
from the other side.

---

## 4. Three findings that were not on the rung-0 list

### 4.1 dem's retrieval is not reproducible, and the cause is one line — `bench/reproducibility-probe.ts`

This is the largest thing rung 0 turned up, and it was not on the list. It surfaced because two
runs of the *deterministic* graph ablation — cached embeddings, lexical reranker, no model call
anywhere — reported 90.5% and 91.0% gold-session coverage, moving multiple points on some
question types (single-session-preference 66.7% → 83.3%, temporal-reasoning 87.0% → 89.9%).
Nothing in that stack should have moved at all.

**Measured.** Ingest the same question twice inside one process, same facts, same vectors, same
reranker, same dates, and compare the evidence tables *by content*:

> **12 of 12 questions produced a different top-15. 12 of 12 changed which rows are in the
> table, not merely their order. 130–143 of 180 row positions moved** (two runs of the probe
> itself — the count varies, which is the same phenomenon one level up).

**Cause, proven by mutation rather than inferred.** `retain.ts:210` mints `id: randomUUID()`,
and every ranking tie-break in `recall.ts` is `id.localeCompare(id)` — the RRF fusion sort, the
reranker reorder, and the graph channel's ordering. RRF scores are sums of a few discrete
`1/(k + rank)` terms, so exact ties are common and tie groups are large; which candidates enter
the 40-row rerank pool and which 15 leave it is decided by a random string. Replacing the uuid
with a content-derived id (`subject|predicate|object|validStart`) and re-running the probe gives
**0/12 differing and 0 row positions moved**, with nothing else changed.

**Why it matters past the bench.** Two consecutive asks of the same question can be answered
from different evidence — that is a product property, not a harness artifact.

> **Corrected 2026-09-18.** This paragraph originally went on to claim that the same
> nondeterminism is "a concrete, removable part" of the bench's 1.6pp noise floor. That was a
> guess, it was measured, and **it failed**: four n=500 runs with deterministic ids gave sd
> 0.91pp against the random arm's 0.50pp — wider, not tighter — with the mean moving −0.30pp
> (p = 0.59). Retrieval nondeterminism is large at the TABLE level and still does not detectably
> move TOTAL accuracy variance; the floor is dominated by the answerer and the judge, exactly as
> the published figure always said. See `docs/plans/2026-09-18-dem-deterministic-ids-report.md`.
> The determinism finding below is unaffected — it is a property of the store, not a statistic
> about scores.

**The fix is one line and rung 0 deliberately does not take it.** Deriving the id from content
makes retrieval reproducible for free, but it also changes which rows reach the answerer, so it
moves every score by an unknown amount and needs its own measured arm. Landing it inside a
measurement change would be two changes at once — the mistake the counting-directives report was
written to stop. Concretely:

- **Rung 1's normalizer arm should run against the current build**, so it stays comparable to
  the stored 87.4% baseline and the 1.6pp floor, both of which were measured with this noise in
  them.
- **Determinism should then be its own change with its own arms**, and it is cheap to evaluate:
  no new API calls, and the probe is already its regression test (it must read `0/N`).
- Until then, any diagnostic that diffs two evidence tables must compare *within* one process
  over one ingested store, which is what `graph-ablation.ts` does and why its arm comparison
  survives while its absolute level moves.

### 4.2 `rerank-v4.0-pro` is not reproducible either

The first ablation run reported **24 of 100** top-15 tables differing between the arms — while
the graph channel had fired on only **2**. On the other 98 the two arms fuse provably identical
candidate lists, so the tables could not differ for any reason internal to this bench.

Two checks settled it. Re-running with the deterministic lexical reranker gives **2 of 100**
differing tables, exactly matching the 2 questions where the graph channel fires. And asking
Cohere directly — three calls, byte-identical query and 40 documents — gives run 1 ≡ run 2 but
run 3 differing with `maxAbsDelta = 4.26e-3` and a different ordering.

So **~22% of top-15 evidence tables reorder between two identical calls** on the production
stack. Consequences worth carrying:

- a retrieval-level comparison on the production stack has an irreducible table-reordering
  jitter, and a difference smaller than that is not a signal;
- any diagnostic that diffs two evidence tables (`diagnose-temporal.ts`, future rank-displacement
  probes in §7) must use `--stack vertex` or repeat, or it will report reranker noise as an
  effect;
- this sits alongside §4.1 and the answerer/judge variance already measured (n=500 TOTAL
  1.6pp, n=100 ±4–6pp). It was invisible because no prior experiment ran the same query through
  the reranker twice.

### 4.3 The statement → session join is exact, so the coverage numbers are exact

The ablation attributes a recalled tuple back to a session by its statement text, first-wins,
which is only sound while one statement text comes from one session. Measured over the same
n=100 sample: **0 of 32,214 statement keys are emitted by more than one session** (1,758 of
them gold-bearing). The check is now computed on every ablation run and printed, rather than
being a claim in prose.

---

## 5. Operational notes for whoever runs this next

- **The machine ran out of disk mid-run.** `/System/Volumes/Data` is at 874 GB of 926 GB with
  ~600 MiB free; this is not the bench's doing (its caches total ~1.6 GB) but it is enough to
  kill a long job. The first normalizer run died `ENOSPC` at 71%.
- **That is why relation scores are cached as eight cosines, not as vectors.** Nothing
  downstream of the normalizer reads a 384-dimensional vector — only its cosine against eight
  fixed slot descriptions — so caching vectors stored 48× more than any consumer used: 7.8 KB
  per relation against ~120 bytes. The predicate cache is ~11 MB where it would have been
  ~660 MB. The file name carries a signature over the slot descriptions and the embedding task
  type, so changing either starts a new cache instead of mixing incomparable scales.
- **Embedding concurrency is a quota, not a throughput dial.** 12 workers × 5 instances is
  ~95 req/s and returns 429 from `aiplatform.googleapis.com/online_prediction_requests`; the
  embedder's own retry gives up after 4 attempts, so the job dies rather than slowing. 5 workers
  is ~130–200 relations/s and runs clean.
- **Flush as you go.** Run 1 flushed only at the end and lost ~13k paid-for embeddings to the
  crash. The scoring loop now appends every 2,000 relations and is resumable.
- `bench/cache` in `dem-memory/.gitignore` lost its trailing slash: the 1.5 GB embedding cache is
  most easily shared between worktrees by symlinking that path, and `bench/cache/` matches a
  directory but not a symlink — which offered the whole cache up as an untracked file.

---

## 6. What rung 1 inherits

- `bench/supersession-replay.ts`, with its measured numbers in the header comment, `--rule`,
  `--scope` and `--order`, and a warning on any figure that is zero by construction.
- `bench/slots.ts` — the eight-slot vocabulary, the descriptions, the synonym table, and
  `assignSlotFromScores`, which is the decision procedure a rung-1 `src/` implementation has to
  preserve.
- `bench/normalizer-eval.ts` and its resumable slot-cosine cache.
- `bench/graph-ablation.ts`.
- `tests/supersession-replay.test.ts` (16 cases) and `tests/slots.test.ts` (13 cases), hermetic.
  The replay suite already covers the three fixtures rung 1 is required to add — closure hits
  exactly the prior, a backdated row is closed by the later row already active, and a human row
  survives an extracted one — plus provenance in the other direction, equal-`when` ordering,
  subject isolation, and the `recommended`-closes-nothing gate. Each was mutation-checked:
  removing rule 2 reddens exactly the two two-sided tests, removing rule 3 reddens exactly the
  immunity test, and reverting the slot key to the predicate reddens exactly the gate test.
- `tests/fixtures/normalizer-known-bad.json` — 22 entries, each carrying its measured cosine and
  the reason it must never map. All 22 refuse at 0.78 today (three vacuously; see §2.4), and a
  rung-1 implementation must keep refusing all 22.
- `bench/reproducibility-probe.ts` — currently reports `12/12 NOT reproducible`; it is the
  regression test for the id fix and must read `0/N` once that lands.

### The shape rung 1 should now take

Not the shape §8 specified. Concretely:

1. **Land the deterministic id first**, on its own, with its own n=500 arms. It is the only
   change here that makes every later measurement cheaper and more trustworthy, and the probe
   already gates it.
2. **Implement §3.4's closure in `src` behind a flag, with the synonym-only normalizer.** The
   engine work is unchanged and worth doing — two-sided closure, provenance-ordered immunity,
   `closed_by`, and dropping `invalidatesPrevious`-driven closure when the flag is on. The
   16 replay tests already pin all of it, including the two rules this corpus cannot exercise.
3. **Do not spend 8 × n=500 on the normalizer arm as specified.** 0.34% of facts and 61 closures
   against a 1.6pp floor is not a measurable treatment. If a safety number is still wanted, the
   cheap version is a recall-only pass: replay the closures, then ask whether any closed row was
   in a gold top-15 — free, exact, and it answers the only question the expensive run could.
4. **Drop the graph channel** (§3), which is pure subtraction and needs no measurement to
   justify beyond what is here.

### Two things rung 0 could not test, stated so nobody reads silence as evidence

- **Provenance immunity (§3.4 rule 3)** cannot fire on this corpus: every cached fact is
  `provenance: extracted`, so the comparison is always equal-vs-equal. Pinned by unit test only.
- **Two-sided closure under `--order validstart`** is zero by construction, not by measurement.
  It fires 9 times at question scope under session ordering, which is the number to quote.
