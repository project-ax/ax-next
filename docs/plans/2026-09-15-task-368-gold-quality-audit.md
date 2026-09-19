# TASK-368 — how much of the failure set is bad gold

**The card asked:** of the 24 scored failures in the 2026-09-14 n=100 e2e run, how
many are unwinnable because the *label* is wrong rather than because our memory is?

**Answer: 3 of 24 are unwinnable. 3 more are winnable-but-scored-wrong. 18 of 24 are
real.**

*(Corrected 2026-09-19, TASK-394: the headline originally read "4 strict / 17 real".
That double-counted `eaca4986` — it is bad gold (see below) and was also carried into
the strict-evidence table. The "Every row, with its reading" table below was right
throughout: 3 / 3 / 18. See "The 3 that are unwinnable" and the corrected section
below for why `eaca4986` belongs in bad-gold only.)*

| reading of each failure | n | share of the 24 |
|---|---|---|
| **bad gold** — no correct answer exists, or the gold contradicts its own dates | **3** | 12.5% |
| **gold sound, scoring strict** — the pipeline emitted the gold value and still failed | **3** | 12.5% |
| **real** — memory, retrieval, or the agent's reasoning genuinely failed | **18** | **75.0%** |

**The card's own premise does not survive the audit.** It opened from "two of the 9
false refusals look like bad gold — if that rate holds (22%)…". Only **one** of its two
worked examples holds up. `gpt4_fa19884d` is sound gold: the user states the answer
almost verbatim, and the TASK-361 report read that session wrong. Corrected and
extended to all 24, the clear bad-gold rate is **12.5%, not 22%**.

**What this does to 76.0%.** Nothing. 76.0% stays the product number — it is what the
shipped pipeline scores against the published benchmark, and that is the figure that
stays comparable to our own history and to everyone else's. What the audit buys is a
*band* around the addressable part:

| | |
|---|---|
| scored product number (unchanged, quote this) | **76.0%** |
| ceiling if the 3 unwinnable rows were removed | 79.0% |
| ceiling if the 3 strict-scored rows also went our way | **82.0%** |
| headroom that is actually ours to win | **~18 points of the 24** |

So label noise is real and worth knowing about, but it is **not** the story. Three
quarters of the failure set is ours.

---

## The 3 that are unwinnable

### `7024f17c` — the gold contradicts its own dates

> "How many hours of jogging and yoga did I do last week?" — gold **0.5 hours**

The question is dated **2023/05/30 (Tue)**. The only jog anywhere in the corpus is a
30-minute jog the user logs in a session dated **2023/05/20 (Sat)**, ten days earlier.
Gold's 0.5 hours *is* that jog.

There is no reading of "last week" from Tuesday May 30 that reaches May 20:

| reading of "last week" | window | May 20 inside? |
|---|---|---|
| previous ISO week (Mon–Sun) | May 22 – May 28 | no |
| previous Sun-start week | May 21 – May 27 | no |
| trailing 7 days | May 23 – May 30 | no |

Our agent found the jog, dated it correctly, and excluded it — *"One 30-minute jog
recorded on May 20 (a Saturday), which falls just outside last week"* — then said it
could not give a total. That is the correct behaviour, scored as a false refusal.

The date the agent reasons from is not a guess on its part: `e2e-driver.ts:289` passes
`sample.question_date` through to `buildAnswerSystem`, which appends
`Today's date: 2023/05/30 (Tue) 21:24` to the system prompt. So the agent is told the
question date explicitly and excludes the jog on that basis, correctly.

Memory did its job here. The label is wrong.

**TASK-365's replay makes the same point from the other side.** On a second draw the
agent did *not* refuse — it reached 0.5 hours, but only by inventing a window the
question does not support: *"here's what I have for last week (the week of **May
20–26**)"*. It then still failed, on the hedge (*"the confirmed total is **at least 0.5
hours** of jogging"*). Two runs, two different failure modes, correct memory both
times.

### `eaca4986` — the gold names an artifact the corpus does not contain

> "…what was the chord progression for the chorus in the second song?" — gold
> **C D E F G A B A G F E D C**

The source session is one prompt — *"Create a sad song with notes"* — and a rewrite
request. The assistant replies with **melodic note lines** above each lyric. No chord
progression is produced anywhere in the exchange. The gold takes the second song's
chorus note line and calls it "the chord progression".

Then the part that makes this the sharpest row in the set:

> **The agent's answer contains the gold string verbatim.**
> *"The second song … featured the chorus 'You're the one I want, the one I need' with
> the melody **C D E F G A B A G F E D C**. But the exact chord progression for the
> second song's chorus wasn't saved in my memory."*

Memory retained the value exactly. The agent printed it exactly. It then correctly
declined to call a melody a chord progression — and was scored
`abstained-incorrectly`.

**TASK-365 replayed this row the same day and it happened again**, which removes any
doubt that it was a one-off phrasing accident:

> "**Song 2** (romantic rewrite): Chorus melody — **C-D-E-F-G-A-B-A-G-F-E-D-C**. The
> chord progressions weren't saved in my long-term memory."

And this time the judge's own stated reason concedes the match while failing the row:

> "Agent refused on chord-progression grounds **even though … the gold note sequence
> exactly matches the melody it recalled for song 2**."

That is the strongest single piece of evidence in this audit: the scorer names the
correspondence and marks it wrong anyway.

(Minor, same row: the question says "two sad songs". The second song is the *romantic*
rewrite, explicitly not sad. The agent resolved "second song" correctly anyway.)

### `0a995998` — the gold over-counts

> "How many items of clothing do I need to pick up or return from a store?" — gold **3**

Searching the whole 44-session haystack for pick-up/return language turns up exactly
two store items:

1. **navy blue blazer** — awaiting pickup from the dry cleaner
2. **Zara boots** — exchanged 2/5 for a larger size, new pair not yet collected

The only third clothing item in play is a **green sweater the user lent to their
sister**. That is the sister returning something to the user, not the user returning
something to a store.

Our agent answered **2** and said why: *"(Your green sweater is lent to your sister,
but that's not a store pickup/return situation.)"* Reaching 3 requires counting the
sweater, or double-counting the single Zara exchange as both a return and a pickup.
Neither is stated.

---

## The 3 where we produced the gold and lost anyway

These are not bad gold. The gold is right, the pipeline retrieved it, and the answer
was still marked wrong. Verified by exact substring match against the scored
`agentAnswer`, not by eyeballing. The table below lists **five** rows because two of
them — `eaca4986` and `7024f17c` (TASK-365 replay) — are **already counted** among the
3 bad-gold rows above: both are listed here only because they *also* fail this same
"gold present verbatim, still marked wrong" pattern, not because either is a member of
this group. (Corrected 2026-09-19, TASK-394: an earlier version of this section header
said "The 4" and folded `eaca4986` into the strict count, double-counting it against
its own bad-gold classification above. Only `4b24c848`, `a2f3aa27`, and
`gpt4_93159ced_abs` are strict-scored; that is the group this section is actually
about.)

| question | gold | present verbatim in our answer? | why it was failed |
|---|---|---|---|
| `eaca4986` (bad gold, see above — not a member of this group) | `C D E F G A B A G F E D C` | **yes** | labelled it "melody", declined to call it a chord progression |
| `4b24c848` | `five` | **yes** ("5 H&M tops") | hedged "at least 5" |
| `a2f3aa27` | `1300` | **yes** ("1,250–1,300") | gave a range and a staleness caveat |
| `7024f17c` (TASK-365 replay; bad gold, see above — not a member of this group) | `0.5 hours` | **yes** ("at least 0.5 hours") | hedged on the yoga half |
| `gpt4_93159ced_abs` | "…you haven't started working at Google yet" | **yes** ("no record of you working at Google") | rejected the false premise, then kept helping |

Two deserve the detail:

**`4b24c848`** — "How many tops have I bought from H&M so far?", gold *five*. The corpus
says *three* on Aug 11 and *"I've already got five tops from H&M so far, **and I'm
thinking of getting a few more**"* on Sep 30. The question is asked Oct 20. Our answer
named 5 and flagged that the user was mid-shopping-trip at the last data point. The
hedge is the corpus being honest, and it is what cost the row.

**`gpt4_93159ced_abs`** — this is an `_abs` row, the split that exists to test whether a
model refuses when it should. The agent **did the thing the split tests**: it caught
that there is no Google job at all. It then answered the adjacent question about
NovaTech, and the judge scored the whole row `incorrect`. Reasonable people can score
that either way; what is not in question is that the false-premise detection worked.

One more, `32260d93`, sits at the edge of this group. It is a
`single-session-preference` row whose "gold" is a rubric — *"would prefer stand-up
comedy specials on Netflix … may not prefer recommendations for other genres or
platforms"*. Our answer **led with exactly that**, including Hasan Minhaj's *Homecoming
King*, the corpus's own first recommendation. It failed for *also* offering true-crime
picks. But the same haystack has the user saying *"I was surprised by how much I got
into the true crime genre — I mean, I listened to 5 days straight of Crime Junkie"*.
The rubric's exclusion clause is contradicted by the corpus it was written from. I have
counted this row as **real** rather than strict-scored, because the agent did overreach
past what was asked — but it is the weakest "real" in the set.

---

## Correction to the TASK-361 report

`gpt4_fa19884d` is **not** bad gold, and the previous report should not have said it
was. It read the evidence session as the user only *asking for* bluegrass
recommendations. The last user turn of that session (Fri 2023/03/31, and the question
is dated Wed 2023/04/05, so "last Friday" resolves exactly) says:

> "I recently discovered **a bluegrass band that features a banjo player** and started
> enjoying their music **today**."

Gold is *"a bluegrass band that features a banjo player"* — lifted from that sentence.
The date is right, the phrasing is right, and the value is stated by the user. Our
agent refused. That is a **real** failure and it moves from the bad-gold column to the
addressable one.

This is the second time in this track that a per-question judgment flipped on a closer
read of the source rather than on new measurement, which is an argument for spending
the free-and-exhaustive audits early.

---

## A corpus artifact worth knowing about, measured across all 500

Separate from gold quality: **94 of 500 LongMemEval-S questions (18.8%) have a haystack
whose sessions all carry the same calendar date**, and **44 of 500 (8.8%) have at least
one evidence session timestamped *after* the question was asked.**

| | corpus (n=500) | scored (n=100) | failures (n=24) | non-failures (n=76) |
|---|---|---|---|---|
| zero-day haystack span | 94 (18.8%) | 17 | **6 (25%)** | 11 (14.5%) |
| ≥1 evidence session after the question | 44 (8.8%) | 10 | **4 (16.7%)** | 6 (7.9%) |

Zero-span haystacks are concentrated in exactly the question types that care most:
60 of the 94 are `temporal-reasoning`, 31 are `multi-session`. On those rows the session
timestamps carry **no** temporal signal at all — every ordering fact has to come from
relative phrases inside the text ("last month", "three weeks ago", "yesterday"). And on
the 8.8%, the agent is asked at 17:49 about something the user only says at 18:55.

The enrichment among failures is real but modest — about 1.7×. This does not rescue any
row and I am not proposing to exclude any on this basis. It is worth recording because
it is a standing reason temporal-reasoning is the worst block, and because anyone
building a temporal fix should know the timestamps are not the ground truth they look
like.

---

## Every row, with its reading

| question | type | scored | reading | why |
|---|---|---|---|---|
| `7024f17c` | multi-session | abstained-incorrectly | **bad gold** | counts a May-20 jog as "last week" for a May-30 question |
| `eaca4986` | ss-assistant | abstained-incorrectly | **bad gold** | calls a melody line a "chord progression"; agent emitted it verbatim |
| `0a995998` | multi-session | incorrect | **bad gold** | 2 store items exist; gold says 3 |
| `4b24c848` | knowledge-update | incorrect | strict | named "5"; failed for hedging |
| `a2f3aa27` | knowledge-update | incorrect | strict | said "1,250–1,300"; gold hardens a user's own "I *think* I'm close to 1300" |
| `gpt4_93159ced_abs` | temporal | incorrect | strict | caught the false premise, then kept answering |
| `32260d93` | ss-preference | incorrect | real (weak) | led with the gold preference, then overreached into other genres |
| `gpt4_fa19884d` | temporal | abstained-incorrectly | real | user states the band description verbatim on the right Friday |
| `gpt4_5dcc0aab` | temporal | abstained-incorrectly | real | "I cleaned my white Adidas sneakers last month" is in the corpus; agent offered Converse |
| `993da5e2` | temporal | abstained-incorrectly | real | rug "a month ago" + rearrange "three weeks ago" → ~9 days; split across same-slug docs |
| `gpt4_5438fa52` | temporal | abstained-incorrectly | real | «cultural festival» never extracted |
| `0e5e2d1a` | ss-assistant | abstained-incorrectly | real | "38 subjects" is in the doc; TASK-361 replayed it correctly 3/3 |
| `352ab8bd` | ss-assistant | abstained-incorrectly | real | "~20% framerate with HAMT" in the session, dropped at extraction |
| `5809eb10` | ss-assistant | abstained-incorrectly | real | "construction of the house began in 2014" verbatim, dropped at extraction |
| `88432d0a` | multi-session | incorrect | real | counted a *planned* chicken-wing bake as a 5th bake |
| `91b15a6e` | multi-session | incorrect | real | vanity minimum is the user's own "$150"; agent used $200 |
| `d24813b1` | ss-preference | incorrect | real | claimed "you've made this before" of a cake the user only discussed |
| `gpt4_7f6b06db` | temporal | incorrect | real | included Sequoia (Feb 20, outside the window), dropped Muir Woods |
| `gpt4_e061b84f` | temporal | incorrect | real | substituted a volleyball game for the Midsummer 5K |
| `9a707b81` | temporal | incorrect | real | had **both** dates right (Mar 20, Apr 10) and refused to subtract |
| `gpt4_4fc4f797` | temporal | incorrect | real | used the May-15 *planned* track day instead of the Apr-24 test |
| `6e984301` | temporal | incorrect | real | user said "just started … today"; agent claimed 6 weeks prior |
| `c9f37c46` | temporal | incorrect | real | both anchors right (Feb, Apr), arithmetic wrong (called it 3 months) |
| `6a1eabeb` | knowledge-update | incorrect | real | returned the stale 27:12 PB over the later 25:50 |

Two patterns fall out of the "real" column, and neither is a memory-fidelity bug:

- **Plans counted as events** — `88432d0a`, `gpt4_e061b84f`, `gpt4_4fc4f797`. The corpus
  says "I'm thinking of baking…", "after my volleyball league game", "I'm planning to
  participate on May 15th", and the agent scored them as things that happened. Three
  rows, one mechanism.
- **Memory was complete and the reasoning still lost** — `9a707b81` (both dates right,
  refused to subtract), `c9f37c46` (both anchors right, arithmetic wrong), `6e984301`
  (misread "just started today"). Three more rows where nothing about retrieval or
  extraction would have helped.

That is **6 of 24 that no memory change can fix**, on top of the 3 bad gold and 3 strict.

---

## Do we carry an exclusion list?

**Yes for annotation, no for exclusion, and never as a corpus patch.**

The known-bad-gold list is **3 question ids**:

```
7024f17c    gold counts an out-of-window event ("last week" is wrong by 10 days)
eaca4986    gold calls a melodic note line a "chord progression"; no chord progression exists
0a995998    gold counts 3 store pick-up/return items where the corpus supports 2
```

How to use it:

- **Do** cite it when a report's failure list contains one of them, so nobody spends a
  second session re-diagnosing `7024f17c`'s jog.
- **Do** quote "76.0%" as the number, and "79.0% excluding 3 known-bad-gold rows" as an
  annotation beside it when the distinction matters.
- **Do not** compute a headline accuracy with them dropped. Three rows out of a hundred
  is inside the run-to-run variance TASK-365 is measuring, and a number that quietly
  excludes its own hardest rows is not comparable to anything.
- **Do not** edit `longmemeval_s_cleaned.json`. It is a published benchmark. A patched
  copy makes every number we have — including our whole history — incomparable with
  every number anyone else has. The deliverable is this list, not a fixed dataset. The
  file is untouched; this audit is read-only.

The list is deliberately short. I did **not** add the 3 strict-scored rows to it,
because all three are winnable on our side: two turn on answer *style* (hedging,
ranges), and the third is helpfulness after a correct refusal. All three are
prompt-level things we control, not properties of the benchmark. If we ever want
those points, the fix is on our side.

---

## Method

Free — no API calls, no spend. Two inputs:

```bash
# the 24 scored failures (9 abstained-incorrectly + 15 incorrect)
~/.cache/ax-memory-bench/longmemeval-s-e2e/2026-09-14.jsonl

# the corpus, read-only
~/.cache/ax-memory-bench/longmemeval-s/longmemeval_s_cleaned.json
```

The corpus is a 277MB pretty-printed JSON array; it is streamed record-by-record on the
`    {` / `    }` line boundary rather than `json.load`-ed, which keeps it under a few
MB of RSS. For each of the 24 failures the record was pulled whole and a digest built
of: `question_date`, `question`, `answer`, every turn of every session named in
`answer_session_ids`, plus `agentAnswer` / `judgeReason` from the resume JSONL.

**Every one of the 24 was read**, not sampled — 24 is small enough that sampling buys
nothing and costs the ability to state a rate. Three cross-checks ran over the full
haystack rather than the evidence sessions, because an evidence-only read is how you
conclude a value is absent when it is two sessions away:

- `0a995998` — regex over all 44 sessions for pick-up/return language, to be sure no
  third store item exists outside the labelled evidence.
- `32260d93` — search for genre signals outside the evidence session, which is what
  turned up the true-crime turns that contradict the gold rubric.
- `a2f3aa27`, `6a1eabeb`, `4b24c848` — all occurrences of the updated value, to confirm
  which figure is actually latest.

**What I did not trust.** A token-overlap score between gold and `agentAnswer` was
computed first as an automatic screen for "we said the gold and still failed". It is
unreliable in both directions — it scored `c9f37c46` at 100% because "months" matched
while the agent said 3 and gold said 2, and it scored `eaca4986` at 0% because the gold
is single letters. It is not in this report. The four "gold present verbatim" rows
verified against the scored run (three strict-scored, plus `eaca4986` which is bad
gold) are backed by **exact substring match** against the scored answer text instead,
which is the check that actually means what it says.

The verdicts themselves are judgments from reading the source. Where a judgment is
close — `32260d93`, `a2f3aa27` — the report says so and counts it against us.

## Reproducing

```bash
# corpus-wide date artifact (zero-span haystacks, post-question evidence sessions)
python3 - <<'PY'
import json, datetime, re, os
def parse(d): return datetime.datetime.strptime(re.sub(r'\s*\(\w+\)','',d).strip(), '%Y/%m/%d %H:%M')
buf=[]; depth=0; stats=[]
CORPUS = os.path.expanduser('~/.cache/ax-memory-bench/longmemeval-s/longmemeval_s_cleaned.json')
for line in open(CORPUS):
    s=line.rstrip('\n')
    if s=='    {': buf=[s]; depth=1; continue
    if depth:
        buf.append(s)
        if s in ('    }','    },'):
            r=json.loads('\n'.join(buf).rstrip(',')); depth=0; buf=[]
            qd=parse(r['question_date']); ds=[parse(x) for x in r['haystack_dates']]
            idx={x:i for i,x in enumerate(r['haystack_session_ids'])}
            stats.append(((max(ds)-min(ds)).days,
                          sum(1 for x in r['answer_session_ids'] if x in idx and ds[idx[x]]>qd)))
print('zero-span', sum(1 for a,_ in stats if a==0), '/', len(stats))
print('evidence after question', sum(1 for _,b in stats if b>0), '/', len(stats))
PY

# the four "gold present verbatim" rows (three strict-scored, plus eaca4986 which is
# bad gold — see "The 3 that are unwinnable")
python3 - <<'PY'
import json, os
rows={r['questionId']: r for r in (json.loads(l) for l in open(
    os.path.expanduser('~/.cache/ax-memory-bench/longmemeval-s-e2e/2026-09-14.jsonl')))}
for qid, needle in [('eaca4986','C D E F G A B A G F E D C'), ('4b24c848','5 H&M tops'),
                    ('a2f3aa27','1,300'), ('gpt4_93159ced_abs','no record of you working at Google')]:
    print(qid, needle in rows[qid]['agentAnswer'])
PY
```

Source: `docs/plans/2026-09-15-task-361-detail-loss-report.md`
