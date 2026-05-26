# `@ax/memory-strata` Phase 3 design — eval harness + vector-vs-no-vector spike

**Date:** 2026-05-12. **Owner:** Vinay. **Status:** Design approved, impl plan pending.

This is the design spec for Strata Phase 3. Master sequencing lives in `docs/plans/2026-05-10-memory-strata-roadmap.md`; this doc fixes the *shape* of the eval harness + binding spike. The Phase 3A and Phase 3B implementation plans will be derived from this spec.

The deliverable is the **binding decision** on whether Level 3 (dense embeddings + RRF fusion) stays in the Progressive Enhancement Path. Per the roadmap: if BM25-only or BM25 + LLM rerank comes within ~3 points of BM25 + dense + RRF on LongMemEval-S, Level 3 is dropped and the embedding-model dependency is removed from the design entirely.

---

## Source of truth

- **Strata design spec:** `docs/plans/memory-strata-design.md` — Sections "Evaluation Plan", "The vector-vs-no-vector spike", and "Progressive Enhancement Path" define the requirements this design implements.
- **Roadmap:** `docs/plans/2026-05-10-memory-strata-roadmap.md` — Phase 3 acceptance criteria and the "Done when" checklist.
- **Project conventions:** `CLAUDE.md` — six invariants, voice & tone, half-wired window policy.
- **Phase 2 ship lists:**
  - `2026-05-10-memory-strata-phase-2a-consolidator-impl.md`
  - `2026-05-10-memory-strata-phase-2b-retriever-impl.md`
  - Production BM25 path is what Config A reuses.
- **Memory:** `feedback_yagni_check_in_plans.md` (audit each task for load-bearing at MVP), `feedback_check_plan_vs_reality.md` (roadmap's "Phase 2 has been running ≥1 week" trigger was not met; user authorized proceeding in full and accepting synthetic-only signal on the internal corpus).

## Trigger gap acknowledgement

The roadmap's stated Phase 3 trigger ("Phase 2 retrieval has been running for ≥1 week") was **not met** at the start of this design. Phase 2A and 2B both shipped on 2026-05-11; this design was drafted on 2026-05-12. The deviation is intentional and authorized:

- The public benchmarks (LongMemEval-S, LoCoMo) are not gated on dogfooding — they're closed corpora and give the same signal regardless of when the spike runs.
- The internal eval is synthesized from `docs/plans/` + `.claude/memory/` and is therefore approximate to our real workload, not a direct read of dogfooded production data. This is acknowledged in the report.
- Re-running the bench against real dogfooded memory data is a cheap follow-up if Phase 4 needs it (the harness exists; only the corpus changes).

## Open question resolved at design time

The roadmap and Strata design doc left **memsearch port-vs-sidecar** as an open question. Phase 2 resolved this implicitly by porting BM25 directly to TypeScript (the FTS5 + tsvector indexer packages). Phase 3 inherits this: there is no Python sidecar; embeddings (Config C) come from the ZeroEntropy SDK and a sqlite-vec index built in-process from the bench.

---

## Decisions

### D1 — Harness location: spike-only modules in `packages/memory-strata/test/bench/`

The eval harness lives entirely under `test/bench/`. Configs B (rerank) and C (dense + RRF) compose on top of the production BM25 search hook. Production indexer packages (`memory-strata-index-sqlite`, `memory-strata-index-postgres`) are **not** extended in Phase 3. If the binding decision lands on "Level 3 in," a follow-up phase wires vectors into production indexers using the spike code as reference.

Rationale:

- Honors CLAUDE.md invariant #3 (no half-wired plugins): no production code paths added for a measurement that may be discarded.
- Honors invariant #5 (capabilities explicit and minimized): bench-time dependencies (`zeroentropy`, `sqlite-vec`, `openai`, `@huggingface/hub`) stay in `devDependencies` of `@ax/memory-strata`; runtime capability surface is unchanged.
- Config A reuses the shipped `memory:index:search` hook through a thin in-process driver, so the spike's "baseline" is genuinely the production path, not a re-implementation.

### D2 — Models

| Role | Model | Provider | Per-call cost driver |
|---|---|---|---|
| Agent under test (consumes injected memory, answers questions) | `claude-sonnet-4-6` | Anthropic | matches production default |
| Embedding for Config C | `zembed-1` | ZeroEntropy | dense vector at index + query time |
| Reranker for Config B | `zerank-2` | ZeroEntropy | top-K rerank per query |
| Judge (grades `(question, gold, answer)` → correct/incorrect/uncertain) | `x-ai/grok-4.3` via OpenRouter | OpenRouter | cross-family judge avoids same-family bias |

Rationale:

- Sonnet 4.6 as the agent matches what production agents actually use; the spike measures realistic retrieval impact on a realistic agent.
- ZeroEntropy `zembed-1` + `zerank-2` were selected by the project lead. SDK is `zeroentropy@0.1.0-alpha.10` on npm (Stainless-style shape); pin to exact version.
- Grok 4.3 (`x-ai/grok-4.3`, $1.25/M in, $2.50/M out, 1M ctx as of 2026-05-12) is cross-family relative to the Claude-Sonnet agent under test, removing the obvious bias that a same-family judge would have. Called via the `openai` npm SDK pointed at `https://openrouter.ai/api/v1`.

### D3 — Datasets: fetch-on-demand with content-addressed cache

- **LongMemEval-S** and **LoCoMo** are pulled from HuggingFace on first run, cached under `~/.cache/ax-memory-bench/<dataset>/`. Re-runs are cache hits and fast.
- **Internal corpus** is synthesized once from current `docs/plans/` and `.claude/memory/`, then committed as `packages/memory-strata/test/bench/internal-corpus.json`. Regeneration requires explicit `--regen-internal` flag, so internal eval is deterministic across runs.
- Repo stays small (no LFS), but bench requires network on first run. Cache-miss with no network = bench fails with a clear "manual download" message.

### D4 — PR shape: two PRs (3A scaffolding, 3B binding run)

- **Phase 3A** lands the harness skeleton, dataset loaders, internal-corpus synthesizer, all three config drivers, the cost meter, the cache utility, the report writer, and stubbed/smoke tests. **No real LLM/embedding calls are made except a small `BENCH_LIVE=1` real-API smoke** that proves the SDKs are wired (single question, single config, single corpus, hard-fail above $0.50).
- **Phase 3B** runs the full bench (`pnpm --filter @ax/memory-strata bench --corpus all --config all`), commits the head-to-head report, updates the Strata design doc's Progressive Enhancement Path to match the decision, and updates the roadmap's Phase 4 trigger language. If Level 3 is "in," 3B files a follow-up issue for the production vector wire-in but does not do that work itself.

Splitting at this seam keeps each PR's acceptance bar clean: 3A is "the harness exists and the plumbing works on stubs," 3B is "the decision is made and committed."

### D5 — Cost guardrail: hard cap at $50 per full run, partial-report on abort

The meter tracks tokens + dollars across every LLM, embedding, and reranker call. Before each call, the meter projects the worst-case remaining spend (current spend + max-tokens × per-token-cost across the remaining (corpus, config, question) tuples). If the projection exceeds $50, the bench aborts cleanly:

1. Aggregates whatever results exist.
2. Writes a partial-run report flagged "Aborted: cost cap exceeded."
3. Exits non-zero.

The cap is a safety net, not a budget. Hitting it means the harness has a bug, the corpus is larger than expected, or model pricing drifted. Expected real spend for the full triple run is ~$15–25 (rough estimate: ~2000 question evaluations × 3 configs × ~$0.003 average, plus embedding cost on the first run only).

### D6 — Internal corpus signal is bounded and labeled

The internal corpus is synthetic — LLM-generated Q&A pairs over a synthesized Strata tree built from `docs/plans/` + `.claude/memory/`. To bound the risk that bad Q&A pairs poison the signal:

- Phase 3A's PR description hand-spot-checks at least 20% of generated questions and reports the false-positive rate (questions where the "gold" answer is wrong or ambiguous).
- If hand-check accuracy is below 80%, the synthesizer is iterated until it passes, OR up to 30 hand-authored questions supplement the synthetic set.
- The report explicitly labels the internal corpus result as "synthetic-derived; treat as directional, not authoritative."

---

## Architecture

```
packages/memory-strata/test/bench/
├── cli.ts                      # entry point, arg parsing, orchestration
├── corpora/
│   ├── longmemeval-s.ts        # HF fetcher → Strata tree + QA set
│   ├── locomo.ts               # HF fetcher → Strata tree + QA set
│   └── internal.ts             # synthesizer from ax-next docs/plans/ + .claude/memory/
├── configs/
│   ├── a-bm25.ts               # reuses memory:index:search hook
│   ├── b-rerank.ts             # A + zerank-2 over top-K
│   └── c-rrf.ts                # A + zembed-1 dense search + RRF fusion
├── agent.ts                    # Sonnet 4.6 agent with injected retrieved memory
├── judge.ts                    # Grok 4.3 via OpenRouter (q, gold, answer) → {correct, reason}
├── meter.ts                    # token + $ accounting, $50 hard cap
├── cache.ts                    # ~/.cache/ax-memory-bench/ helper
├── report.ts                   # writes docs/plans/<date>-memory-strata-vector-spike-report.md
├── internal-corpus.json        # committed synthetic corpus (regen via --regen-internal)
└── __tests__/
    ├── corpora.test.ts         # round-trip transforms
    ├── configs.test.ts         # RRF math, fusion, top-K selection
    ├── meter.test.ts           # cost projection + cap
    ├── cache.test.ts           # cache hit/miss/corruption
    └── smoke.test.ts           # all configs × 10-Q sample × stubbed LLMs
```

Each config is a function:

```ts
type ConfigDriver = (
  corpus: BenchCorpus,
  question: BenchQuestion,
  opts: { topK: number; signal: AbortSignal },
) => Promise<{
  retrievedDocs: Array<{ path: string; score: number; summary: string }>;
  latencyMs: number;
  tokensUsed: { embedding?: number; rerank?: number };
}>;
```

The bench loop is straightforward:

```ts
for (const corpus of selectedCorpora) {
  for (const config of selectedConfigs) {
    buildIndexes(corpus, config);
    for (const question of corpus.questions) {
      meter.checkCap(/* projected worst-case for remaining work */);
      const retrieval = await config.driver(corpus, question, { topK: 10, signal });
      const answer = await agent.answer(question.text, retrieval.retrievedDocs);
      const verdict = await judge.grade(question.text, question.goldAnswer, answer);
      results.record({ corpus, config, question, retrieval, answer, verdict });
    }
  }
}
report.write(results);
```

## Data flow

1. **Argument parsing.** `--corpus longmemeval-s|locomo|internal|all`, `--config a|b|c|all`, `--sample N` (default: full), `--smoke` (stubbed LLMs, 10 Qs each, <2 min), `--regen-internal`, `--bench-live` (alias for `BENCH_LIVE=1`).
2. **Env check.** Verify `ANTHROPIC_API_KEY`, `ZEROENTROPY_API_KEY`, `OPENROUTER_API_KEY`. Missing keys → clear per-key error, exit non-zero. No silent skip.
3. **Corpus load.** Each loader checks `~/.cache/ax-memory-bench/<dataset>/`. Cache miss → fetch from HuggingFace → decode → transform to `{ memoryTree: Map<path, MarkdownDoc>, questions: QASet[] }`. Internal corpus is read from `internal-corpus.json` unless `--regen-internal`.
4. **Index build.** Configs A/B share a per-corpus FTS5 index built from the corpus's memory tree (using the production `memory:index:search` building block, instantiated against an in-memory SQLite). Config C builds the same FTS5 index plus a sqlite-vec dense column; documents are embedded at build time via `zembed-1`, cached by content hash to avoid re-embedding across runs.
5. **Per-question evaluation.** Retrieval → injection → agent answer → judge verdict. Metrics recorded per question: correctness (correct/incorrect/uncertain), recall@5/10 vs gold-cited docs (where the dataset provides them), retrieval latency, total tokens, total $.
6. **Aggregation.** Per (corpus, config): accuracy %, recall@k, p50/p95 latency, total $, tokens-per-correct-answer (TPCA).
7. **Report write.** Markdown report at `docs/plans/<run-date>-memory-strata-vector-spike-report.md`. Includes the explicit binding decision: "Level 3 [IN / OUT / OPT-IN]" applying the ≥3-point LongMemEval-S threshold from the roadmap.
8. **Design-doc + roadmap updates** (Phase 3B only). The PR also updates `memory-strata-design.md`'s Progressive Enhancement Path and the roadmap's Phase 4 trigger language to reflect the decision.

## Error handling

| Failure | Behavior |
|---|---|
| Missing API key (any of the three) | Per-key error message naming the env var; non-zero exit. |
| HuggingFace fetch failure (no cache) | Print dataset URL + expected cache path; non-zero exit. No retry. |
| ZeroEntropy / Anthropic / OpenRouter 429 or 5xx | Exponential backoff (1s/2s/4s), max 3 retries per call. Beyond that, abort the whole run with partial-report write. |
| Judge says "uncertain" | Separate bucket in results; not counted as wrong. Report shows uncertain% per config. |
| Cost cap projection exceeds $50 | Hard abort, partial-report write flagged "Aborted: cost cap exceeded", non-zero exit. |
| Internal corpus regen fails (invalid JSON, schema violation) | Fall back to the committed `internal-corpus.json`; log warning. Regen is best-effort. |
| Cache corruption (truncated JSONL, etc.) | Delete the cache entry, re-fetch. If re-fetch also fails, exit non-zero. |
| sqlite-vec extension missing | Clear error pointing to install instructions; non-zero exit. |
| `BENCH_LIVE=1` smoke exceeds $0.50 | Hard abort, non-zero exit. Smoke is a sanity check; if it costs more than 50¢, SDKs are misconfigured. |

## Testing strategy

### Phase 3A (scaffolding PR)

1. **Smoke test** (`bench --smoke`): 10 questions × 3 corpora × 3 configs run in under 2 minutes against stubbed LLMs/embeddings/rerankers. Stubs return canned vectors + scores; the test asserts plumbing works end-to-end (no real network calls). This is the primary acceptance test.
2. **Unit tests under `__tests__/`**:
   - Corpus loaders: round-trip transform from raw HF JSON → Strata tree → expected paths + frontmatter shape.
   - Config drivers: RRF math (known input ranks → known fused output), top-K selection, score-tie behavior.
   - Cost meter: token counts + dollar projection, cap-hit detection.
   - Cache utility: cache hit, cache miss (fetches), corruption recovery (deletes + refetches).
   - Internal-corpus synthesizer: with stubbed LLM, verify generated Q&A respects the schema and writes deterministically.
3. **Real-API live smoke** (`BENCH_LIVE=1 pnpm --filter @ax/memory-strata bench --live-smoke`): single question, single config (`c-rrf`, exercises all three providers), single corpus (internal, no HF fetch needed). Hard-fails above $0.50. Gated behind `BENCH_LIVE=1` so it never runs in CI.
4. **CLAUDE.md invariants honored**:
   - Invariant #2 (no cross-plugin imports): bench only imports from `@ax/memory-strata` itself (production BM25 helpers) and test-time devDependencies.
   - Invariant #3 (no half-wired plugins): not applicable to a dev-only on-demand tool; PR notes call this out explicitly.
   - Invariant #5 (capabilities minimized): all bench dependencies are in `devDependencies`; runtime surface unchanged.

### Phase 3B (binding run PR)

1. Full `pnpm --filter @ax/memory-strata bench --corpus all --config all` completes under the $50 cap.
2. `docs/plans/<run-date>-memory-strata-vector-spike-report.md` exists and contains:
   - Per-corpus tables: accuracy %, recall@5, recall@10, p50/p95 latency, total $, tokens-per-correct-answer.
   - Cross-corpus summary with the ≥3-point LongMemEval-S threshold explicitly applied.
   - Binding decision section: "Level 3 [IN / OUT / OPT-IN]" with reasoning.
   - Caveats section: internal-corpus-synthetic flag, judge-family note, dataset license note.
3. `docs/plans/memory-strata-design.md` Progressive Enhancement Path updated to match the decision.
4. `docs/plans/2026-05-10-memory-strata-roadmap.md` Phase 4 trigger language updated (e.g., if Level 3 is "out," remove vector-related risk lines).
5. If Level 3 is "IN," a follow-up GitHub issue is filed for the production vector-indexer wire-in. That work is NOT in Phase 3B.

## Risks tracked here

- **`zeroentropy@0.1.0-alpha.10` is alpha.** API may change before stable release. Pin exact version. Document the working version in the report; if the SDK has broken between report write and a future re-run, the report's pinned version is the audit anchor.
- **HuggingFace dataset licenses are research-only.** LongMemEval and LoCoMo are bench-only; we don't redistribute. License is noted in the report.
- **Internal corpus is synthetic.** Spot-check threshold is 20% with 80% true-gold accuracy; if it fails, supplement with up to 30 hand-authored questions.
- **Cost-meter drift.** Token counting differs per provider. The meter uses each SDK's reported `usage` field when available; fallback is a tokenizer estimate (claude-tokenizer for Anthropic and OpenRouter agent calls, model-card-stated rates for ZeroEntropy embeddings/rerankers).
- **Judge bias residual.** Grok 4.3 is cross-family relative to Sonnet 4.6 agent under test, but it is itself a large model with its own biases. The report notes this and suggests a cross-judge sweep (e.g., re-running the judge layer with GPT-5) as a Phase 5+ follow-up if the binding decision is close (≤5-point margin).
- **Trigger-gap residual.** Internal corpus is synthesized, not dogfooded. If Phase 4 retrieval-quality concerns surface that the spike missed, the harness can be re-run against real production memory data; only the corpus loader changes.

## What this design explicitly does NOT cover

- The actual implementation of Config C's vector index in production indexer packages. That's a follow-up phase, gated on the Phase 3B decision.
- Multi-tenant scoping in retrieval (roadmap Phase 5+).
- A reranker for the production retrieval path (roadmap Phase 4, Level 6).
- KV-cache assembly (roadmap Phase 4).
- Cross-judge sweep beyond Grok 4.3 (potential Phase 5+ follow-up if binding decision is close).

The phase plan derived from this design will enumerate concrete tasks, file paths, and invariants for Phase 3A and Phase 3B.
