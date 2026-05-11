// Shared contract test-suite for any plugin that registers the four
// memory:index:* service hooks. The point: a single set of assertions that
// runs against every backend (sqlite today, postgres next) so we can prove
// the contract is genuinely interchangeable instead of accidentally
// sqlite-shaped.
//
// This file imports `@ax/core` types only — no plugin imports — so the
// contract itself stays storage-agnostic (Invariant 1, Invariant 19).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import type { Plugin } from '@ax/core';

export interface IndexBackendFactory {
  (): Promise<{ plugin: Plugin; teardown: () => Promise<void> }>;
}

// ---------------------------------------------------------------------------
// Hook I/O types (mirrors the shapes the backend must honour)
// ---------------------------------------------------------------------------

export interface UpsertInput {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  factType: string;
  body: string;
  headers: string;
}

export interface SearchInput {
  query: string;
  topK: number;
  categoryFilter?: string;
}

export interface SearchResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  score: number;
}

export interface SearchOutput {
  results: SearchResult[];
}

export interface DeleteInput {
  docId: string;
}

// ---------------------------------------------------------------------------
// runIndexContract
// ---------------------------------------------------------------------------

export function runIndexContract(label: string, factory: IndexBackendFactory): void {
  describe(`${label} — memory:index contract`, () => {
    let bus: HookBus;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      bus = new HookBus();
      const ctx = makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
        workspace: { rootPath: '/tmp' },
      });
      const result = await factory();
      teardown = result.teardown;
      await result.plugin.init({ bus, config: {} });
      // store ctx on bus scope — helpers below create fresh ones per call
      void ctx; // suppress unused warning; tests use makeCtx() inline
    });

    afterEach(async () => {
      await teardown();
    });

    function makeCtx() {
      return makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
        workspace: { rootPath: '/tmp' },
      });
    }

    async function upsert(input: UpsertInput): Promise<void> {
      await bus.call<UpsertInput, void>('memory:index:upsert', makeCtx(), input);
    }

    async function search(input: SearchInput): Promise<SearchOutput> {
      return bus.call<SearchInput, SearchOutput>('memory:index:search', makeCtx(), input);
    }

    async function del(docId: string): Promise<void> {
      await bus.call<DeleteInput, void>('memory:index:delete', makeCtx(), { docId });
    }

    async function clear(): Promise<void> {
      await bus.call<Record<string, never>, void>('memory:index:clear', makeCtx(), {});
    }

    // -----------------------------------------------------------------------
    // Test 1: upsert + search returns the matching doc
    // -----------------------------------------------------------------------
    it('upsert + search returns the matching doc', async () => {
      await upsert({
        docId: 'preference/react',
        category: 'preference',
        slug: 'react',
        summary: 'User prefers React over Vue',
        factType: 'preference',
        body: 'The user has expressed a preference for React.',
        headers: '',
      });

      const out = await search({ query: 'react', topK: 5 });
      expect(out.results).toHaveLength(1);
      expect(out.results[0]!.docId).toBe('preference/react');
      expect(out.results[0]!.score).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Test 2: idempotent upsert — second write wins
    // -----------------------------------------------------------------------
    it('idempotent upsert: second write wins', async () => {
      await upsert({
        docId: 'preference/editor',
        category: 'preference',
        slug: 'editor',
        summary: 'User prefers Vim',
        factType: 'preference',
        body: 'The user likes Vim.',
        headers: '',
      });
      await upsert({
        docId: 'preference/editor',
        category: 'preference',
        slug: 'editor',
        summary: 'User prefers Emacs over Vim',
        factType: 'preference',
        body: 'The user switched to Emacs.',
        headers: '',
      });

      const out = await search({ query: 'Emacs', topK: 5 });
      expect(out.results).toHaveLength(1);
      expect(out.results[0]!.summary).toBe('User prefers Emacs over Vim');
    });

    // -----------------------------------------------------------------------
    // Test 3: delete removes from search
    // -----------------------------------------------------------------------
    it('delete removes a doc from search results', async () => {
      await upsert({
        docId: 'entity/alice',
        category: 'entity',
        slug: 'alice',
        summary: 'Alice is a team member',
        factType: 'entity',
        body: 'Alice works on the platform team.',
        headers: '',
      });
      await upsert({
        docId: 'entity/bob',
        category: 'entity',
        slug: 'bob',
        summary: 'Bob is a team member',
        factType: 'entity',
        body: 'Bob works on the infrastructure team.',
        headers: '',
      });

      await del('entity/alice');

      const out = await search({ query: 'team member', topK: 5 });
      const docIds = out.results.map((r) => r.docId);
      expect(docIds).not.toContain('entity/alice');
      expect(docIds).toContain('entity/bob');
    });

    // -----------------------------------------------------------------------
    // Test 4: clear empties the index
    // -----------------------------------------------------------------------
    it('clear empties the index', async () => {
      await upsert({
        docId: 'decision/arch',
        category: 'decision',
        slug: 'arch',
        summary: 'Use microservices architecture',
        factType: 'decision',
        body: 'We decided to use microservices.',
        headers: '',
      });
      await upsert({
        docId: 'decision/lang',
        category: 'decision',
        slug: 'lang',
        summary: 'Use TypeScript for all services',
        factType: 'decision',
        body: 'TypeScript was chosen for type safety.',
        headers: '',
      });

      await clear();

      const out = await search({ query: 'microservices TypeScript', topK: 10 });
      expect(out.results).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Test 5: categoryFilter narrows results
    // -----------------------------------------------------------------------
    it('categoryFilter narrows results to the specified category', async () => {
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

    // -----------------------------------------------------------------------
    // Test 6: ranking — more-relevant doc ranks higher (or ties)
    // -----------------------------------------------------------------------
    it('ranking: more-relevant doc scores >= less-relevant doc', async () => {
      await upsert({
        docId: 'preference/typescript',
        category: 'preference',
        slug: 'typescript',
        summary: 'TypeScript is the preferred language for all development',
        factType: 'preference',
        body: 'The team chose TypeScript.',
        headers: '',
      });
      await upsert({
        docId: 'episode/meeting-2024',
        category: 'episode',
        slug: 'meeting-2024',
        summary: 'Team meeting notes from 2024',
        factType: 'episode',
        body: 'During the meeting we briefly mentioned TypeScript once.',
        headers: '',
      });

      const out = await search({ query: 'TypeScript preferred language', topK: 5 });
      expect(out.results.length).toBeGreaterThanOrEqual(2);
      const summaryMatchIdx = out.results.findIndex((r) => r.docId === 'preference/typescript');
      const bodyOnlyIdx = out.results.findIndex((r) => r.docId === 'episode/meeting-2024');
      expect(summaryMatchIdx).toBeGreaterThanOrEqual(0);
      expect(bodyOnlyIdx).toBeGreaterThanOrEqual(0);
      // The doc whose summary contains the query terms should score >= the one
      // that only mentions them in the body.
      expect(out.results[summaryMatchIdx]!.score).toBeGreaterThanOrEqual(
        out.results[bodyOnlyIdx]!.score,
      );
    });

    // -----------------------------------------------------------------------
    // Test 7: empty / nonexistent query returns 0 results without throwing
    // -----------------------------------------------------------------------
    it('empty query returns 0 results without throwing', async () => {
      await upsert({
        docId: 'general/misc',
        category: 'general',
        slug: 'misc',
        summary: 'Miscellaneous note',
        factType: 'general',
        body: 'Some general information.',
        headers: '',
      });

      // Completely nonexistent term
      const out1 = await search({ query: 'xyzzy_totally_absent_zork_quux', topK: 5 });
      expect(out1.results).toHaveLength(0);

      // Empty string query
      const out2 = await search({ query: '', topK: 5 });
      expect(Array.isArray(out2.results)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Test 8: searchable surface includes summary, body, and headers
    // -----------------------------------------------------------------------
    it('searchable surface includes summary, body, and headers', async () => {
      const TERM = 'xanadu_surface_test_term';

      // Doc A: term appears only in summary
      await upsert({
        docId: 'general/summary-hit',
        category: 'general',
        slug: 'summary-hit',
        summary: `Contains ${TERM} in the summary`,
        factType: 'general',
        body: 'No special term here.',
        headers: '',
      });

      // Doc B: term appears only in body
      await upsert({
        docId: 'general/body-hit',
        category: 'general',
        slug: 'body-hit',
        summary: 'No special term in summary',
        factType: 'general',
        body: `This body section mentions ${TERM} once.`,
        headers: '',
      });

      // Doc C: term appears only in headers
      await upsert({
        docId: 'general/headers-hit',
        category: 'general',
        slug: 'headers-hit',
        summary: 'No special term in summary',
        factType: 'general',
        body: 'No special term in body.',
        headers: `## ${TERM} section`,
      });

      const out = await search({ query: TERM, topK: 10 });
      const docIds = out.results.map((r) => r.docId);
      expect(docIds).toContain('general/summary-hit');
      expect(docIds).toContain('general/body-hit');
      expect(docIds).toContain('general/headers-hit');
    });
  });
}
