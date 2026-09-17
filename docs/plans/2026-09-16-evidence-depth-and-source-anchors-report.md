# Two levers that did not pay: evidence depth and source anchors

**Date:** 2026-09-16
**Question:** after the assistant-content extraction fix, dem-memory answers from 15 rows /
~890 tokens while hindsight answers from ~224 facts / ~8,845 tokens. Is dem's evidence budget
the remaining gap — and would carrying raw source text alongside each fact close it?
**Answer:** no, and no. Both are **negative results** on dem's shipping config. The lever was
extraction, and it already shipped.

## Result

Same 100 LongMemEval-S questions (`--sampler spaced`), same judge (`x-ai/grok-4.3`), same
extraction cache. Only the evidence regime changes.

| answerer | fixed-15 | Path A (fill the budget) | Path B (+ source excerpts) |
|---|---|---|---|
| `z-ai/glm-5.3-flash` | 83.0% | 88.0% | 87.0% |
| `anthropic/claude-sonnet-4.6` | 88.0% | **87.0%** | **87.0%** |

**Neither replicates.** Path A: GLM 7W/2L (p=0.180), Sonnet 1W/2L (p=1.000); of 10 flips across
the two arms, **1 replicated**, 0 replicated losses, 1 conflict. Path B vs Path A: GLM 5W/6L
(p=1.000), Sonnet 3W/3L (p=1.000); of 14 flips, **1 replicated win**, 0 replicated losses,
2 conflicts. `single-session-assistant` is **9/11 in all four GLM-extraction configs** — neither
path moved the type Path B was designed for.

Both cost real money for that: Path A is **1.93x** and Path B **1.84x** the answer-prompt tokens
of the baseline (1378 -> 2664 / 2532 median).

**The GLM +5.0 is the same 27-question `multi-session` instability that has now produced a
spurious +14.8 four separate times in this project.** It is the single most reliable way to be
fooled by this benchmark.

## What each path was, and what shipped

**Path A — fill the token budget instead of taking a fixed 15 rows.** This found a genuine
defect: across three scored n=100 runs (300 questions) the 2000-token budget bound **zero**
times, every question returned exactly 15 rows at 26%-44% of the allowance, and
`compileEvidenceTable`'s rank-ordered trim had therefore **never executed in a scored run**.
Fixing it works mechanically (34 rows, 1967 tokens median) and buys nothing.
**Shipped as opt-in**: `DEFAULT_EVIDENCE_ROWS = 15` stays the default; pass a larger
`RecallOptions.limit` (see `DEFAULT_EVIDENCE_ROW_CAP`) to fill the budget, and raise
`rerankPool` with it or the table's tail falls back to raw RRF order.

**Path B — carry a verbatim slice of the source dialogue per fact.** Extraction is lossy and
terminal: with a terse extractor, 30 of 56 answerable failures had the gold **nowhere in the
bank**, so no retrieval depth could reach them. Hindsight avoids this by passing raw transcript
chunks to its answerer (`longmemeval_benchmark.py` dumps `recall_result`, chunks included) —
which is why its score barely moves across engine models.
**Shipped as opt-in and OFF**: `sourceExcerpts: 0`. `src/engine/source-chunk.ts` +
`memories.source_chunk`.

**It needs no re-extract**, which is the one improvement on the design as proposed. Asking the
extractor to emit a source span changes the extraction prompt, which re-keys the fact cache and
forces a full cold re-extract (~1.5h, ~$2.20 per engine). But `retain()` already has the
dialogue at its call site, so matching each fact to its best-scoring turn is free and needs no
model call. Attribution is heuristic; for a safety net that is enough. Verified end-to-end on
`8aef76bc`: `Mod Podge` reaches the evidence table via an excerpt, from nano's own facts, which
had compressed it away.

## Where Path B *does* pay, and why it still should not ship on

With `gpt-4.1-nano` as the extractor, Path B scored 28.0% against Path A's 24.0% and the
fixed-15 baseline's 26.0%. That is a single unreplicated arm, and it is insurance against a
failure mode you only have with a weak extractor. dem's shipping extractor does not have it:
**10 of 10 remaining GLM failures already had the gold in the bank.**

## The model comparison this produced

| extractor | answerer | evidence | score | answer $/100q |
|---|---|---|---|---|
| glm-5.3-flash | **glm-5.3-flash** | fixed-15 | 83.0% | **$0.012** |
| glm-5.3-flash | glm-5.3-flash | Path A | 88.0% | $0.021 |
| glm-5.3-flash | claude-sonnet-4.6 | fixed-15 | 88.0% | $0.628 |
| glm-5.3-flash | claude-sonnet-4.6 | Path A | 87.0% | $1.060 |
| **gpt-4.1-nano** | glm-5.3-flash | fixed-15 | **26.0%** | $0.009 |
| gpt-4.1-nano | glm-5.3-flash | Path B | 28.0% | $0.021 |

- **The extractor is the decision that matters: 57 points.** Extraction is lossy and terminal,
  so a weak extractor is unrecoverable — nothing lifted nano above 28%.
- **The answerer barely matters.** Sonnet costs 30-50x for a difference inside the noise band.
- Treat **83-88% at n=100 as one number** (SE ~3.8pp).

## Settled with repeats: the budget does not beat 15 rows, and here is the noise floor

Eight further runs — 4 per config, identical code, same 100 questions, GLM answerer, ~$1 total
on warm caches:

| config | four runs | mean | sd |
|---|---|---|---|
| 15 rows | 86.0, 86.0, 84.0, 82.0 | 84.50% | 1.91 |
| 2000-token budget | 85.0, 83.0, 89.0, 87.0 | 86.00% | 2.58 |

Difference **+1.50pp**, **t(6) = 0.93** (2.45 needed for p<0.05). Per question across all eight
runs: budget better on 12, worse on 7, tied on 81.

**The run-to-run noise floor at n=100 is +/-4-6pp on IDENTICAL code, and 21 of 100 questions
flip at least once across the eight runs.** Minimum detectable difference with 4 repeats per
arm is ~3.9pp; with ONE run per arm — which is how every arm in this report and every arm
earlier in the day was measured — variance cannot be estimated at all, so no single-arm delta
was ever interpretable.

This explains the whole day rather than just this table. Cherry-picking the best budget run
(89.0%) against the worst 15-row run (82.0%) manufactures **+7.0pp** from two configurations
doing nothing different — larger than any effect reported today except the assistant-content
fix. The GLM Path A "+5.0", Path B's "+4.0", and all four `multi-session` "+14.8"s sit inside
this band.

Caveat on the number: these eight runs share one question sample and one extraction cache, so
they measure answerer + judge variance only. The true error budget, including sampling, is
LARGER than +/-4-6pp.

**Standing bar for this bench: 4+ repeats per arm, or an effect big enough not to need the
test.** The assistant-content extraction fix is the second kind — +36.4pp on its type, in both
answerers, with all four flipped questions confirmed mechanically.

## Method note worth keeping

**Run both answer arms before believing any per-type delta.** A second arm costs ~15 min and
cents on warm caches. Today it overturned three separate single-arm results, each of which had
a persuasive mechanism story attached. A mechanism story is not corroboration — one is equally
easy to write for either sign, after the fact. Use McNemar on discordant pairs; the runs are
paired, so an unpaired SE is the wrong test.
