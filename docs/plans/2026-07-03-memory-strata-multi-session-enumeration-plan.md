# memory-strata multi-session enumeration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Counting/aggregation questions over facts scattered across docs get the full instance set: dated fact lines, `matchedFacts` on every `memory_search` hit, enumeration coaching, and a near-dup doc guard.

**Architecture:** Facts gain date prefixes at promotion (doc-store formats, consolidator supplies `event_time`). `memory_search` results are enriched host-side with every matching fact line read from the doc body (tier-aware, same read path as `memory_read_section`) — no index/contract change. The orchestrator prompt and the bench answer loop are coached to enumerate. The consolidator stops minting near-duplicate docs via a token-subset slug guard. The e2e bench stops lying about session dates.

**Tech Stack:** TypeScript, pnpm workspace, Vitest. No new dependencies. Spec: `docs/plans/2026-07-03-memory-strata-multi-session-enumeration-design.md`.

## Global Constraints

- **TDD:** every code change is preceded by a failing test. Bug Fix Policy applies.
- **Pre-PR gate:** `pnpm build` + `pnpm --filter @ax/memory-strata test` + `pnpm exec eslint <changed files>` all green. (Known pre-existing local failures in `@ax/credential-proxy` and one `@ax/conversations` race test are NOT yours — see memory; CI arbitrates.)
- **Storage-agnostic naming:** the new field is `matchedFacts` — no FTS/tsquery vocab anywhere hook-facing. The `memory:index:search` contract and both index backends are UNTOUCHED by this plan.
- **Caps:** `matchedFacts` ≤ 20 lines per doc, ≤ 60 per response. Fact date prefix format is `(YYYY-MM-DD) ` exactly.
- **Enrichment is best-effort:** a doc-read failure during matchedFacts enrichment must never fail the tool call — log and return `matchedFacts: []` for that row.
- **Test scaffolding caveat:** test-code blocks below are templates — if a named test file already exists or sibling tests use different helpers (`makeWiredBus`, `asToolCall`, tmp-dir fixtures), follow the sibling conventions; the asserted behavior is what's mandated.
- **Commit trailer:** end every commit message with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```
- **Validation** (e2e before/after) is post-merge and offline (~5h/run) — NOT a merge gate. Do not run `bench --mode e2e`.

## File Structure

| File | Change |
|---|---|
| `packages/memory-strata/src/doc-store.ts` | export `formatFactLine` + `stripFactDate` |
| `packages/memory-strata/src/consolidator.ts` | date-tag facts at promotion; near-dup slug guard; date-stripped dedup |
| `packages/memory-strata/src/slug-guard.ts` | NEW — `findNearDupSlug` token-subset rule |
| `packages/memory-strata/src/doc-body.ts` | NEW — `readDocBody`/`extractDocBody` moved from memory-read-section |
| `packages/memory-strata/src/matched-facts.ts` | NEW — `extractMatchedFacts` line matcher |
| `packages/memory-strata/src/tools/memory-read-section.ts` | import moved `readDocBody` |
| `packages/memory-strata/src/tools/memory-search.ts` | enrich results with `matchedFacts`; descriptor text |
| `packages/memory-strata/src/orchestrator.ts` | enumeration coaching in SYSTEM; 8-op cap |
| `packages/memory-strata/src/plugin.ts` | `nowFn` config seam (3 call sites) |
| `packages/memory-strata/test/bench/e2e-answer.ts` | `matchedFacts` render; tool-turn budget 6; `questionDate`; bench tool description |
| `packages/memory-strata/test/bench/e2e-driver.ts` | session-fiction `nowFn`; pass `question_date` |

---

### Task 1: Dated fact lines (`formatFactLine`) + date-safe dedup

**Files:**
- Modify: `packages/memory-strata/src/doc-store.ts`
- Modify: `packages/memory-strata/src/consolidator.ts`
- Test: `packages/memory-strata/src/__tests__/doc-store.test.ts`, `packages/memory-strata/src/__tests__/consolidator.test.ts` (extend the existing files; create only if absent)

**Interfaces:**
- Produces: `formatFactLine(fact: string, isoTimestamp?: string | undefined): string` and `stripFactDate(line: string): string`, both exported from `doc-store.ts`. Fact lines in doc bodies may now start with `(YYYY-MM-DD) `.

- [ ] **Step 1: Write the failing tests** (doc-store test file):

```ts
import { formatFactLine, stripFactDate } from '../doc-store.js';

describe('formatFactLine', () => {
  it('prefixes a date-only tag from an ISO timestamp', () => {
    expect(formatFactLine('User visited The Art Cube.', '2026-02-15T18:30:00.000Z')).toBe(
      '(2026-02-15) User visited The Art Cube.',
    );
  });
  it('renders bare when no timestamp', () => {
    expect(formatFactLine('User visited The Art Cube.', undefined)).toBe(
      'User visited The Art Cube.',
    );
  });
  it('renders bare on a malformed timestamp', () => {
    expect(formatFactLine('fact', 'not-a-date')).toBe('fact');
  });
});

describe('stripFactDate', () => {
  it('strips a leading date tag', () => {
    expect(stripFactDate('(2026-02-15) User visited The Art Cube.')).toBe(
      'User visited The Art Cube.',
    );
  });
  it('leaves undated lines alone', () => {
    expect(stripFactDate('User visited The Art Cube.')).toBe('User visited The Art Cube.');
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @ax/memory-strata test -- src/__tests__/doc-store.test.ts 2>&1 | tail -10`
Expected: FAIL — `formatFactLine` is not exported.

- [ ] **Step 3: Implement in `doc-store.ts`** (below `appendFactToBody`):

```ts
const FACT_DATE_RE = /^\((\d{4}-\d{2}-\d{2})\)\s*/;

/**
 * Prefix a fact with its event date — `(YYYY-MM-DD) <fact>` — so counting /
 * time-scoped questions ("in February", "this year") are decidable from the
 * doc body. Undated / malformed timestamps render the bare fact (back-compat:
 * existing undated lines stay valid; no migration).
 */
export function formatFactLine(fact: string, isoTimestamp?: string | undefined): string {
  const day = isoTimestamp?.slice(0, 10);
  return day !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `(${day}) ${fact}` : fact;
}

/** Inverse of formatFactLine's prefix — used by dedup so a dated fact still
 * Jaccard-matches its undated restatement. */
export function stripFactDate(line: string): string {
  return line.replace(FACT_DATE_RE, '');
}
```

- [ ] **Step 4: Run to verify GREEN** (same command).

- [ ] **Step 5: Write the failing consolidator test** (extend consolidator test file; follow its existing tmp-workspace fixture pattern):

```ts
it('promotes facts with a date tag from the observation event_time, and dedups a dated fact against its undated restatement', async () => {
  // Arrange: one inbox observation with event_time, using the file's existing
  // seedInboxObservation/fixture helper; then a second observation restating
  // the same summary WITHOUT event_time.
  // (Adapt helper names to the file's conventions.)
  // Act: run consolidate() twice.
  // Assert 1: the promoted doc body contains `- (2026-02-15) <summary>`.
  // Assert 2: second pass reports dupesMerged: 1 and the doc still has ONE fact line.
});
```

The test must construct the first observation with `event_time: '2026-02-15T18:30:00.000Z'` in its frontmatter and assert the exact body line; write real assertions, not the comment sketch above.

- [ ] **Step 6: Run to verify RED** — the body line has no date prefix.

- [ ] **Step 7: Wire the consolidator.** In `consolidator.ts`:

Import: `import { appendFact, formatFactLine, mergeConversationIntoDoc, readDoc, stripFactDate, writeNewDoc } from './doc-store.js';` (extend the existing import).

At the `writeNewDoc` call, change `facts:`:

```ts
            facts: [
              formatFactLine(
                obs.frontmatter.summary ?? '',
                obs.frontmatter.event_time ?? obs.frontmatter.recorded_at,
              ),
            ],
```

At the `appendFact` call, change `newFact:`:

```ts
            newFact: formatFactLine(
              obs.frontmatter.summary ?? '',
              obs.frontmatter.event_time ?? obs.frontmatter.recorded_at,
            ),
```

Where `existingFacts` is built from the doc body (`extractFactsFromBody`), strip date tags so dedup compares fact text, not dates:

```ts
      const existingFacts = existing
        ? extractFactsFromBody(existing.body).map(stripFactDate)
        : [];
```

Also strip when accumulating this-pass facts if the file pushes formatted lines into `factsInDoc` — dedup must always compare undated text (check how `factsInDoc` is appended to after each promote and apply `stripFactDate` there too if needed).

- [ ] **Step 8: Run to verify GREEN**: `pnpm --filter @ax/memory-strata test -- src/__tests__/consolidator.test.ts src/__tests__/doc-store.test.ts 2>&1 | tail -10`

- [ ] **Step 9: Run the package suite** (`pnpm --filter @ax/memory-strata test 2>&1 | tail -5`) — fixtures asserting exact doc bodies elsewhere may need date-free observations (no `event_time`) or updated expectations; fix them to keep behavior-neutral.

- [ ] **Step 10: Commit**

```bash
git add packages/memory-strata/src/doc-store.ts packages/memory-strata/src/consolidator.ts packages/memory-strata/src/__tests__
git commit -m "$(cat <<'EOF'
feat(memory-strata): date-tag promoted facts from observation event_time

Inbox observations carry event_time/recorded_at but promotion dropped them,
leaving docs as undated fact lists — time-scoped counting questions were
undecidable. Facts now render as `- (YYYY-MM-DD) <fact>`; dedup strips the
tag so dated facts still match undated restatements.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Near-dup slug guard at promotion

**Files:**
- Create: `packages/memory-strata/src/slug-guard.ts`
- Modify: `packages/memory-strata/src/consolidator.ts`
- Test: `packages/memory-strata/src/__tests__/slug-guard.test.ts` (new), `packages/memory-strata/src/__tests__/consolidator.test.ts` (extend)

**Interfaces:**
- Produces: `findNearDupSlug(newSlug: string, existingSlugs: string[]): string | null` from `slug-guard.ts`.

- [ ] **Step 1: Write the failing unit test** (`slug-guard.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { findNearDupSlug } from '../slug-guard.js';

describe('findNearDupSlug', () => {
  it('matches a token-subset slug one token apart', () => {
    expect(findNearDupSlug('b-29-bomber-model', ['b-29-bomber-model-kit'])).toBe(
      'b-29-bomber-model-kit',
    );
    expect(findNearDupSlug('b-29-bomber-model-kit', ['b-29-bomber-model'])).toBe(
      'b-29-bomber-model',
    );
  });
  it('rejects short slugs (guard against catch-all merges)', () => {
    expect(findNearDupSlug('user', ['user-s-watch'])).toBeNull();
  });
  it('rejects slugs more than one token apart', () => {
    expect(findNearDupSlug('b-29-bomber', ['b-29-bomber-model-kit'])).toBeNull();
  });
  it('rejects non-subset overlaps', () => {
    expect(findNearDupSlug('tiger-i-diorama', ['tiger-ii-model-kit'])).toBeNull();
  });
  it('returns null with no candidates', () => {
    expect(findNearDupSlug('anything-at-all-here', [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify RED** (module doesn't exist).

- [ ] **Step 3: Implement `slug-guard.ts`:**

```ts
// Near-duplicate slug detection (multi-session enumeration design, D4). The
// autopsy found one instance minting several docs (`b-29-bomber-model`,
// `b-29-bomber-model-kit`, ...) which inflates enumeration counts ("how many
// projects" answered 9 vs gold 2). Rule is deliberately conservative:
// same-category callers only, both slugs ≥ 3 tokens, token-SUBSET relation,
// and at most ONE token of difference — `user` never merges into
// `user-s-watch`, but `b-29-bomber-model` folds into `b-29-bomber-model-kit`.

export function findNearDupSlug(newSlug: string, existingSlugs: string[]): string | null {
  const nt = tokens(newSlug);
  if (nt.length < 3) return null;
  for (const existing of existingSlugs) {
    if (existing === newSlug) continue;
    const et = tokens(existing);
    if (et.length < 3) continue;
    const [small, big] = nt.length <= et.length ? [nt, et] : [et, nt];
    if (big.length - small.length > 1) continue;
    const bigSet = new Set(big);
    if (small.every((t) => bigSet.has(t))) return existing;
  }
  return null;
}

function tokens(slug: string): string[] {
  return slug.split('-').filter((t) => t.length > 0);
}
```

- [ ] **Step 4: Run to verify GREEN.**

- [ ] **Step 5: Write the failing consolidator integration test** (extend consolidator test file, its fixture conventions): seed a doc `decision/b-29-bomber-model-kit` (via a first consolidate pass), then a NEW inbox observation whose subject slugifies to `b-29-bomber-model` in the SAME category. Run consolidate. Assert: no `decision/b-29-bomber-model.md` file exists, the existing doc gained the new fact line, and (if the file asserts logs) a `memory_strata_near_dup_slug_merged` warn fired.

- [ ] **Step 6: Run to verify RED** — a second doc is created today.

- [ ] **Step 7: Wire the guard in `consolidator.ts`.** Import `findNearDupSlug` from `./slug-guard.js`. Inside the per-cluster loop, BEFORE the `readDoc` call for the cluster, redirect the slug when a same-category near-dup doc already exists on disk or was created earlier this pass:

```ts
      // D4 (enumeration design): if a same-category doc already exists whose
      // slug is a token-subset near-dup of this cluster's (b-29-bomber-model
      // vs b-29-bomber-model-kit), append there instead of minting a sibling —
      // duplicate docs inflate enumeration counts.
      const slugsInCategory = await listCategorySlugs(input.workspaceRoot, cluster.category);
      const nearDup = findNearDupSlug(cluster.slug, slugsInCategory);
      if (nearDup !== null) {
        log.warn('memory_strata_near_dup_slug_merged', {
          category: cluster.category,
          newSlug: cluster.slug,
          mergedInto: nearDup,
        });
        cluster.slug = nearDup;
      }
```

Add the helper at module scope (near the other fs helpers in the file):

```ts
async function listCategorySlugs(workspaceRoot: string, category: DocCategory): Promise<string[]> {
  const dirAbs = join(workspaceRoot, categoryDir(category));
  try {
    const names = await fs.readdir(dirAbs);
    return names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -'.md'.length));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
```

Reuse the file's existing `fs`/`join`/`categoryDir` imports (add any that are missing: `categoryDir` comes from `./paths.js`). If `cluster.slug` is readonly on the cluster type, introduce `const slug = nearDup ?? cluster.slug;` and use `slug` for the rest of the loop body instead of mutating.

- [ ] **Step 8: Run to verify GREEN**, then the package suite.

- [ ] **Step 9: Commit**

```bash
git add packages/memory-strata/src/slug-guard.ts packages/memory-strata/src/consolidator.ts packages/memory-strata/src/__tests__
git commit -m "$(cat <<'EOF'
feat(memory-strata): fold near-duplicate slugs into the existing doc

Token-subset slugs one token apart (b-29-bomber-model vs
b-29-bomber-model-kit) minted sibling docs, inflating enumeration counts.
Same-category clusters now append to the existing near-dup doc, logged as
memory_strata_near_dup_slug_merged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `matchedFacts` on memory_search results

**Files:**
- Create: `packages/memory-strata/src/doc-body.ts` (move `readDocBody`/`extractDocBody` from memory-read-section)
- Create: `packages/memory-strata/src/matched-facts.ts`
- Modify: `packages/memory-strata/src/tools/memory-read-section.ts` (import the moved helpers)
- Modify: `packages/memory-strata/src/tools/memory-search.ts`
- Test: `packages/memory-strata/src/__tests__/matched-facts.test.ts` (new), `packages/memory-strata/src/__tests__/tools-memory-search.test.ts` (extend)

**Interfaces:**
- Consumes: `readDocBody(bus, ctx, category, slug): Promise<string | null>` (tier-aware read, moved verbatim).
- Produces: `extractMatchedFacts(body: string, query: string, opts?: { maxLines?: number }): string[]`; every `tool:execute:memory_search` result row gains `matchedFacts: string[]`.

- [ ] **Step 1: Write the failing matcher test** (`matched-facts.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { extractMatchedFacts } from '../matched-facts.js';

const BODY = [
  '# Doc',
  '',
  '## Facts',
  '- (2026-02-01) User attended the Austin Film Festival 48-hour challenge.',
  '- User is researching fish stocking levels for a 55-gallon tank.',
  '- (2026-03-10) User volunteered at the Portland Film Festival.',
  '- User enjoyed films like Parasite.',
  '',
].join('\n');

describe('extractMatchedFacts', () => {
  it('returns every fact line matching any query token', () => {
    expect(extractMatchedFacts(BODY, 'film festivals attended')).toEqual([
      '(2026-02-01) User attended the Austin Film Festival 48-hour challenge.',
      '(2026-03-10) User volunteered at the Portland Film Festival.',
      'User enjoyed films like Parasite.',
    ]);
  });
  it('prefix-stems: festival matches festivals and vice versa', () => {
    expect(extractMatchedFacts(BODY, 'festival')).toHaveLength(2);
  });
  it('drops stopword-only queries', () => {
    expect(extractMatchedFacts(BODY, 'how many did I')).toEqual([]);
  });
  it('caps output at maxLines', () => {
    expect(extractMatchedFacts(BODY, 'user', { maxLines: 2 })).toHaveLength(2);
  });
  it('returns [] for a body with no fact lines', () => {
    expect(extractMatchedFacts('# Doc\n\nprose only\n', 'festival')).toEqual([]);
  });
});
```

Note the third expectation in the first test: `films` matches the query token `film` by prefix — the assertion list must include it.

- [ ] **Step 2: RED** (module missing).

- [ ] **Step 3: Implement `matched-facts.ts`:**

```ts
// Host-side fact-line matching for memory_search enrichment (enumeration
// design, D2). Term-match is deliberately naive — lowercase tokens, mutual
// prefix stemming — because it runs over the agent's OWN doc bodies as plain
// strings; no query text ever reaches a search engine on this path. The
// class-semantics gap ("citrus" won't match "lime") is handled by retrieval
// coaching (D3), not here.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'my', 'i', 'me', 'did', 'do', 'does', 'how', 'many', 'much', 'what', 'when',
  'which', 'who', 'have', 'has', 'had', 'was', 'were', 'is', 'are', 'user',
]);

const DEFAULT_MAX_LINES = 20;

export function extractMatchedFacts(
  body: string,
  query: string,
  opts?: { maxLines?: number },
): string[] {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  if (maxLines <= 0) return [];
  const qTokens = tokenize(query).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (qTokens.length === 0) return [];

  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const words = tokenize(line);
    const hit = qTokens.some((q) =>
      words.some((w) => (w.length >= 3 && q.startsWith(w)) || w.startsWith(q)),
    );
    if (!hit) continue;
    out.push(line.slice(2));
    if (out.length >= maxLines) break;
  }
  return out;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}
```

- [ ] **Step 4: GREEN** on the matcher test.

- [ ] **Step 5: Move the doc-body read helpers.** Create `src/doc-body.ts` containing `readDocBody` and `extractDocBody` MOVED VERBATIM from `tools/memory-read-section.ts` (both functions, their doc comments, and their imports: `posix`, `AGENT_TIER_MEMORY_ROOT`/`agentTierAvailable`, `readDoc`, `docFile`/`DocCategory`, the `WorkspaceReadInput/Output` types). Export both. In `memory-read-section.ts`, delete the local copies and `import { readDocBody } from '../doc-body.js';`. Run `pnpm --filter @ax/memory-strata test 2>&1 | tail -5` — pure move, everything stays green.

- [ ] **Step 6: Write the failing executor test** (extend `tools-memory-search.test.ts`, reusing its `makeWiredBus`-style helpers and tmp-workspace fixtures): write a real doc via `writeNewDoc` (workspace fixture) with three fact lines, two of which mention weddings; stub `memory:index:search` to return that docId; call `tool:execute:memory_search` with query `weddings attended`; assert the result row carries `matchedFacts` with exactly the two wedding lines. Add a second case: doc file missing on disk → `matchedFacts: []` and the call still succeeds.

- [ ] **Step 7: RED** — rows carry no `matchedFacts`.

- [ ] **Step 8: Enrich in `memory-search.ts`.** Imports:

```ts
import { readDocBody } from '../doc-body.js';
import { extractMatchedFacts } from '../matched-facts.js';
import { parseDocId } from '../doc-id.js';
```

Extend the executor result generic with `matchedFacts: string[]`, and add before `registerMemorySearch`'s executor returns:

```ts
const MAX_FACTS_PER_DOC = 20;
const MAX_FACTS_PER_RESPONSE = 60;

/** D2 (enumeration design): attach every query-matching fact line from each
 * hit's body. Best-effort — a read failure yields [] for that row, never a
 * failed tool call. Applies to orchestrator `<load>` rows too (their doc
 * bodies never touched the index). */
async function withMatchedFacts<
  R extends { docId: string },
>(bus: HookBus, ctx: AgentContext, rows: R[], query: string): Promise<Array<R & { matchedFacts: string[] }>> {
  const out: Array<R & { matchedFacts: string[] }> = [];
  let total = 0;
  for (const row of rows) {
    let matchedFacts: string[] = [];
    if (total < MAX_FACTS_PER_RESPONSE && query.length > 0) {
      try {
        const parsed = parseDocId(row.docId);
        const body = parsed === null
          ? null
          : await readDocBody(bus, ctx, parsed.category, parsed.slug);
        if (body !== null) {
          matchedFacts = extractMatchedFacts(body, query, {
            maxLines: Math.min(MAX_FACTS_PER_DOC, MAX_FACTS_PER_RESPONSE - total),
          });
          total += matchedFacts.length;
        }
      } catch (err) {
        ctx.logger.warn('memory_strata_matched_facts_failed', {
          err: err instanceof Error ? err : new Error(String(err)),
          docId: row.docId,
        });
      }
    }
    out.push({ ...row, matchedFacts });
  }
  return out;
}
```

(`AgentContext` comes from `@ax/core` — extend the existing type-only import.) Route BOTH return paths through it:

```ts
          if (orchestrated !== null) {
            return { results: await withMatchedFacts(bus, ctx, orchestrated, query) };
          }
```

```ts
      const results = await retrieve(bus, ctx, {
        query,
        topK,
        ...(categoryFilter !== undefined ? { categoryFilter } : {}),
      });
      return { results: await withMatchedFacts(bus, ctx, results, query) };
```

Update `MEMORY_SEARCH_DESCRIPTOR.description` to:

```ts
  description:
    'Search long-term memory. Each hit carries a one-line summary, a `snippet` ' +
    '(match-centered body excerpt), and `matchedFacts` — EVERY fact line in that ' +
    'doc matching your query, with dates like (2026-02-15) when known. For ' +
    'counting/enumeration questions ("how many X"), read matchedFacts across ALL ' +
    'hits, then run 1-2 more searches with instance-specific terms (e.g. for ' +
    '"citrus" also try "lime", "lemon") before concluding. Use memory_read_section ' +
    'to read a whole doc when matchedFacts looks truncated.',
```

- [ ] **Step 9: GREEN** on the executor test, then the package suite.

- [ ] **Step 10: Commit**

```bash
git add packages/memory-strata/src/doc-body.ts packages/memory-strata/src/matched-facts.ts packages/memory-strata/src/tools packages/memory-strata/src/__tests__
git commit -m "$(cat <<'EOF'
feat(memory-strata): return every matching fact line from memory_search

Counting questions failed because instances are scattered across docs and a
single 48-token snippet shows one match. Each hit now carries matchedFacts —
every query-matching fact line from the doc body, read tier-aware host-side
(no index/contract change), capped 20/doc and 60/response. Orchestrator
<load> rows are enriched too, closing their empty-snippet gap.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Enumeration coaching (orchestrator prompt, op cap, bench answer loop)

**Files:**
- Modify: `packages/memory-strata/src/orchestrator.ts`
- Modify: `packages/memory-strata/test/bench/e2e-answer.ts`
- Test: `packages/memory-strata/src/__tests__/orchestrator.test.ts` (extend), `packages/memory-strata/test/bench/__tests__/e2e-answer.test.ts` (extend)

**Interfaces:**
- Produces: `parseOrchestratorPlan` caps ops at 8 (`MAX_OPS` exported for tests); bench `MemorySearchResult` gains `matchedFacts: string[]`; `DEFAULT_MAX_TOOL_TURNS` becomes 6.

- [ ] **Step 1: Write the failing op-cap test** (extend orchestrator test file):

```ts
it('caps a runaway plan at 8 ops', () => {
  const text = Array.from({ length: 12 }, (_, i) => `<fts query="probe ${i}"/>`).join('\n');
  const plan = parseOrchestratorPlan(text);
  expect(plan.ops).toHaveLength(8);
  expect(plan.ops[0]).toEqual({ kind: 'fts', query: 'probe 0' });
});
```

- [ ] **Step 2: RED** (12 ops today).

- [ ] **Step 3: Implement.** In `orchestrator.ts` add `export const MAX_OPS = 8;` above `parseOrchestratorPlan`, and end that function with:

```ts
  return { ops: ops.slice(0, MAX_OPS), followupNeeded: FOLLOWUP_RE.test(stripped) };
```

Replace the SYSTEM prompt's `Rules:` block with:

```
Rules:
- Emit between 1 and 8 ops total. Prefer the smallest precise set.
- For counting or aggregation queries ("how many X", "sum of Y", "list all Z"),
  instances are usually SCATTERED across several docs: load EVERY plausibly
  relevant doc and add 1-3 <fts> probes with instance-level terms (for
  "citrus fruits" also probe "lime", "lemon", "orange"; for "doctors" probe
  "appointment", "specialist").
- doc ids must exactly match entries in the map (e.g. "preference/coffee").
- Do not output prose, code fences, or explanations. Only the XML ops.
```

(The `<fts ...>` tag description above the Rules block loses its "max 1-2 of these per query" parenthetical — enumeration probes are now legitimate.)

- [ ] **Step 4: GREEN**, plus the file's existing prompt-shape tests if any assert the old text (update them).

- [ ] **Step 5: Write the failing bench render test** (extend `e2e-answer.test.ts`): a `MemorySearchResult` with `matchedFacts: ['(2026-02-01) went to Austin Film Festival', 'volunteered at Portland Film Festival']` must render both lines in the tool_result content handed to the model (drive `runAnswerLoop` like the existing snippet test does); a row with `matchedFacts: []` renders no `facts:` block.

- [ ] **Step 6: RED** (type error / missing lines).

- [ ] **Step 7: Implement in `e2e-answer.ts`:**

Add to the interface:

```ts
export interface MemorySearchResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  matchedFacts: string[];
  score: number;
}
```

Update `formatSearchResults`:

```ts
function formatSearchResults(rows: MemorySearchResult[]): string {
  if (rows.length === 0) return 'No matching memory documents found.';
  return rows
    .map((r, i) => {
      let entry = `[${i + 1}] (${r.docId}) ${r.summary}`;
      // Orchestrator-mode map-<load> rows carry snippet: '' — rendering
      // `match: ""` would read as "this doc matched nothing", so omit the line.
      if (r.snippet.trim() !== '') entry += `\n    match: "${r.snippet}"`;
      if (r.matchedFacts.length > 0) {
        entry += `\n    facts:\n${r.matchedFacts.map((f) => `      - ${f}`).join('\n')}`;
      }
      return entry;
    })
    .join('\n');
}
```

Change `DEFAULT_MAX_TOOL_TURNS` from 4 to 6 (same file, near the top), and extend the bench-side `MEMORY_SEARCH_TOOL` (`Anthropic.Tool`) description with one sentence: `'For counting questions, read the facts lists across ALL hits and run follow-up searches with instance-specific terms before concluding.'` Fix any pre-existing `MemorySearchResult` literals in the bench tests missing the new required field (add `matchedFacts: []`).

- [ ] **Step 8: GREEN**, then the package suite.

- [ ] **Step 9: Commit**

```bash
git add packages/memory-strata/src/orchestrator.ts packages/memory-strata/src/__tests__ packages/memory-strata/test/bench
git commit -m "$(cat <<'EOF'
feat(memory-strata): coach retrieval and the bench answer loop to enumerate

The orchestrator prompt now tells the planner that counting-query instances
are scattered (load every plausible doc + instance-term fts probes), with a
defensive 8-op cap. The bench renders matchedFacts under each hit and gets
6 tool turns.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Bench temporal fidelity (`nowFn` seam + haystack_dates + question_date)

**Files:**
- Modify: `packages/memory-strata/src/plugin.ts`
- Modify: `packages/memory-strata/test/bench/e2e-driver.ts`
- Modify: `packages/memory-strata/test/bench/e2e-answer.ts`
- Test: `packages/memory-strata/src/__tests__/plugin.test.ts` (extend), `packages/memory-strata/test/bench/__tests__/e2e-driver.test.ts` (extend; create only if absent)

**Interfaces:**
- Produces: `MemoryStrataConfig.nowFn?: () => Date`; `runE2EQuestion` threads `haystack_dates[i]` into ingestion time and `question_date` into the answer system prompt; `answerClient.answer` accepts `questionDate?: string`.

- [ ] **Step 1: Write the failing plugin test** (extend `plugin.test.ts`, following its wiring fixtures): construct the plugin with `nowFn: () => new Date('2023-05-20T00:00:00.000Z')`, drive one `chat:end` → observer → consolidation (the file has this pattern), and assert the promoted doc's frontmatter `created` is `2023-05-20T00:00:00.000Z` and the fact line starts with `(2023-05-20)` (the observer stamps `event_time` from its `now`).

- [ ] **Step 2: RED** — created is wall-clock.

- [ ] **Step 3: Implement the seam.** In `plugin.ts`, add to `MemoryStrataConfig`:

```ts
  /**
   * Time source for observer stamps and consolidation passes. Bench-only
   * seam (e2e temporal fidelity — the harness replays sessions whose fiction
   * happened on corpus dates, not today). Production omits it: real time.
   */
  nowFn?: () => Date;
```

Inside `createMemoryStrataPlugin`, near the other cfg unpacking: `const nowFn = cfg.nowFn ?? (() => new Date());` — then replace all three `now: new Date(),` call sites (the `runObserver` call and both `consolidate` calls) with `now: nowFn(),`.

- [ ] **Step 4: GREEN**, then package suite.

- [ ] **Step 5: Write the failing driver test** (extend/create the driver test with the file's stub conventions — stub extraction LLM and answer client, no network): a sample with `haystack_dates: ['2023/05/20 (Sat) 02:21']` must produce an observer `now` of 2023-05-20 (assert via the promoted doc / a captured `nowFn` seam), and `question_date: '2023-06-01'` must appear in the answer client's received system prompt as `Today's date: 2023-06-01`.

- [ ] **Step 6: RED.**

- [ ] **Step 7: Implement in the bench.** In `e2e-driver.ts`:

```ts
/** Parse a LongMemEval haystack/question date ("2023/05/20 (Sat) 02:21") to a
 * Date, or null when absent/malformed — null falls back to wall-clock. */
export function parseCorpusDate(raw: string | undefined): Date | null {
  if (raw === undefined) return null;
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(raw.trim());
  if (m === null) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
```

In `runE2EQuestion`: hold `let fictionNow: Date | null = null;` and pass the seam to the plugin:

```ts
  const strata = createMemoryStrataPlugin({
    consolidatorDebounceMs: 0,
    nowFn: () => fictionNow ?? new Date(),
    ...
```

In the ingest loop, set it per session (the loop needs the index — switch `for (const session of ...)` to `for (const [i, session] of sample.haystack_sessions.entries())`):

```ts
      fictionNow = parseCorpusDate(sample.haystack_dates?.[i]);
```

And pass the question date to the answer call:

```ts
    const answer = await answerClient.answer({
      injectedMemory,
      question: sample.question,
      ...(sample.question_date !== undefined ? { questionDate: sample.question_date } : {}),
      search,
      readSection,
    });
```

In `e2e-answer.ts`, extend the `answer` signature (`questionDate?: string`) and the system assembly:

```ts
    async answer({ injectedMemory, question, questionDate, search, readSection }) {
      let system = injectedMemory.trim().length > 0
        ? `${SYSTEM_PREAMBLE}\n\n# Injected memory\n${injectedMemory}`
        : SYSTEM_PREAMBLE;
      if (questionDate !== undefined && questionDate.trim().length > 0) {
        system += `\n\nToday's date: ${questionDate.trim()}`;
      }
      return runAnswerLoop({ client, model, maxToolTurns, system, question, search, readSection });
    },
```

(Also add `questionDate?: string` to the `E2EAnswerClient` interface's `answer` args type in the same file.)

- [ ] **Step 8: GREEN**, then package suite.

- [ ] **Step 9: Commit**

```bash
git add packages/memory-strata/src/plugin.ts packages/memory-strata/src/__tests__ packages/memory-strata/test/bench
git commit -m "$(cat <<'EOF'
feat(memory-strata): bench temporal fidelity via a nowFn config seam

The e2e harness ingested corpus sessions at wall-clock time, so fact dates
and "this year"/"in February" questions were fiction-vs-reality mismatches.
The plugin gains a nowFn seam (production unchanged); the driver feeds
haystack_dates per session and hands question_date to the answer prompt.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Enumeration canary (cross-doc instances surface in one search)

**Files:**
- Test: `packages/memory-strata/src/__tests__/enumeration-canary.test.ts` (new)

**Interfaces:**
- Consumes: `writeNewDoc` (Task 1's dated facts), `registerMemorySearch` + `withMatchedFacts` behavior (Task 3).

- [ ] **Step 1: Write the canary** (this is a regression net, not TDD — the behavior exists after Tasks 1+3; it must pass immediately):

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext } from '@ax/core';
import { writeNewDoc } from '../doc-store.js';
import { registerMemorySearch } from '../tools/memory-search.js';

// The multi-session e2e failure mode: instances of one class scattered across
// docs. One memory_search must surface ALL of them via matchedFacts.
describe('enumeration canary', () => {
  it('surfaces every scattered instance in matchedFacts across hits', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'enum-canary-'));
    const now = new Date('2026-01-10T00:00:00.000Z');
    const docs = [
      { slug: 'emily-and-sarah', fact: '(2026-01-05) User attended Emily and Sarah\'s wedding.' },
      { slug: 'jen-and-tom', fact: '(2026-03-02) User attended Jen and Tom\'s barn wedding.' },
      { slug: 'rachel-and-mike', fact: '(2026-06-20) User attended Rachel and Mike\'s beach wedding.' },
    ];
    for (const d of docs) {
      await writeNewDoc({
        workspaceRoot, category: 'episode', slug: d.slug, summary: 'a wedding',
        subject: d.slug, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['obs-1'], now, facts: [d.fact],
      });
    }
    const bus = new HookBus();
    bus.registerService('tool:register', 'canary', async () => ({ ok: true as const }));
    bus.registerService('memory:index:search', 'canary-index', async () => ({
      results: docs.map((d, i) => ({
        docId: `episode/${d.slug}`, category: 'episode', slug: d.slug,
        summary: 'a wedding', snippet: '', score: 1 - i * 0.1,
      })),
    }));
    await registerMemorySearch(bus);
    const ctx = makeAgentContext({
      sessionId: 's', agentId: 'a', userId: 'u',
      workspace: { rootPath: workspaceRoot },
    });
    const out = (await bus.call('tool:execute:memory_search', ctx, {
      input: { query: 'weddings attended', topK: 5 },
    })) as { results: Array<{ matchedFacts: string[] }> };
    const allFacts = out.results.flatMap((r) => r.matchedFacts);
    expect(allFacts.some((f) => f.includes('Emily'))).toBe(true);
    expect(allFacts.some((f) => f.includes('Jen'))).toBe(true);
    expect(allFacts.some((f) => f.includes('Rachel'))).toBe(true);
  });
});
```

Adapt scaffolding (bus helpers, `makeAgentContext` shape, index-stub registration signature) to what `tools-memory-search.test.ts` actually uses.

- [ ] **Step 2: Run it — must PASS.** If it fails, a Task 1/3 behavior is broken; fix there, not in the canary.

- [ ] **Step 3: Full gate.**

```bash
pnpm build 2>&1 | tail -3
pnpm --filter @ax/memory-strata test 2>&1 | tail -5
git diff --name-only origin/main..HEAD | grep -E '\.(ts|tsx)$' | xargs pnpm exec eslint
```

- [ ] **Step 4: Commit**

```bash
git add packages/memory-strata/src/__tests__/enumeration-canary.test.ts
git commit -m "$(cat <<'EOF'
test(memory-strata): enumeration canary — scattered instances all surface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Validation (not a task — post-merge, offline)

```bash
set -a; source .env.walk; set +a
pnpm --filter @ax/memory-strata bench --mode e2e --sample 100 --cap 35 --resume e2e-enum-bm25   # XAI unset
pnpm --filter @ax/memory-strata bench --mode e2e --sample 100 --cap 35 --resume e2e-enum-orch   # XAI set
```

Baselines (2026-07-02, post-snippet): orch 73.0% overall / 46.7% multi-session; BM25 70.0% / 50.0%. Gate: multi-session ≥ 65%, overall ≥ baseline −1pt, correct-refusal ≥ 83%. Copy the date-named report aside between runs (it's overwritten per-day).

## Self-Review

- **Spec coverage:** D1 → Task 1; D4 → Task 2; D2 → Task 3; D3 → Task 4; D5 → Task 5; testing §6 canary → Task 6. Boundary/security notes live in the design doc.
- **Placeholder scan:** Task 1 Step 5 and Tasks 4-6 name exact assertions but delegate scaffolding to sibling conventions per the Global Constraints caveat — deliberate, not a gap.
- **Type consistency:** `matchedFacts: string[]` identical across the executor generic, `withMatchedFacts`, bench `MemorySearchResult`, and the canary. `formatFactLine`/`stripFactDate` names match between Tasks 1 and 3 (matcher operates on raw lines and needs no stripping). `nowFn` name matches plugin config and driver usage.
