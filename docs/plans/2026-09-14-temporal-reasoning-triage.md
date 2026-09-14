# temporal-reasoning at 59.3% — what the 11 failures actually are

**Source:** `~/.cache/ax-memory-bench/longmemeval-s-e2e/2026-09-14.jsonl`, the
e2e run behind `docs/plans/2026-09-14-memory-strata-e2e-report.md`.
**Cost to produce this:** $0. No API calls — the resume JSONL carries
`question`, `goldAnswer`, `agentAnswer` and `judgeReason` per row.
**Reading note:** the file holds **101 rows for 100 questions**. One question is
duplicated (the second occurrence of trap #4 in the handoff). Everything below
dedupes on `questionId`, last row wins; the deduped set reproduces the report's
76.0%.

---

## The handoff's hypothesis does not survive the failures

The handoff predicted a supersession bug:

> answering "what did I use before I switched" needs the memory to preserve
> supersession, and the consolidator's dedup/promote path is where that would be
> lost.

**Zero of the 11 temporal-reasoning failures are supersession failures.** No
failure involves a superseded value being returned in place of a current one, or
vice versa. That hypothesis should be dropped unless something else motivates it.

What the 11 actually are, splitting cleanly in two:

| cause | n | shape |
|---|---|---|
| wrong anchor event, or wrong date arithmetic on the right ones | 6 | agent names two dated events and computes between them |
| the specific value was never in memory to retrieve | 4 | agent finds the right document and says the detail is absent |
| gold wanted a refusal, agent answered | 1 | the `_abs` variant |

---

## Finding 1 — the detail-loss failure is NOT temporal, and it is the bigger bug

This is the one worth acting on, and looking only at temporal-reasoning hides
it. Across all 100 questions there are **9 false refusals**, and every single one
has the same shape: **the agent retrieves the right document, and narrates that
the specific value is not in it.**

| type | question | gold | what the agent said it had |
|---|---|---|---|
| single-session-assistant | how many subjects in the binaural-beats study | 38 | "only capture the general topics — alpha/theta/delta waves" |
| single-session-assistant | HAMT average framerate improvement | ~20% | "general details about the HAMLET framework" |
| single-session-assistant | what year construction began (Bajimaya case) | 2014 | "focused on the article editing work we did" |
| single-session-assistant | chorus chord progression | C D E F G A B A G F E D C | "captures the melodies … but not the chord progressions" |
| temporal-reasoning | artist started listening to last Friday | a bluegrass band with a banjo player | "mention you exploring **bluegrass music**" |
| temporal-reasoning | which shoes did I clean last month | white Adidas sneakers | "wore your Converse … to a music festival" |
| temporal-reasoning | how long using the new area rug | one week | "rearranged your furniture about three weeks ago" |
| temporal-reasoning | cultural festival vs Spanish classes, which first | Spanish classes | Spanish classes dated; no cultural festival at all |
| multi-session | hours of jogging and yoga last week | 0.5 hours | "plans and past habits, not actual logged sessions" |

The agent is not failing to search — mean `toolCalls` on false refusals is **2.9,
the highest of any verdict** (correct: 2.0, correct-refusal: 1.5). It searches
harder and still finds only the topic.

So this is not retrieval. **Observer extraction / consolidator densification is
preserving the topic and dropping the specific value** — the number, the year,
the proper noun, the sequence. Which explains the per-type spread exactly:

| type | n | acc | false refusal | wrong answer |
|---|---|---|---|---|
| single-session-user | 14 | 100.0% | 0 | 0 |
| multi-session | 27 | 85.2% | 1 | 3 |
| knowledge-update | 15 | 80.0% | 0 | 3 |
| single-session-preference | 6 | 66.7% | 0 | 2 |
| **single-session-assistant** | 11 | **63.6%** | **4** | 0 |
| **temporal-reasoning** | 27 | **59.3%** | 4 | **7** |

`single-session-assistant` has the **highest false-refusal rate in the corpus**
(4/11 = 36% vs temporal's 15%) and *zero* wrong answers — it is the purest
expression of this bug, because those questions ask the agent to recall a
specific figure from a past assistant turn and nothing else. Chasing
temporal-reasoning alone would have found this obliquely, at best.

## Finding 2 — temporal-reasoning's own bug is anchor selection, not supersession

The 6 remaining failures are date reasoning, and they split again:

**Picked the wrong anchor event** (retrieval returned several candidates and the
agent chose wrongly):

- *Order of my three trips*: answered Sequoia, Big Sur, Yosemite. Gold: Muir
  Woods, Big Sur, Yosemite. It substituted a trip outside the window and dropped
  the one inside it — and flagged its own doubt ("right at the edge of the
  3-month window").
- *Order of three sports events*: answered Triathlon, **Volleyball**, Soccer.
  Gold: Triathlon, **5K Run**, Soccer. Same shape — a real adjacent event
  substituted for the right one.
- *Days between suspension feedback and testing*: answered 59 (Mar 17 → May 15).
  Gold 38. The arithmetic is correct; the March 17 anchor is the wrong feedback
  event.
- *Weeks of sculpting classes*: reasoned "6 weeks as of Feb 11" + "3 weeks
  later" = ~9. Gold 3.

**Arithmetic slip on correct anchors:**

- *How long watching stand-up*: "February 2023 … April 2023 — roughly **3
  months** later". February to April is two. Gold: 2 months.

**Event-identity failure:**

- *Days since the baking class when I made the cake*: the agent asserted the
  baking class and the cake were unrelated events and refused the premise. Gold
  treats them as one occasion (21 days).

The common thread across the first four: retrieval surfaced a *plausible
neighbour* and nothing downstream forced a check that the chosen event is the
one the question names. That is a different lever from memory fidelity.

## Finding 3 — one abstention-policy miss

`gpt4_93159ced_abs` asks "how long had I been working before I started my current
job at Google?" when the user has never worked at Google. Gold wants a refusal.
The agent correctly observed there is no Google record — then answered anyway,
substituting NovaTech and producing a confident "4 years and 9 months". It had
the right information and the wrong policy: a false premise should stop the
answer, not get silently repaired.

---

## What I would do next, revised

1. **Measure the detail-loss bug directly, without paying for a full e2e run.**
   Take the 9 false-refusal questions, dump the memory state the agent actually
   had, and check whether the gold value is present anywhere in `docs/` or only
   in the raw session. That distinguishes *extraction never captured it* from
   *consolidation later dropped it* — different fixes, and the JSONL cannot tell
   them apart. This is the highest-value next step and it is nearly free.
2. **Re-run with `--types single-session-assistant`** once a fix exists. It is
   the cleanest signal for this bug (36% false refusal, no confounding wrong
   answers) and it is 54 questions, not 500. Note the handoff's own trap: that
   block starts at corpus position 434, so only `--types` reaches it.
3. **Leave supersession alone** until something other than this run motivates it.
4. Anchor selection (Finding 2) is a retrieval/answer-stage concern, not a memory
   one, and should not be folded into the same fix.
