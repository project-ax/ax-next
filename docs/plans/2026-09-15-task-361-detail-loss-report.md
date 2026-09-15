# TASK-361 — where the specific value is actually lost

**The card asked:** across the 9 false refusals in the 2026-09-14 n=100 e2e run,
is the specific value lost at **Observer extraction** or at **consolidator
densification**?

**Answer: mostly neither — but extraction is real in a third of them, and it has
a shape.**

| where the evidence actually was | n |
|---|---|
| **retained** — extracted, consolidated, in the tree, agent said otherwise | **6/9** |
| **extraction** — evidence the question needed never reached the inbox | **3/9** |
| consolidation — extracted, then dropped by the consolidator | **0/9** |

**The consolidator never lost anything.** Densification — half of what the card
asked about, and the previous handoff's named suspect — is not implicated once in
nine questions. Of the six `retained`, two are arguably not bugs at all: the gold
is questionable.

**The sharpest single result:** re-running `0e5e2d1a` through the *same* shipped
pipeline — same GLM planner, same Sonnet answer stage, same judge — answered it
correctly **3 times out of 3**, each on a single tool call:

> "The *Music and Medicine* study had **38 subjects**, who listened to binaural
> beats for 30 minutes daily over three weeks…"

The scored run refused, on 2 tool calls. Memory retained the fact in 4/4
independent ingests. So for that question nothing is broken: **the refusal was an
outlier draw**, and some share of the "false refusal" bucket is run-to-run
variance rather than a defect to fix.

**Cost: $0.74 all in**, against the ~$86 the previous track spent to reach a
weaker conclusion:

| | |
|---|---|
| the 9-question diagnostic run | $0.386 |
| 3 extra ingests of `0e5e2d1a` (extraction-variance rate) | $0.131 |
| 3 full e2e replays of `0e5e2d1a` (answer-variance rate) | $0.225 |
| every re-score after the first, including 5 probe fixes | **$0.000** |

Roughly half of it bought the two *rates* — 4/4 and 3/3 — that turned "the answer
stage refused" from an assertion into a measurement, and then overturned it. The
free half is `--from-dump`: the layers are dumped once and re-scored forever,
which is what made it affordable to find five probe defects after the fact instead
of paying for the run again each time.

---

## What replaces the hypothesis

Four mechanisms, needing four different fixes — and only one of them is the
memory-fidelity bug the card assumed.

### 1. The fact was in front of the agent, and the refusal does not reproduce

`0e5e2d1a` (single-session-assistant, gold "38 subjects") is the clean case.
`docs/general/binaural-beats.md` is a **1,546-byte doc with exactly three fact
lines**:

1. …binaural beats might reduce anxiety and depression … not … a sole treatment…
2. **…3. Music and Medicine — 38 subjects, 30 minutes daily for three weeks…**
3. …alpha, theta, and delta wave binaural beats are types used for anxiety…

The agent's refusal names **fact 1 and fact 3**:

> "…only capture the general topics we discussed — such as **alpha/theta/delta
> waves** and **the caution about not using binaural beats as a sole treatment**
> — but there's no mention of a specific study published in *Music and Medicine*
> or the number of subjects in it."

Facts are contiguous in the body, so nothing that showed it 1 and 3 could have
hidden 2. Two further checks close it off:

- **Retrieval would have handed it over.** Running the shipped
  `extractMatchedFacts` against the real doc body returns the "38 subjects" line
  for every plausible query — including bare `binaural beats` and
  `how many subjects study Music and Medicine`. There is no per-line truncation
  anywhere between the doc and the model.
- **Extraction is not flaky here.** Four independent ingests all extracted and
  consolidated the studies fact (4/4), so "that run happened not to extract it"
  does not explain the refusal.
- **Neither is the answer stage, it turns out.** Three full replays through the
  scored path all answered correctly, on one tool call each, against the scored
  run's two-tool-call refusal.

So: extracted, consolidated, matchable, answerable — and refused once. **This is
variance, not a defect**, and it is the reason recommendation 1 below is to
measure the reproduction rate before building anything. A single false refusal is
weak evidence of a structural problem; it took four ingests and three replays to
establish that for one question, which is exactly why it should be measured
across the bucket rather than argued per-question.

### 2. One concept, two docs, and the agent read the other one

`993da5e2` (temporal-reasoning, gold "one week") looks identical from the JSONL
and is a different bug. The tree holds **two docs with the same slug under
different categories**:

| doc | summary |
|---|---|
| `docs/general/living-room-decor.md` | "…decorating a reading nook … created after **rearranging furniture three weeks ago**." |
| `docs/entity/living-room-decor.md` | "The user recently got a new **Moroccan-inspired area rug** for their living room **a month ago**." |

The agent quoted the *general* doc's summary almost verbatim — "you rearranged
your furniture about three weeks ago and … a cozy modern-traditional style with
beige, cream, and wood tones" — and concluded it had "no information … about an
area rug." The rug is in the sibling.

Answering needs **both** halves (a rug bought a month ago, furniture rearranged
three weeks ago → about one week). Splitting one concept across two category
docs with an identical slug is what made that impossible, and it is a **CLAUDE.md
invariant 4 problem inside memory's own layout** — one source of truth per
concept — rather than a retrieval-tuning knob.

### 3. The extraction losses have a shape: working ON a document drops the document

Three questions lose evidence at extraction, and two of them fail the same way.

`352ab8bd` asks for the HAMT agent's framerate improvement (~20%) from a CVPR
paper review. `docs/episode/cvpr-hamlet-paper-review.md` exists and holds five
facts — every one of them about the **review activity**: the 8/10 review, the
2/10 review, the borderline 6/10, the Program Chair's reject. «HAMT»,
«framerate», «hardware», «modular» are all in the sessions and **absent from the
tree**.

`5809eb10` asks what year construction began (2014) in a case the user pasted.
`docs/decision/bajimaya-v-reward-homes-article.md` exists and holds the
**article-editing work**: the intro paragraph, the conclusion titles, the meta
titles. «began in 2014» and «construction of the house» never reached the inbox.

In both, the user's activity was *working on a document*, and the Observer
recorded **the activity** while dropping **the document's contents**.

Note what these two have in common that the retained cases do not: in `0e5e2d1a`
(the studies list) and `eaca4986` (the song's chords) the assistant's output *was*
the substance of the exchange, and both survived intact — the chord progression
is in `docs/general/romantic-song.md` verbatim. So this is not "assistant content
is dropped". It is narrower and more fixable than that.

**Both agents diagnosed themselves correctly**, which is worth noticing given the
other six:

> "captures general details about the HAMLET framework and the reviews that were
> written, but the specific figure … is not recorded in my long-term memory"

> "The details I have are focused on the article editing work we did — such as
> the intro paragraph, conclusion titles, meta titles…"

### 4. And one loses the half the gold answer does not name

`gpt4_5438fa52` asks **which came first, a cultural festival or the start of
Spanish classes**. Gold is "Spanish classes", and memory keeps that: *"User has
been taking Spanish classes since ~Feb 2023."*

**"cultural festival" appears zero times in the extracted facts and zero times in
the tree**, though it is right there in a user turn of session 3: *"I attended a
cultural festival in my hometown yesterday."* The Observer never wrote it down.

So the pipeline lost half of what the question needed — and it is the half the
gold answer does **not** name, which is why a probe aimed at the gold string
reported a healthy pipeline. Same family as the two above: an event stated in
passing, in a user turn whose main topic was a Europe trip.

---

## The measured table

All nine, scored by `bench:diag-detail-loss --from-dump`. The verdict column is
the automatic screen; the reading column is the judgment after looking at the
line each probe matched (three verdicts were overruled that way — see Method).

| question | type | verdict | what the tree actually shows |
|---|---|---|---|
| `0e5e2d1a` | assistant | retained | "Music and Medicine — **38 subjects**" present in 4/4 ingests. **3/3 replays answer correctly.** Outlier draw, not a defect. |
| `eaca4986` | assistant | retained | `general/romantic-song.md`: "chorus **C D E F G A B A G F E D C**", verbatim. Agent said it had melodies but not chords. |
| `gpt4_5dcc0aab` | temporal | retained | "**cleaned** their white Adidas sneakers last month … festival on 2023-04-15". Agent said no record of cleaning; offered Converse. |
| `993da5e2` | temporal | retained | Split across `general/living-room-decor` (rearranged 3 weeks ago) and `entity/living-room-decor` (rug, a month ago). Agent quoted the first. |
| `7024f17c` | multi | retained | 30-minute jog kept and dated 2023-05-20. Question is dated 05-30, so "last week" = May 22–28 and the agent's exclusion is defensible — **gold looks wrong**. |
| `gpt4_fa19884d` | temporal | retained | Bluegrass exploration + the recommendation list kept. The session has the user *asking for* recommendations; no artist is "started listening to" — **gold under-determined**. |
| `352ab8bd` | assistant | **partial** | CVPR doc kept the review scores, dropped the paper's content. «HAMT» «framerate» «hardware» «modular» lost at extraction. |
| `5809eb10` | assistant | **partial** | Bajimaya doc kept the article-editing work, dropped the case facts. «began in 2014» lost at extraction. |
| `gpt4_5438fa52` | temporal | **partial** | «cultural festival» lost at extraction; the Spanish-classes half retained. Comparison needs both. |

Grouped by what would actually fix them:

| cause | n | questions |
|---|---|---|
| extraction drops document/passing content | 3 | `352ab8bd` `5809eb10` `gpt4_5438fa52` |
| retained; failure is downstream | 3 | `gpt4_5dcc0aab` `993da5e2` `eaca4986` |
| retained; the refusal did not reproduce | 1 | `0e5e2d1a` |
| retained; gold is questionable | 2 | `7024f17c` `gpt4_fa19884d` |
| **consolidation** | **0** | — |

---

## Method

```bash
set -a && . ./.env.walk && set +a
pnpm --filter @ax/memory-strata bench:diag-detail-loss --out-dir <dir>   # paid, ~$0.04/q
pnpm --filter @ax/memory-strata bench:diag-detail-loss --from-dump <dir> # free, re-scores
```

The diagnostic runs the **real** ingest — real Observer, real consolidator, the
shipped GLM 5.3 Flash memory-ops model — and reads the tree at two points:

- **after each session's Observer settles and BEFORE the consolidation flush**,
  which is the only instant the inbox holds raw extraction output; and
- **after ingest**, the whole tree.

It is a seam on `runE2EQuestion`, not a second copy of the ingest loop: that loop
encodes the settle-then-flush ordering the 2026-07-08 inbox-stranding bug came
from getting wrong, and a diagnostic that reimplemented it would drift into
measuring a pipeline nothing runs. No answer stage and no judge, which is what
makes it ~$0.04 instead of ~$0.09 a question.

### Fidelity checks run before believing any of it

- **Same input as the scored run.** The e2e harness can stop ingest early on its
  cost cap, which would let the diagnostic "find" values the run never had. All
  9 questions ingested every haystack session in the scored run
  (`sessionsIngested` == corpus session count), so there is no such gap.
- **A re-ingest is a fresh draw, not a replay.** Extraction is an LLM call, so
  `retained` means "this pipeline retains it", not "that exact run retained it".
  Where that mattered — `0e5e2d1a` — it was measured rather than asserted: 3/3
  draws retained the fact.
- **The verdict is a screen; the evidence line is the judgment.** Every surviving
  probe prints the line it matched, and two probes matched the right word in the
  wrong context and were overruled by reading. Three probe defects were found
  and fixed this way; all three pushed toward a false `retained`.

### What `matchable` does not claim

`probeRetrievability` delegates to the shipped `extractMatchedFacts`, so it
answers "would the matcher return this value from this doc". It does **not**
model doc **selection** — the planner picks a handful of docs off
`system/map.md` first. `993da5e2` is exactly that gap: matchable in one doc,
while the agent was looking at its same-slug sibling.

---

## What to do next, in the order I would do it

### 1. Measure how many of the 9 still refuse. ~$0.8, and it gates everything else.

`0e5e2d1a` answered **correctly on 3 of 3 replays** through the same pipeline.
That is one question, not a rate across the bucket — but it changes the question:
before building any fix, re-run all 9 and count how many refuse again.

This is the most decision-relevant number available and nearly the cheapest. If
most of them answer on a second draw, the work is about **variance** — making the
agent drill in before it declares absence — and every structural fix below is
premature. If most refuse again, they are reproducible and worth fixing
individually. Right now nobody knows which world we are in, and the difference
is the whole roadmap.

Note what this does NOT mean: the scored 76.0% is still the honest product
number. Variance in both directions is already priced into it. The point is only
that a *single* refusal is weak evidence of a *structural* defect.

### 2. Same-slug docs in different categories. Real, and a clean fix.

`general/living-room-decor` and `entity/living-room-decor` hold two halves of one
subject, and the question needed both. This is CLAUDE.md **invariant 4 — one
source of truth per concept — violated inside memory's own layout**, so it is
worth fixing whatever the variance rate turns out to be.

Measured across the dumped trees (free, no API calls): **11 same-slug pairs
across 1,033 docs**, roughly 1%, one or two per tree —

| tree | docs | same-slug pairs | example |
|---|---|---|---|
| `gpt4_fa19884d` | 180 | 5 | `user` exists under **four** categories |
| `993da5e2` | 162 | 2 | `living-room-decor` (`general` + `entity`) |
| `0e5e2d1a` | 167 | 2 | `sustainable-fashion` (`preference` + `general`) |
| `gpt4_5dcc0aab` | 178 | 1 | `hiking-boots` (`episode` + `decision`) |
| `gpt4_5438fa52` | 175 | 1 | `europe-trip` (`episode` + `decision`) |
| `7024f17c` | 171 | 0 | — |

So it is rare rather than rampant — and it still cost the answer on `993da5e2`,
because rarity does not help when the split lands on the subject the question is
about. `user` split four ways is the one worth looking at first.

### 3. The extraction gap — "working on a document" drops the document.

The one place the card's own hypothesis holds, 3 of 9. Two of them are the same
mechanism: the Observer recorded that the user was reviewing a paper / editing an
article and dropped what the paper and the article said. The third is an event
mentioned in passing in a turn about something else.

Worth sizing before any prompt work, and this tool sizes it cheaply: run it over
the `single-session-assistant` block (54 questions, reachable only via `--types`
— that block starts at corpus position 434, so `--sample` never contains it) and
count `partial`. That is ~$2 and it says whether this is three questions or a
systematic hole.

Note the counter-examples before assuming "assistant content is dropped": the
binaural studies list and the song's chord progression both survived intact.

### 4. Stop looking at the consolidator.

**Consolidation lost nothing in 9 of 9.** Densification was half the card's
question and the previous handoff's named suspect, and it is not implicated once.
Combined with what that handoff already killed — supersession loss, map fidelity
— the list of dead hypotheses is now three, and each was killed by measurement
rather than left untested.

---

## Reproducing this

```bash
set -a && . ./.env.walk && set +a

# paid: real ingest, dumps the layers. ~$0.04/question.
pnpm --filter @ax/memory-strata bench:diag-detail-loss --out-dir /tmp/t361

# free: re-score those dumps, any number of times
pnpm --filter @ax/memory-strata bench:diag-detail-loss --from-dump /tmp/t361

# replay ONE question through the full scored path (planner + Sonnet + judge)
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --ids 0e5e2d1a --cap 2 --resume replay2 --out /tmp/replay2.md
```

Pass a distinct `--resume <id>` per replay: the checkpoint is date-stamped, so a
second run on the same day would otherwise see the question as already scored and
skip it.
