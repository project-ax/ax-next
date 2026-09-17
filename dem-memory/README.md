# dem-memory

Decoupled Epistemic Memory — a long-horizon agent memory substrate.

No multi-turn reflection loops. No prompt rehydration. Memories are stored as
bi-temporal relational quadruples, retrieved through four deterministic
channels, fused with Reciprocal Rank Fusion, reranked by a Cohere cross-encoder,
and synthesized in a single LLM pass over an evidence table capped at 2,000 tokens.

## The four epistemic networks

| Network | Tag | What lives there |
| :---- | :---- | :---- |
| `world` | `[FACT]` | Objective, verifiable assertions about external entities and domain rules |
| `experience` | `[FACT]` | First-person records of interactions, actions, and recommendations |
| `observation` | `[OBS]` | Synthesized behavioral profiles (produced offline; not extracted from dialogue) |
| `opinion` | `[OPIN]` | Subjective beliefs and inferred preferences, with explicit confidence scores |

## Install

```bash
npm install
npm run build
npm test
npm run verify   # SQLite vec0 + FTS5 smoke check
```

Requires Node 22+.

## Quick start

```ts
import { createDemMemory } from "./src/index.js";

const memory = createDemMemory({ path: "./memory.db", bankId: "personal" });

// Retention: extract facts from dialogue, persist + index, update the entity graph.
await memory.retain([
  { role: "user", content: "I've switched my backend to Python FastAPI.", at: "2025-01-15T10:00:00Z" },
]);

// Recall: four channels -> RRF -> neural rerank.
const result = await memory.recall("what backend does Sam prefer?");
console.log(result.tuples);

// Reflect: evidence table -> single grounded completion, or [DATA_ABSENT].
const reflected = await memory.reflect("what backend does Sam prefer?");
console.log(reflected.answer);
```

## CLI

```bash
npm run cli -- --db ./memory.db --embed hash --reranker lexical
# /retain "Sam prefers Python FastAPI"
# /recall "what backend does sam prefer"
# /ask "what backend does sam prefer"
```

Non-interactive: `npm run cli -- recall "sam backend"`.

## Configuration

### Embeddings — Vertex AI (default)

Dense vectors (384 dims, matching the `vec0` table) come from the Vertex AI
prediction endpoint using `text-embedding-005` with `outputDimensionality: 384`
and task-aware retrieval types (`RETRIEVAL_DOCUMENT` on write,
`RETRIEVAL_QUERY` on read).

- `GOOGLE_APPLICATION_CREDENTIALS` — service-account JSON path (Application
  Default Credentials; gcloud ADC works too)
- `GOOGLE_CLOUD_PROJECT` (or `GCP_PROJECT_ID`) — project id, unless ADC implies it
- `DEM_VERTEX_REGION` — default `us-central1`
- `DEM_VERTEX_EMBED_MODEL` — default `text-embedding-005`
- `DEM_VERTEX_ACCESS_TOKEN` — pre-obtained bearer token (skips ADC)
- `DEM_EMBED_PROVIDER` — `vertex` (default) or `hash`
- Option equivalent: `embedProvider: "vertex" | "hash"`, or inject your own
  `embed(texts, task)` function.

### Reranking — Cohere Rerank 4.0 (default)

The top 40 RRF candidates are scored by the Cohere rerank API
(`POST /v2/rerank`, model `rerank-v4.0-pro`); the top 15 survive into context assembly.

- `COHERE_API_KEY` — required for the default reranker
- `DEM_COHERE_RERANK_MODEL` — default `rerank-v4.0-pro` (variants: `rerank-v4.0-fast`, `rerank-v4.0-pro`)
- `DEM_COHERE_BASE_URL` — for proxies (default `https://api.cohere.com`)
- `DEM_RERANKER` — `cohere` (default), `lexical`, or `none`
- Option equivalent: `rerank: "cohere" | "lexical" | "none" | customFunction`.

### Extraction & synthesis — OpenAI (default)

Fact extraction (`generateObject` + zod) and single-pass synthesis
(`generateText`) run through the Vercel AI SDK:

- `OPENAI_API_KEY`
- `DEM_EXTRACT_MODEL` — default `gpt-4o-mini`
- `DEM_GENERATE_MODEL` — default `gpt-4o-mini`
- Option equivalent: `extract`, `generate` (inject anything that speaks the
  interface, e.g. a DeepSeek-V3 endpoint).

### Other flags

- `DEM_DB_PATH` / `path` — SQLite file (default `./dem-memory.db`; `:memory:` supported)
- `DEM_BANK_ID` / `bankId` — memory bank (default `default`)

## Architecture

**Retention (`retain`).** Dialogue goes through one structured-extraction call
producing `⟨subject, predicate, object, validStart, confidence, invalidatesPrevious⟩`
quadruples. Facts flagged `invalidatesPrevious` close the currently-active
records sharing `(bank, subject, predicate)` by setting their `valid_end` to the
new fact's `validStart` — history is preserved, current reality is updated.
Each tuple is then inserted atomically across the relational, FTS5, and vec0
stores, and the batch's subjects update the in-memory Hebbian co-occurrence graph.

Note on the design's invalidation condition: only still-active records
(`valid_end` at the infinity sentinel) are closed. Re-matching already-superseded
records would rewrite closed intervals and corrupt point-in-time history.

**Recall (`recall`).** Four channels run per query — no generative calls:

1. **Sparse** — FTS5 `MATCH` with BM25 ordering
2. **Dense** — Vertex embedding, vec0 KNN cosine search
3. **Graph** — query entities matched against the co-occurrence graph, two-hop
   traversal with edge-weight decay, memories fetched per subject
4. **Temporal** — `valid_start ≤ t_anchor < valid_end` when anchored; otherwise
   the currently-active set

Results fuse via `RRF(d) = Σ 1/(60 + rank)`; the top 40 go to the Cohere
cross-encoder; the top 15 are returned.

**Reflect (`reflect`).** Recalled tuples compile into a markdown evidence table
(Network | When | Confidence | Statement), trimmed to the token ceiling
(default 2,000, estimated at ~4 chars/token). Rows are trimmed by rank and then
rendered oldest-first, so elapsed time reads straight down the column without
costing us the top-ranked row. The table plus disposition ratings
(Skepticism/Literalism/Empathy, 1–5) and the abstention directive are sent to
the model in one pass. If the evidence table is empty, `reflect` returns
`[DATA_ABSENT]` without calling any model.

### `asOf` vs `temporalAnchor`

Two different questions, two different options — conflating them costs answers
in both directions.

| Option | Means | Effect |
| :---- | :---- | :---- |
| `temporalAnchor` | "what did the bank hold **as of** then?" | **Filters** recall to records whose validity interval covers the anchor |
| `asOf` | "what time is it **now**, for the asker?" | **Presentation only** — renders each row's elapsed time and tells the model today's date |

A question like *"how many weeks ago did I start using Ibotta?"* needs `asOf`:
the model cannot subtract two ISO strings reliably, and without a reference date
it will correctly report that it cannot know. Passing that same date as
`temporalAnchor` instead also silently evicts every record dated after it —
including the ~16% of extracted facts that describe planned future events.

```ts
// "It is 2023-05-06. How long ago was that?"  -> grounds the prompt, filters nothing
await memory.reflect("how many weeks ago did I start using Ibotta?", {
  asOf: "2023-05-06T09:18:00Z",
});

// "Show me the bank as it stood on 2023-05-06." -> time travel, filters the candidate set
await memory.recall("cashback apps", { temporalAnchor: "2023-05-06T09:18:00Z" });
```

`reflect` falls back to `temporalAnchor` as the reference time when only that is
given: if you time-travel to an instant, that instant is the present. The `ask`
and `recall` CLI commands default `asOf` to the wall clock; the library never
reads the clock on your behalf.

## Tests

```bash
npm test
```

The suite is hermetic: tests inject a deterministic hash embedder and either
stub or lexical rerankers, so no network, no GCP project, no API keys. The
fixture (`tests/fixtures/test-dialogue.json`) carries multi-session transcripts
with the facts a faithful extraction should produce.

Covers the design's checklist: knowledge updates with bi-temporal invalidation,
temporal-anchor retrieval, abstention behavior, and the 2,000-token evidence
ceiling — plus four-channel recall, RRF math, bank isolation, and graph reach.

## Known limitations

- The co-occurrence graph is in-memory; it is rebuilt from stored batches
  (grouped by `transaction_time`) when a bank opens.
- The token ceiling uses a characters/4 estimator, not a model tokenizer.
- The dense channel KNN fetches a widened candidate pool and filters by bank
  afterwards; banks with many memories pay for it in post-filtering, not correctness.
