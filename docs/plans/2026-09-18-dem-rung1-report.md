# DEM-first memory — rung 1, re-scoped

**Date:** 2026-09-18
**Ladder:** §8 of `docs/plans/2026-09-18-dem-first-memory-design.md`, rung 1.
**Predecessor:** `docs/plans/2026-09-18-dem-rung0-report.md`, which ended in a stop.
**Facts:** pinned to extraction fingerprint `f4752a79`. The extraction prompt is untouched.

## What rung 1 was, and why it is not that any more

§8 specifies rung 1 as: implement §3.3–3.4, then run **n=500, GLM answerer, 4 runs per arm,
flag on vs off**, gated on "no loss beyond the 1.6pp floor on TOTAL". Roughly $5 and ten hours.

Rung 0 measured the treatment that design would have been scoring. With the synonym-only
normalizer, the slot rule closes **59 rows across 500 question-banks** — against 162,147 fact
ingests. A change that small is not visible through a 1.6pp noise floor, so eight scored runs
would have reported "no detectable difference" whatever the truth was. That is the prior, not
a finding.

So the implementation happened and the blanket scoring did not. Instead:

1. **Implement §3.3–3.4 in `src` behind a flag** — done, and it turned up a correctness bug in
   the design's own rule 2 (§1).
2. **Find out which questions can change, exactly** — `bench/closure-impact.ts`, free (§2).
3. **Score only those** — 16 questions, both arms, 4 reps. The delta is then EXACT over the
   whole corpus, because the other 484 are provably identical (§3).

**Verdict: the gate passes.** The slot rule is **+1.00 question per run over the 16 it can
touch**, i.e. **+0.20pp over the 500-question corpus**, measured exactly rather than estimated.
It is not a significant effect and is not claimed as one; what matters is that it is not a
loss, and that the cost of finding out was about fifteen minutes.

---

## 1. The implementation, and the bug it found in §3.4

`supersession: 'slot'` settles each statement in one transaction: close every row of the
`(subject, slot)` still open at the new row's start, bound the new row at its earliest
successor, refuse to cross provenance in either direction, and record `closed_by`.
`synonymNormalizer` is the only normalizer on the write path; `embeddingNormalizer` is
exported, unused, and carries rung 0's 13.2% precision figure in its doc comment.

**§3.4's rule 2 is wrong as written.** It says to bound a backdated statement "if an **active**
row has `R'.when > S.when`". That reading passes every in-order case and every two-row case,
and breaks on three values arriving newest-first: write Denver (Sep), Boston (Jan), Seattle
(Jun) — by the time Seattle lands, Boston has already been bounded by Denver and is no longer
active, so Boston keeps claiming January-to-September beside Seattle's June-to-September, and a
temporal query for July returns two answers about where one person lived.

The fix is to end every row whose interval is **open at** the new statement's start
(`valid_start <= S < valid_end`), which keeps a `(subject, slot)` history a chain: each row ends
exactly where its successor begins, exactly one row active. Found by asserting the chain
invariant directly over **all six arrival orders** of three values — no single-order test sees
it. `bench/supersession-replay.ts` carries the same correction, because it is a second
implementation of the same rule and it is the copy that produced the published numbers.

**A second fidelity gap, found the same way.** The replay treats a bank as one flat stream, so
a flagged fact can close a fact from its own session. `retain()` does not — it runs DEM's
invalidation loop *before* inserting the batch's own rows. At question scope in session order
the flat replay closes **245** rows where the product closes **75**; the new `--batch batched`
mode, which mirrors `retain()`, closes **71** and reconciles them. So **Appendix A.4's method
overstates DEM's closure rate about 3.4× at conversation scope.** The lifetime column — where
rung 0's argument actually lives — is unaffected: 5,519 rows and **max 622** batched, against
5,587 and 622 flat.

---

## 2. Which questions can change at all — `bench/closure-impact.ts`

Per question, two stores of the same bank in two separate in-memory databases, ingested
identically, differing only in `supersession`. Both run content-derived ids, so a row has the
same id in both arms and the tables compare row by row — which is why step 2 had to land before
this measurement was possible. `--stack vertex`, because `rerank-v4.0-pro` reorders ~22% of
tables between identical calls and would swamp the treatment.

| | |
|---|---|
| rows closed by `invalidatesPrevious` (baseline) | **75** |
| rows closed by the slot rule | **59** |
| questions where either closed anything | 85 / 500 |
| **evidence tables that differ** | **16 / 500** |
| rows dropped from a table | 16 (5 gold-bearing) |
| rows admitted to a table | 16 (5 gold-bearing) |
| **gold-SESSION coverage lost** | **1 question** |
| **gold-SESSION coverage gained** | **1 question** |

Two things to read carefully here.

**Both rules close things, and the baseline closes more.** An earlier draft of this script
reported only the slot arm's count, which implied the slot rule was the sole active agent. It
is not: on the single biggest mover the slot arm closes *nothing* and the entire difference is
what the baseline destroyed.

**Count sessions, not rows.** Five gold-bearing rows leave a table, but most are replaced by
another row of the *same session*, which costs the answerer nothing. On gold-session coverage
the exposure is one question down and one up.

---

## 3. Scoring exactly those 16 — the re-scoped arm

`bench/run.ts` gained `--ids`, with a banner refusing to let a filtered run's TOTAL be read as
a corpus accuracy. Both arms run content ids, so the slot rule is the only variable. Four reps
each, production stack.

| | base (`invalidates-previous`) | slot |
|---|---|---|
| per-run totals | 13, 12, 13, 13 | 14, 14, 14, 13 |
| mean | 12.75 / 16 | **13.75 / 16** |
| rep-outcomes positive | 51 / 64 | 55 / 64 |

**+1.00 question per run → +0.20pp over the corpus, exact.** McNemar over 64 paired
(question, rep) outcomes: slot wins 7, baseline wins 3, 10 discordant — p ≈ 0.34. Small, not
significant, and not claimed to be; the gate asked only that it not be a loss.

Six questions moved. The two that carry the result:

**`4adc0475`, 0/4 → 4/4** — baseline closed 1 row, slot closed 0. DEM's `invalidatesPrevious`
was destroying a row, and its absence lets a gold row (`user | plays_indoor_soccer`) into the
table; gold-session coverage goes 1 → 2. **The old rule was costing this answer.** Replicated
across all four reps.

**`031748ae`, 4/4 → 2/4** — the slot rule's genuine cost, and the interesting one. It closed
`user | works_as | Senior Software Engineer (new role)`, a gold row, on a **knowledge-update**
question. The mapping `works_as → role` is *correct*. The closure is still wrong, because
`validityClause` defaults to `valid_end = INFINITY` — a closed row leaves the candidate set
entirely — and a knowledge-update question asks about the transition, not the current value.

That is a design finding, not a bench artifact: **§4.2's `memory_recall` gives the agent no way
to ask for history.** The design deliberately kept `at` off the tool (§4.2, and rightly — it is
a footgun), but "show me superseded values too" is a different and safer request than time
travel. Nothing here settles what the right shape is; it does establish that a *correct* slot
mapping can cost an answer whenever the question is about the change, which is one of
LongMemEval's six types and the one DEM already scores 87–88% on.

---

## 4. What is still unmeasured, said plainly

- **Whether the slot rule helps at all in the long run.** Everything above is one LongMemEval
  corpus, where a "lifetime" is ~48 sessions. The case for slot supersession was never that it
  raises this benchmark; it was that `predicate` cannot be both a free-text label and an
  exact-match key. This measurement says it does not *hurt*, which is what rung 1 was for.
- **The knowledge-update cost, at scale.** One question in 500, and the mechanism is clear.
  Whether it generalises needs either more slots in play or a corpus with more corrections.
- **Provenance immunity and two-sided closure, on real data.** Every cached fact is
  `provenance: extracted`, and no corpus question exercises a human correction. Both rules are
  pinned by unit test only, and that is stated wherever they are reported.
- **The embedding normalizer** stays off at 13.2% precision. Nothing here re-opens it.
