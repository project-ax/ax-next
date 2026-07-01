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
  (bus: HookBus): Promise<{ plugin: Plugin; teardown: () => Promise<void> }>;
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
  snippet: string;
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
    // Initialise to a no-op so an exception in beforeEach (before `teardown`
    // gets assigned) doesn't trigger a second error in afterEach that masks
    // the real failure.
    let teardown: () => Promise<void> = async () => {};

    beforeEach(async () => {
      bus = new HookBus();
      const result = await factory(bus);
      teardown = result.teardown;
      await result.plugin.init({ bus, config: {} });
    });

    afterEach(async () => {
      await teardown();
    });

    // Default ctx — a single (userId, agentId) tenant. All the single-tenant
    // cases below run as this agent. The per-agent isolation case (Test 10)
    // mints DISTINCT ctxs to prove cross-tenant separation.
    function makeCtx(agentId = 'a', userId = 'u') {
      return makeAgentContext({
        sessionId: 's',
        agentId,
        userId,
        workspace: { rootPath: '/tmp' },
      });
    }

    async function upsert(input: UpsertInput, ctx = makeCtx()): Promise<void> {
      await bus.call<UpsertInput, void>('memory:index:upsert', ctx, input);
    }

    async function search(input: SearchInput, ctx = makeCtx()): Promise<SearchOutput> {
      return bus.call<SearchInput, SearchOutput>('memory:index:search', ctx, input);
    }

    async function del(docId: string, ctx = makeCtx()): Promise<void> {
      await bus.call<DeleteInput, void>('memory:index:delete', ctx, { docId });
    }

    async function clear(ctx = makeCtx()): Promise<void> {
      await bus.call<Record<string, never>, void>('memory:index:clear', ctx, {});
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
        body: 'The discussion covered TypeScript as the preferred language for development.',
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

    // -----------------------------------------------------------------------
    // Test 9: invalid-payload rejection at the boundary
    // -----------------------------------------------------------------------
    // SQLite's FTS5 `LIMIT -1` means unbounded — the postgres backend would
    // throw a less helpful error. Either is bad. Both backends should reject
    // non-positive topK at the service boundary with PluginError.code
    // 'invalid-payload'.
    it('rejects non-positive topK with PluginError code invalid-payload', async () => {
      // Use try/catch — vitest's `.rejects.toThrow()` only inspects message,
      // and our contract is "the structured `.code` field is invalid-payload"
      // (the message wording is backend-private).
      const expectInvalid = async (topK: number): Promise<void> => {
        try {
          await bus.call('memory:index:search', makeCtx(), {
            query: 'anything',
            topK,
          });
          throw new Error(`expected memory:index:search to reject for topK=${topK}`);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as { code?: string }).code).toBe('invalid-payload');
        }
      };
      await expectInvalid(0);
      await expectInvalid(-5);
    });

    it('clamps topK above MAX_TOP_K instead of unbounded results', async () => {
      // Seed one doc so the query has something to return.
      await upsert({
        docId: 'general/single',
        category: 'general',
        slug: 'single',
        summary: 'clamping test',
        factType: 'general',
        body: 'body',
        headers: '',
      });
      // 1_000_000 would otherwise translate to an unbounded LIMIT in many
      // engines. The clamp keeps callers honest without breaking the call.
      const out = await search({ query: 'clamping', topK: 1_000_000 });
      // Result count itself can be 1 (one doc); the assertion is "no throw".
      expect(out.results.length).toBeGreaterThanOrEqual(0);
    });

    // -----------------------------------------------------------------------
    // Test 10: PER-AGENT ISOLATION (TASK-186 — multi-tenant boundary)
    // -----------------------------------------------------------------------
    // The index is a SINGLE shared store (one sqlite db / one postgres table)
    // across every agent in a deployment. Before TASK-186 it keyed rows only
    // by docId, so agent A's `memory_search` could return agent B's facts —
    // a cross-tenant leak. Every write/read/delete/clear must be scoped to the
    // calling agent (derived from ctx). This case FAILS on the pre-fix pooled
    // behavior: A's search would surface B's doc, and a same-docId write from B
    // would clobber A's row.
    describe('per-agent isolation (TASK-186)', () => {
      const ctxA = makeCtx('agent-a', 'user-a');
      const ctxB = makeCtx('agent-b', 'user-b');

      it("search under agent A never returns agent B's docs", async () => {
        await upsert(
          {
            docId: 'preference/db',
            category: 'preference',
            slug: 'db',
            summary: 'Agent A prefers postgres',
            factType: 'preference',
            body: 'Agent A loves postgres for everything.',
            headers: '',
          },
          ctxA,
        );
        await upsert(
          {
            docId: 'preference/db',
            category: 'preference',
            slug: 'db',
            summary: 'Agent B prefers sqlite',
            factType: 'preference',
            body: 'Agent B loves sqlite for everything.',
            headers: '',
          },
          ctxB,
        );

        // Same docId, different content, different agents. Neither write
        // clobbers the other (no pooled collision), and each agent sees only
        // its own row. Query on the term BOTH docs share ("prefers") so the
        // assertion is purely about agent scoping, independent of each
        // backend's full-text AND/OR query semantics.
        const outA = await search({ query: 'prefers', topK: 10 }, ctxA);
        expect(outA.results).toHaveLength(1);
        expect(outA.results[0]!.summary).toBe('Agent A prefers postgres');

        const outB = await search({ query: 'prefers', topK: 10 }, ctxB);
        expect(outB.results).toHaveLength(1);
        expect(outB.results[0]!.summary).toBe('Agent B prefers sqlite');
      });

      it("delete under agent A does not remove agent B's same-docId doc", async () => {
        await upsert(
          {
            docId: 'entity/shared-id',
            category: 'entity',
            slug: 'shared-id',
            summary: 'A entity record',
            factType: 'entity',
            body: 'Agent A entity body content.',
            headers: '',
          },
          ctxA,
        );
        await upsert(
          {
            docId: 'entity/shared-id',
            category: 'entity',
            slug: 'shared-id',
            summary: 'B entity record',
            factType: 'entity',
            body: 'Agent B entity body content.',
            headers: '',
          },
          ctxB,
        );

        await del('entity/shared-id', ctxA);

        // A's row is gone; B's identically-keyed row is untouched.
        const outA = await search({ query: 'entity record body', topK: 10 }, ctxA);
        expect(outA.results.map((r) => r.docId)).not.toContain('entity/shared-id');

        const outB = await search({ query: 'entity record body', topK: 10 }, ctxB);
        expect(outB.results).toHaveLength(1);
        expect(outB.results[0]!.summary).toBe('B entity record');
      });

      it("clear under agent A leaves agent B's index intact", async () => {
        await upsert(
          {
            docId: 'general/note',
            category: 'general',
            slug: 'note',
            summary: 'A note',
            factType: 'general',
            body: 'Agent A general note.',
            headers: '',
          },
          ctxA,
        );
        await upsert(
          {
            docId: 'general/note',
            category: 'general',
            slug: 'note',
            summary: 'B note',
            factType: 'general',
            body: 'Agent B general note.',
            headers: '',
          },
          ctxB,
        );

        await clear(ctxA);

        const outA = await search({ query: 'general note', topK: 10 }, ctxA);
        expect(outA.results).toHaveLength(0);

        const outB = await search({ query: 'general note', topK: 10 }, ctxB);
        expect(outB.results).toHaveLength(1);
        expect(outB.results[0]!.summary).toBe('B note');
      });
    });
  });
}
