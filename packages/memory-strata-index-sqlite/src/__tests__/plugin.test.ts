import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestHarness } from '@ax/test-harness';
import { createMemoryStrataIndexSqlitePlugin } from '../plugin.js';
import { escapeFts5Query } from '../queries.js';
import type { UpsertInput, SearchInput, SearchOutput } from '@ax/memory-strata-index-contract';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function makeHarness(databasePath: string) {
  const h = await createTestHarness({
    plugins: [createMemoryStrataIndexSqlitePlugin({ databasePath })],
  });

  async function upsert(input: UpsertInput): Promise<void> {
    await h.bus.call<UpsertInput, void>('memory:index:upsert', h.ctx(), input);
  }

  async function search(input: SearchInput): Promise<SearchOutput> {
    return h.bus.call<SearchInput, SearchOutput>('memory:index:search', h.ctx(), input);
  }

  return { h, upsert, search };
}

// ---------------------------------------------------------------------------
// FTS5 query escaping unit tests
// ---------------------------------------------------------------------------

describe('escapeFts5Query', () => {
  it('wraps a single token in double-quotes', () => {
    expect(escapeFts5Query('react')).toBe('"react"');
  });

  it('quotes each token separately and joins with OR (prevents FTS5 boolean/syntax parsing)', () => {
    // Without per-token quoting, FTS5 would treat "AND" / "OR" as boolean operators.
    // With per-token quoting, each word is a literal single-token phrase query.
    // Tokens are joined with " OR " for OR semantics (any match is returned).
    expect(escapeFts5Query('react AND vue')).toBe('"react" OR "AND" OR "vue"');
    expect(escapeFts5Query('node OR python')).toBe('"node" OR "OR" OR "python"');
    // Multi-word query: each token quoted, joined with OR
    expect(escapeFts5Query('TypeScript language')).toBe('"TypeScript" OR "language"');
  });

  it('doubles internal double-quote characters within each token', () => {
    // A token that itself contains a double-quote has it doubled per FTS5 spec.
    expect(escapeFts5Query('"hi"')).toBe('"""hi"""');
  });

  it('returns empty string for empty input', () => {
    expect(escapeFts5Query('')).toBe('');
    expect(escapeFts5Query('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// SQLite-specific integration tests
// ---------------------------------------------------------------------------

describe('@ax/memory-strata-index-sqlite — sqlite-specific', () => {
  let dir: string;
  let databasePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-strata-index-sqlite-test-'));
    databasePath = join(dir, 'index.db');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: FTS5 boolean operators are treated as literals (not parsed)
  // -------------------------------------------------------------------------
  it('query "react AND vue" does NOT trigger FTS5 boolean parsing', async () => {
    const { upsert, search } = await makeHarness(databasePath);

    // Insert a doc whose body contains the literal phrase "react AND vue"
    await upsert({
      docId: 'tech/react-and-vue',
      category: 'tech',
      slug: 'react-and-vue',
      summary: 'Comparison of react and vue',
      factType: 'preference',
      body: 'The team compared react AND vue frameworks.',
      headers: '',
    });

    // Insert a decoy that only mentions "react"
    await upsert({
      docId: 'tech/react-only',
      category: 'tech',
      slug: 'react-only',
      summary: 'React framework notes',
      factType: 'preference',
      body: 'Only mentions react here.',
      headers: '',
    });

    // The query should not crash (would throw if FTS5 parsed "AND" as boolean
    // with no right operand when used as a prefix operator incorrectly).
    const out = await search({ query: 'react AND vue', topK: 5 });
    // At minimum the search should complete without throwing.
    expect(Array.isArray(out.results)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: Special characters in body don't crash upsert or search
  // -------------------------------------------------------------------------
  it('handles apostrophes, parentheses, and quotes in body', async () => {
    const { upsert, search } = await makeHarness(databasePath);

    await upsert({
      docId: 'general/special-chars',
      category: 'general',
      slug: 'special-chars',
      summary: "It's a test with 'apostrophes' and (parentheses)",
      factType: 'general',
      body: 'He said "hello" to O\'Brien\'s team (the backend folks).',
      headers: '',
    });

    // Should not throw on upsert.
    // Search for a simple token that exists in the body.
    const out = await search({ query: 'hello', topK: 5 });
    expect(out.results.length).toBeGreaterThanOrEqual(1);
    expect(out.results[0]!.docId).toBe('general/special-chars');
  });

  // -------------------------------------------------------------------------
  // Test 3: CJK + ASCII mixed content — findable on the ASCII token
  // -------------------------------------------------------------------------
  it('handles CJK + ASCII mixed content (unicode61 tokenizer)', async () => {
    const { upsert, search } = await makeHarness(databasePath);

    // Use a space between the CJK text and the ASCII token so the unicode61
    // tokenizer can split them into separate tokens.
    await upsert({
      docId: 'i18n/chinese',
      category: 'i18n',
      slug: 'chinese',
      summary: '用户喜欢使用 TypeScript',
      factType: 'general',
      body: '这是一个测试文档。',
      headers: '',
    });

    // unicode61 tokenizer handles CJK and ASCII — doc should be findable by
    // the space-separated ASCII token.
    const out = await search({ query: 'TypeScript', topK: 5 });
    const docIds = out.results.map((r) => r.docId);
    expect(docIds).toContain('i18n/chinese');
  });

  // -------------------------------------------------------------------------
  // Test 4: Idempotent upsert (I22) — same docId 5 times → 1 result, latest wins
  // -------------------------------------------------------------------------
  it('idempotent upsert: upserting same doc 5 times leaves exactly 1 result with latest summary', async () => {
    const { upsert, search } = await makeHarness(databasePath);

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

    const out = await search({ query: 'iterative', topK: 10 });
    // Exactly one result (not 5 duplicates)
    expect(out.results).toHaveLength(1);
    // Latest version wins
    expect(out.results[0]!.summary).toBe('Version 5 of the summary');
  });

  // -------------------------------------------------------------------------
  // Test 4b: a literal <b> in the body survives verbatim into the snippet
  // -------------------------------------------------------------------------
  // sqlite's snippet() uses empty start/end markers (no highlighting) and
  // returns the raw original body text, so a literal <b> in the body is
  // preserved. This is the parity SOURCE the postgres backend targets — and
  // the backend divergence worth pinning: postgres's ts_headline drops <...>
  // as a tag token, so it can't preserve a literal <b> the way sqlite does.
  it('preserves a literal <b> occurring in the body text into the snippet', async () => {
    const { upsert, search } = await makeHarness(databasePath);

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
    expect(snippet).toContain('graduated');
    // The literal <b> from the body survives verbatim (no strip, no markers).
    expect(snippet).toContain('<b>');
  });

  // -------------------------------------------------------------------------
  // Test 5: Manifest registers all four hooks
  // -------------------------------------------------------------------------
  it('manifest registers all four memory:index:* hooks', () => {
    const plugin = createMemoryStrataIndexSqlitePlugin({ databasePath: ':memory:' });
    expect(plugin.manifest.name).toBe('@ax/memory-strata-index-sqlite');
    expect(plugin.manifest.registers).toContain('memory:index:upsert');
    expect(plugin.manifest.registers).toContain('memory:index:search');
    expect(plugin.manifest.registers).toContain('memory:index:delete');
    expect(plugin.manifest.registers).toContain('memory:index:clear');
  });
});
