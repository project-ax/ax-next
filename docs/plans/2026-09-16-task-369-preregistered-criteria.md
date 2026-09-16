# Pre-registered "wrong the same way" criteria — written 2026-09-16T22:04Z

Written BEFORE the first replay row was scored (the resume JSONL
`task369-incorrect-repro.jsonl` did not exist at 22:04:11Z; run started 22:02Z and
the first question takes ~6 min). Recorded so the per-row "same wrong anchor"
call is a prediction checked against the replay, not a story fitted to it.

Definitions used in the report:

- **reproduces (raw)** — the replay verdict is `incorrect` or
  `abstained-incorrectly`. Any failure counts, whatever the mechanism.
- **same wrong anchor** — reproduces AND the replay's failure turns on the
  specific wrong value / substituted event named below.
- **different failure** — reproduces, but on a different value or mechanism.
  (Per TASK-365's framing: a repeat with the same wrong anchor is a defect; a
  different wrong answer each time is variance.)
- **did not reproduce** — verdict `correct` or `abstained-correctly`.

| id | 2026-09-14 wrong anchor | counts as "same wrong anchor" iff the replay… |
|---|---|---|
| `0a995998` | answered **2** store items, excluding the sister's sweater | answers 2 again (or otherwise misses the 3rd item) |
| `88432d0a` | counted **5** bakes, including the May-28 chicken wings | counts a planned/5th bake again |
| `32260d93` | led with stand-up, then also offered true-crime + history | recommends beyond stand-up again |
| `d24813b1` | ignored the lemon poppyseed anchor; pitched cookies / lemon-lavender | again misses lemon poppyseed |
| `91b15a6e` | **$5,200** — vanity minimum taken as $200, not the user's $150 | uses a vanity minimum other than $150 |
| `gpt4_7f6b06db` | included **Sequoia** (Feb 20, out of window), dropped **Muir Woods** | same substitution |
| `9a707b81` | had Mar 20 **and** Apr 10 and declined to subtract | declines to subtract / denies the combined event again |
| `gpt4_4fc4f797` | used the **May 15 planned** track day → 59 days | anchors on May 15 again |
| `gpt4_e061b84f` | substituted a **volleyball game** for the Midsummer 5K | same substitution |
| `6e984301` | "6 weeks as of Feb 11" → **~9 weeks** | reaches ~9 weeks / the same 6-week premise |
| `c9f37c46` | Feb → Apr called **3 months** | says 3 months again |
| `gpt4_93159ced_abs` | caught the false premise, then answered the adjacent question | keeps answering after the refusal again |
| `6a1eabeb` | returned the stale **27:12** over the later 25:50 | returns 27:12 again |
| `4b24c848` | named 5, failed on the **"at least 5"** hedge | hedges on 5 again |
| `a2f3aa27` | gave the range **"1,250–1,300"** + a staleness caveat | gives a range / staleness caveat again |

## TASK-368's reading of these 15 (the grouping the card asks me to report against)

- **bad gold (unwinnable as labelled)** — `0a995998`
- **strict (gold present verbatim, lost on style)** — `4b24c848`, `a2f3aa27`,
  `gpt4_93159ced_abs`
- **real** — the other 11: `88432d0a`, `32260d93`, `d24813b1`, `91b15a6e`,
  `gpt4_7f6b06db`, `9a707b81`, `gpt4_4fc4f797`, `gpt4_e061b84f`, `6e984301`,
  `c9f37c46`, `6a1eabeb`

  (1 + 3 + 11 = 15. TASK-368 scored 24 failures overall as 3 bad gold / 4 strict /
  17 real; the other 2 bad-gold and 1 strict rows are in the 9-refusal bucket
  TASK-365 replayed, not here.)

## Config note (appended 22:07Z, still before any row was scored)

First launch (22:02Z) ran at the harness default `--concurrency 1`, on the
assumption that matching TASK-365's replay was the comparable choice. Checking
the 2026-09-14 report's own `Command` line showed the BASELINE ran
`--concurrency 4`. The comparison this card makes is replay-vs-baseline, so the
baseline's concurrency is the one to match. Aborted at **0 scored rows** (the
resume JSONL did not exist) and relaunched at `--concurrency 4` at 22:07Z.
~$0.03 of extraction on the first question is discarded and is NOT in the
reported total.

---

## Addendum, added after the run (the record above is left as written)

Two things this file got wrong at write time, corrected here rather than edited
above, because a pre-registration that gets tidied afterwards is not one:

1. The parenthetical quotes TASK-368's headline as "3 bad gold / 4 strict / 17
   real". Its own per-row table parses to **3 / 3 / 18** — see the report's
   correction section. The grouping of these 15 (1 bad gold, 3 strict, 11 real)
   is unaffected, because it was taken from the per-row table.

2. The `88432d0a` criterion reads "counts a planned bake again". That is the
   right criterion and it was met, but the report's first draft then argued the
   row *refuted* the plans-as-events mechanism, on the strength of the agent
   excluding a planned focaccia by name. Checking the corpus showed the chicken
   wings it counted are themselves a plan from the same session, so the row
   instantiates the mechanism rather than refuting it. Caught in review.

Outcome against the predictions: **11 of the 12 reproducing rows matched their
criterion.** The miss is `gpt4_7f6b06db`, predicted to return Sequoia again and
observed to have invented two entirely new wrong trips instead — which is why it
is the one row classed as variance rather than a stable defect.
