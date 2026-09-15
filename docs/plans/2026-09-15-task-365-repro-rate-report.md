# TASK-365 — how many of the 9 false refusals actually reproduce

**The card asked:** re-run all 9 false refusals from the 2026-09-14 n=100 e2e run
through the scored path and count how many refuse again.

**Answer: 3 of 9 — and they are not a random 3.**

| | n |
|---|---|
| **did NOT refuse again** | **6/9** |
| refused again | 3/9 |
| of the 6, outright `correct` | 5 |

That alone would say "mostly variance, go build nothing". The sharper result is
**which** 3:

| TASK-361's grouping of the 9 | replayed | refused again |
|---|---|---|
| retained — failure was downstream / an outlier draw / questionable gold | 7 | **1** |
| **extraction dropped the document's contents** | **2** | **2** |

**Both** of the questions TASK-361 identified as "working ON a document drops the
document" refused again. **Six of the seven** it identified as anything else did not.
The one remaining refusal, `eaca4986`, is a bad-gold row that printed the gold value
both times (below).

The two competing explanations for this bucket — run-to-run variance vs. a structural
extraction gap — were not distinguishable from the 2026-09-14 run. They separate
cleanly here, and they split the bucket almost perfectly.

**Cost: $0.798**, against a ~$0.8 estimate.

---

## The run

```bash
set -a && . ./.env.walk && set +a
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --ids 7024f17c,gpt4_fa19884d,gpt4_5dcc0aab,993da5e2,gpt4_5438fa52,0e5e2d1a,352ab8bd,5809eb10,eaca4986 \
  --cap 2 --resume repro-rate
```

- **Planner:** `z-ai/glm-5.3-flash:nitro` (config E — orchestrator over `system/map.md`
  + BM25 fallback)
- **Answer stage:** `claude-sonnet-4-6` · **Observer/consolidator:**
  `z-ai/glm-5.3-flash:nitro` · **Judge:** `x-ai/grok-4.3`
- **Sampling:** `--ids`, 9 questions — 4 `single-session-assistant`, 4
  `temporal-reasoning`, 1 `multi-session`. **Not comparable to a corpus accuracy
  number**; this is a fixed, deliberately-biased set (it is the failure bucket), and the
  harness's own 55.6% headline for the run means nothing outside this report.
- **Ingest fidelity:** 48.9 haystack sessions/question average, matching the scored run
  — no cost-cap truncation, so the replay saw the same input.
- Raw harness output: `docs/plans/2026-09-15-task-365-repro-rate-raw.md`

| question | type | scored 2026-09-14 | replay | tools (was → now) | $ |
|---|---|---|---|---|---|
| `7024f17c` | multi-session | abstained-incorrectly | **incorrect** (did not refuse) | 2 → 4 | 0.106 |
| `gpt4_fa19884d` | temporal-reasoning | abstained-incorrectly | **correct** | 6 → 3 | 0.102 |
| `gpt4_5dcc0aab` | temporal-reasoning | abstained-incorrectly | **correct** | 3 → 1 | 0.076 |
| `993da5e2` | temporal-reasoning | abstained-incorrectly | **correct** | 2 → 2 | 0.075 |
| `gpt4_5438fa52` | temporal-reasoning | abstained-incorrectly | **correct** | 4 → 4 | 0.093 |
| `0e5e2d1a` | single-session-assistant | abstained-incorrectly | **correct** | 2 → 1 | 0.076 |
| `352ab8bd` | single-session-assistant | abstained-incorrectly | **abstained-incorrectly** | 3 → 3 | 0.097 |
| `5809eb10` | single-session-assistant | abstained-incorrectly | **abstained-incorrectly** | 2 → 1 | 0.074 |
| `eaca4986` | single-session-assistant | abstained-incorrectly | **abstained-incorrectly** | 2 → 3 | 0.099 |

---

## The 2 that reproduce are the same mechanism, and they reproduce *verbatim*

These are not "failed again". They failed again **with the same self-diagnosis**, which
is what makes them a defect rather than a draw.

**`352ab8bd`** — average framerate improvement (~20%) from a CVPR paper review:

| run | the agent's own account of what it has |
|---|---|
| 2026-09-14 | "captures general details about the HAMLET framework **and the reviews that were written**, but the specific figure … is not recorded" |
| replay | "My stored notes cover **the review scores, structure, and the Program Chair decision**, but not the detailed numerical results from the paper's experimental section" |

**`5809eb10`** — what year construction began (2014) in a pasted legal case:

| run | the agent's own account of what it has |
|---|---|
| 2026-09-14 | "The details I have are focused on **the article editing work we did** — intro paragraph, conclusion titles, meta titles" |
| replay | "Our discussion was focused on **optimising the article's writing** — shortening the intro, conclusion titles, and meta descriptions — rather than the specific factual details of the case timeline" |

Two independent ingests, two independent answer draws, and the tree has the same shape
both times: **the activity is recorded, the document's contents are not.** The agent is
reporting accurately on a memory that is genuinely missing the fact. That is the
extraction gap TASK-366 exists to size, and it is now measured rather than inferred
from one run.

## The 3rd is not a memory defect at all

**`eaca4986`** refused again — and produced the gold value again.

> "**Song 2** (romantic rewrite): Chorus melody — **C-D-E-F-G-A-B-A-G-F-E-D-C**. The
> chord progressions weren't saved in my long-term memory."

Gold is `C D E F G A B A G F E D C`. The judge's own reason concedes the point:

> "Agent refused on chord-progression grounds **even though … the gold note sequence
> exactly matches the melody it recalled for song 2**."

The source session only ever produces melodic note lines — the user asked for "a sad
song with notes" — so there is no chord progression in the corpus to retrieve. Memory
kept the value both times; the agent declined both times to call a melody a chord
progression; the judge failed it both times while stating the match. See
`docs/plans/2026-09-15-task-368-gold-quality-audit.md`, where this is one of 3
known-bad-gold rows.

So the honest reading of the reproduction count is **two rates, not one**:

| | |
|---|---|
| refused again (raw, as scored) | **3/9** |
| refused again *for a reason memory can fix* | **2/9** |

---

## `7024f17c` did not refuse — and still failed, on the hedge

Worth recording because it changes what kind of failure this row is. On replay the
agent answered:

> "the confirmed total is **at least 0.5 hours of jogging**, but I don't have enough
> detail to give you a precise yoga hour count"

Gold is `0.5 hours`. Judge: *"Agent hedges with 'at least 0.5 jogging, unknown yoga'
instead of matching the gold total of exactly 0.5 hours."*

So across two runs this question has now failed twice for two different reasons —
once as a refusal, once as a hedge — while the underlying memory was correct both
times. (It is also the clearest bad-gold row in the set: gold counts a **May 20** jog
as "last week" for a question dated **May 30**. The replay only reached 0.5 hours by
inventing a "week of May 20–26" window.) TASK-368 documents three more rows that lost
on hedging the same way; that is a prompt-level lever, not a memory one.

---

## What this means for the roadmap

**The card framed this as a fork: "mostly variance → every structural fix is premature"
vs "mostly reproducible → fix them one at a time". The answer is that the bucket was
two populations, and the split is on TASK-361's own grouping.**

| card | verdict | why |
|---|---|---|
| **TASK-366** (extraction: working ON a document drops it) | **still worth doing — now the best-evidenced card in the track** | its 2 questions are 2/2 reproducible, with the agent naming the same cause both times |
| **TASK-363** (temporal picks a plausible neighbouring event) | **do NOT do it as written** | all 4 temporal refusals answered on replay, 4/4. Its premise is not in this bucket — see below |
| structural work on the other 5 refusals | **no** | they answered on a second draw; there is nothing stable to fix |

**On TASK-363 specifically.** Its dep was `TASK-365`, and TASK-365 says its evidence
evaporated: every temporal question in the refusal bucket answered correctly on replay.
But the *phenomenon* TASK-363 names is real — it is just in the **`incorrect` bucket,
not the refusal bucket**, and TASK-368's read of those 15 found it with a sharper
mechanism than the card states:

- `gpt4_4fc4f797` used a **planned** May-15 track day instead of the April-24 test
- `gpt4_e061b84f` substituted a **planned** volleyball game for the Midsummer 5K
- `88432d0a` counted a **planned** chicken-wing bake as a completed bake
- `gpt4_7f6b06db` included Sequoia (Feb 20, outside the window) and dropped Muir Woods

Three of the four are one mechanism: **a stated intention is stored and then recalled as
a completed event.** That is a narrower and more testable claim than "picks a plausible
neighbouring event", and it points at the Observer's fact typing rather than at
retrieval. TASK-363 should be **rewritten around that** and re-gated on a repro run of
the 15 `incorrect` rows (~$1.2), not on this one.

**The unrun measurement.** This run deliberately covered only the 9 refusals, per the
card. The 15 `incorrect` rows are still unmeasured for reproducibility, and after this
result that is the gap that matters: 6 of 9 refusals turned out to be draws, so
assuming the 15 are stable would be repeating exactly the mistake this card was written
to prevent.

---

## Caveats

- **n=1 per question.** A question that answered once is not proven stable; it is proven
  *not reproducible from one observation*, which is all that was claimed. `0e5e2d1a` is
  the only one with a real rate (4/4 across this run and TASK-361's three replays).
- **One consolidator timeout fired**, on `lme-gpt4_fa19884d`
  (`memory_strata_consolidator_failed`, 17:33:30). That question answered **correctly**
  anyway, so the timeout can only have biased against the "did not reproduce" result,
  not toward it. No observer timeouts.
- **The 55.6% in the raw harness report is not an accuracy number.** It is 9
  hand-picked failures; the harness prints the headline regardless and labels the run
  `NOT comparable to a full-corpus overall score`. **76.0% remains the product number.**
- **`--out` does nothing in `--mode e2e`.** `parseCliArgs` accepts it but
  `runE2EMode` never receives it, so the report always lands at
  `docs/plans/<date>-memory-strata-e2e-report.md` and overwrites whatever tracked file
  is there. The card, the TASK-361 report and the handoff all pass `--out`; none of them
  work. The raw output was copied to a distinct path and the tracked file restored.

## Reproducing

```bash
set -a && . ./.env.walk && set +a
# NOTE: --resume must be a fresh id. The checkpoint is date-stamped, so a second run
# the same day sees these 9 as already scored and writes an empty report that looks fine.
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --ids 7024f17c,gpt4_fa19884d,gpt4_5dcc0aab,993da5e2,gpt4_5438fa52,0e5e2d1a,352ab8bd,5809eb10,eaca4986 \
  --cap 2 --resume <fresh-id>

# free: compare any two runs question-by-question
python3 - <<'PY'
import json, os
C=os.path.expanduser('~/.cache/ax-memory-bench/longmemeval-s-e2e')
orig={r['questionId']:r for r in (json.loads(l) for l in open(f'{C}/2026-09-14.jsonl'))}
rep ={r['questionId']:r for r in (json.loads(l) for l in open(f'{C}/repro-rate.jsonl'))}
again=sum(1 for q,r in rep.items() if r['verdict']=='abstained-incorrectly')
for q,r in rep.items():
    print(f"{q:<18}{orig[q]['verdict']:<24}-> {r['verdict']}")
print(f"refused again: {again}/{len(rep)}")
PY
```

Source: `docs/plans/2026-09-15-task-361-detail-loss-report.md`
Companion: `docs/plans/2026-09-15-task-368-gold-quality-audit.md`
