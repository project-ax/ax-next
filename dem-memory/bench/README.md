# LongMemEval-S bench adapter

Drives dem-memory through the LongMemEval-S protocol, methodology-compatible
with `@ax/memory-strata`'s e2e bench (same corpus file, same judge prompt).

## Run

```bash
# OPENROUTER_API_KEY must be in the environment.
npx tsx bench/run.ts --n 30                      # stratified smoke
npx tsx bench/run.ts --n 30 --types temporal-reasoning,knowledge-update
npx tsx bench/run.ts --n 500                     # full run
```

- Corpus: reuses `~/.cache/ax-memory-bench/longmemeval-s/longmemeval_s_cleaned.json`
  (the strata bench's HF cache; override with `DEM_BENCH_CORPUS_PATH`).
- Model: `--model` (default `z-ai/glm-5.3-flash:nitro`), reasoning effort
  `--effort` (default `minimal`) via OpenRouter's unified `reasoning` param.
- Judge: `--judge-model` (default `x-ai/grok-4.3` — same judge as the strata
  bench, so scores are comparable).
- Extraction cache: `bench/cache/extraction.json`, keyed by session id + content
  hash. Sessions repeat across questions; the cache is the dominant cost lever.
  Results append to `bench/results/run-<date>.jsonl` and resume on rerun
  (error rows are retried).
- The smoke path uses the deterministic hash embedder + lexical reranker so no
  GCP/Cohere credentials are needed; production runs should inject the real
  stack (Vertex `text-embedding-005` + Cohere `rerank-v4.0-pro`) — those scores are
  not comparable until it does.

## Offline analyses (no LLM calls)

These read the caches and answer a question without scoring anything. Each one's own
header comment carries its measured numbers.

```bash
npx tsx bench/consolidation-survival.ts --fingerprint f4752a79   # would Strata's drop rules keep these facts?
npx tsx bench/supersession-replay.ts    --fingerprint f4752a79   # what does invalidation actually close?
npx tsx bench/supersession-replay.ts    --fingerprint f4752a79 --rule slot --order session
npx tsx bench/normalizer-eval.ts        --fingerprint f4752a79   # can a relation be mapped to a profile slot?
npx tsx bench/graph-ablation.ts --n 100 --fingerprint f4752a79 --stack vertex   # does the graph channel do anything?
```

`normalizer-eval` and `graph-ablation` are not quite free — the first embeds ~84.5k relation
phrases (~$0.10, ~12 min cold, resumable), the second pays one reranker call per question per
arm unless you use `--stack vertex`, which is free and deterministic.

**Use `--stack vertex` for anything that compares two evidence tables.** `rerank-v4.0-pro` is
not reproducible: three calls with a byte-identical query and document list gave run 1 ≡ run 2
and run 3 differing by `maxAbsDelta` 4.26e-3 with a different ordering, and across an n=100
ablation ~22% of top-15 tables reordered between two identical calls. A table diff on the
production stack measures the reranker, not your change.

## What the driver does per sample

1. Fresh in-memory bank (`bankId` = question id).
2. One `retain()` per haystack session, turns stamped with the session date, so
   `validStart` derives from dialogue time.
3. `reflect(question)` — evidence table ≤ 2,000 tokens, single pass, or
   `[DATA_ABSENT]`.
4. Grok judge with `Unanswerable: <question_id ends with _abs>`.
