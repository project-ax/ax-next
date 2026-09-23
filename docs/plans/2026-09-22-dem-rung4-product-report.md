# Facts-memory product measurement — TASK-497

## Outcome

**Complete: 100 pinned questions per arm, 200 unique result rows.** Both answer arms
pass the **76.0% accuracy gate**. Both **fail** the **recall p95 <1,600 ms** target.
This is not an all-gates pass and is **not a decision to replace Strata**.
`presets/k8s` remains unchanged.

| Metric | Sonnet 4.6 | GLM 5.3 Flash |
|---|---:|---:|
| Correct / questions | 84 / 100 | 81 / 100 |
| Accuracy | 84.0% — PASS | 81.0% — PASS |
| Questions using recall | 98 / 100 (98%) | 91 / 100 (91%) |
| Recall calls / question | 1.72 | 1.34 |
| Recall calls | 172 | 134 |
| Recall p95 | 3,201.861 ms — FAIL | 3,146.532 ms — FAIL |
| Failed tool calls in completed captures | 0 | 0 |
| Degraded recall calls | 15 | 12 |
| Uncertain judge verdicts | 0 | 0 |
| Incremental answer/recall/judge cost, 100q | $3.20993785 | $0.55106867 |
| Cold standalone cost, including shared ingestion | $13.21535205 | $10.55648287 |

These are one paired run, not repeated-run means or a best-of. The design's
identical-code noise floors are **1.6pp total**, **5.3pp multi-session**, and
**13.4pp hallucination**. They are context, not confidence intervals for this run.
The 76% reference was measured on Strata's full n=500 corpus; this n=100 sample
is not a paired superiority experiment against a fresh Strata control.

## Costs and interruptions

The final conservative ledger charge is **$13.76642072 / $25.00**, including
**$10.00541420** shared ingestion/preflight. Do not add the two standalone-arm
columns: each includes the same ingestion. Costs include failed attempts and resumes.

| Cost basis | Entries | USD |
|---|---:|---:|
| OpenRouter provider-reported | 5,137 | 4.15509427 |
| Published-rate estimates | 8,814 | 3.38123940 |
| Uncertain upper bounds | 61 | 6.23008705 |
| Vertex HTTP errors recorded as not billed | 2 | 0 |
| Total | 14,014 | 13.76642072 |

All 14,014 reservations have settlements. The largest running charge including
in-flight reservations was **$14.077207895**, below the cap. The ledger is **not a
confirmed invoice total**: unknown charges retain reservations. Estimates use
Anthropic token/cache rates, Vertex $0.000025 per 1,000 non-Gemini embedding
characters, and Cohere $0.0025 per search unit. Taxes and credit-purchase fees are excluded.

There were **five process interruptions** after the initial one-pair capture check:

- Question 23 (`0f05491a`): judge request after saved Sonnet answer.
- Question 88 (`gpt4_4cd9eba1`): judge request after saved GLM answer.
- Question 93 (`b0479f84`): first Sonnet request, no captured answer.
- Question 93 again: Sonnet request after tool use, no final answer captured.
- Question 96 (`eaca4986`): first Sonnet request after degraded ingestion, no captured answer.

Resumes used the same frozen source, bank checkpoints, question set, and ledger.
Saved answers were reused; no captured answer or completed verdict was regenerated.
Uncaptured answer attempts restarted. Their intermediate tool transcripts and
latencies were **not persisted by this harness**, so tool-call and latency metrics
cover completed captures, while the cost ledger includes interrupted attempts.
The final process exited 0; that does not mean there were no earlier failures.

There were **29 observer/export failure events**, retained across the 100 banks.
All **4,777 historical sessions were attempted/checkpointed**, not necessarily
successfully extracted. Failed ingestion was not replayed to improve the answers.
Degraded calls and slow tails remain included in the reported p95 values. The frozen
harness did not preserve exact exception classes; later unauthenticated connectivity
checks cannot establish the cause of those earlier failures.

## Breakdown

| Question type | n / arm | Sonnet correct | GLM correct |
|---|---:|---:|---:|
| Multi-session | 27 | 23 (85.2%) | 23 (85.2%) |
| Temporal reasoning | 27 | 22 (81.5%) | 22 (81.5%) |
| Knowledge update | 15 | 12 (80.0%) | 11 (73.3%) |
| Single-session user | 14 | 13 (92.9%) | 12 (85.7%) |
| Single-session assistant | 11 | 9 (81.8%) | 9 (81.8%) |
| Single-session preference | 6 | 5 (83.3%) | 4 (66.7%) |

| Abstention measure | Sonnet | GLM |
|---|---:|---:|
| Unanswerable questions | 5 | 5 |
| Correct refusals | 4 | 3 |
| Non-refusal answers on unanswerable questions | 1 | 2 |
| Other unanswerable outcomes | 0 | 0 |
| False refusals on answerable questions | 3 | 5 |

The inherited report labels non-refusal answers on `_abs` questions
"hallucinations" even when the inherited judge marks an answer `correct`.
These are refusal-policy flags, not a new human adjudication of factual falsehood.
Scores and classifications were retained unchanged. One question moves this
five-question subset by 20 percentage points; do not generalize its percentages.

## Method and provenance

- Run ID: `15c4554d-c9b7-413a-8939-51178cf829ff`.
- Measured source: `69e639f1ea0b86643060f05b8672b15321f7be7d`.
- Product baseline: merged preset PR #676, `0a8a6e1c8029b30b01d698a873a651af15927288`.
- Corpus: LongMemEval-S, 500 questions; SHA-256
  `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Selection: the 100 stratified IDs in `scripts/memory-product-e2e-inputs.json`.
- Answer models: `claude-sonnet-4-6` and `z-ai/glm-5.3-flash:nitro`.
  GLM uses minimal reasoning. Both use 512 answer tokens, up to six tool-bearing
  rounds, then a final no-tools round.
- Extraction: `z-ai/glm-5.3-flash:nitro`, product prompt fingerprint `e7466bf4`.
  Judge: existing Strata rubric through `x-ai/grok-4.3`.
- One isolated bank per question, shared by both read-only answer arms. Full histories
  run sequentially through the actual preset-selected observer, normalization,
  SQLite storage, exports, injected memory, and model-selected `memory_recall`.
  There is no harness-selected retrieval answer.
- Vertex `text-embedding-005` and Cohere `rerank-v4.0-pro` were live. Corpus time is
  simulated; recall latency uses `performance.now()`.
- The fixed personal-agent/credential control-plane fixture excludes UI, HTTP host,
  Kubernetes and NFS performance. No claims about those surfaces are made here.

Raw captures remain in `/tmp/task497-live`, including per-bank answer captures,
checkpoints, extraction caches, databases, and `interruption-01.json` through
`interruption-05.json`. The independent final audit is `/tmp/task497-audited-final.json`.
It checked all expected IDs/arms, capture equality, session totals, source digest,
per-type counts, every ledger event and report headline against the artifacts.
These local artifacts are not embedded in this report; retain them for follow-up.

| Artifact | SHA-256 |
|---|---|
| `manifest.json` | `b90cc89af73cdb621f03aa01f535b2cbc5344a9c011d1ba01093554e712a186d` |
| `results.jsonl` | `9b2ea9f9b26a7a3a59208da74bc9676143167295875afd7bba00e8c5ccce36f6` |
| `costs.jsonl` | `0002d7797e100074726ff95acfdc327a00f52b81d7d124c822fbaa30328564f8` |
| Generated `report.md` | `10bc0fdc734073712c668d225647327bb370e0bbefe30e0fec882eedf73aab21` |

The GLM argument-parse catch was narrowed **after capture** so recall lifecycle
errors propagate. That code fix is not part of the measured source and no answers
were rerun afterward. A new run requires a new directory; the identity guard must
not be bypassed to resume these artifacts using the changed harness.

## Follow-up, not implemented here

Investigate latency/degradation before a replacement decision. A future benchmark
should persist intermediate answer turns and sanitized failure classes so interrupted
attempts are diagnosable and their tool activity is reportable. Those changes must
use a separately identified run, not rewrite this measurement. No product rewrite,
digest upgrade, Strata removal, or live-cluster rollout is included in TASK-497.
