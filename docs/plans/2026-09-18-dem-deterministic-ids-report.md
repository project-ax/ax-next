# dem-memory — making retrieval reproducible, measured

**Date:** 2026-09-18
**Change:** `idStrategy: 'content'` — derive a row's id from the statement instead of `randomUUID()`.
**Why it is its own change:** it moves which rows reach the answerer, so it moves every score by
an unknown amount. Landing that inside another change would be two changes at once.
**Facts:** pinned to extraction fingerprint `f4752a79`. The extraction prompt is untouched.

## The defect

`retain.ts` mints `id: randomUUID()`, and **every ranking tie-break in `recall.ts` is
`id.localeCompare(id)`** — the RRF fusion sort, the reranker reorder, and the graph channel.
RRF scores are sums of a few discrete `1/(k + rank)` terms, so exact ties are common and the
tie groups straddle both the 40-row rerank-pool boundary and the 15-row evidence boundary. A
random string decides which rows the answerer sees.

`bench/reproducibility-probe.ts`, on the deterministic stack with no model call anywhere,
ingesting the same question twice in one process:

| | `random` (shipped) | `content` |
|---|---|---|
| questions whose top-15 differs | **12 / 12** | **0 / 12** |
| questions whose top-15 row SET differs | 11–12 / 12 | 0 / 12 |
| row positions moved | 125–143 of 180 | 0 |

Proven by mutation rather than inferred: splicing a uuid back into the content path restores
12/12. Nothing else changed.

This is not only a bench property. All four recall channels apply `validityClause`, which
defaults to `valid_end = INFINITY`, so the candidate set is real; two consecutive asks of the
same question can be answered from different evidence.

## Does it cost accuracy?

n=500, `--sampler spaced`, GLM answerer, grok-4.3 judge, production stack, 4 runs per arm.

| | control (`random`) | treatment (`content`) |
|---|---|---|
| runs | 87.6, 88.0, 87.4, **86.8** | 87.4, 87.8, 87.6, **85.8** |
| mean | 87.45% | 87.15% |
| sd | 0.50pp | 0.91pp |

**Delta −0.30pp**, against a measured n=500 TOTAL noise floor of **1.6pp** on identical code.
Welch's t over the eight runs: t = −0.58, df 6, **p = 0.59**. No detectable difference.

Read the fourth treatment run honestly: at **85.8%** it is the lowest of all eight, and it is
what moved the delta from +0.15pp (three runs) to −0.30pp (four). It is not an anomaly —
85.8% is exactly the low end of the control-to-control spread this project already published
(85.8 / 87.4 on identical code, 2026-09-17). It ran alone rather than three-up, as `ids-ctrl-1`
did, and that run scored 87.6%, so there is no concurrency story here. It is one draw from a
distribution this bench has shown before.

**The default flips to `content` anyway, and the justification is NOT accuracy.** It is that
the same question asked twice should be answered from the same evidence — a product property,
not a score — and that paired row-by-row measurement becomes possible at all, which is what
`bench/closure-impact.ts` is built on. The arms exist to show the change does not COST
accuracy, and they show that.

## The second prediction failed, and it was mine

Pre-registered alongside the accuracy gate: the treatment's run-to-run spread should be
**tighter**, since making retrieval deterministic removes a noise source.

**It is wider — 0.91pp against the control's 0.50pp.** With four runs per arm an F-test has
almost no power (F = 3.3, df 3,3, p ≈ 0.35), so this is not evidence that determinism *widens*
anything. But the prediction was directional and the direction came out against it, and after
three runs it looked like it was holding at 0.20pp. Saying "no power" only once the sign turned
unfavourable would be choosing when the caveat applies.

**The useful conclusion is the one this rules out.** Retrieval nondeterminism is real and large
at the TABLE level — 12 of 12 questions get a different top-15, with different row sets — and it
still does not detectably move TOTAL accuracy variance at n=500. So the claim I made in the
rung-0 report, that this is "a concrete, removable part" of the bench's noise floor, **is not
supported by measurement and should not be repeated.** The floor is evidently dominated by the
answerer and the judge, which is what the published 1.6pp figure always described.

The determinism result itself is untouched: it rests on `bench/reproducibility-probe.ts` —
12/12 → 0/12, proven by mutation — which is a property of the store, not a statistic about
scores. What changes is the argument for caring about it: reproducibility for its own sake and
for the paired measurements it enables, not noise reduction.

## Two measurement artifacts worth knowing before quoting any number off this bench

**A resumed run keeps its stale `error` rows.** `bench/run.ts` resumes by skipping question ids
whose verdict is not `error` and APPENDING the retries; the old rows stay in the JSONL. After
retrying two Cohere 502s, `ids-det-3`'s file held 502 rows for 500 questions and the printed
summary still said `errors=2` although both retries had scored. **Read a resumed run by taking
the last row per `question_id`.** Deduped, that run is 438/500 with zero errors.

**An in-flight run looks finished.** The first version of the scoring script filtered on "no
errors", which a partially-complete run passes trivially: `ids-det-4` had scored 19 of 500,
read 89.5%, and pulled the treatment mean up by 0.7pp — half this bench's noise floor, in the
treatment's favour. **Gate on the denominator (`rows === 500`), never on the absence of
errors.** A prefix of a stratified sample is also a biased one, because the sampler interleaves
types so an early prefix over-represents whichever come first.

Cohere 502s were the only failures across eight n=500 runs: 3 rows out of 4,000.
