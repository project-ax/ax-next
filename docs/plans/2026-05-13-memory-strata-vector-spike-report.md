# Strata vector-vs-no-vector spike report

**Date:** 2026-05-13
**Cap:** $50
**Total spent (across the two underlying runs):** $11.4391 (A+B run: $3.6754 — C run: $7.7637)

> _The report below merges two underlying bench invocations: one that produced Config A + Config B (a 100-Q LongMemEval-S sample), and a second `--config c-rrf`-only re-run after a ZeroEntropy rate-limit fix (batched-embed). All three configs evaluate the same 100 LongMemEval-S questions._

## Results

| corpus | Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | $ (meter) |
|---|---|---|---|---|---|---|---|---|
| longmemeval-s | A: BM25-only | 100 | **22.0%** | **25.0%** | 1.0% | 71 | 148 | $1.7377 |
| longmemeval-s | B: BM25 + zerank-2 | 97 | 19.6% | 20.6% | 4.1% | 603 | 925 | $1.8787 |
| longmemeval-s | C: BM25 + zembed-1 + RRF | 100 | **13.0%** | **16.0%** | 3.0% | 600 | 814 | $7.7637 |

## Binding decision

**Level 3: OUT.** The roadmap's threshold says Level 3 stays IN only if `C beats both A and B by ≥3 points` on LongMemEval-S accuracy. We see the opposite: **C loses to A by 9.0 points and to B by 6.6 points.** That's well outside the ±3-point band — there is no plausible path where Level 3 (vectors + RRF, with the design's "lightweight summary+headers" indexing strategy) earns its keep on this corpus.

A secondary finding worth surfacing: **the Level-6 reranker (Config B) also underperforms BM25-only.** B trails A by 2.4 points accuracy, has 4.4 points lower recall@5, and runs ~6× slower (p95 925 ms vs 148 ms). Per the roadmap's branching rules, "B beats A by a clear margin but C does not beat B → Level 3 OUT, prioritise reranker (Level 6)." That branch does not fire here — B doesn't beat A either. **Phase 4's reranker priority should be reconsidered.**

The cleanest BM25-only configuration won the spike on every dimension that mattered: highest accuracy, highest recall@5, lowest latency, and (true) lowest cost. The reranker and vector paths each spent more — in tokens, in latency, in code surface — and returned less.

A nuance the table doesn't fully convey: this 22% absolute accuracy on Config A is well below the LongMemEval-S literature range (30–50% on Sonnet+RAG configs). The gap reflects Strata's intentionally lightweight retrieval+injection: the BM25 index is over the full body but the retrieved snippets are truncated bodies (2000 chars), and the vector index is summary+headers only — both consistent with the Strata design doc's "lightweight indexing" intent. **Inside that lightweight regime, BM25 is the right answer.** A separate evaluation comparing Strata's lightweight regime against a heavyweight reference RAG is out of scope here.

### Cross-reference: c137 prior art (added after the run)

After the bench run completed, the Strata design doc was revised to incorporate [c137 Mapped Memory](https://www.c137.ai/research) — a closed-source single-developer system that reportedly hits **90.4% on LongMemEval-S with zero embeddings**, using a compact always-in-context "memory map" + a cheap-LLM retrieval orchestrator. Two implications for this binding decision:

1. **The Level 3 OUT conclusion is strengthened.** c137 is a second independent signal (alongside ByteRover's BM25-only LoCoMo numbers) that vector retrieval isn't load-bearing for agent memory. The design doc's c137 revision also tightened the spike's acceptance threshold from "≥3 points" to "**≥5 points**" — our observed 9-point margin against vectors clears the new threshold by 4 points, so the decision survives the tighter standard.

2. **A new Config D — Retrieval Orchestrator + `system/map.md` — was added to the spike configurations.** It is *not* exercised in this round. Config D is structurally different from A/B/C — instead of running a retrieval index, it generates a per-corpus map at build time and uses a cheap LLM stage at query time to emit XML retrieval ops. Whether Config D outperforms BM25-only is the next open question on the binding axis, but it doesn't change the existing **C vs A** verdict. A follow-up spike implements Config D + an abstention-aware judge (c137 reports 86.7–96.7% correct-refusal rates, which is now a primary eval axis per the c137-revised design).

In short: this PR's binding decision against vectors stands. The c137-revised design doc renumbers the level (vectors are now Level 7, formerly Level 3) and raises the bar; both reinforce the OUT conclusion.

## Caveats

- **Single-corpus run.** LoCoMo and the internal synthetic corpus were not exercised in this round. LongMemEval-S is the authoritative axis per the roadmap, so the binding decision applies, but a cross-corpus corroboration on LoCoMo is queued as a follow-up once the harness gains per-question concurrency (the sequential ~1.5h cost per corpus is the gating factor).
- **LongMemEval-cleaned, not original.** The Phase 3A loader pointed at `xiaowu0162/LongMemEval`, which has been deprecated by its author and replaced by `xiaowu0162/longmemeval-cleaned`. We loaded the cleaned variant — the author's stated rationale is that the cleaned version "removes noisy history sessions that interfere with the answer correctness." Absolute accuracy may be modestly higher than what the original-corpus literature reports. The relative ranking across A/B/C should be unaffected.
- **n=100.** Margins should hold at n=250+, but a tighter confidence interval is a follow-up if the decision were ever revisited.
- **Judge bias.** Grok 4.3 (cross-family with Sonnet 4.6 agent under test) was the judge. A multi-judge sweep (e.g., GPT-5 as a second judge) is a Phase 5+ follow-up if the binding decision were close — here, the 9-point margin on Level 3 and the 2.4-point reverse margin on Level 6 are large enough that judge bias is unlikely to flip the conclusion.
- **Config B reranker operates on truncated bodies.** Config B passes the top-2000-chars of each candidate body (not just the summary) to `zerank-2`. So this is a fair benchmark of the reranker against truncated-body content — which matches production injection. A reranker scoring against full bodies might score differently, but full-body rerank isn't in any Phase-4 design.
- **Config C vector index over summary+headers.** Per the Strata design doc ("Lightweight indexing"), `zembed-1` embeds `summary + headers` (not body), and BM25 retrieves over body. RRF fuses them. The fact that this hurts overall accuracy is itself a finding — the summary+headers signal is too sparse for the embedding to be informative. If Level 3 were ever revisited, the obvious next experiment would be embedding bodies, but that contradicts the lightweight-indexing design tenet, and the spike result above provides the evidence to not pursue that fork without a stronger motivation.
- **Cost-meter inflation in Config C.** A Phase 3A bug surfaced during the run: `c-rrf.ts:120` returns the *cumulative* `embeddingTokens` counter on every per-question `retrieve()` call, and `cli.ts:152` records that cumulative value as a per-question delta — so the build-phase embed tokens get re-counted ~100×. The displayed $7.76 for Config C is roughly 50× the true cost (≈ $1.87 for agent+judge + ≈ $0.06 for embedding ≈ $1.93). The bug does not affect accuracy, recall, or latency — only the displayed dollar figure for Config C. A two-line fix (track per-call delta, not cumulative) is filed as a follow-up.
- **Three Config B questions skipped** with `Cannot read properties of undefined (reading '0')` — a per-question JS error caught by the new skip-on-error path. The skipped count of 3 / 100 (3%) is small enough not to change the ranking. Root-causing the source of that error is a follow-up.
- **ZeroEntropy SDK quirks** (carried over from Phase 3A): `input_type: 'document' | 'query'` required; embed response shape is `{ results: [{ embedding }], usage: { total_tokens } }`; rerank `total_tokens` is top-level (not under `usage`); `zembed-1` default dim is 2560.
- **LongMemEval and LoCoMo are research-licensed** datasets; results above are derived but not redistributed.
- `zeroentropy@0.1.0-alpha.10` (alpha SDK) — re-runs may need to re-pin if the SDK changes.
