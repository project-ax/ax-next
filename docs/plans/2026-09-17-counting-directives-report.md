# Counting directives: a null effect, a replicated regression, and an empirical noise floor

**Date:** 2026-09-17 · **Engine:** glm-5.3-flash on both ends · **Judge:** x-ai/grok-4.3
**Corpus:** LongMemEval-S, n=500 (full) · **Facts:** extraction generation `f4752a79`, pinned
with `--fingerprint`, so all four arms answer from the identical 130,779 facts that produced
the 87.4% baseline, with zero extraction calls.

## What was tested

Four reflect-prompt directives aimed at the diagnosed multi-session failures — gated
arithmetic, single-number count commitment, event coreference, and event-date-over-statement-date.
Every clause was gated on the evidence being present, and directive 8 handed the zero case
back to the abstention directive explicitly, because all four push toward answering more.

Reader-side only: retrieval was untouched, so an arm differs from its control by the prompt
alone. Two control arms and two treatment arms, same binary, differing by
`--counting-directives`.

## Result: null on accuracy

| type | n | ctrl 1 | ctrl 2 | ctrl spread | treat 1 | treat 2 | treat spread | effect |
|---|---|---|---|---|---|---|---|---|
| multi-session | 133 | 75.9% | 81.2% | **5.3** | 80.5% | 80.5% | 0.0 | +1.9 |
| temporal-reasoning | 133 | 88.0% | 86.5% | 1.5 | 87.2% | 89.5% | 2.3 | +1.1 |
| knowledge-update | 78 | 87.2% | 91.0% | 3.8 | 89.7% | 87.2% | 2.6 | −0.6 |
| single-session-user | 70 | 98.6% | 98.6% | 0.0 | 100.0% | 98.6% | 1.4 | +0.7 |
| single-session-assistant | 56 | 89.3% | 91.1% | 1.8 | 89.3% | 91.1% | 1.8 | +0.0 |
| single-session-preference | 30 | 80.0% | 76.7% | 3.3 | 70.0% | 80.0% | **10.0** | −3.3 |
| **TOTAL** | 500 | **85.8%** | **87.4%** | **1.6** | **86.8%** | **87.6%** | 0.8 | **+0.6** |

Paired McNemar, exact: pair 1 TOTAL 23W/18L **p=0.533**; pair 2 TOTAL 19W/18L **p=1.000**.
multi-session, the target type: pair 1 +4.5 (13W/7L, p=0.263), pair 2 −0.8 (9W/10L, p=1.000).
**The sign of the target-type effect depends on which control you pair against.**

## Result: a replicated regression on false refusal

| arm | hallucination (30 `_abs`) | false refusal (470 answerable) | count |
|---|---|---|---|
| control 1 | 26.7% | 1.7% | 8 |
| control 2 | 13.3% | 1.1% | 5 |
| treatment 1 | 26.7% | **2.6%** | 12 |
| treatment 2 | 13.3% | **3.4%** | 16 |

Hallucination is **unchanged within every pair** — the 13.4pp control-to-control gap is run
noise on n=30, not an effect. False refusal is the only metric that separates: the control
range [1.1, 1.7] and the treatment range [2.6, 3.4] **do not overlap**, and refusals roughly
doubled, 6.5 → 14 questions on average.

The mechanism is the gating itself. Directive 7's "if an operand is missing, say which one"
and directive 8's hand-off to directive 3 are low-risk, high-compliance exits. On a
colloquially phrased aggregation question, a model told to check its operands scrutinises a
borderline mention, decides the boundaries are not explicit, and takes the exit. The
directives bought discipline and paid in willingness.

**Decision: reverted.** An effect inside the noise band, bought with a replicated regression on
the safety boundary, at extra prompt tokens and latency.

## The most valuable artifact: an empirical n=500 noise floor

Two runs of **identical code** on the same 500 questions, same judge:

- **TOTAL 85.8% vs 87.4% — 1.6pp**, 28W/20L, p=0.312.
- **multi-session 75.9% vs 81.2% — 5.3pp**, larger than the binomial SE (~3.4pp) at n=133 that
  the previous error budget assumed, and larger than the effect it was used to evaluate.
- **knowledge-update 3.8pp**, single-session-preference 3.3pp (and 10.0pp between the two
  treatment arms — SE at n=30 is ~7.9pp, so three questions move it 10 points).
- **hallucination 26.7% vs 13.3% — 13.4pp**, i.e. 8/30 vs 4/30.

Consequences:
1. The **87.4% headline is robust** — 85.8 / 87.4 on identical code, with the stored baseline at
   87.4 inside that range. The `confidence` removal is confirmed neutral.
2. **No per-type claim at n=133 is interpretable from one run per arm.** multi-session moves
   5.3pp for free.
3. **No abstention claim at n=30 is interpretable from one run per arm.** It moves 13.4pp for free.

## A metric correction that changes a published claim

On `_abs` questions the judge returns **`correct`** for a refusal written in prose — e.g.
`80ec1f4f_abs` answered `[DATA_ABSENT]` plus an explanation. Counting every non
-`abstained-correctly` verdict as a hallucination therefore penalises the desired behaviour.
Only a judge verdict of `incorrect` is an invented answer.

| arm | as previously reported | corrected |
|---|---|---|
| dem GLM n=500 | 26.7% | **20.0%** (6/30) |
| dem Sonnet n=500 | 36.7% | **26.7%** (8/30) |

Strata's reference is 20.0%, so dem-GLM is **level with Strata on hallucination**, not
materially worse, while keeping the far lower false-refusal rate. The claim that abstention is
"the worst failure mode available, the thing to fix before claiming dem is better" was
overstated.

## Two retrieval fixes that do not survive contact

Proposed alongside the prompt arm, both rejected on measurement rather than opinion:

- **Per-subject candidate quota** (`MAX_ROWS_PER_SUBJECT = 2`) to stop query-entity crowding.
  `subject` in dem is the **speaker**, not the entity: `assistant` 52.3% and `user` 37.7% of
  130,779 facts, **90.0% in two values**. The crowded table in `gpt4_7fce9456` is 12 `user` +
  3 `assistant`, so the cap would cut it to ~4 rows and still not separate Brookside from
  Cedar Creek — both are `user` facts. The crowding entity lives in the predicate/object text.
- **MMR** as the entity-agnostic substitute. Measured on the real candidate list: Cedar Creek
  sits at **rank 16 of 40**, and MMR at λ=0.5 and λ=0.7 **both fail to admit it**. The six
  Brookside rows are semantically but not lexically redundant (`made offer on`,
  `is purchasing property`, `saw townhouse on` share few tokens), so token-set similarity
  cannot see the redundancy. Only a larger table admits rank 16, and that is Path A, already
  measured null.

Also rejected: renaming the `When` column to "Session Recorded Date". `When` equals the session
date **93.0%** of the time (121,635/130,779; 1.9% after, 5.1% before), so the label is mostly
accurate — but it rewrites the signal behind 90.2% on 133 temporal questions to fix one
multi-session question, and `51c32626`'s gold date lives in a **different row**
(`ACL conference, whose submission date was February 1st`, rank 2), so no header change makes
the model combine rank 1 with rank 2.

## Reproduce

```bash
npx tsx bench/run.ts --n 500 --stack production --sampler spaced \
  --fingerprint f4752a79 --out-dir bench/results/<arm> [--counting-directives]
npx tsx bench/compare-arms.ts bench/results/<control> bench/results/<treatment>
```

`--fingerprint` is read-only: a pinned run errors on a cache miss rather than extracting with
the current prompt and filing the result under the pinned generation's key.
