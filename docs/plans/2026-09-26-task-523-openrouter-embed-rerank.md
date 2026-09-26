# TASK-523 — memory embeddings + reranking through OpenRouter

Card: route memory embed (Gemini) and rerank (Voyage) through OpenRouter so the
memory preset runs on ONE long-lived credential, `provider:openrouter`, which
already has a validate-and-save path on the Provider keys screen.

Owner decisions (card, 2026-09-25/26): embed `google/gemini-embedding-001:nitro`
at `dimensions: 384`; rerank `voyageai/rerank-2.5:nitro`; no benchmark re-run.
Reverses TASK-496's "Vertex `text-embedding-005` + Cohere `rerank-v4.0-pro`".

## Decisions made here (see `.claude/memory/decisions/2026-09-26-TASK-523.md`)

1. **Replace, don't add.** The Vertex and Cohere drivers are deleted. Nothing but
   the memory preset configured them; keeping them would be code no deployment
   reaches (half-wired policy) and an extra egress host in `endpoints.ts`.
2. **Model grammar per endpoint.** OpenRouter model ids carry `/` and `:`
   (`google/gemini-embedding-001:nitro`), which the old URL-path grammar
   forbids. The model now travels in the JSON body, not the URL, but it is still
   grammar-checked (`vendor/model[:variant]`, lowercase, bounded) — config and
   payload alike.
3. **No task type on the wire.** OpenRouter documents an `input_type` field
   ("e.g. search_query, search_document") but not whether its Google route maps
   it to Gemini's task type, and this session has no key to probe it. Sending an
   unmapped field risks a 400 that would take the whole dense channel dark. So
   the body is exactly `{model, input, dimensions, encoding_format}` for both
   tasks; a test pins that. `EmbeddingTask` stays on the hook (vendor-neutral,
   other producers use it). Follow-up: probe with a key; enable if vectors differ.
4. **Embedding fingerprint is store-level, owned by the fact store.** The store
   already sends `model` in the `embeddings:embed` payload (the producer honours
   a payload model), so the model the store asks for IS the model that produced
   the vectors. The store records it in a one-row meta table; on open, if the
   configured model differs (or is unknown while vectors exist), every vector is
   deleted in one transaction and the new model recorded — so no two vector
   spaces ever coexist in `vec0`. The preset always pins the model on the ref.
   No hook-surface change.
5. **Re-embed trigger.** Nothing in production calls `memory:facts:reindex`, so
   vectors deleted on a model change (or never written because the key was
   missing at record time) would never come back. After a `memory:facts:record`
   whose embed succeeded, if that agent has rows without vectors, the store runs
   the existing bounded vector backfill detached and single-flight per agent.
6. **Degradation unchanged.** Missing `provider:openrouter` ⇒ both producers
   answer `undefined` ⇒ recall reports `["semantic","ranking"]`; never a local
   hash fallback.

## Tasks

1. `@ax/embeddings` — OpenRouter embed + rerank drivers, endpoint table,
   grammar, config (`provider: 'openrouter'`, no `projectId`), tests, README.
2. `@ax/memory-facts-sqlite` — embed-model meta table + wipe-on-change at open;
   detached single-flight vector backfill after a successful record; tests.
3. `@ax/preset-memory` + CLI help + chart + kind docs — one credential
   (`provider:openrouter`), no Vertex project, env vars and chart values removed,
   `validatePreset` no longer requires `vertexProject`; tests.
4. `scripts/memory-product-e2e.mjs` — the rung-4 harness drives the preset, so
   it moves to OpenRouter metering (no Vertex token minting, no Cohere key).
5. Memory shards (decision reversing TASK-496), stale doc lines fixed.

YAGNI check: all five are load-bearing — 3 is the acceptance, 1 is what 3 wires,
2 is acceptance item "model change triggers re-embedding", 4 would break
otherwise (it imports the preset), 5 is contract rule 5.

Security: new egress host for this plugin (`openrouter.ai`, already a host-side
egress host for the observer) and a credential ref change; security-checklist
runs before review.
