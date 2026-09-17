# Hindsight differential: the assistant-content gap was ours, and the multi-session gap was never there

**Date:** 2026-09-16
**Question:** dem-memory scored 45.5% on LongMemEval-S `single-session-assistant` and 74.1%
on `multi-session`. Were those real defects, or artifacts of our benchmark — bad gold, a
harsh judge, an unlucky sample?
**Method:** run the original [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)
against the *same 38 questions*, score it with *dem's own judge*, and compare paired rows.
**Answer:** `single-session-assistant` was a real defect in dem's extraction prompt.
`multi-session` was never a gap at all — it disappears the moment models and reasoning
effort are matched.

## Result

Four hindsight arms, all scored by dem's grok-4.3 judge and dem's five-way verdict prompt,
on the same 38 rows from the same `longmemeval_s_cleaned.json`. Scored the way `bench/run.ts`
scores: a row counts iff the verdict is `correct` or `abstained-correctly`.

| question_type | n | dem-sonnet | dem-glm | hs-A | hs-B | **hs-C** | hs-D |
|---|---|---|---|---|---|---|---|
| multi-session | 27 | 74.1% | **81.5%** | 85.2% | 74.1% | **81.5%** | 92.6% |
| single-session-assistant | 11 | 45.5% | **45.5%** | 100% | 100% | **100%** | 100% |
| TOTAL | 38 | 65.8% | 71.1% | 89.5% | 81.6% | 86.8% | 94.7% |

Arms (the dem columns are the **pre-fix** `n100-sonnet/` and `n100-glm/` runs, which is what
the 38 rows were selected against):

| arm | engine / retain | answerer | effort (engine / answer) |
|---|---|---|---|
| hs-A | `openai/gpt-4o-mini` | `anthropic/claude-sonnet-4.6` | not sent / high |
| hs-B | `z-ai/glm-5.3-flash` | `z-ai/glm-5.3-flash` | not sent / high |
| **hs-C** | **`z-ai/glm-5.3-flash`** | **`z-ai/glm-5.3-flash`** | **minimal / minimal** |
| hs-D | `openai/gpt-4.1-nano` | `z-ai/glm-5.3-flash` | not sent / minimal |

**hs-C is the controlled arm.** It matches dem-glm on every dial we could control: same engine
model, same answerer model, `minimal` on both sides, same questions, same judge.

## What the controlled arm says

- **`multi-session`: 81.5% vs dem-glm's 81.5% — an exact tie.** The apparent gap was model
  choice and noise, not architecture. Across engines the same 27 questions swing 74.1% → 92.6%,
  which is the same instability the handoff already documents *within* dem's own two arms
  (88.9% sonnet vs 77.8% GLM post-fix, having been 74.1% vs 81.5% pre-fix — the arms swapped
  which one led). **Treat any single-arm `multi-session` number as uninterpretable.** This run
  is independent support for that rule, from a second system.
- **`single-session-assistant`: 100% vs 45.5%, p = 0.031.** Matching the effort changed nothing.

The `single-session-assistant` result is **8 for 8**: every arm against both dem baselines
gives identical discordant counts, `dem+0 / hs+6`, McNemar exact two-sided p = 0.0312 — across
three engine models, two answerers, and both effort settings. Nothing about model choice or
reasoning budget touches it.

That invariance is the point. A defect that survives changing the model, the answerer, and the
reasoning budget, while a neighbouring question type ties exactly under the same conditions, is
a defect in *what the extraction prompt keeps* — which is precisely the diagnosis reached
independently by dumping dem's own evidence tables (facts present at ranks 1–7, detail
compressed out by "Keep objects concise: a phrase, a value, or an outcome").

### Headroom that remains

The assistant-content fix took dem to **9/11**. Hindsight's ceiling on the same rows is
**11/11**. `single-session-assistant` is nearly done, not done.

One of the two is `7161e7e2`, which the handoff flags as a synthesis failure on correct
evidence. **All four hindsight arms answer it correctly**, with the positional lookup dem's
answerer refuses:

> On Sunday, the shift rotation for Admon was the 8am-4pm (Day Shift).

So the information is recoverable and the question is answerable. That corroborates the
handoff's read: this one is synthesis, not retrieval.

## What this does NOT show

- **Not a system-level verdict.** Hindsight answered from a median **8,187 tokens / 270 facts**;
  dem answers from **15 rows / ~495 tokens**. A ~16× evidence budget inflates every TOTAL
  column here. It cannot explain one type moving 45.5 → 100 while its neighbour ties exactly —
  but do not quote the TOTAL row as "hindsight beats dem".
- **Not an abstention win.** Hindsight is *worse* here and unstable: on `6456829e_abs` the four
  arms return `incorrect`, `correct`, `correct` and `abstained-correctly` respectively. dem's
  abstention discipline is the better behaviour.
- **Not a timing measurement.** Arms C and D shared one Mac's CPU and took a DNS outage
  mid-run. Only hs-A's 29 minutes is a clean wall-clock number.
- **Not evidence about consolidation.** Same asymmetry the handoff states for Strata: this
  ingests every session directly, with no consolidation regime to survive.

## Reproducing it

Pinned to hindsight commit `a6518c9` (2026-09-16). The benchmark runs the engine **embedded**
(`MemoryEngine` + embedded pg0 + local `BAAI/bge-small-en-v1.5`), so no Docker server is needed
— only an LLM key.

**Three patches were required to run it at all.** The first is a genuine upstream break:

1. **`LLMCallResult` is never unwrapped.** `LLMConfig.call` returns an `LLMCallResult` whose
   `.content` holds the parsed `response_format` model, but the benchmark's answer generator
   (`longmemeval_benchmark.py`) and judge (`common/benchmark_runner.py`) both still treat the
   return value as the model itself. Out of the box **every answer fails** with
   `Error generating answer: 'LLMCallResult' object has no attribute 'reasoning'` and the run
   reports 0.0%. Hindsight's published 94.6% did not come from this code path as it stands.
2. **`--question-id` took one id.** The underlying `specific_item` already accepts an iterable,
   so this is a one-line CLI split on commas.
3. **Role reasoning effort was hard-coded** to `"high"` in `build_role_llm_config`, with no
   override. Patched to read `HINDSIGHT_API_[ROLE_]LLM_REASONING_EFFORT`, falling back to the
   old default. **Without this, any "same model" comparison is silently unmatched** — which is
   what made the first GLM arm (hs-B) uncontrolled.

Comparability details that mattered:

- **Same corpus file.** Hindsight downloads `longmemeval_s_cleaned.json` from
  `xiaowu0162/longmemeval-cleaned` — the same file `bench/harness.ts` reads. Question ids line up.
- **Re-judge, don't trust its verdicts.** Hindsight judges with category-specific prompts, a
  bare `correct: bool`, and an explicit "be generous" instruction. It has no
  `abstained-correctly`, so it cannot express dem's abstention metrics. Its answers were
  re-scored with dem's judge and prompt; its own `is_correct` is recorded for reference only.
  This is not cosmetic — dem's judge overturned hindsight's verdict on 2 of 38 rows in arm A.
- **Arms must not share a store.** Every item ingests into bank `longmemeval_<question_id>` and
  clears it first, so two concurrent arms on one database destroy each other's banks. Arm D ran
  on its own embedded instance via `HINDSIGHT_API_DATABASE_URL=pg0://armd`.

### Gotchas

- **GLM as the engine is dramatically slower than the OpenAI models.** hs-A finished 38
  questions in 29 minutes; hs-B took ~105, with one bank alone taking 68 minutes
  (`RETAIN_BATCH_ASYNC ... in 4128.641s`). Budget accordingly.
- **A DNS blip kills the run.** `socket.gaierror: [Errno 8]` on `openrouter.ai` propagated out
  of `retain_batch` and exited both running arms. `--fill` resumes from the results file
  without re-ingesting completed questions — use it.
- **Do not wait on `pgrep -f longmemeval_benchmark`.** A shell running that check contains the
  string in its own command line, so it matches itself and never exits. Wait on the PID.

## Artifacts

Throwaway, in the session scratchpad (`hindsight/` clone, `arm{A,B,C,D}.results.json`,
`arm{A,B,C,D}.rejudged.jsonl`, `compare.py`). The one piece worth keeping is
`dem-memory/bench/rejudge-hindsight.ts`, which re-scores any hindsight results file with dem's
judge; it is uncommitted and has no callers, so delete it unless a standing hindsight arm is
wanted.


---

## Addendum, 2026-09-16 (later session): hindsight's answerer sees raw transcript, so its score is not a dem ceiling

Verified while trying to reproduce hs-D's configuration inside dem. **Hindsight passes the raw
source chunks to its answering model alongside the extracted facts**, so its numbers are not
measuring the same thing dem's are.

In `benchmarks/longmemeval/longmemeval_benchmark.py`, the recall result carries a `chunks` map
and BOTH context formats forward it: `_format_context_structured` appends
`Source chunk: "…"` (truncated to 1000 chars) under every fact, and the default
`_format_context_json` is a bare `json.dumps(recall_result)`, which dumps the chunks too.

Caught on `8aef76bc`. Hindsight answered "Mod Podge" correctly and its `reasoning` quotes the
source sentence verbatim — while **none of its 232 `retrieved_memories` contain the string in
any field**, including `context` and `metadata`. Its extracted facts had lost the detail exactly
as gpt-4.1-nano's did for dem; it recovered it from the transcript chunk beside the fact.

Why this matters for how the table above is read:

- **It explains the arm-invariance.** hs-A/B/C/D barely move across gpt-4o-mini, glm-5.3-flash
  and gpt-4.1-nano engines because a weak extractor costs little when the raw text travels with
  the fact. Running dem on hindsight's own best engine (`gpt-4.1-nano`, hs-D) scores **26.0%**
  against hindsight's 94.7% on the same rows and judge — 71 points, with the model held
  constant. dem answers ONLY from extracted triples; extraction is lossy and terminal.
- **"11/11, so dem has 2 rows of headroom" is the wrong inference.** It compares an
  extract-then-answer system against memory-indexed RAG over transcripts with ~17x the evidence
  budget (median 224 facts / ~8,845 tokens vs dem's 15 rows / ~890).
- **This is a legitimate architecture, not cheating, and mostly not what carries its score.**
  Only **1 of 18** correct answers in arms A and D is clearly ungrounded in the recorded facts.
  The correction is to the comparison, not to hindsight.

Followed up in `docs/plans/2026-09-16-evidence-depth-and-source-anchors-report.md`, which builds
dem's equivalent (source anchors, Path B) and measures it as a null on dem's shipping config.
