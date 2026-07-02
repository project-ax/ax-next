import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createTestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createMemoryStrataIndexPostgresPlugin } from '../plugin.js';
import type { UpsertInput, SearchInput, SearchOutput } from '@ax/memory-strata-index-contract';

let container: StartedPostgreSqlContainer;
let connectionString: string;
// Admin Kysely for DDL (reset between tests).
let adminDb: Kysely<unknown>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
  adminDb = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  });
}, 120_000);

// Single afterAll, explicit ordering: drain every per-test harness pool
// FIRST, then the admin pool, THEN stop the container. Splitting these
// across two afterAll blocks was a flake source on CI — when the
// container stops, any still-open pool client emits a FATAL 57P01
// (admin_shutdown) which @ax/database-postgres's `pool.on('error')`
// handler logs as `database_postgres_pool_error`. The log itself is
// fine, but vitest 4 treats the uncaught upstream exception as an
// "Unhandled Error" and fails the run even though all 16 tests passed.
// One-shot teardown removes the race.
afterAll(async () => {
  while (openedDbs.length > 0) {
    const k = openedDbs.pop()!;
    await k.destroy().catch(() => {});
  }
  await adminDb?.destroy().catch(() => {});
  await stopPostgresContainer(container);
});

// ---------------------------------------------------------------------------
// Build a harness (both plugins). Captures opened Kysely instances so we
// can drain pools between tests.
// ---------------------------------------------------------------------------

const openedDbs: Kysely<unknown>[] = [];

async function makeHarness() {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createMemoryStrataIndexPostgresPlugin(),
    ],
  });
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  openedDbs.push(db);

  async function upsert(input: UpsertInput): Promise<void> {
    await h.bus.call<UpsertInput, void>('memory:index:upsert', h.ctx(), input);
  }

  async function search(input: SearchInput): Promise<SearchOutput> {
    return h.bus.call<SearchInput, SearchOutput>('memory:index:search', h.ctx(), input);
  }

  return { h, upsert, search };
}

beforeEach(async () => {
  // Truncate between tests so each starts with an empty index.
  try {
    await sql`TRUNCATE memory_strata_index_v2_docs`.execute(adminDb);
  } catch {
    // Table doesn't exist yet on the very first test — migration will create it.
  }
});


// ---------------------------------------------------------------------------
// Test 1: tsvector weight A (summary) ranks higher than weight C (body)
// ---------------------------------------------------------------------------
describe('@ax/memory-strata-index-postgres — postgres-specific', () => {
  it('summary match (weight A) ranks higher than body match (weight C)', async () => {
    const { upsert, search } = await makeHarness();
    const TERM = 'polarfox_test_term';

    // Doc A: term in summary only (weight A)
    await upsert({
      docId: 'test/summary-hit',
      category: 'test',
      slug: 'summary-hit',
      summary: `Contains ${TERM} in the summary`,
      factType: 'test',
      body: 'No matching term here.',
      headers: '',
    });

    // Doc B: term in body only (weight C)
    await upsert({
      docId: 'test/body-hit',
      category: 'test',
      slug: 'body-hit',
      summary: 'No matching term in summary',
      factType: 'test',
      body: `This body mentions ${TERM} once.`,
      headers: '',
    });

    const out = await search({ query: TERM, topK: 5 });
    expect(out.results).toHaveLength(2);
    const summaryIdx = out.results.findIndex((r) => r.docId === 'test/summary-hit');
    const bodyIdx = out.results.findIndex((r) => r.docId === 'test/body-hit');
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    // summary weight A must rank >= body weight C
    expect(out.results[summaryIdx]!.score).toBeGreaterThanOrEqual(
      out.results[bodyIdx]!.score,
    );
    // With Postgres tsvector weighting, summary should strictly rank HIGHER than body.
    expect(out.results[summaryIdx]!.score).toBeGreaterThan(out.results[bodyIdx]!.score);
  });

  // -------------------------------------------------------------------------
  // Test 2: Special characters in content don't crash upsert or search
  // -------------------------------------------------------------------------
  it('handles apostrophes, parentheses, and quotes in body', async () => {
    const { upsert, search } = await makeHarness();

    await upsert({
      docId: 'general/special-chars',
      category: 'general',
      slug: 'special-chars',
      summary: "It's a test with 'apostrophes' and (parentheses)",
      factType: 'general',
      body: 'He said "hello" to O\'Brien\'s team (the backend folks).',
      headers: '',
    });

    // Should not throw on upsert — parameterized plainto_tsquery is safe.
    const out = await search({ query: 'hello', topK: 5 });
    expect(out.results.length).toBeGreaterThanOrEqual(1);
    expect(out.results[0]!.docId).toBe('general/special-chars');
  });

  // -------------------------------------------------------------------------
  // Test 3: Idempotent upsert (ON CONFLICT) leaves exactly one row
  // -------------------------------------------------------------------------
  it('idempotent upsert: same docId 5 times leaves exactly 1 row', async () => {
    const { upsert, search } = await makeHarness();

    for (let i = 1; i <= 5; i++) {
      await upsert({
        docId: 'preference/iterative',
        category: 'preference',
        slug: 'iterative',
        summary: `Version ${i} of the summary`,
        factType: 'preference',
        body: 'Iterative body content.',
        headers: '',
      });
    }

    // Verify via search that there's exactly 1 result
    const out = await search({ query: 'iterative', topK: 10 });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.summary).toBe('Version 5 of the summary');

    // Also verify at the SQL level: exactly 1 row with this doc_id
    const countResult = await sql<{ cnt: string }>`
      SELECT count(*) AS cnt FROM memory_strata_index_v2_docs
      WHERE doc_id = 'preference/iterative'
    `.execute(adminDb);
    expect(Number(countResult.rows[0]!.cnt)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: Empty query returns [] without touching postgres
  // -------------------------------------------------------------------------
  it('empty query returns [] without throwing', async () => {
    const { upsert, search } = await makeHarness();

    await upsert({
      docId: 'general/misc',
      category: 'general',
      slug: 'misc',
      summary: 'Miscellaneous note',
      factType: 'general',
      body: 'Some general information.',
      headers: '',
    });

    const out = await search({ query: '', topK: 5 });
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 5: categoryFilter combines with full-text predicate
  // -------------------------------------------------------------------------
  it('categoryFilter combines correctly with full-text predicate', async () => {
    const { upsert, search } = await makeHarness();

    await upsert({
      docId: 'preference/database',
      category: 'preference',
      slug: 'database',
      summary: 'Prefer PostgreSQL as the primary database',
      factType: 'preference',
      body: 'The team prefers PostgreSQL.',
      headers: '',
    });
    await upsert({
      docId: 'decision/database',
      category: 'decision',
      slug: 'database',
      summary: 'Decided to use PostgreSQL as the primary database',
      factType: 'decision',
      body: 'PostgreSQL was chosen for production.',
      headers: '',
    });

    const out = await search({
      query: 'PostgreSQL',
      topK: 10,
      categoryFilter: 'preference',
    });
    const docIds = out.results.map((r) => r.docId);
    expect(docIds).toContain('preference/database');
    expect(docIds).not.toContain('decision/database');
  });

  // -------------------------------------------------------------------------
  // Test 5b: a literal <b> in the body does not leak highlight markers
  // -------------------------------------------------------------------------
  // With empty StartSel/StopSel, ts_headline emits no <b>…</b> around matches,
  // so the mapper needs no strip-regex. A literal <b> in the body is itself
  // dropped by ts_headline (the default parser classifies <...> as a `tag`
  // token and windowed output omits it) — the opposite of the sqlite backend,
  // which returns it verbatim. Either way, the snippet must carry the
  // surrounding body words and NO `<b>`/`</b>` (neither a highlight artifact
  // nor a re-introduced literal). Regression guard for the strip-regex removal.
  it('snippet carries no <b>/</b> markers even when the body contains a literal <b>', async () => {
    const { upsert, search } = await makeHarness();

    await upsert({
      docId: 'general/literal-tag',
      category: 'general',
      slug: 'literal-tag',
      summary: 'No special value in summary',
      factType: 'general',
      body: 'The user graduated and here is a literal <b> tag inside the body text.',
      headers: '',
    });

    const out = await search({ query: 'graduated', topK: 5 });
    expect(out.results).toHaveLength(1);
    const snippet = out.results[0]!.snippet;
    // Surrounding words are preserved.
    expect(snippet).toContain('graduated');
    expect(snippet).toContain('tag');
    // No highlight markers leak (empty selectors) and the literal <b> is not
    // present as a raw substring.
    expect(snippet).not.toContain('<b>');
    expect(snippet).not.toContain('</b>');
  });

  // -------------------------------------------------------------------------
  // Test 5c: scattered matches in a long body are joined by the '…' delimiter
  // -------------------------------------------------------------------------
  // Truncation-marker parity with the sqlite backend (whose snippet() carries
  // '…'). ts_headline emits FragmentDelimiter only BETWEEN fragments, so a doc
  // with two disjoint match regions returns two windows joined by '…'.
  it("snippet joins disjoint match windows with '…' (FragmentDelimiter parity)", async () => {
    const { upsert, search } = await makeHarness();

    await upsert({
      docId: 'decision/scattered',
      category: 'decision',
      slug: 'scattered',
      summary: 'Scattered matches',
      factType: 'decision',
      body:
        'The user graduated early on then a very long stretch of filler words ' +
        'aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt uu vv ww xx yy zz ' +
        'aa2 bb2 cc2 dd2 ee2 ff2 gg2 hh2 ii2 jj2 finally the closing remarks appear at the end.',
      headers: '',
    });

    const out = await search({ query: 'graduated closing', topK: 5 });
    expect(out.results).toHaveLength(1);
    const snippet = out.results[0]!.snippet;
    expect(snippet).toContain('…');
    // Both match regions surface across the two joined fragments.
    expect(snippet).toContain('graduated');
    expect(snippet).toContain('closing');
  });

  // -------------------------------------------------------------------------
  // Test 5d: a quote-only query token is safe (never throws)
  // -------------------------------------------------------------------------
  // buildOrTsQuery turns `"` into `" "` (a quoted space). websearch_to_tsquery
  // treats that as an empty/stop-word query (a NOTICE, never an error) that
  // matches nothing — so search returns [] rather than throwing.
  it('a quote-only query token returns [] without throwing', async () => {
    const { upsert, search } = await makeHarness();

    await upsert({
      docId: 'general/quote-token',
      category: 'general',
      slug: 'quote-token',
      summary: 'Some note',
      factType: 'general',
      body: 'A body with the word graduated in it.',
      headers: '',
    });

    const out = await search({ query: '"', topK: 5 });
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: Manifest registers all four hooks and calls database:get-instance
  // -------------------------------------------------------------------------
  it('manifest declares correct registers and calls', () => {
    const plugin = createMemoryStrataIndexPostgresPlugin();
    expect(plugin.manifest.name).toBe('@ax/memory-strata-index-postgres');
    expect(plugin.manifest.registers).toContain('memory:index:upsert');
    expect(plugin.manifest.registers).toContain('memory:index:search');
    expect(plugin.manifest.registers).toContain('memory:index:delete');
    expect(plugin.manifest.registers).toContain('memory:index:clear');
    expect(plugin.manifest.calls).toContain('database:get-instance');
  });
});
