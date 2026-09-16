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

## What the driver does per sample

1. Fresh in-memory bank (`bankId` = question id).
2. One `retain()` per haystack session, turns stamped with the session date, so
   `validStart` derives from dialogue time.
3. `reflect(question)` — evidence table ≤ 2,000 tokens, single pass, or
   `[DATA_ABSENT]`.
4. Grok judge with `Unanswerable: <question_id ends with _abs>`.
