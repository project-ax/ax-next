# Strata vector-vs-no-vector spike report

**Date:** 2026-09-12
**Cap:** $50
**Orchestrator model:** `z-ai/glm-5.3-flash:nitro`
**Total spent:** $5.1611

## Results

| corpus | Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | $ |
|---|---|---|---|---|---|---|---|---|
| longmemeval-s | E: Orchestrator + BM25 fallback | 500 | 36.0% | 94.4% | 0.0% | 655 | 1603 | $5.1611 |

## Abstention

| corpus | Config | unanswerable n | correct-refusal | hallucinated | false-refusal (on answerable) |
|---|---|---|---|---|---|
| longmemeval-s | E: Orchestrator + BM25 fallback | 30 | 25 (83.3%) | 5 | 223 / 470 |

## Spend by model

| model | tokens in | tokens out | $ | % of run |
|---|---|---|---|---|
| `claude-sonnet-4-6` | 1,255,919 | 36,292 | $4.3121 | 83.6% |
| `x-ai/grok-4.3` | 248,894 | 150,764 | $0.6880 | 13.3% |
| `z-ai/glm-5.3-flash:nitro` | 1,009,286 | 19,060 | $0.1609 | 3.1% |

## Plan shape

How much of the retrieval the PLANNER actually did. An arm that falls back on
most questions is running BM25 under an orchestrator's name — it will score and
cost like BM25 no matter what the config column says.

| corpus | Config | n | mean docs from planner | planner returned nothing | followup requested | fell back to BM25 |
|---|---|---|---|---|---|---|
| longmemeval-s | E: Orchestrator + BM25 fallback | 500 | 2.74 | 0.0% | 34.6% | 26.2% |

## Binding decision

Apply the roadmap's >= 3-point LongMemEval-S accuracy threshold:
- If C beats both A and B by >= 3 points -> Level 3 stays IN.
- If A or B comes within 3 points of C -> Level 3 is OUT.
- If B beats A by a clear margin but C does not beat B -> Level 3 OUT, prioritise reranker (Level 6) in Phase 4.

> _Phase 3B PR author fills in the explicit decision based on the LongMemEval-S row above._

## Caveats

- Internal corpus is synthetic; treat as directional, not authoritative.
- Judge is Grok 4.3 (cross-family with Sonnet 4.6 agent under test), but still a large model with its own biases. Cross-judge sweep is a Phase 5+ follow-up if the decision is close.
- LongMemEval and LoCoMo are research-licensed datasets; results are not redistributed.
- zeroentropy@0.1.0-alpha.10 (alpha SDK) — re-runs may need to re-pin if the SDK changes.
