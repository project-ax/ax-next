# Strata vector-vs-no-vector spike report

**Date:** 2026-09-14
**Cap:** $50
**Sampling:** --sample 150 (stratified by question_type) -> longmemeval-s: multi-session=40 temporal-reasoning=40 knowledge-update=23 single-session-user=21 single-session-assistant=17 single-session-preference=9
**Answer-stage body cap:** 20,000 chars/doc
**Orchestrator model:** `z-ai/glm-5.3-flash:nitro`
**Total spent:** $7.9943

## Results

| corpus | Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | $ |
|---|---|---|---|---|---|---|---|---|
| longmemeval-s | E: Orchestrator + BM25 fallback | 150 | 63.3% | 92.7% | 0.0% | 2525 | 15229 | $7.9943 |

## Abstention

| corpus | Config | unanswerable n | correct-refusal | hallucinated | false-refusal (on answerable) |
|---|---|---|---|---|---|
| longmemeval-s | E: Orchestrator + BM25 fallback | 7 | 6 (85.7%) | 1 | 30 / 143 |

## Spend by model

| model | tokens in | tokens out | $ | % of run |
|---|---|---|---|---|
| `claude-sonnet-4-6` | 2,428,458 | 29,586 | $7.7292 | 96.7% |
| `x-ai/grok-4.3` | 90,672 | 40,991 | $0.2158 | 2.7% |
| `z-ai/glm-5.3-flash:nitro` | 301,987 | 8,011 | $0.0493 | 0.6% |

## Plan shape

How much of the retrieval the PLANNER actually did. An arm that falls back on
most questions is running BM25 under an orchestrator's name — it will score and
cost like BM25 no matter what the config column says.

| corpus | Config | n | mean docs from planner | planner returned nothing | followup requested | fell back to BM25 |
|---|---|---|---|---|---|---|
| longmemeval-s | E: Orchestrator + BM25 fallback | 150 | 2.95 | 0.7% | 42.0% | 30.0% |

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
