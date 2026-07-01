# TASK-191 — Promote the Retrieval Orchestrator (config E) into the Strata runtime

**Branch:** `auto-ship/TASK-191-orchestrator-runtime` · **Epic:** strata-finish · Base `main`.

## Problem

The retrieval orchestrator (cheap-LLM stage: reads `system/map.md` + query → emits `load`/`fts` ops)
is bench-only (`test/bench/orchestrator.ts`). The corrected n=500 spike
(`docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md`) found **config E
(orchestrator + BM25 fallback) + LLM-densified map beats BM25-only by +7.6pp accuracy /
+14.2pp recall@5**, clearing the ≥5-point bar, with better abstention — and latency is
acceptable via **direct xAI (~400ms p50)**, not OpenRouter's ~11s routing artifact. TASK-190
already ships the LLM-densified map. This card wires the orchestrator into the runtime.

## Approach (chosen — see decisions.md 2026-07-01)

- **Seam = the `memory_search` tool executor** (query-time, tool-driven). It already carries a
  real query at turn time (chat-start inject has none). Orchestrator-enabled: read `system/map.md`
  via the existing inject/tier read path → run orchestrator LLM(map, query) → execute load/fts ops
  → return rows; fall back to plain BM25 (`retrieve`) on miss / timeout / no-client / `retrievalMode:'bm25'`.
  **Zero new hook surface** (TASK-190 guidance: read the map via the inject path, no `memory:map:*` hook).
- **Client = injected `OrchestratorClient`**, default **direct-xAI**, OpenRouter fallback,
  implemented with global **`fetch`** (no `openai`/SDK runtime dep). Host-side egress, gated by the
  host holding `XAI_API_KEY`. Presets build it from env and pass it in; absent ⇒ BM25.
- **Op grammar strictly parsed + whitelisted** (`<load>`/`<fts>` only); load docId validated by the
  memory_read_section traversal guard AND must exist in the agent's own map before it surfaces.
- **Config:** `MemoryStrataConfig.retrievalMode?: 'orchestrator'|'bm25'` (default `'orchestrator'`)
  + `orchestrator?: { client; model?; timeoutMs?; topK? }`.

## Tasks (independent, testable; TDD test-first each)

### Task 1 — `src/orchestrator.ts` (pure logic; standard model)
Port from bench, adapted to the runtime map. Exports:
- `OrchestratorClient` = `{ complete({system,user}): Promise<{text; usage:{in;out}}>}`.
- `OrchestratorOp` = `{kind:'load'; docId; section?}` | `{kind:'fts'; query}`; `parseOrchestratorPlan(text)` (strict regex, whitelist).
- `parseMapEntries(mapBody)` → `Array<{docId; category; slug; summary}>` from the `## <cat>/` + `- <slug>: <summary>` map format; and `renderMapForOrchestrator(entries)` → flat `- <cat>/<slug>: <summary>` listing.
- `runOrchestratedRetrieve({ client, mapBody, query, topK, model, timeoutMs, ftsSearch, logger })`
  → `Promise<RetrievalResult[] | null>`: builds map table + prompt, `raceTimeout`s `client.complete`,
  parses ops, resolves `load` (map-table lookup + `parseDocId` guard → row score 1) + `fts` (`ftsSearch`),
  dedup by docId (load wins), cap topK. Returns `null` on: empty map, client throw/timeout, or zero resolved rows (⇒ caller falls back to BM25).
- Reuse `parseDocId` traversal guard (extract to a shared spot or re-declare; export from a small module both tools use). **DO NOT** write forbidden ship-list tokens (FTS5/vector/dense/rerank/embeddings/hnswlib).
**Tests:** `src/__tests__/orchestrator.test.ts` — parse (load/fts/mixed/fenced/entity-decode/bad-op-ignored), map-entry parse, load-op resolution + traversal-guard rejection + hallucinated-docId drop, fts merge+dedup, topK cap, null on empty-map / client-throw / timeout / zero-rows.

### Task 2 — `src/orchestrator-client.ts` (fetch clients; standard model)
- `makeXaiOrchestratorClient(apiKey, model='grok-4-fast-non-reasoning')` → POST `https://api.x.ai/v1/chat/completions`, Bearer, `{model, max_tokens:512, messages:[{role:'system'},{role:'user'}]}`, parse `choices[0].message.content` + `usage.{prompt_tokens,completion_tokens}`. Bounded retry on 429/5xx/network.
- `makeOpenRouterOrchestratorClient(apiKey, model='x-ai/grok-4-fast', forceProvider?)` → POST `https://openrouter.ai/api/v1/chat/completions`, optional `provider:{order,allow_fallbacks:false}`.
- Both satisfy `OrchestratorClient`. Injectable `fetch` seam (default global fetch) for tests.
**Tests:** `src/__tests__/orchestrator-client.test.ts` — stubbed fetch: xAI posts to api.x.ai with Bearer + correct body, parses text/usage; OpenRouter posts to openrouter.ai + provider routing when forced; retry on one 503 then success; throws after exhausting retries.

### Task 3 — wire into `memory_search` + config (integration; capable model)
- `MemoryStrataConfig`: add `retrievalMode?` + `orchestrator?: { client: OrchestratorClient; model?; timeoutMs?; topK? }`.
- `plugin.ts init`: thread orchestrator opts into `registerMemorySearch(bus, opts)`.
- `registerMemorySearch(bus, opts?)`: in the executor, when `opts?.orchestrator?.client` present AND `retrievalMode!=='bm25'` AND `query.length>0` AND `categoryFilter===undefined`: read map body (tier-aware — reuse/export an inject map-reader), call `runOrchestratedRetrieve`; if it returns non-null rows, return them; else fall through to BM25 `retrieve`. Preserve exact BM25 behavior otherwise.
- Export a tier-aware `readInjectedMapBody(bus, ctx, workspaceRoot)` from inject.ts (reuses `readSystemBody`/`readTierSystemBody('map')`).
- `index.ts`: export `makeXaiOrchestratorClient`, `makeOpenRouterOrchestratorClient`, type `OrchestratorClient`.
**Tests:** `src/__tests__/tools-memory-search.test.ts` (extend) — orchestrator client present → load op returns the mapped doc row (assert client called w/ map+query); client returns null → BM25 fallback; `retrievalMode:'bm25'` → orchestrator never called; categoryFilter set → orchestrator skipped (BM25). Plus a `plugin.test.ts` assertion that manifest.calls is UNCHANGED (no new hook).

### Task 4 — preset wiring (mechanical; cheap model)
- CLI (`packages/cli/src/main.ts:354`): `const xaiKey = process.env.XAI_API_KEY; createMemoryStrataPlugin(xaiKey ? { orchestrator: { client: makeXaiOrchestratorClient(xaiKey) } } : {})`.
- k8s (`presets/k8s/src/index.ts:1144`): same env-guarded build. Import from `@ax/memory-strata`.
- Confirm preset tests still green (manifest.calls unchanged ⇒ no preset.test change expected).

### Task 5 — e2e harness orchestrator support + report note (integration; standard model)
- `e2e-driver.ts` `RunE2EQuestionDeps`: add optional `orchestratorClient?: OrchestratorClient`; thread into `createMemoryStrataPlugin({ ..., ...(orchestratorClient ? { orchestrator: { client: orchestratorClient } } : {}) })`.
- `e2e-cli.ts`: build `makeXaiOrchestratorClient(process.env.XAI_API_KEY)` when present, pass through; the report NAMES the retrieval mode (orchestrator direct-xAI vs BM25) + notes direct-xAI p50 (not OpenRouter routing).
- `e2e-driver.test.ts`: add a test that with a stub orchestrator client emitting a `<load>` op the agent gets the right doc (orchestrator path reachable from the e2e acceptance); the existing no-client test already proves BM25 degradation.

## Boundary review
No new/changed hook surface (orchestrator is internal to memory_search; map read via existing inject path; fts via existing `memory:index:search`). Manifest `calls` unchanged. → No boundary-review entry required; noted in PR.

## Security-checklist (required — untrusted content → LLM → ops)
- **Prompt injection:** map summaries (derived from prior possibly-untrusted convos) + query feed the orchestrator LLM. Mitigation: strict regex parse, whitelist `<load>`/`<fts>` only; load docId run through the traversal guard (closed category set, slug `^[a-z0-9-]+$`, no `..`) AND must exist in the agent's own map; a crafted injection can at most load one of the agent's OWN docs (owner-routed reads) — never traverse out / cross tenant. fts query rides the parameterized BM25 indexer.
- **Sandbox escape:** N/A — host-side, no sandbox boundary touched; runner never sees the key/client.
- **Supply chain:** NO new npm dep (fetch client). Egress to pinned hosts api.x.ai / openrouter.ai, Bearer from host env.

## Gate
`pnpm build` + `pnpm --filter @ax/memory-strata test` + (cli/k8s preset tests) + `eslint`. tsc clean.
Whole-branch `ax-code-reviewer` before PR.
