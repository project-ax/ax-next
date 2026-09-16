# TASK-369 — how many of the 15 `incorrect` rows actually reproduce

**The card asked:** re-run all 15 `incorrect` rows from the 2026-09-14 n=100 e2e
run through the scored path, count how many are wrong again, and say whether the
ones that are are wrong *the same way*.

**Answer: 12 of 15 — and 11 of those 12 are wrong the same way.**

| | n |
|---|---|
| **failed again** | **12/15** |
| did not reproduce (came back `correct`) | 3/15 |
| of the 12, **same wrong anchor as the scored run** | **11** |
| of the 12, wrong differently | 1 |
| identical verdict string | 11/15 |

This is the opposite shape to TASK-365. There, 6 of 9 refusals evaporated on a
second draw and the bucket split into two populations. Here the bucket is
**mostly one population**: a wrong answer that is wrong for a stable, nameable
reason, usually to the digit. `91b15a6e` returned **$5,200** both times.
`gpt4_4fc4f797` computed **59 days** from the same two dates both times.
`6a1eabeb` returned **27:12** both times. `c9f37c46` said **3 months** both
times.

**Cost: $1.3103**, against the card's ~$1.2 estimate. Wall clock 28m53s.

**Do not read this as a verdict on 76.0%.** That stays the product number. This
is a deliberately-biased fixed set — it *is* the failure bucket — and the
harness's own 20.0% headline for the run means nothing outside this report.

---

## The two rates the card asked for

TASK-365 reported a raw rate and a "for a reason memory can fix" rate, holding the
denominator fixed and reducing the numerator. Same convention here:

| | |
|---|---|
| failed again (raw, as scored) | **12/15** |
| failed again *for a reason memory can fix* | **9/15** |

The 3 subtracted are the rows TASK-368 reads as not winnable by any memory
change, which reproduced anyway: `0a995998` (bad gold — the gold counts 3 store
items where the corpus supports 2), `4b24c848` and `gpt4_93159ced_abs` (strict —
the gold is present in our own answer and the row was failed on style).

Cross-check from the other direction, because a ratio nothing recomputes is the
part most likely to be wrong: of the **11** rows TASK-368 reads as *real*, **9**
reproduced (`d24813b1` and `gpt4_e061b84f` did not). Both derivations give 9.

---

## Every row

MEASURED — each row executed once through the scored path and observed. Nothing
in this table is inferred from reading code.

| question | type | TASK-368's reading | scored 2026-09-14 | replay | same wrong anchor? | $ |
|---|---|---|---|---|---|---|
| `0a995998` | multi-session | bad gold | incorrect | **incorrect** | yes — "**2 items**", same two | 0.074 |
| `88432d0a` | multi-session | real | incorrect | **incorrect** | yes — **5 bakes**, wings again | 0.157 |
| `32260d93` | ss-preference | real (weak) | incorrect | **incorrect** | yes — true crime + history again | 0.098 |
| `d24813b1` | ss-preference | real | incorrect | **correct** | — | 0.103 |
| `91b15a6e` | multi-session | real | incorrect | **incorrect** | yes — **$5,200**, vanity at $200 | 0.077 |
| `gpt4_7f6b06db` | temporal | real | incorrect | **incorrect** | **no — different wrong trips** | 0.087 |
| `9a707b81` | temporal | real | incorrect | **abstained-incorrectly** | yes — declines to link, again | 0.099 |
| `gpt4_4fc4f797` | temporal | real | incorrect | **incorrect** | yes — **59 days** from May 15 | 0.096 |
| `gpt4_e061b84f` | temporal | real | incorrect | **correct** | — | 0.078 |
| `6e984301` | temporal | real | incorrect | **incorrect** | yes — **8–9 weeks**, same premise | 0.073 |
| `c9f37c46` | temporal | real | incorrect | **incorrect** | yes — **3 months** | 0.096 |
| `gpt4_93159ced_abs` | temporal | strict | incorrect | **incorrect** | yes — refutes, then answers | 0.076 |
| `6a1eabeb` | knowledge-update | real | incorrect | **incorrect** | yes — **27:12** | 0.054 |
| `4b24c848` | knowledge-update | strict | incorrect | **incorrect** | yes — hedges past 5 | 0.072 |
| `a2f3aa27` | knowledge-update | strict | incorrect | **correct** | — | 0.071 |

**Ingest fidelity: 15/15 ingested the full haystack**, `sessionsIngested` identical
to the scored run on every row (46.9 average, matching the baseline's 47.8 across
its own 100). No cost-cap truncation, so the replay saw the same input. No
observer or consolidator failures in the log.

---

## The one row that is variance, and it is not subtle

**`gpt4_7f6b06db`** — "the order of the three trips I took in the past three
months". It failed both times and named a **completely different** wrong set:

| run | trips it returned |
|---|---|
| 2026-09-14 | Sequoia NP (Feb 20) → Big Sur/Monterey → Yosemite |
| replay | Big Sur/Monterey → **Dubai & Abu Dhabi** → **Golden Week (Himeji/Kobe/Osaka)** |

Gold is Muir Woods → Big Sur/Monterey → Yosemite. So the *stable* part is that
**Muir Woods is missing both times** and Big Sur is found both times; the rest of
the answer is drawn fresh. This is the one row in the 15 where "fix the wrong
anchor" has no anchor to fix — there is no repeated wrong value, only a repeated
gap. Treat it as a retrieval-recall row, not a reasoning row.

---

## `9a707b81` changed failure mode — and that retro-invalidates an attribution

It went `incorrect` → `abstained-incorrectly`. The underlying behaviour is
unchanged: both times it found the class and the cake, both times it declined to
connect them.

| run | what it did |
|---|---|
| 2026-09-14 | dated the class **Mar 20** and the cake **Apr 10**, then denied a combined event |
| replay | dated the class **Mar 21** and the cake **Apr 10**, then said memory has no linked event |

Worth noting that on 2026-09-14 the two dates it printed are **exactly 21 days
apart, which is the gold answer**. It had the arithmetic in hand and refused to
do it.

The consequence is for a different report. `2026-09-15-answer-stage-arms-report.md`
lists `9a707b81` as a **regression caused by the scaffold** — "went from a wrong
answer to a refusal, growing the false-refusal bucket". This replay makes the
same transition **with no code change at all**, so that transition is inside
unaided variance and is not attributable to the scaffold from one treatment draw.

---

## What this does to the answer-stage screen (the biggest downstream consequence)

The answer-stage-arms report names this exact run as its missing control:

> **TASK-369** — Still unrun and still gates any small claim. 15 of the 19
> attributable rows here have **no control draw**, so the adjusted numbers are an
> **upper bound** on both arms.

The control now exists. Of the **6** rows that report credits to the recall
scaffold, **3 fix themselves with no change at all**:

| row | scaffold | unaided control (this run) | still attributable? |
|---|---|---|---|
| `d24813b1` | FIXED | **correct** | **no** |
| `91b15a6e` | FIXED | incorrect | yes |
| `gpt4_e061b84f` | FIXED | **correct** | **no** |
| `c9f37c46` | FIXED | incorrect | yes |
| `4b24c848` | FIXED | incorrect | yes |
| `a2f3aa27` | FIXED | **correct** | **no** |

| arm | adjusted fixes as published | attributable after this control |
|---|---|---|
| recall scaffold (TASK-370) | 6 | **3** |
| adaptive thinking (TASK-371) | 1 | **0** |

Adaptive thinking's single adjusted fix was `gpt4_e061b84f`, which moves on its
own. Its measured attributable count on this set is now zero.

**The caveat that keeps this honest:** the control is n=1 per row, so "moves on
its own" is one observation, not a proven rate. A row that moved once could still
be genuinely helped by the scaffold — what is gone is the *attribution* from a
single treatment draw. That is precisely the standard the arms report itself
applied when it discounted five rows using TASK-365's control, so applying it
here is consistency, not a new bar.

---

## What this does to TASK-363

TASK-365 recommended rewriting TASK-363 around **"a stated intention is stored and
then recalled as a completed event"**, naming three rows as one mechanism and
gating the rewrite on this run. The gate returns a split verdict:

| row | the claimed mechanism | replay |
|---|---|---|
| `gpt4_4fc4f797` | used the *planned* May-15 track day | **reproduces, same anchor** |
| `88432d0a` | counted a *planned* chicken-wing bake | reproduces (still **5**) — but see below |
| `gpt4_e061b84f` | substituted a *planned* volleyball game | **did not reproduce** |

So it is 2/3 at best, and `88432d0a` argues against the mechanism even while
failing. In the replay the agent **explicitly applied plan-vs-event discipline**
and said so:

> "(Note: The focaccia was planned for the weekend of May 28 but I don't have a
> confirmed record that you actually baked it.)"

It excluded a plan by name and still counted five. On 2026-09-14 it excluded a
different plan by name — *"The tart … is still planned and hasn't been baked
yet"* — and still counted five. Twice the agent demonstrated the discipline the
proposed fix would teach it, and twice it over-counted anyway. Its two lists are
also not the same five: the dates move (cookies ~May 18 vs May 22, baguette ~May
24 vs ~May 20) and the fifth item is the wings both times.

**Recommendation: do not rewrite TASK-363 around plans-as-events on this
evidence.** One row supports it cleanly (`gpt4_4fc4f797`), one refutes it
(`gpt4_e061b84f`, which now answers correctly unaided), and one fails for a
reason the mechanism does not explain (`88432d0a`). A card built on "three rows,
one mechanism" would be built on one row.

---

## The stable core: 9 rows, 4 mechanisms

The 9 memory-addressable reproductions, grouped by what actually went wrong. All
9 reproduced with the same anchor except `gpt4_7f6b06db`.

**Arithmetic/derivation with the inputs in hand (3).** `9a707b81` had both dates
and would not subtract. `c9f37c46` had both anchors (Feb, Apr) and called it 3
months. `6e984301` had the Feb-11 "6 weeks" and the Mar-4 purchase and reached
8–9 weeks. Nothing about retrieval or extraction reaches these.

**A qualifier dropped from a stored number (2).** `91b15a6e` used $200 for the
vanity where the user's own floor is $150 — twice, to the same $5,200.
`6a1eabeb` returned the stale 27:12 over the later 25:50 — twice, and in the
replay it added a confident date and an exclamation mark.

**Counting/ordering over a set (3).** `0a995998` (2 vs 3, bad gold), `88432d0a`
(5 vs 4), `gpt4_7f6b06db` (wrong trips, unstably wrong).

**Over-answering (1).** `32260d93` led with the gold preference and then offered
true crime and history again, on both draws.

The first two groups — 5 rows — are the sharpest target in the set: the value is
in memory, it is retrieved, and it is then used wrongly in a way that repeats
verbatim. That is a defect, not a draw.

---

## Correction to TASK-368: its headline does not match its own table

Free, and found while assembling the grouping this card asked for. Parsing
TASK-368's **"Every row, with its reading"** table (24 rows, 24 unique ids):

| | per-row table | report headline |
|---|---|---|
| bad gold | 3 | 3 |
| strict | **3** | **4** |
| real | **18** | **17** |

The extra `strict` is `eaca4986`. Its strict-evidence table lists **five** rows
under a header reading "The 4", and **two** of them (`eaca4986`, `7024f17c`) are
explicitly already counted among the 3 bad-gold rows; the parenthetical excuses
only one of the two. 5 − 2 = 3, which is what the per-row table independently
says.

| TASK-368 stated | corrected |
|---|---|
| 76.0% product number | unchanged — **76.0%** |
| 79.0% excluding 3 known-bad-gold rows | unchanged — **79.0%** |
| 83.0% if the strict rows also went our way | **82.0%** |
| "~17 points of the 24 are ours to win" | **~18 of 24** |

Neither the shipped number nor the 3-id bad-gold list moves. One row shifts from
"winnable-but-scored-wrong" to "real", which makes the addressable bucket
slightly *larger*.

```bash
python3 - <<'PY'
import re
from collections import Counter
txt = open('docs/plans/2026-09-15-task-368-gold-quality-audit.md').read()
sec = txt.split('## Every row, with its reading')[1]
rows = [l for l in sec.splitlines() if l.startswith('| `')]
c = Counter()
for l in rows:
    cells = [x.strip() for x in l.strip('|').split('|')]
    c[re.sub(r'\*|\s*\(weak\)', '', cells[3]).strip()] += 1
print(len(rows), 'rows ->', dict(c))
PY
```

---

## Method

**The premise was checked before it was spent against, and it holds.** The card's
15 ids are exactly the 15 `incorrect` rows in `2026-09-14.jsonl` — symmetric
difference empty in both directions, 15 listed, 15 unique. The file has **101
lines for 100 unique questions** (`c14c00dd` is written twice); that row is not
one of the 15 and 76.0% is unaffected. All 15 resolve in the corpus; total
haystack 704 sessions.

**What counted as "reproduces":** the replay verdict is `incorrect` or
`abstained-incorrectly`. All 15 were `incorrect` at baseline, so a row returning
`abstained-incorrectly` still counts as failing again, and is broken out —
`9a707b81` is the only one.

**What counted as "wrong the same way":** reproduces AND the failure turns on the
same wrong value or substituted event. **The per-row criteria were written down
before the first row was scored** (`preregistered-criteria.md`, 22:04:11Z; the
resume JSONL did not exist until 22:14Z), so each call is a prediction checked
against the replay rather than a story fitted to it. 11 of 12 matched the
prediction; the miss is `gpt4_7f6b06db`, predicted "Sequoia again" and observed
to have invented two new trips instead.

**n = 1 per question.** A row that answered correctly once is not proven stable;
it is proven *not reproducible from one observation*, which is all that is
claimed. This cuts both ways and is why the scaffold de-attribution above is
stated as "not attributable", not as "the scaffold does nothing".

**Config.** Planner `z-ai/glm-5.3-flash:nitro` (config E, `reasoning: minimal`) ·
answer `claude-sonnet-4-6`, no scaffold, no thinking arm · Observer/consolidator
`z-ai/glm-5.3-flash:nitro` · judge `x-ai/grok-4.3` · `--concurrency 4` · cap $3.

**On concurrency.** The 2026-09-14 baseline ran `--concurrency 4` (its report's
own `Command` line). This card compares replay against that baseline, so the
baseline's concurrency is what to match. A first launch at the harness default of
1 was aborted at **0 scored rows** and relaunched; ~$0.03 of extraction on it is
discarded and is not in the $1.3103. For the record, **TASK-365 replayed its 9 at
the default 1** against the same concurrency-4 baseline and does not note the
difference — worth knowing when comparing the two cards' rates.

**Comparing to TASK-365 fairly.** Its headline is "refused again, **3/9**". Its
*failed again* rate is **4/9**, because `7024f17c` stopped refusing and failed on
a hedge instead. These 15 were all `incorrect`, so 12/15 belongs next to 4/9, not
next to 3/9.

**Traps.** `--resume` is date-stamped; a fresh id (`task369-incorrect-repro`) was
verified absent before launch. `--out` is a silent no-op in `--mode e2e` — parsed
at `cli.ts:211`/`:239`, never passed to `runE2EMode` at `:254`, report path
hardcoded at `e2e-cli.ts:406-413`, and **no test covers it** (INFERRED from
reading the code, not executed). The harness report was copied to
`2026-09-16-task-369-repro-rate-raw.md` and the generic path removed; no tracked
file was overwritten. Finally, **a `pgrep` miss is not evidence a run is dead —
and here the probe was the thing that was wrong**: `pgrep -f 'tsx
test/bench/cli.ts'` can never match, because the real command line is
`…/node_modules/tsx/dist/cli.mjs test/bench/cli.ts …`. It reported "process gone"
on a healthy run; corroborating against log mtime, observer-run count and `ps`
settled it in seconds. Use `pgrep -f 'test/bench/cli.ts'`.

## Reproducing

```bash
set -a && . ./.env.walk && set +a
# --resume must be a FRESH id; the checkpoint is date-stamped.
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --ids 0a995998,88432d0a,32260d93,d24813b1,91b15a6e,gpt4_7f6b06db,9a707b81,gpt4_4fc4f797,gpt4_e061b84f,6e984301,c9f37c46,gpt4_93159ced_abs,6a1eabeb,4b24c848,a2f3aa27 \
  --concurrency 4 --cap 3 --resume <fresh-id>

# free: compare the two runs question-by-question
python3 - <<'PY'
import json, os
C = os.path.expanduser('~/.cache/ax-memory-bench/longmemeval-s-e2e')
orig = {}
for l in open(f'{C}/2026-09-14.jsonl'):
    r = json.loads(l); orig[r['questionId']] = r
rep = [json.loads(l) for l in open(f'{C}/task369-incorrect-repro.jsonl')]
FAIL = {'incorrect', 'abstained-incorrectly'}
for r in rep:
    print("%-22s %-12s -> %s" % (r['questionId'], orig[r['questionId']]['verdict'], r['verdict']))
print("failed again: %d/%d" % (sum(1 for r in rep if r['verdict'] in FAIL), len(rep)))
PY
```

Raw harness output: `docs/plans/2026-09-16-task-369-repro-rate-raw.md`
Source: `docs/plans/2026-09-15-task-365-repro-rate-report.md`
Companions: `docs/plans/2026-09-15-task-368-gold-quality-audit.md`,
`docs/plans/2026-09-15-answer-stage-arms-report.md`
