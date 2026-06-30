# Strata end-to-end LongMemEval-S report

Measures the **shipped** `@ax/memory-strata` runtime end-to-end — Observer extraction (`chat:end`) → inbox → consolidator (decay/cluster/dedup/promote) → `docs/` + `system/recent.md` → `system-prompt:augment` injection + `memory_search` → answer — NOT the bench A–E retrieval-config drivers.

**Date:** 2026-06-30
**Answer LLM (under test):** `claude-sonnet-4-6` (Anthropic)
**Observer / consolidator extraction LLM:** `claude-haiku-4-5-20251001` (Anthropic)
**Judge:** `x-ai/grok-4.3` (via OpenRouter)
**Requested sample:** n=100
**Cost cap:** $25
**Total spent:** $0.0000
**Command:** `pnpm --filter @ax/memory-strata bench --mode e2e --fixture`

> **Representative report (fixture mode).** No live API keys were present, so this report was produced from the deterministic integration fixture to demonstrate the harness end-to-end. The numbers are illustrative, NOT a measured LongMemEval-S score. Re-run with `ANTHROPIC_API_KEY` + `OPENROUTER_API_KEY` set for real numbers.

## Headline

| metric | value |
|---|---|
| questions evaluated | 2 |
| **end-to-end accuracy** (correct + correct-refusal) | **100.0%** |
| uncertain (judge couldn't tell) | 0.0% |
| avg haystack sessions ingested / question | 1.5 |
| avg memory_search calls / question | 1.0 |

## Abstention (the `_abs` unanswerable split)

| metric | value |
|---|---|
| unanswerable questions | 1 |
| **correct-refusal rate** (refused when it should) | 100.0% |
| **hallucination rate** (answered an unanswerable) | 0.0% |
| answerable questions | 1 |
| **false-refusal rate** (refused an answerable — missed retrieval) | 0.0% |

## By question type

| question_type | n | accuracy | uncertain% |
|---|---|---|---|
| single-session-preference | 1 | 100.0% | 0.0% |
| single-session-user | 1 | 100.0% | 0.0% |

## How to read this number

- This is the **first** measurement of the shipped product end-to-end. The earlier spike reports (`2026-05-13-…vector-spike-report.md`, `…phase-3c-config-d-report.md`) scored RETRIEVAL CONFIGS (A–E) with a generic agent + a deliberately lightweight injection regime — their absolute 20–28% is **not** comparable to this number.
- The published c137 LongMemEval-S anchor is ~90.4%, measured with a different agent + judge + retrieval stack. Treat the gap as a starting baseline for TASK-190 (map/densified inject) and TASK-191 (retrieval orchestrator), which this report exists to give a real before/after against — NOT as a like-for-like comparison.
- Apples-to-apples requires naming the stack: answer LLM `claude-sonnet-4-6`, extraction `claude-haiku-4-5-20251001`, judge `x-ai/grok-4.3`. A different judge or answer model would move the absolute number.

