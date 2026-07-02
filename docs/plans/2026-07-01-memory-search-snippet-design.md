# memory_search matched-snippet — design

**Date:** 2026-07-01
**Status:** approved, pre-implementation
**Owner:** Strata retrieval

## Motivation

The e2e LongMemEval-S harness measures the shipped `@ax/memory-strata` runtime end
to end. After wiring `memory_read_section` (PR #372) the number moved ~0% → **27.0%**
(BM25) → **37.8%** (orchestrator, TASK-191). The dominant remaining failure is
**false refusal**: on answerable questions the agent says "I don't know" —
61.7% of answerable questions under BM25, 44.6% under the orchestrator.

A deterministic autopsy of 6 false-refusals isolated the cause. It is **not**
extraction and **not** ranking:

| signal | result |
|---|---|
| gold value captured in a doc **body** | 6/6 |
| gold doc **ranked into BM25 top-10** | 5/6 |
| gold value present in the doc **summary** | 1/6 |
| gold value present in **`system/map.md`** | 0/6 |

The consolidator collapses facts into coarse per-category mega-docs
(`decision/user`, `preference/user`, `episode/user`) whose single-line summary
cannot represent the dozens of facts inside. `memory_search` returns **only that
summary**, so the agent sees an irrelevant-looking blurb over the exact doc that
holds its answer and refuses. The full body is already stored and indexed (that is
why BM25 ranks the doc) — it is simply never returned.

## Goal

`memory_search` returns, per hit, a **bounded excerpt of the body centered on the
query match**, in addition to the existing summary — so the value the agent needs
is visible in the search result itself, without a second `memory_read_section`
call.

## Non-goals

- **Consolidation / doc granularity** (splitting `<category>/user` mega-docs) — that
  is a separate lever (#2). This change fixes what the agent sees *after* a doc is
  retrieved; it does not change what gets stored or how it is clustered.
- **`system/map.md` densification** — the map still lacks values, which is why the
  *orchestrator's* map-navigation stays blind. That is part of #2. This change most
  directly lifts the BM25 / `memory_search` surface (the 27% baseline); the
  orchestrator benefits only where its retrieval surfaces `memory_search` results.
- **`memory_read_section`** — unchanged; it stays the deliberate full-body drill-in.
- Making the snippet window size user-tunable — a sensible fixed default (YAGNI).

## Design

### 1. Contract — `@ax/memory-strata-index-contract`

`SearchResult` gains a required field:

```ts
export interface SearchResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;   // NEW — bounded body excerpt centered on the query match
  score: number;
}
```

`SearchInput` is unchanged — the window size is a backend-internal constant
(~48 tokens / MaxWords=48), not a request parameter.

The shared conformance kit (`IndexBackendFactory` tests) gains a case: index a doc
whose **body** contains a distinctive value the **summary** omits, search for a
term in that value, and assert the returned `snippet` contains the value. Both
backends run this kit, so parity is enforced by the contract, not by hand.

### 2. sqlite backend — `@ax/memory-strata-index-sqlite`

FTS5 `body` is column index **6** (agent_key 0, doc_id 1, category 2, slug 3,
summary 4, fact_type 5, body 6, headers 7). Add to both SELECT variants in
`queries.ts`:

```sql
snippet(<table>, 6, '', '', '…', 48) AS snippet
```

No highlight markers (empty start/end match strings) to keep the text clean for the
model; `'…'` ellipsis; ~48-token window. Map `snippet` onto the result row.

### 3. postgres backend — `@ax/memory-strata-index-postgres`

Add to the search SELECT in `queries.ts`, reusing the existing tsquery:

```sql
ts_headline('english', body, <existing tsquery>,
            'MaxWords=48, MinWords=16, StartSel=, StopSel=') AS snippet
```

Map `snippet` onto the result row.

### 4. Threading (consumer side)

- `retriever.ts` `RetrievalResult` gains `snippet: string`; passed through from the
  `memory:index:search` output.
- `tools/memory-search.ts` executor: include `snippet` in each returned result
  object (its output is the tool result the model sees). Update the tool
  **description** to state that each result includes a matched excerpt and that the
  agent should read it before deciding to abstain.
- **e2e bench**: add `snippet` to `MemorySearchResult` and render it in
  `formatSearchResults` (`[i] (docId) summary — "…snippet…"`). This is the surface
  that moves the eval number.

### Snippet window

Default ~48 tokens with `'…'` ellipsis. Rationale: the query terms (e.g.
"degree", "graduate") sit adjacent to the value ("Business Administration") in the
extracted fact, so a small window reliably captures it while staying compact for
mega-docs. Fixed constant, defined once per backend.

## Testing (TDD)

1. **Contract conformance** — the new "value in body, not in summary" case; run by
   both backends (sqlite in-process; postgres via its existing test harness).
2. **sqlite unit** — `search()` returns a `snippet` containing a body-only value.
3. **postgres unit** — same assertion against `ts_headline` output.
4. **`memory_search` executor test** — returned results carry a populated `snippet`.
5. **Validation (not a unit test)** — re-run the e2e harness (BM25 and orchestrator)
   and confirm false-refusal drops from the 61.7% / 44.6% baseline.

## Boundary review (hook-payload change)

- **Alternate impl:** the `SearchResult` contract is implemented by both sqlite and
  postgres, and both produce `snippet` (FTS5 `snippet()` / PG `ts_headline()`). The
  field is a generic "matched excerpt", not backend-specific.
- **Field-name leak:** `snippet` is storage-agnostic — not `fts5_snippet` /
  `ts_headline` / a column index. No leak.
- **Subscriber risk:** the only subscribers (`retriever` → `memory_search`
  executor) pass it through untouched; none key off a backend detail.
- **Wire surface:** `tool:execute:memory_search`'s output is the tool result handed
  to the model; the schema lives in the memory-strata plugin and gains `snippet`.

## Security review

- **Untrusted content:** the snippet is derived from the agent's **own** stored body
  via a parameterized DB function; the query is already FTS5/tsquery-escaped
  (I17). No new injection surface.
- **Scope:** search is already `agent_key`-scoped (TASK-186), so a snippet can only
  ever reflect the calling agent's own memory — no cross-tenant leak.
- **Disclosure:** the snippet surfaces more of the agent's own body than the summary
  did, but it is content the agent already owns and could read via
  `memory_read_section`. No trust boundary crossed.

## Follow-ups (out of scope here)

- **#2** value-preserving, granular consolidation + `map.md` values (unblocks the
  orchestrator's map navigation).
- **#3** inbox-stranded facts + ranking (the yoga autopsy case).
