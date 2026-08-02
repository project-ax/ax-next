# Strata end-to-end LongMemEval-S report

Measures the **shipped** `@ax/memory-strata` runtime end-to-end — Observer extraction (`chat:end`) → inbox → consolidator (decay/cluster/dedup/promote) → `docs/` + `system/recent.md` → `system-prompt:augment` injection + `memory_search` → answer — NOT the bench A–E retrieval-config drivers.

**Date:** 2026-08-02
**Answer LLM (under test):** `claude-sonnet-4-6` (Anthropic)
**Observer / consolidator extraction LLM:** `claude-haiku-4-5-20251001` (Anthropic)
**Judge:** `x-ai/grok-4.3` (via OpenRouter)
- **Retrieval:** BM25-only (TASK-190 baseline)
**Requested sample:** n=500
**Cost cap:** $400
**Total spent:** $135.4579
**Command:** `pnpm --filter @ax/memory-strata bench --mode e2e --sample 500`

## Headline

| metric | value |
|---|---|
| questions evaluated | 500 |
| **end-to-end accuracy** (correct + correct-refusal) | **76.0%** |
| uncertain (judge couldn't tell) | 0.0% |
| avg haystack sessions ingested / question | 47.7 |
| avg memory tool calls / question | 1.9 |

## Abstention (the `_abs` unanswerable split)

| metric | value |
|---|---|
| unanswerable questions | 30 |
| **correct-refusal rate** (refused when it should) | 83.3% |
| **hallucination rate** (answered an unanswerable) | 16.7% |
| answerable questions | 470 |
| **false-refusal rate** (refused an answerable — missed retrieval) | 8.1% |

## By question type

| question_type | n | accuracy | uncertain% |
|---|---|---|---|
| knowledge-update | 78 | 71.8% | 0.0% |
| multi-session | 133 | 69.2% | 0.0% |
| single-session-assistant | 56 | 83.9% | 0.0% |
| single-session-preference | 30 | 73.3% | 0.0% |
| single-session-user | 70 | 84.3% | 0.0% |
| temporal-reasoning | 133 | 78.2% | 0.0% |

## How to read this number

- This is the **first** measurement of the shipped product end-to-end. The earlier spike reports (`2026-05-13-…vector-spike-report.md`, `…phase-3c-config-d-report.md`) scored RETRIEVAL CONFIGS (A–E) with a generic agent + a deliberately lightweight injection regime — their absolute 20–28% is **not** comparable to this number.
- The published c137 LongMemEval-S anchor is ~90.4%, measured with a different agent + judge + retrieval stack. Treat the gap as a starting baseline for TASK-190 (map/densified inject) and TASK-191 (retrieval orchestrator), which this report exists to give a real before/after against — NOT as a like-for-like comparison.
- Apples-to-apples requires naming the stack: answer LLM `claude-sonnet-4-6`, extraction `claude-haiku-4-5-20251001`, judge `x-ai/grok-4.3`. A different judge or answer model would move the absolute number.

