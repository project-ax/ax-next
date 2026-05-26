# `@ax/memory-strata` Phase 2B implementation plan (Retriever + agent tools)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **second** half of Phase 2 — a **BM25 keyword index** over the agent's `memory/` tree, plus three agent-facing tools (`memory_search`, `memory_read_section`, `memory_note`) and **summary-first auto-injection** at chat:start. The index has two backend implementations selected at preset wire-up time: SQLite FTS5 (CLI preset) and Postgres `tsvector` + GIN (k8s preset). No vectors, no RRF, no LLM rerank — those wait for Phase 3's eval spike.

**Architecture:** Adds new hook surface `memory:index:upsert | search | delete | clear`, transport- and storage-agnostic per CLAUDE.md invariant 1. Two new companion plugins register the hooks against their respective backends — `@ax/memory-strata-index-sqlite` and `@ax/memory-strata-index-postgres`. The existing `@ax/memory-strata` plugin gains: a re-indexer that calls `memory:index:upsert` whenever a doc is written by Phase 2A's Consolidator, the three agent tools (registered via `tool:register`), and a `chat:start` subscriber that builds an auto-injected memory block.

**Tech Stack:** TypeScript, pnpm monorepo, Node 22+, Kysely + better-sqlite3 (SQLite FTS5 via `CREATE VIRTUAL TABLE … USING fts5`), Kysely + pg (Postgres `tsvector` + `to_tsquery` + GIN index). Schema lives in each companion plugin (`memory_strata_index_v1_*` table prefix). Spec: `docs/plans/memory-strata-design.md` § "2. Retriever" + § "Agent Tool Interface" + § "Context Assembly: How Strata Keeps Context Small".

---

## Source of truth

- **Design spec:** `docs/plans/memory-strata-design.md` — § "2. Retriever" (~744–809) for the retrieval mechanics; § "Indexing Strategy: Metadata and Headers, Not Full Text" (~684–692) for what to index; § "Agent Tool Interface" (~1025–1061) for the tool surfaces; § "Context Assembly" (~955–1022) for the auto-injection layout. Phase 2B implements the BM25-only branch of this — no dense embeddings, no RRF (single result list, no fusion needed).
- **Phase 2A plan:** `docs/plans/2026-05-10-memory-strata-phase-2a-consolidator-impl.md` — defines the `docs/<category>/<slug>.md` substrate the index reads from. The Consolidator's `writeNewDoc` and `appendFact` both end with the on-disk write; Phase 2B hooks them via a NEW `memory:doc:written` event so the indexer reacts without `@ax/memory-strata` knowing whether an indexer is even loaded.
- **Storage backends:** `packages/storage-sqlite/src/plugin.ts` and `packages/storage-postgres/src/plugin.ts` — the pattern Phase 2B mirrors. The postgres companion reuses the shared Kysely instance via `database:get-instance`; the sqlite companion opens its own file (mirrors storage-sqlite).
- **Tool registration:** `packages/mcp-client/src/tool-dispatcher-plugin.ts` — `tool:register` is the single source of truth for the agent's tool catalog. Memory tools register `executesIn: 'host'` so each tool call round-trips through the host-side `tool:execute:<name>` service.
- **Project conventions:** `CLAUDE.md` — six invariants. Especially I1 (transport/storage-agnostic hooks): the `memory:index:*` payloads must use neutral terms like `docId`, `text`, `category`, never `tsvector`, `fts_table`, `kysely`, etc.
- **Memory:** `feedback_half_wired_window_pattern.md` (every new-plugin phase loads in CLI + k8s preset same PR — Phase 2B introduces TWO new plugins; SQLite goes in CLI preset, Postgres goes in k8s preset; the half-wired window is "any preset where Consolidator runs but no indexer plugin is loaded"), `feedback_yagni_check_in_plans.md` (see YAGNI section below — the design doc lists `memory_edit`, `memory_list`, `update_core_memory` and Phase 2B explicitly cuts them).

## Invariants (audit trail per project pattern)

Continues from Phase 2A's I16.

- **I17 — `memory:index:*` hooks are transport- and storage-agnostic.** No SQLite-specific (`fts5`, `match`, `bm25`), no Postgres-specific (`tsvector`, `to_tsquery`, `ts_rank`, `gin`), no Kysely shapes, no row primary-key types in the payload field names. Boundary review checklist applied per CLAUDE.md.
- **I18 — Indexer is the single source of truth for search.** Search results NEVER reach the agent without going through `memory:index:search`. The Consolidator does NOT keep a parallel in-memory cache. No plugin reads memory files directly to perform search — they all go through the hook. (Reading a single file by id for `memory_read_section` is fine; that's not a search.)
- **I19 — Two backends behave identically on the contract surface.** A shared contract test runs against both `@ax/memory-strata-index-sqlite` and `@ax/memory-strata-index-postgres`: same fixture, same query, same expected ranking. Differences (FTS5 vs tsvector tokenization edge cases) are documented inline; the test asserts top-3 equivalence on a curated fixture.
- **I20 — Agent tools never bypass the sensitive-gate.** `memory_note` (manual save) routes through Phase 1's `filterSensitive` gate before any inbox write — same path as the Observer. A regression test asserts that a `memory_note({content: "<fake credential>"})` call leaves no inbox file behind and returns a clear error to the agent.
- **I21 — Auto-injected summaries are token-bounded.** The chat-orchestrator's prompt-augment subscriber that builds the memory block enforces a hard token cap (default 1500 tokens for the auto-injected section). Over-budget docs are dropped lowest-rank-first. A test asserts a corpus of 100 docs yields a memory block under the cap.
- **I22 — Re-index is idempotent and non-destructive on failure.** Calling `memory:index:upsert` for the same `docId` twice is a no-op (UPSERT semantics). A failure mid-upsert leaves the index in its prior state (transactional). A test simulates an upsert failure and asserts the previous version of the doc is still searchable.
- **I23 — Phase 2B ship-list.** Drops the strings the Phase 2A ship-list test forbade for this layer (memory_search, memory_read_section, memory_note, tool:register, FTS5, RRF). Still forbidden in 2B: `vector`, `hnswlib`, `embeddings`, `dense`, `rerank` (Phase 3+).
- **I24 — Half-wired window CLOSED.** Phase 2B PR loads `@ax/memory-strata-index-sqlite` in the CLI preset AND `@ax/memory-strata-index-postgres` in the k8s preset, in the same PR. PR notes contain an explicit "half-wired window: CLOSED" line and call out the matrix: CLI = sqlite indexer, k8s = postgres indexer.

---

## Open decisions (resolve in Task 2B.0)

### Decision A: Auto-injection scope at chat:start

| Option | Pros | Cons |
|---|---|---|
| **A1: System-prompt augment hook** *(recommended)* | The chat-orchestrator is the natural seam — it already builds the system prompt envelope before invoking the runner. Add a new service hook `system-prompt:augment` that returns extra string content; memory-strata implements it and contributes the memory block. Reusable for future prompt-augmentation needs. | Adds a new hook surface (boundary review required). |
| A2: Memory-strata writes a synthetic `memory/system/_inject.md` and the agent's prompt template references it | No new hook; agent reads via existing fs tools. | Brittle: depends on every agent's persona referencing the file path; doesn't compose; can't be made conditional on retrieval results. |
| A3: Defer auto-injection to Phase 2C | Smaller 2B PR; keeps tools as the only retrieval path until we have a hook design we love. | Agent has to call `memory_search` every turn — no passive memory until 2C. Misses the design doc's "hybrid injection" point. |

**Recommendation: A1.** The hook is small and the benefit is concrete. Boundary-review form below.

### Decision B: Companion plugin loading wire-up

| Option | Pros | Cons |
|---|---|---|
| **B1: One companion plugin per backend, preset chooses** *(recommended)* | Mirrors `@ax/storage-sqlite` / `@ax/storage-postgres` exactly. CLI preset loads sqlite indexer; k8s preset loads postgres indexer. Zero runtime backend detection. | Two plugin packages to maintain. Both implement the same `memory:index:*` hooks against different SQL. |
| B2: One plugin with runtime dialect detection | One package; introspect the shared `database:get-instance`'s dialect, branch SQL internally. | Mixes two SQL flavors in one source tree; harder to test in isolation; preset's choice of DB becomes implicit. Doesn't match the storage-* precedent. |

**Recommendation: B1.** Match the storage precedent.

### Decision C: Tool catalog scope for `memory_*`

| Option | Pros | Cons |
|---|---|---|
| **C1: Always-on for every agent** *(recommended for MVP)* | Simplest. Every agent gets the memory tools by default; per-agent allow-list via `agentConfig.allowedTools` continues to work. | An agent that doesn't want memory tools must explicitly exclude them. |
| C2: Opt-in per agent | Tighter blast radius. | Today there's no UI to toggle tool sets per agent; adds friction without value at MVP. |

**Recommendation: C1.** The Phase 1 default agent already loads with no `allowedTools` filter (see `@ax/tool-dispatcher`'s wildcard semantics).

---

## YAGNI audit (per `feedback_yagni_check_in_plans.md`)

Cuts vs design doc § "Agent Tool Interface":

- **`memory_edit`** — letting the agent rewrite a doc section programmatically. Risky surface (the agent could rewrite its own persona); requires a permission story we don't have. Defer until a real workflow needs it; for now an agent who wants to update memory uses `memory_note` and waits for the Consolidator.
- **`memory_list`** — listing all topics in a category. Replaceable with a directory walk via the agent's existing filesystem tools; not load-bearing. Defer until an agent's missing it.
- **`update_core_memory`** — direct write to `system/agent.md` or `system/user.md`. Same risk surface as `memory_edit`. Defer.

Cuts vs design doc § "2. Retriever":

- **Vector search + RRF fusion** — Phase 3 spike decides this. 2B is BM25-only.
- **LLM reranker** — Phase 4 (or Phase 3 if the spike says BM25 alone is good enough).
- **`recency` / `importance` / `scope_match` ranking signals** — design lists `final_score = 0.35 lex + 0.35 dense + 0.15 rec + 0.10 imp + 0.05 scope`. With dense gone, we ship lex-only ranking in 2B. Recency/importance can be added as light multipliers later if eval shows they matter.
- **`mode: "headers"`** — drill-down via headers tree. `memory_read_section(doc_id, header)` already exposes per-section reads; the headers list isn't load-bearing.

Cuts vs design doc § "Promoter":

- **Auto-pin frequently accessed docs** — Phase 4 (Promoter is its own phase).
- **LRU warm cache** — Phase 4. The OS page cache is good enough for 2B.

---

## File structure

### New packages

```
packages/memory-strata-index-sqlite/
  package.json
  tsconfig.json
  src/
    index.ts        — re-exports createMemoryStrataIndexSqlitePlugin
    plugin.ts       — plugin factory, registers memory:index:* hooks
    schema.ts       — `memory_strata_index_v1_docs` FTS5 virtual table + meta table
    queries.ts      — typed wrappers around SELECT/INSERT/UPDATE/DELETE
    __tests__/
      plugin.test.ts            — round-trips upsert/search/delete
      contract.test.ts          — runs the shared contract from @ax/memory-strata-index-contract

packages/memory-strata-index-postgres/
  package.json
  tsconfig.json
  src/
    index.ts        — re-exports createMemoryStrataIndexPostgresPlugin
    plugin.ts       — plugin factory, calls database:get-instance, registers hooks
    migrations.ts   — adds `memory_strata_index_v1_docs` table + tsvector column + GIN index
    queries.ts      — typed wrappers around SELECT/INSERT/UPDATE/DELETE
    __tests__/
      plugin.test.ts
      contract.test.ts

packages/memory-strata-index-contract/
  package.json
  tsconfig.json
  src/
    index.ts        — exports `runIndexContract(label, factory)` helper
```

### Modified packages

```
packages/memory-strata/src/
  retriever.ts                   — new; thin client over memory:index:* hooks (called by tools + auto-inject)
  reindex.ts                     — new; subscribes to memory:doc:written, calls memory:index:upsert
  tools/                         — new directory
    memory-search.ts             — registers descriptor + tool:execute:memory_search
    memory-read-section.ts       — registers descriptor + tool:execute:memory_read_section
    memory-note.ts               — registers descriptor + tool:execute:memory_note (covers I20)
  inject.ts                      — new; system-prompt:augment provider, builds the memory block
  plugin.ts                      — wire reindex, tools, inject; thread the existing capabilities forward
  consolidator.ts                — emit memory:doc:written after writeNewDoc / appendFact
  __tests__/
    retriever.test.ts
    reindex.test.ts
    tools-memory-search.test.ts
    tools-memory-read-section.test.ts
    tools-memory-note.test.ts    — covers I20
    inject.test.ts               — covers I21 (token cap)
    ship-list.test.ts            — drop memory_search / memory_read_section / memory_note / tool:register / FTS5 / RRF; still forbid vector / hnswlib / embeddings / dense / rerank

packages/chat-orchestrator/src/
  plugin.ts                      — register system-prompt:augment service (subscribers contribute; results concatenated)
  __tests__/
    augment.test.ts              — covers Decision A1 (subscriber output ends up in system prompt envelope)

packages/cli/src/main.ts                — load @ax/memory-strata-index-sqlite alongside @ax/memory-strata
packages/preset-k8s/src/main.ts         — load @ax/memory-strata-index-postgres alongside @ax/memory-strata
pnpm-workspace.yaml                     — add the three new packages
```

### Files NOT touched (deliberate)

- `packages/llm-anthropic/*` — no LLM rerank in 2B.
- `packages/agent-claude-sdk-runner/*`, `packages/agent-native-runner/*` — tools register through the standard `tool:register` flow; the runners call `tool.list` and the new tools appear automatically.
- `packages/sandbox-*` — the agent calls `memory_*` tools via the SDK MCP host server, which already routes `executesIn: 'host'` calls through `tool.execute-host`.

---

## Phase 2B — Retriever + tools + auto-injection

### Task 2B.0 — Resolve open decisions

- [ ] **Step 1:** Read `docs/plans/memory-strata-design.md` § "2. Retriever", § "Agent Tool Interface", § "Context Assembly". Read `packages/storage-sqlite/src/plugin.ts` and `packages/storage-postgres/src/plugin.ts` end-to-end (templates we'll mirror).
- [ ] **Step 2:** Confirm Decisions A, B, C above. If autonomous, present via `AskUserQuestion`. Deviations: `D8`/`D9`/`D10` in PR notes (continues from Phase 2A's D7).
- [ ] **Step 3:** Confirm `chat-orchestrator` is willing to accept a new service hook. If the orchestrator's owner has a different abstraction in mind for prompt augmentation, capture as `D11` and adjust the plan.

### Task 2B.1 — Boundary review for `memory:index:*` and `system-prompt:augment`

> Two new hook surfaces; both need the four-question boundary review per CLAUDE.md before any code lands. Capture answers in PR notes.

#### Boundary review — `memory:index:upsert | search | delete | clear`

- **Alternate impl this hook could have:** Yes — this PR ships TWO impls (sqlite + postgres) and the hook's whole point is to abstract them. A future Elasticsearch / Tantivy / Meilisearch plugin would also implement these.
- **Payload field names that might leak:** Reviewed — proposed shapes:
  - `upsert({ docId, category, slug, summary, factType, body, headers })` — neutral; `docId` is opaque (`<category>/<slug>`); no `tsvector`/`fts5`/`rank` in writes.
  - `search({ query, topK, categoryFilter? })` returns `{ results: [{ docId, category, slug, summary, score }] }` — `score` is a normalized 0..1 float, not engine-specific.
  - `delete({ docId })`, `clear({})` — no payload risk.
- **Subscriber risk:** None — these are service hooks (one provider per registration), no subscribers expected.
- **Wire surface:** Not exposed over IPC in 2B. Internal-only.

#### Boundary review — `memory:doc:written`

- **Alternate impl this hook could have:** None reasonable; the event reflects an on-disk fact. But subscribers are real (the indexer); the event must therefore exist.
- **Payload field names:** `{ docId, category, slug, kind: 'created' | 'updated', summary }`. Neutral.
- **Subscriber risk:** Subscribers (the indexer) MUST be idempotent — same event may fire twice on retry.
- **Wire surface:** Not exposed over IPC.

#### Boundary review — `system-prompt:augment`

- **Alternate impl this hook could have:** Yes — any plugin (memory-strata, future personalization, future tenant-policy) could contribute.
- **Payload field names:** `augment({})` returns `{ contributions: [{source, body}] }`. `source` is the contributing plugin name (string); `body` is the markdown contribution. Neutral.
- **Subscriber risk:** Multi-contributor by design. The orchestrator concatenates contributions in registration order; it does NOT key off any plugin name.
- **Wire surface:** Not exposed over IPC.

- [ ] **Step 1:** Capture all three reviews verbatim in PR notes.
- [ ] **Step 2:** Get reviewer sign-off on the hook shapes BEFORE implementing the indexers (cheap to rename now, expensive after subscribers ship).

### Task 2B.2 — Scaffold `@ax/memory-strata-index-contract`

**Files:**
- Create: `packages/memory-strata-index-contract/{package.json,tsconfig.json,src/index.ts}`

- [ ] **Step 1: Copy `package.json` shape from `@ax/test-harness`** (or a similarly small contract package). Set `name: @ax/memory-strata-index-contract`, dependencies: `@ax/core`, `vitest` as a dev dep.
- [ ] **Step 2: Implement `runIndexContract`** — a vitest suite the two backend packages import. Walks: upsert 5 docs, search 'react' returns the react doc first, search nonexistent returns empty, delete a docId removes it from search, idempotent upsert, ranking gives the more-relevant doc a higher score.

The contract test exports a single function `runIndexContract(label, factory)` where `factory` returns `{ plugin, teardown }`. Each backend package supplies its own factory (sqlite uses a temp file; postgres uses a test container or a live connection from env). The body of the contract is roughly:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { HookBus, Plugin, AgentContext } from '@ax/core';
import { makeAgentContext, createInMemoryBus } from '@ax/core';

export interface IndexFactory {
  (): Promise<{ plugin: Plugin; teardown: () => Promise<void> }>;
}

export function runIndexContract(label: string, factory: IndexFactory): void {
  describe(label + ' — memory:index contract', () => {
    let bus: HookBus;
    let ctx: AgentContext;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      bus = createInMemoryBus();
      ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
      const built = await factory();
      teardown = built.teardown;
      await built.plugin.init({ bus });
    });

    afterEach(async () => { await teardown(); });

    it('upsert + search returns the matching doc', async () => {
      await bus.call('memory:index:upsert', ctx, {
        docId: 'preference/react',
        category: 'preference',
        slug: 'react',
        summary: 'User prefers React over Vue',
        factType: 'preference',
        body: 'User has used React for 5+ years.',
        headers: 'Facts',
      });
      const out = await bus.call('memory:index:search', ctx, {
        query: 'react', topK: 5,
      });
      expect(out.results).toHaveLength(1);
      expect(out.results[0].docId).toBe('preference/react');
      expect(out.results[0].score).toBeGreaterThan(0);
    });

    it('idempotent upsert: second call replaces, does not duplicate', async () => {
      const upsert = (summary: string) =>
        bus.call('memory:index:upsert', ctx, {
          docId: 'preference/react', category: 'preference', slug: 'react',
          summary, factType: 'preference', body: '', headers: '',
        });
      await upsert('first version');
      await upsert('updated summary');
      const out = await bus.call('memory:index:search', ctx, { query: 'updated', topK: 5 });
      expect(out.results).toHaveLength(1);
      expect(out.results[0].summary).toBe('updated summary');
    });

    // …delete, clear, ranking tests follow the same pattern…
  });
}
```

- [ ] **Step 3:** `pnpm install && pnpm --filter @ax/memory-strata-index-contract build`.
- [ ] **Step 4: Commit:** `feat(memory-strata-index-contract): shared contract test for index backends`.

### Task 2B.3 — Scaffold + implement `@ax/memory-strata-index-sqlite`

**Files:**
- Create: `packages/memory-strata-index-sqlite/{package.json,tsconfig.json,src/{index.ts,plugin.ts,schema.ts,queries.ts,__tests__/plugin.test.ts,__tests__/contract.test.ts}}`

- [ ] **Step 1:** Copy `package.json` + `tsconfig.json` shape from `@ax/storage-sqlite`. Adjust dependencies: `@ax/core`, `@ax/memory-strata-index-contract` (devDep), `kysely`, `better-sqlite3`.
- [ ] **Step 2: Implement `schema.ts`** — opens a Kysely<Database> over the shared sqlite file (path comes from plugin config, mirrors storage-sqlite's `databasePath`), runs the migration:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_strata_index_v1_docs
USING fts5(
  doc_id UNINDEXED,
  category UNINDEXED,
  slug UNINDEXED,
  summary,
  fact_type UNINDEXED,
  body,
  headers,
  tokenize = 'porter unicode61'
);
```

The `UNINDEXED` columns are still readable but don't contribute to BM25 ranking — `summary`, `body`, and `headers` are the searchable surface.

- [ ] **Step 3: Implement `queries.ts`** — typed `upsert(docId, …)`, `search(query, topK, categoryFilter?)`, `deleteOne(docId)`, `clearAll()`. The upsert is `DELETE WHERE doc_id = ? THEN INSERT` (FTS5 doesn't have native UPSERT). The search uses `MATCH ?` with sqlite's BM25 ranking via `bm25(memory_strata_index_v1_docs)`. Categories filter is a `WHERE category = ?` clause.

> **FTS5 query escaping:** The agent-supplied query string MUST be escaped before passing to MATCH (FTS5 has its own query language with `AND`, `OR`, `NEAR`, etc. that the agent doesn't intend to invoke). Use a small `escapeFts5Query` helper that wraps the query in double quotes and doubles internal double quotes — produces a phrase query, simple and safe. Test: a query of `react AND vue` should NOT trigger boolean parsing.

- [ ] **Step 4: Implement `plugin.ts`** — opens the database in `init`, registers the four hooks. Manifest:

```typescript
manifest: {
  name: '@ax/memory-strata-index-sqlite',
  version: '0.0.0',
  registers: [
    'memory:index:upsert',
    'memory:index:search',
    'memory:index:delete',
    'memory:index:clear',
  ],
  calls: [],
  subscribes: [],
}
```

- [ ] **Step 5:** Write `__tests__/plugin.test.ts` — sqlite-specific edge cases (FTS5 escaping, special characters in body, unicode, concurrent upserts using better-sqlite3's WAL mode).
- [ ] **Step 6:** Write `__tests__/contract.test.ts` — imports `runIndexContract` from `@ax/memory-strata-index-contract` and supplies a sqlite factory backed by a temp file.
- [ ] **Step 7:** `pnpm --filter @ax/memory-strata-index-sqlite test` — all green.
- [ ] **Step 8: Commit:** `feat(memory-strata-index-sqlite): BM25 index over docs/ via sqlite FTS5`.

### Task 2B.4 — Scaffold + implement `@ax/memory-strata-index-postgres`

**Files:**
- Create: `packages/memory-strata-index-postgres/{package.json,tsconfig.json,src/{index.ts,plugin.ts,migrations.ts,queries.ts,__tests__/plugin.test.ts,__tests__/contract.test.ts}}`

- [ ] **Step 1:** Copy `package.json` + `tsconfig.json` shape from `@ax/storage-postgres`. Adjust dependencies: `@ax/core`, `@ax/memory-strata-index-contract` (devDep), `kysely`. Calls `database:get-instance` (mirrors storage-postgres pattern).
- [ ] **Step 2: Implement `migrations.ts`** — adds:

```sql
CREATE TABLE IF NOT EXISTS memory_strata_index_v1_docs (
  doc_id    TEXT PRIMARY KEY,
  category  TEXT NOT NULL,
  slug      TEXT NOT NULL,
  summary   TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  body      TEXT NOT NULL,
  headers   TEXT NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(headers, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body,    '')), 'C')
  ) STORED
);

CREATE INDEX IF NOT EXISTS memory_strata_index_v1_docs_tsv_gin
  ON memory_strata_index_v1_docs
  USING GIN (search_tsv);
```

The weighting (A/B/C) corresponds to "summary > headers > body" relevance — matches the design doc's "Indexing Strategy: Metadata and Headers, Not Full Text" intent.

- [ ] **Step 3: Implement `queries.ts`** — typed `upsert` (INSERT … ON CONFLICT (doc_id) DO UPDATE SET …), `search(query, topK, categoryFilter?)` using `WHERE search_tsv @@ plainto_tsquery('english', ?)` ordered by `ts_rank(search_tsv, plainto_tsquery('english', ?)) DESC`, `deleteOne(docId)`, `clearAll()`.

> **plainto_tsquery escaping:** `plainto_tsquery` already handles arbitrary user input safely (it strips operators), so no manual escaping needed. Test: a query of `react AND vue` should be tokenized as three terms, not parsed as boolean.

- [ ] **Step 4:** Implement `plugin.ts` — calls `database:get-instance`, runs migration, registers the four hooks. Same manifest as the sqlite peer.
- [ ] **Step 5:** Write `__tests__/plugin.test.ts` — postgres-specific edge cases (tsvector weighting, special characters, concurrent upserts under transaction isolation).
- [ ] **Step 6:** Write `__tests__/contract.test.ts` — same shape as sqlite's, but the test factory spins up a postgres test container (or uses the workspace's existing testcontainers helper if there is one — search `packages/database-postgres` for the pattern).
- [ ] **Step 7:** `pnpm --filter @ax/memory-strata-index-postgres test` — all green.
- [ ] **Step 8: Commit:** `feat(memory-strata-index-postgres): BM25 index over docs/ via postgres tsvector`.

### Task 2B.5 — Emit `memory:doc:written` from Phase 2A's Consolidator

**Files:**
- Modify: `packages/memory-strata/src/consolidator.ts`
- Modify: `packages/memory-strata/src/plugin.ts` (declares the new event in the manifest)
- Test:   extend `consolidator.test.ts`

- [ ] **Step 1:** Add an optional `bus?: HookBus` field to `ConsolidationInput`. After each `writeNewDoc` and `appendFact`, if `bus` is present, publish `memory:doc:written` with `{ docId, category, slug, kind: 'created' | 'updated', summary }`.
- [ ] **Step 2:** Modify `plugin.ts` — pass `bus` through to `runConsolidation` and add `memory:doc:written` to the manifest's `registers` list (memory-strata is the producer; the indexer plugin is the consumer).
- [ ] **Step 3:** Extend `consolidator.test.ts` — assert the bus saw one `memory:doc:written` per write, with the right `kind`.
- [ ] **Step 4:** All memory-strata tests green.
- [ ] **Step 5: Commit:** `feat(memory-strata): emit memory:doc:written from consolidator`.

### Task 2B.6 — `reindex.ts`: subscribe to `memory:doc:written`, call `memory:index:upsert`

**Files:**
- Create: `packages/memory-strata/src/reindex.ts`
- Test:   `packages/memory-strata/src/__tests__/reindex.test.ts`

- [ ] **Step 1: Write the failing test (covers I22).** Fixture: a fake bus with the `memory:index:upsert` hook stubbed. Emit `memory:doc:written`; assert one `memory:index:upsert` call with the right payload (the subscriber re-reads the doc from disk to get canonical body + headers, NOT a copy from the event payload). Then simulate the upsert throwing; assert the subscriber logs the error but doesn't crash (subscriber posture: never throw out).
- [ ] **Step 2: Implement `reindex.ts`:**

```typescript
import type { HookBus } from '@ax/core';
import { readDoc } from './doc-store.js';

export function registerReindexer(bus: HookBus): void {
  bus.subscribe('memory:doc:written', '@ax/memory-strata', async (ctx, payload) => {
    const { docId, category, slug, kind } = payload;
    // Re-read the doc so we get the canonical body + headers, NOT a copy
    // from the event payload (which would let a subscriber-side
    // transformation drift from disk).
    const doc = await readDoc({
      workspaceRoot: ctx.workspace.rootPath,
      category, slug,
    });
    if (doc === null) return; // doc was deleted between write and reindex; skip.
    const headers = extractHeaders(doc.body);
    try {
      await bus.call('memory:index:upsert', ctx, {
        docId, category, slug,
        summary: doc.frontmatter.summary,
        factType: doc.frontmatter.factType,
        body: doc.body,
        headers: headers.join('\n'),
      });
    } catch (err) {
      ctx.logger.warn('memory_strata_reindex_failed', {
        docId, kind,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
    return undefined;
  });
}

function extractHeaders(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m !== null) out.push(m[1]!);
  }
  return out;
}
```

- [ ] **Step 3:** Wire into `plugin.ts` — `init` calls `registerReindexer(bus)`. Add `memory:index:upsert` to the manifest's `calls` list and `memory:doc:written` to `subscribes`.
- [ ] **Step 4:** All memory-strata tests green.
- [ ] **Step 5: Commit:** `feat(memory-strata): re-index docs on memory:doc:written`.

### Task 2B.7 — `retriever.ts`: thin client over `memory:index:search`

**Files:**
- Create: `packages/memory-strata/src/retriever.ts`
- Test:   `packages/memory-strata/src/__tests__/retriever.test.ts`

- [ ] **Step 1: Write the failing test.** Fixture: stub `memory:index:search` returning fixture results; assert `retrieve(bus, ctx, {query, topK})` returns them in order. When the indexer hook isn't registered, the retriever returns `[]` (graceful degradation in test harness contexts).
- [ ] **Step 2: Implement:**

```typescript
import type { HookBus, AgentContext } from '@ax/core';

export interface RetrieveInput {
  query: string;
  topK?: number;
  categoryFilter?: string;
}

export interface RetrievalResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  score: number;
}

export async function retrieve(
  bus: HookBus,
  ctx: AgentContext,
  input: RetrieveInput,
): Promise<RetrievalResult[]> {
  if (!bus.hasService('memory:index:search')) return [];
  const out = await bus.call('memory:index:search', ctx, {
    query: input.query,
    topK: input.topK ?? 5,
    categoryFilter: input.categoryFilter,
  });
  return out.results;
}
```

- [ ] **Step 3:** Test, commit: `feat(memory-strata): retrieve() helper over memory:index:search`.

### Task 2B.8 — `tools/memory-search.ts`

**Files:**
- Create: `packages/memory-strata/src/tools/memory-search.ts`
- Test:   `packages/memory-strata/src/__tests__/tools-memory-search.test.ts`

- [ ] **Step 1: Write the failing test.** Register the plugin against a fake bus; call `tool:execute:memory_search` with `{query: 'react'}`; assert the response is shaped `{ results: [{docId, summary, score}] }`. Assert `topK` is clamped to `[1, 20]`. Assert `categoryFilter`, when present, is passed through to the indexer.

- [ ] **Step 2: Implement:**

```typescript
import { makeAgentContext, type HookBus, type ToolDescriptor } from '@ax/core';
import { retrieve } from '../retriever.js';

export const MEMORY_SEARCH_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_search',
  description:
    'Search long-term memory. Returns document summaries (~50 tokens each). ' +
    'Use this BEFORE asserting facts about durable preferences, decisions, or known entities.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language search.' },
      categoryFilter: {
        type: 'string',
        description: 'Optional. One of: entity | preference | decision | episode | general',
      },
      topK: { type: 'number', description: 'Default 5; max 20.' },
    },
    required: ['query'],
  },
  outputSchema: { type: 'object', properties: { results: { type: 'array' } } },
};

export async function registerMemorySearch(bus: HookBus): Promise<void> {
  const ctx = makeAgentContext({
    sessionId: 'init',
    agentId: '@ax/memory-strata',
    userId: 'system',
  });
  await bus.call('tool:register', ctx, MEMORY_SEARCH_DESCRIPTOR);

  bus.registerService(
    'tool:execute:memory_search',
    '@ax/memory-strata',
    async (ctx, input) => {
      const topK = Math.max(1, Math.min(Number(input?.topK ?? 5), 20));
      const results = await retrieve(bus, ctx, {
        query: String(input?.query ?? ''),
        topK,
        categoryFilter:
          typeof input?.categoryFilter === 'string'
            ? input.categoryFilter
            : undefined,
      });
      return { results };
    },
  );
}
```

- [ ] **Step 3:** Run the test. Commit: `feat(memory-strata): memory_search tool`.

### Task 2B.9 — `tools/memory-read-section.ts`

**Files:**
- Create: `packages/memory-strata/src/tools/memory-read-section.ts`
- Test:   `packages/memory-strata/src/__tests__/tools-memory-read-section.test.ts`

- [ ] **Step 1: Write the failing test.** Fixture: write a doc with sections `## Facts` and `## Working Style`; call `memory_read_section({docId: 'preference/react', header: 'Facts'})`; assert the response is the body of that section only (not the whole doc). Assert `header` omitted returns the whole body. Assert a docId with path separators (`../`, `/etc/passwd`) is rejected.
- [ ] **Step 2: Implement** — parse the docId as `<category>/<slug>`, validate `category` is in the enum, validate `slug` matches `/^[a-z0-9-]+$/` (no path traversal), call `readDoc()`, walk the body for `## <header>` and slice until the next `##`. If `header` is omitted, return the whole body.
- [ ] **Step 3:** Test, commit: `feat(memory-strata): memory_read_section tool`.

### Task 2B.10 — `tools/memory-note.ts` (covers I20)

**Files:**
- Create: `packages/memory-strata/src/tools/memory-note.ts`
- Test:   `packages/memory-strata/src/__tests__/tools-memory-note.test.ts`

- [ ] **Step 1: Write the failing test (covers I20).**
  - Fixture A — a `memory_note({subject: 'react', content: 'User has used React for 5 years', factType: 'preference', confidence: 0.9})` call results in a new inbox file.
  - Fixture B — `memory_note({subject: 'creds', content: 'My API key is sk-ant-XXXXXXXXXXXXXXXXXXXXX'})` is REJECTED before any disk write; the response carries `{ rejected: true, reason: 'sensitive', kinds: ['anthropic-api-key'] }`. NO inbox file is created.
- [ ] **Step 2: Implement** — runs the input through `filterSensitive`; if rejected, return the structured error; if accepted, write to inbox the same way Phase 1's Observer does. (Refactor Phase 1's `writeInboxObservation` into `inbox-store.ts` so both `memory_note` and the Observer share the same write path. This refactor is part of this task — it ensures I18 / I20 are enforced by construction.)
- [ ] **Step 3:** Test, commit: `feat(memory-strata): memory_note tool with sensitive-gate (covers I20)`.

### Task 2B.11 — `system-prompt:augment` hook in chat-orchestrator (Decision A1)

**Files:**
- Modify: `packages/chat-orchestrator/src/plugin.ts`
- Test:   `packages/chat-orchestrator/src/__tests__/augment.test.ts`

- [ ] **Step 1:** Read the orchestrator's existing `agent:invoke` path end-to-end. Identify the moment the system prompt envelope is assembled before the runner is invoked.
- [ ] **Step 2: Write the failing test.** Register a stub provider for `system-prompt:augment` returning `{ contributions: [{source: 'test', body: 'INJECT-ME'}] }`; trigger `agent:invoke`; assert the runner sees `'INJECT-ME'` in its system prompt input. Assert that when `system-prompt:augment` is NOT registered, the orchestrator behaves identically to today (no-op).
- [ ] **Step 3: Add the hook.** Two shapes considered:
  - (a) Multi-subscribe broadcast: `bus.publish('system-prompt:augment', ctx, {})` and subscribers respond by calling a separate service. Ugly.
  - (b) Service hook the orchestrator calls — a single registered service `system-prompt:augment` returning `{ contributions: [{source, body}] }`.

  Pick (b). Multi-source contributors are a Phase 5+ concern (rename or expand the hook to support a subscriber chain when a second contributor lands).

- [ ] **Step 4:** Modify the orchestrator's `agent:invoke` path to call `system-prompt:augment` (if registered via `bus.hasService`) and prepend the contribution to the system prompt envelope.
- [ ] **Step 5:** Test, commit: `feat(chat-orchestrator): system-prompt:augment hook`.

### Task 2B.12 — `inject.ts`: build the auto-injected memory block (covers I21)

**Files:**
- Create: `packages/memory-strata/src/inject.ts`
- Test:   `packages/memory-strata/src/__tests__/inject.test.ts`

- [ ] **Step 1: Write the failing test (covers I21).** Fixture: 100 docs in the index; the latest user message is "billing API"; call `buildMemoryBlock(bus, ctx, {lastUserMessage})`; assert:
  - Output is a markdown string containing `## User Profile`, `## Recent`, `## Relevant Documents`.
  - Output is under 1500 tokens (use a simple `Math.ceil(text.length / 4)` heuristic for the cap; precise tokenization is overkill here).
  - When the corpus is huge, lowest-rank docs are dropped first.
- [ ] **Step 2: Implement** — build the block from:
  - `system/user.md` summary
  - `system/recent.md` body
  - Top-K (default 3) summaries from `retrieve(bus, ctx, {query: lastUserMessage, topK: 3})`

  Concatenate into the layout described in design § "Context Assembly" (~963–1011). Drop docs to fit the cap.

- [ ] **Step 3:** Wire `@ax/memory-strata` to register the `system-prompt:augment` service (returning `{ contributions: [{source: '@ax/memory-strata', body: <buildMemoryBlock output>}] }`). Add it to the manifest's `registers` list. Test, commit: `feat(memory-strata): auto-inject summaries into system prompt (covers I21)`.

### Task 2B.13 — Wire CLI preset (sqlite) and k8s preset (postgres)

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/preset-k8s/src/main.ts`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: CLI preset** — add `createMemoryStrataIndexSqlitePlugin({ databasePath })` after `@ax/memory-strata`. The databasePath should match the existing storage-sqlite path (or a sibling — confirm with the conventions for shared sqlite files).
- [ ] **Step 2: k8s preset** — add `createMemoryStrataIndexPostgresPlugin()` after `@ax/memory-strata`. It calls `database:get-instance` from `@ax/database-postgres`, which must be registered earlier — verify topological order.
- [ ] **Step 3:** Update `pnpm-workspace.yaml` if not glob-matched.
- [ ] **Step 4:** `pnpm install && pnpm build && pnpm test` — all green.
- [ ] **Step 5: Commit:** `feat(presets): wire memory-strata indexers (sqlite in CLI, postgres in k8s) — closes Phase 2B half-wired window`.

### Task 2B.14 — Update ship-list test

**Files:**
- Modify: `packages/memory-strata/src/__tests__/ship-list.test.ts`

- [ ] **Step 1:** Drop `memory_search`, `memory_read_section`, `memory_note`, `tool:register`, `FTS5`, `RRF` from the forbidden list (they ship now; FTS5 lives in the sqlite indexer package, not memory-strata's src — but we keep FTS5 forbidden in `memory-strata/src/` to enforce the abstraction). Keep forbidden in 2B: `vector`, `hnswlib`, `embeddings`, `dense`, `rerank`.
- [ ] **Step 2:** Run the test, expect PASS.
- [ ] **Step 3: Commit:** `test(memory-strata): update ship-list for Phase 2B scope`.

### Task 2B.15 — Manual acceptance against kind cluster (k8s + sqlite locally)

- [ ] **Step 1: Run the test suite.** `pnpm build && pnpm test && pnpm lint` — all green, including both indexer contract tests.
- [ ] **Step 2: CLI smoke test (sqlite).** `pnpm --filter @ax/cli start` an agent, run a few chats, then a `memory_search "react"` — verify it returns the doc.
- [ ] **Step 3: kind smoke test (postgres).** `make dev` (host code change), then walk acceptance criteria in the cluster.
- [ ] **Step 4: Bug-fix policy check.** Every bug found gets a regression test before the fix lands.

### Task 2B.16 — PR notes + open

- [ ] **Step 1:** PR notes prep:

```markdown
## Phase 2B — `@ax/memory-strata` Retriever + agent tools + auto-injection

### What ships
- New hook surface: `memory:index:{upsert,search,delete,clear}` + `memory:doc:written` event + `system-prompt:augment` service hook (boundary review attached)
- New companion plugin `@ax/memory-strata-index-sqlite` (FTS5 BM25)
- New companion plugin `@ax/memory-strata-index-postgres` (tsvector + GIN BM25)
- Shared contract test package `@ax/memory-strata-index-contract`
- Three agent tools: `memory_search`, `memory_read_section`, `memory_note`
- Re-indexer: every Consolidator-emitted `memory:doc:written` triggers `memory:index:upsert`
- Auto-injection at chat:start: top-3 summaries appended to the system prompt envelope (~1500 token cap)
- CLI preset wires sqlite indexer; k8s preset wires postgres indexer

### What does NOT ship (Phase 3+)
- Vector / dense / embeddings retrieval (Phase 3 spike decides)
- RRF fusion (only relevant once vectors land)
- LLM reranker (Phase 4 or post-spike)
- `memory_edit`, `memory_list`, `update_core_memory` tools (deferred — see YAGNI)
- recency / importance / scope ranking signals (post-spike)
- Promoter / warm cache (Phase 4)
- Folder summaries (Hermes-style) (deferred)

### Boundary review
- `memory:index:upsert | search | delete | clear` — see Task 2B.1 review
- `memory:doc:written` event — see Task 2B.1 review
- `system-prompt:augment` service — see Task 2B.1 review

### Invariants audit (continues from Phase 2A's I16)
- I17 (transport-agnostic indexer): VERIFIED by cross-backend contract test
- I18 (single source of truth: indexer): VERIFIED — no cached search results outside `memory:index:search`
- I19 (two backends behave identically): VERIFIED by `runIndexContract` against both packages
- I20 (sensitive-gate at memory_note): VERIFIED by `tools-memory-note.test.ts` Fixture B
- I21 (auto-inject token-bounded): VERIFIED by `inject.test.ts` 100-doc fixture
- I22 (re-index idempotent + non-destructive): VERIFIED by `reindex.test.ts` + contract test
- I23 (Phase 2B ship-list): VERIFIED by `ship-list.test.ts`
- I24 (half-wired window CLOSED): VERIFIED — sqlite indexer in CLI preset + postgres indexer in k8s preset, same PR

### Half-wired window: CLOSED in this PR
Matrix:
- CLI preset: @ax/memory-strata + @ax/memory-strata-index-sqlite
- k8s preset: @ax/memory-strata + @ax/memory-strata-index-postgres
No preset where memory-strata loads without an indexer companion.

### Deviations from plan
[list any D8..Dn from open decisions]
```

- [ ] **Step 2: Open the PR.** Title: `feat: @ax/memory-strata Phase 2B (BM25 retriever + tools + auto-inject)`.

---

## Acceptance criteria for Phase 2B

A user (or `k8s-acceptance-loop`) running ax-next against a kind cluster:

1. Start with the agent state from Phase 2A acceptance criteria — `docs/preference/react.md` exists.
2. Send a message asking "what do you remember about React?". The agent invokes `memory_search`, gets back the react doc summary, then optionally `memory_read_section({docId: 'preference/react', header: 'Facts'})`, and answers using both.
3. Send a message asking about something the agent doesn't know. `memory_search` returns 0 results; the agent answers without hallucinating a memory.
4. Manually call `memory_note({subject: 'meeting', content: 'Standup is at 9am Pacific', factType: 'decision', confidence: 0.95})`. After Consolidator runs, `docs/decision/meeting.md` exists.
5. Manually call `memory_note({subject: 'creds', content: 'sk-ant-XXXXXXXXXXXXXXXXXXXXX'})`. The tool returns a structured `{rejected: true, reason: 'sensitive'}` error; no inbox or doc is written; `grep -r "sk-ant-" permanent/memory/` finds nothing.
6. Restart the agent. The auto-injected memory block on the next chat:start contains the user profile + recent.md + top-3 search results for the latest user message.
7. Two agents in the same workspace have isolated indexes (extends I8 -> indexer scope is per-agent).
8. CLI smoke test (sqlite indexer) and k8s smoke test (postgres indexer) both pass the same acceptance walk.

If all eight pass, Phase 2B is done. Phase 3 (eval + vector spike) gets its own plan when triggered.

## Verification

```bash
pnpm --filter @ax/memory-strata-index-contract build
pnpm --filter @ax/memory-strata-index-sqlite test
pnpm --filter @ax/memory-strata-index-postgres test
pnpm --filter @ax/memory-strata test
pnpm test
pnpm lint
make dev    # host-code change requires full rebuild
# then walk the 8-step acceptance criteria above on both backends
```

If any acceptance step fails, fix-and-add-a-test per CLAUDE.md §"Bug Fix Policy" before marking Phase 2B done.
