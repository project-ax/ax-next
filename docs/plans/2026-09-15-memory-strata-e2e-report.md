# Strata end-to-end LongMemEval-S report

Measures the **shipped** `@ax/memory-strata` runtime end-to-end — Observer extraction (`chat:end`) → inbox → consolidator (decay/cluster/dedup/promote) → `docs/` + `system/recent.md` → `system-prompt:augment` injection + `memory_search` → answer — NOT the bench A–E retrieval-config drivers.

**Date:** 2026-09-15
**Answer LLM (under test):** `claude-sonnet-4-6`
**Observer / consolidator extraction LLM:** `z-ai/glm-5.3-flash:nitro`
**Judge:** `x-ai/grok-4.3`
- **Retrieval:** orchestrator (config E — orchestrator over system/map.md + BM25 fallback), planner=`z-ai/glm-5.3-flash:nitro`
  (Planner latency measured 2026-09-14 on `z-ai/glm-5.3-flash:nitro` with minimal reasoning: p50 1.4-1.6s, and p95 1.6s over the 500-call accuracy run. Without the reasoning flag the SAME model measures p50 ~4.9-5.1s — past the budget, falling back to BM25 in silence. See `docs/plans/2026-09-11-orchestrator-accuracy-report.md`.)
**Requested sample:** n=100
**Cost cap:** $2
**Total spent:** $0.0763
**Command:** `pnpm --filter @ax/memory-strata bench --mode e2e --sample 100 --orchestrator-model glm --ids 0e5e2d1a`

## Headline

| metric | value |
|---|---|
| questions evaluated | 1 |
| **end-to-end accuracy** (correct + correct-refusal) | **100.0%** |
| uncertain (judge couldn't tell) | 0.0% |
| avg haystack sessions ingested / question | 46.0 |
| avg memory tool calls / question | 1.0 |

## Abstention (the `_abs` unanswerable split)

| metric | value |
|---|---|
| unanswerable questions | 0 |
| **correct-refusal rate** (refused when it should) | n/a |
| **hallucination rate** (answered an unanswerable) | n/a |
| answerable questions | 1 |
| **false-refusal rate** (refused an answerable — missed retrieval) | 0.0% |

## By question type

| question_type | n | accuracy | uncertain% |
|---|---|---|---|
| single-session-assistant | 1 | 100.0% | 0.0% |

## How to read this number

- This is the **first** measurement of the shipped product end-to-end. The earlier spike reports (`2026-05-13-…vector-spike-report.md`, `…phase-3c-config-d-report.md`) scored RETRIEVAL CONFIGS (A–E) with a generic agent + a deliberately lightweight injection regime — their absolute 20–28% is **not** comparable to this number.
- The published c137 LongMemEval-S anchor is ~90.4%, measured with a different agent + judge + retrieval stack. Treat the gap as a starting baseline for TASK-190 (map/densified inject) and TASK-191 (retrieval orchestrator), which this report exists to give a real before/after against — NOT as a like-for-like comparison.
- Apples-to-apples requires naming the stack: answer LLM `claude-sonnet-4-6`, extraction `z-ai/glm-5.3-flash:nitro`, judge `x-ai/grok-4.3`. A different judge or answer model would move the absolute number.

