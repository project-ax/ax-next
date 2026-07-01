# Strata fair-reranker re-test report (TASK-192)

Settles whether a **fair** local-cross-encoder reranker beats BM25-only. The prior reranker test (config B, hosted `zerank-2`) LOST to BM25-only by 2.4pp at ~6× the latency — but it reranked only `topK*3` candidates, over **2000-char-truncated** bodies, with **no query expansion**. Config **F** fixes all four: a wide BM25 pool, **full bodies**, **query expansion** (PRF + entity discovery), and a **local** cross-encoder (`mixedbread-ai/mxbai-rerank-large-v1`, ~435M) instead of the hosted zerank-2.

**Date:** 2026-06-29
**Reranker (config F):** `mixedbread-ai/mxbai-rerank-large-v1` (local cross-encoder)
**Answer LLM:** `claude-sonnet-4-6` · **Judge:** `x-ai/grok-4.3`
**BM25 candidate pool fed to F:** 50 (vs config B's `topK*3`)
**Command:** `pnpm --filter @ax/memory-strata bench --corpus longmemeval-s --config all`

> **VERDICT: needs-local-run.** This report was generated in an environment WITHOUT a local cross-encoder + the answer/judge API keys, so it carries no measured numbers. The full accuracy + abstention verdict requires a keyed end-to-end run; recall@5 + cross-encoder latency need only a local cross-encoder. Reproduce with:

```bash
# 1. Set up the local cross-encoder (one-time, ~1.7GB model on first run):
python3 -m venv /tmp/rerank-venv
/tmp/rerank-venv/bin/pip install sentence-transformers

# 2. Run the head-to-head (A vs E vs F) with keys + the local reranker:
export ANTHROPIC_API_KEY=... OPENROUTER_API_KEY=... ZEROENTROPY_API_KEY=...
export AX_BENCH_RERANK_PYTHON=/tmp/rerank-venv/bin/python
pnpm --filter @ax/memory-strata bench --corpus longmemeval-s --config all
```

The run rewrites this file with the measured A/E/F table, recall@5, abstention, the isolated cross-encoder per-query latency, and the WIN / NO-WIN verdict against the 5pp bar.

## How to read this

- The bar is **>= 5pp LongMemEval-S accuracy** of fair-F over BM25-only (config A), matching the roadmap threshold used for the orchestrator decision.
- Config B (hosted `zerank-2`, truncated bodies, no expansion) is the prior UNFAIR baseline that lost; config F is this fair re-test. They are different experiments — do not conflate.
- Absolute accuracy here reflects the bench A–E retrieval-config regime (generic agent + `claude-sonnet-4-6` + `x-ai/grok-4.3` judge), NOT the shipped product e2e number (see the TASK-189 e2e report). Only the A-vs-F **delta** is the load-bearing signal.
- Out of scope: wiring a reranker into the runtime. This is a measurement spike; promotion is a separate card iff F wins.
