# memory_search matched-snippet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `memory_search` returns a bounded, match-centered excerpt of each hit's body (alongside the existing summary), so the agent sees the actual value and stops falsely refusing answerable questions.

**Architecture:** Both index backends already store + full-text-index the `body`; the search query just never returns it. Add a `snippet` field to the shared `SearchResult` contract, populate it with each DB's native windowing function (FTS5 `snippet()` / Postgres `ts_headline()`), thread it through the retriever → `memory_search` executor → the tool result, and mirror it in the e2e bench so the eval measures the lift.

**Tech Stack:** TypeScript, pnpm workspace, Kysely + better-sqlite3 (FTS5), Kysely + Postgres (tsvector), Zod, Vitest, `@testcontainers/postgresql`.

## Global Constraints

- **TDD:** every code change is preceded by a failing test. Bug Fix Policy applies.
- **Pre-PR gate:** `pnpm build` (tsc refs) + `pnpm test` + `pnpm exec eslint <changed files>` all green.
- **`snippet` is a REQUIRED contract field** (`snippet: string`), implemented by BOTH backends — no half-wired contract (Invariant 3, 4).
- **Storage-agnostic payload:** the field is named `snippet` — never `fts5_snippet`, `ts_headline`, or a column index (Invariant 1). No FTS5/tsvector vocab crosses the hook.
- **No cross-plugin imports** (Invariant 2): `MAX_TOP_K` and the two `SearchOutputSchema`s stay duplicated per backend; do not import one from the other.
- **Snippet shape:** ~48-token window, `'…'` ellipsis, NO highlight markers. sqlite passes empty match strings; postgres strips the default `<b>`/`</b>` in the mapper.
- **Commit trailers:** end every commit message with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RvNQKujmpeGwGhuJcnqBSc
  ```
- **Postgres tests need Docker** (`@testcontainers/postgresql`). If Docker is unavailable locally, the postgres *contract* test is skipped locally and gated in CI; the postgres *return-schema* test (pure Zod, no Docker) and `pnpm build` still verify the postgres changes locally.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/memory-strata-index-contract/src/index.ts` | shared hook I/O types + conformance kit | `SearchResult.snippet`; new conformance test |
| `packages/memory-strata-index-sqlite/src/queries.ts` | FTS5 search SQL + row mapping | SELECT `snippet()`, map field |
| `packages/memory-strata-index-sqlite/src/plugin.ts` | `memory:index:search` handler + `returns` Zod | `SearchOutputSchema.snippet` |
| `packages/memory-strata-index-sqlite/src/__tests__/return-schemas.test.ts` | asserts the `returns` schema shape | add `snippet` |
| `packages/memory-strata-index-postgres/src/queries.ts` | tsvector search SQL + row mapping | SELECT `ts_headline()`, map + strip markers |
| `packages/memory-strata-index-postgres/src/plugin.ts` | `memory:index:search` handler + `returns` Zod | `SearchOutputSchema.snippet` |
| `packages/memory-strata-index-postgres/src/__tests__/return-schemas.test.ts` | asserts the `returns` schema shape | add `snippet` |
| `packages/memory-strata/src/retriever.ts` | client over `memory:index:search` | `RetrievalResult.snippet` |
| `packages/memory-strata/src/tools/memory-search.ts` | `memory_search` tool executor + descriptor | return `snippet`; description update |
| `packages/memory-strata/src/tools/__tests__/memory-search.test.ts` | executor test | assert `snippet` passthrough (create if absent) |
| `packages/memory-strata/test/bench/e2e-answer.ts` | e2e answer client + result formatting | `MemorySearchResult.snippet`; render in `formatSearchResults` |
| `packages/memory-strata/test/bench/__tests__/e2e-answer.test.ts` | answer-loop tests | assert snippet reaches the model |

---

### Task 1: Contract field + both index backends return `snippet`

A required shared-contract field can't be half-implemented (the build and the shared conformance kit break), so contract + sqlite + postgres land together. Deliverable: both backends surface a match-centered body excerpt, proven by the conformance kit.

**Files:**
- Modify: `packages/memory-strata-index-contract/src/index.ts`
- Modify: `packages/memory-strata-index-sqlite/src/queries.ts`
- Modify: `packages/memory-strata-index-sqlite/src/plugin.ts`
- Modify: `packages/memory-strata-index-sqlite/src/__tests__/return-schemas.test.ts`
- Modify: `packages/memory-strata-index-postgres/src/queries.ts`
- Modify: `packages/memory-strata-index-postgres/src/plugin.ts`
- Modify: `packages/memory-strata-index-postgres/src/__tests__/return-schemas.test.ts`

**Interfaces:**
- Produces: `SearchResult { docId: string; category: string; slug: string; summary: string; snippet: string; score: number }` on the `memory:index:search` hook output.

- [ ] **Step 1: Add the failing conformance case.** In `packages/memory-strata-index-contract/src/index.ts`, inside `runIndexContract`, add a test after Test 8:

```ts
    // -----------------------------------------------------------------------
    // Test 8b: search returns a snippet carrying a body-only value
    // -----------------------------------------------------------------------
    // The value the agent needs often lives ONLY in the body, not the summary
    // (coarse per-category docs). The search result must surface a
    // match-centered body excerpt so the agent sees the value without a
    // second read. Regression guard for the e2e false-refusal fix.
    it('returns a snippet containing a body-only value', async () => {
      await upsert({
        docId: 'decision/user',
        category: 'decision',
        slug: 'user',
        summary: "User's academic and career decisions",
        factType: 'decision',
        body: 'After a lot of thought the user graduated with a B.A. in Business Administration.',
        headers: '',
      });

      const out = await search({ query: 'degree graduated', topK: 5 });
      expect(out.results).toHaveLength(1);
      expect(out.results[0]!.snippet).toContain('Business Administration');
    });
```

- [ ] **Step 2: Add `snippet` to the contract type.** In the same file, extend `SearchResult`:

```ts
export interface SearchResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  score: number;
}
```

- [ ] **Step 3: Red check (sqlite won't compile / test fails).**

Run: `pnpm --filter @ax/memory-strata-index-sqlite test 2>&1 | tail -20`
Expected: FAIL — TS error that `snippet` is missing on the sqlite search result / the new conformance case fails.

- [ ] **Step 4: Implement sqlite snippet in `queries.ts`.** Add `snippet` to `SearchResultRow`, to the `RawRow` type, to both SELECTs (body is FTS5 column index **6**), and to the row mapping:

```ts
export interface SearchResultRow {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  score: number;
}
```

In each of the two `sql<{...}>` blocks, change the row type to add `snippet: string` and add the column to the SELECT (categoryFilter variant shown; apply the identical change to the no-filter variant):

```ts
    const result = await sql<{
      doc_id: string;
      category: string;
      slug: string;
      summary: string;
      snippet: string;
      raw_score: number;
    }>`
      SELECT doc_id, category, slug, summary,
             snippet(${sql.raw(TABLE)}, 6, '', '', '…', 48) AS snippet,
             bm25(${sql.raw(TABLE)}) AS raw_score
      FROM ${sql.raw(TABLE)}
      WHERE ${sql.raw(TABLE)} MATCH ${escaped}
        AND agent_key = ${agentKey}
        AND category = ${categoryFilter}
      ORDER BY bm25(${sql.raw(TABLE)}) ASC
      LIMIT ${topK}
    `.execute(db);
```

Update `rawRows`'s declared type to include `snippet: string`, and the final map:

```ts
  return rawRows.map((r) => ({
    docId: r.doc_id,
    category: r.category,
    slug: r.slug,
    summary: r.summary,
    snippet: r.snippet,
    score: -r.raw_score,
  }));
```

- [ ] **Step 5: Add `snippet` to sqlite `SearchOutputSchema`.** In `packages/memory-strata-index-sqlite/src/plugin.ts`, inside the `z.object` result shape:

```ts
export const SearchOutputSchema = z.object({
  results: z.array(
    z.object({
      docId: z.string(),
      category: z.string(),
      slug: z.string(),
      summary: z.string(),
      snippet: z.string(),
      score: z.number(),
    }),
  ),
}) as unknown as ZodType<SearchOutput>;
```

- [ ] **Step 6: Update sqlite return-schema test.** Open `packages/memory-strata-index-sqlite/src/__tests__/return-schemas.test.ts`. Wherever it builds a sample result object to `SearchOutputSchema.parse(...)`, add `snippet: 'some excerpt'` to that object, and add an assertion that the parsed result preserves it:

```ts
expect(parsed.results[0]!.snippet).toBe('some excerpt');
```

- [ ] **Step 7: Green check (sqlite).**

Run: `pnpm --filter @ax/memory-strata-index-sqlite test 2>&1 | tail -20`
Expected: PASS — the conformance snippet case and return-schema test pass (sqlite runs the kit in-process, no Docker).

- [ ] **Step 8: Implement postgres snippet in `queries.ts`.** In `packages/memory-strata-index-postgres/src/queries.ts`, add `snippet` to `SearchResultRow` and `RawRow`, add `ts_headline` to both SELECTs (categoryFilter variant shown; apply identically to the no-filter variant), and strip the default markers in the map:

```ts
export interface SearchResultRow {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  score: number;
}
```

```ts
  type RawRow = Pick<MemoryStrataIndexDocRow, 'doc_id' | 'category' | 'slug' | 'summary'> & {
    snippet: string;
    score: number;
  };
```

```ts
    const result = await sql<RawRow>`
      SELECT doc_id, category, slug, summary,
             ts_headline('english', body,
               plainto_tsquery('english', ${trimmed}),
               'MaxWords=48, MinWords=16, MaxFragments=1') AS snippet,
             ts_rank(search_tsv, plainto_tsquery('english', ${trimmed})) AS score
      FROM memory_strata_index_v2_docs
      WHERE search_tsv @@ plainto_tsquery('english', ${trimmed})
        AND agent_key = ${agentKey}
        AND category = ${categoryFilter}
      ORDER BY score DESC
      LIMIT ${topK}
    `.execute(db);
```

```ts
  return rows.map((r) => ({
    docId: r.doc_id,
    category: r.category,
    slug: r.slug,
    summary: r.summary,
    // ts_headline emits <b>…</b> around matches by default; strip for clean
    // model-facing text (mirrors sqlite's empty-marker snippet()).
    snippet: String(r.snippet).replace(/<\/?b>/g, ''),
    score: Number(r.score),
  }));
```

- [ ] **Step 9: Add `snippet` to postgres `SearchOutputSchema`.** In `packages/memory-strata-index-postgres/src/plugin.ts`, add `snippet: z.string(),` to the `z.object` result shape (identical placement to Step 5).

- [ ] **Step 10: Update postgres return-schema test.** In `packages/memory-strata-index-postgres/src/__tests__/return-schemas.test.ts`, add `snippet: 'some excerpt'` to the sample result object(s) and assert it's preserved (mirrors Step 6).

- [ ] **Step 11: Green check (postgres).**

Run: `pnpm --filter @ax/memory-strata-index-postgres test 2>&1 | tail -30`
Expected: PASS. The return-schema test passes without Docker. The contract test starts a Postgres testcontainer — if Docker is running it PASSES; if Docker is unavailable it errors on container start (that's an environment gap, not a code failure) — in that case verify via CI and confirm `pnpm build` is green locally.

- [ ] **Step 12: Whole-workspace build.**

Run: `pnpm build 2>&1 | tail -5`
Expected: PASS — no TS errors anywhere (this is where a stray missing-`snippet` in either backend would surface).

- [ ] **Step 13: Commit.**

```bash
git add packages/memory-strata-index-contract packages/memory-strata-index-sqlite packages/memory-strata-index-postgres
git commit -m "$(cat <<'EOF'
feat(memory-strata-index): return a matched body snippet from search

Both backends already index the body but only returned the summary, so the
agent never saw the value it needed. Add a required `snippet` field to the
SearchResult contract, populated by FTS5 snippet() (sqlite) and ts_headline()
(postgres), enforced by the shared conformance kit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RvNQKujmpeGwGhuJcnqBSc
EOF
)"
```

---

### Task 2: Thread `snippet` through the retriever + `memory_search` executor

**Files:**
- Modify: `packages/memory-strata/src/retriever.ts`
- Modify: `packages/memory-strata/src/tools/memory-search.ts`
- Test: `packages/memory-strata/src/tools/__tests__/memory-search.test.ts` (create if absent)

**Interfaces:**
- Consumes: `SearchResult.snippet` from Task 1 on the `memory:index:search` output.
- Produces: each `memory_search` tool result row includes `snippet: string`.

- [ ] **Step 1: Write the failing executor test.** In `packages/memory-strata/src/tools/__tests__/memory-search.test.ts`, add a test that registers a stub `memory:index:search` returning a snippet and asserts the executor surfaces it. (If the file doesn't exist, create it with the imports the sibling tests use — a `HookBus`, `makeAgentContext`, and `registerMemorySearch`.)

```ts
import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { registerMemorySearch } from '../memory-search.js';

describe('memory_search executor snippet passthrough', () => {
  it('includes the body snippet in each result', async () => {
    const bus = new HookBus();
    bus.registerService('memory:index:search', 'stub-index', async () => ({
      results: [{
        docId: 'decision/user', category: 'decision', slug: 'user',
        summary: "User's decisions", snippet: 'graduated with a B.A. in Business Administration',
        score: 1,
      }],
    }));
    await registerMemorySearch(bus);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', workspace: { rootPath: '/tmp' } });

    const out = await bus.call('tool:execute:memory_search', ctx, { input: { query: 'degree', topK: 5 } }) as {
      results: Array<{ docId: string; snippet: string }>;
    };
    expect(out.results[0]!.snippet).toContain('Business Administration');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm --filter @ax/memory-strata test -- src/tools/__tests__/memory-search.test.ts 2>&1 | tail -15`
Expected: FAIL — `snippet` is `undefined` (stripped by the executor's result type / not mapped).

- [ ] **Step 3: Add `snippet` to `RetrievalResult`.** In `packages/memory-strata/src/retriever.ts`:

```ts
export interface RetrievalResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  score: number;
}
```

- [ ] **Step 4: Add `snippet` to the executor result type + tool description.** In `packages/memory-strata/src/tools/memory-search.ts`, extend the `registerService` result generic to include `snippet`:

```ts
  bus.registerService<
    { input?: unknown },
    { results: Array<{ docId: string; category: string; slug: string; summary: string; snippet: string; score: number }> }
  >(
```

and update `MEMORY_SEARCH_DESCRIPTOR.description` to:

```ts
  description:
    'Search long-term memory. Returns, per hit, a one-line summary AND a `snippet` — ' +
    'a short excerpt of the matching document body. READ the snippet before deciding you ' +
    "don't know: the specific value (a name, date, number, place) is usually in the snippet, " +
    'not the summary. Use memory_read_section only to read more of a doc the snippet teased.',
```

- [ ] **Step 5: Run test to verify it passes.**

Run: `pnpm --filter @ax/memory-strata test -- src/tools/__tests__/memory-search.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add packages/memory-strata/src/retriever.ts packages/memory-strata/src/tools/memory-search.ts packages/memory-strata/src/tools/__tests__/memory-search.test.ts
git commit -m "$(cat <<'EOF'
feat(memory-strata): surface the search snippet through memory_search

Thread the new SearchResult.snippet through the retriever and the memory_search
tool result, and tell the agent (in the tool description) to read the snippet
before abstaining.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RvNQKujmpeGwGhuJcnqBSc
EOF
)"
```

---

### Task 3: Surface `snippet` in the e2e bench answer path

**Files:**
- Modify: `packages/memory-strata/test/bench/e2e-answer.ts`
- Test: `packages/memory-strata/test/bench/__tests__/e2e-answer.test.ts`

**Interfaces:**
- Consumes: `snippet` on each `memory_search` result (Task 2).
- Produces: the snippet text appears in the `tool_result` handed to the answer model.

- [ ] **Step 1: Write the failing test.** In `packages/memory-strata/test/bench/__tests__/e2e-answer.test.ts`, add a case asserting the snippet reaches the model:

```ts
  it('includes the result snippet in the tool_result shown to the model', async () => {
    const search = vi.fn(async (): Promise<MemorySearchResult[]> => [
      { docId: 'decision/user', category: 'decision', slug: 'user',
        summary: "User's decisions", snippet: 'graduated with a B.A. in Business Administration', score: 1 },
    ]);
    const create = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'memory_search', input: { query: 'degree' } }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You graduated in Business Administration.' }],
        usage: { input_tokens: 150, output_tokens: 10 },
      });

    await runAnswerLoop({
      client: { messages: { create } }, model: 'm', maxToolTurns: 4,
      system: 'sys', question: 'What degree?', search, readSection: () => Promise.resolve({ body: '' }),
    });

    const toolResult = create.mock.calls[1]![0].messages.at(-1).content[0];
    expect(toolResult.content).toContain('Business Administration');
  });
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/e2e-answer.test.ts 2>&1 | tail -15`
Expected: FAIL — the formatted tool_result carries only the summary, not the snippet.

- [ ] **Step 3: Add `snippet` to `MemorySearchResult` and render it.** In `packages/memory-strata/test/bench/e2e-answer.ts`:

```ts
export interface MemorySearchResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  score: number;
}
```

and update `formatSearchResults`:

```ts
function formatSearchResults(rows: MemorySearchResult[]): string {
  if (rows.length === 0) return 'No matching memory documents found.';
  return rows
    .map((r, i) => `[${i + 1}] (${r.docId}) ${r.summary}\n    match: "${r.snippet}"`)
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `pnpm --filter @ax/memory-strata test -- test/bench/__tests__/e2e-answer.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Full gate + commit.**

```bash
pnpm build 2>&1 | tail -3
pnpm --filter @ax/memory-strata test 2>&1 | tail -5
pnpm exec eslint packages/memory-strata/test/bench/e2e-answer.ts packages/memory-strata/test/bench/__tests__/e2e-answer.test.ts
git add packages/memory-strata/test/bench/e2e-answer.ts packages/memory-strata/test/bench/__tests__/e2e-answer.test.ts
git commit -m "$(cat <<'EOF'
test(memory-strata): show the memory_search snippet to the e2e answer model

The bench answer client now renders each hit's body snippet in the tool_result,
so the e2e harness measures the false-refusal fix.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RvNQKujmpeGwGhuJcnqBSc
EOF
)"
```

---

## Validation (not a task — run after all three land)

Re-run the e2e harness on both retrieval paths and compare against the recorded baselines. Expect **false-refusal to drop** from BM25 61.7% / orchestrator 44.6% and end-to-end accuracy to rise from 27.0% / 37.8%.

```bash
set -a; source .env.walk; set +a
# BM25 (unset XAI to force BM25) and orchestrator (XAI present) — fresh resume ids
pnpm --filter @ax/memory-strata bench --mode e2e --sample 100 --cap 35 --resume e2e-snippet-bm25
pnpm --filter @ax/memory-strata bench --mode e2e --sample 100 --cap 35 --resume e2e-snippet-orch
```

Ingest is ~5h/run (background gets reaped here → run offline or chunk with the resume id). This validates the fix; it is not a merge gate.

## Self-Review

- **Spec coverage:** contract `snippet` (Task 1), sqlite `snippet()` (Task 1), postgres `ts_headline()` (Task 1), conformance case (Task 1 Step 1), retriever + executor threading + tool description (Task 2), bench `MemorySearchResult` + `formatSearchResults` (Task 3), TDD tests at each layer, boundary/security covered in the spec, validation via e2e re-run. All spec sections map to a task.
- **Placeholder scan:** none — every code step shows the code; the two `return-schemas.test.ts` edits name the exact field/assertion to add.
- **Type consistency:** `snippet: string` is identical across `SearchResult` (contract), `SearchResultRow` (both backends), both `SearchOutputSchema`s, `RetrievalResult`, the executor generic, and `MemorySearchResult`. FTS5 body column index is **6** (agent_key 0 … body 6). The `SearchOutputSchema` zod update (Task 1 Steps 5/9) is what prevents the field being stripped before the retriever sees it.
