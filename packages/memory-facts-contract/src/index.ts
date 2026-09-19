// Shared contract test-suite for any plugin that registers the four
// memory:facts:* service hooks (design doc `docs/plans/2026-09-18-dem-first-
// memory-design.md` §2.1-2.2, §3.4). Scope of THIS contract, per
// `.claude/memory/decisions.md`'s "TASK-421 memory-facts contract + sqlite
// engine" section: the closure/tenancy contract only.
//
//  - `memory:facts:recall` here is a simple filtered listing (tenant scope +
//    optional `about` + activeOnly), sorted by `when` desc, capped at
//    `limit`. No FTS, no dense/vector search, no RRF fusion, no rerank —
//    those are TASK-424.
//  - No `temporalAnchor`/`at` time-travel — DEM's `invalidatesPrevious` mode
//    and temporal-anchor recall are explicitly not built here (see
//    decisions.md; `dem-memory/tests/temporal-invalidation.test.ts` is NOT
//    ported).
//
// This file imports `@ax/core` types only — no plugin imports — so the
// contract itself stays storage-agnostic (Invariant 1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import type { Plugin } from '@ax/core';

export interface FactsBackendFactory {
  (bus: HookBus): Promise<{ plugin: Plugin; teardown: () => Promise<void> }>;
}

// ---------------------------------------------------------------------------
// Hook I/O types
// ---------------------------------------------------------------------------

/**
 * Who asserted a statement. A row is only ever closed by a row of
 * equal-or-higher provenance (rule 3), so a human correction survives the
 * next time an extractor meets the old value in a transcript.
 */
export type Provenance = 'extracted' | 'agent' | 'human';

export interface FactStatementInput {
  /** The entity the statement is about (dem-memory's `subject`). */
  about: string;
  /** The relationship or property (dem-memory's `predicate`). */
  relation: string;
  /** The asserted value (dem-memory's `object`). */
  value: string;
  /** ISO-8601 UTC instant the statement became true (dem-memory's `validStart`). */
  when: string;
  /**
   * The slot-supersession key. Derivation lives OUTSIDE this engine (in
   * `@ax/memory`) — a statement arrives with `slot` already set, or absent.
   * Absent means "no slot": stored, retrievable, inert — it closes nothing
   * and nothing closes it.
   */
  slot?: string;
  /** Defaults to `extracted` — `record` is the observer's door. */
  provenance?: Provenance;
  ownerUserId?: string;
  conversationId?: string;
}

export interface RecordInput {
  /**
   * Accepted for forward-compat with TASK-422's idempotent-batch dedup.
   * THIS engine stores/uses it nowhere — no dedup happens on it here.
   */
  batchKey?: string;
  statements: FactStatementInput[];
}

/** One stored row, as returned by `record` or `recall`. */
export interface FactRecord {
  id: string;
  about: string;
  relation: string;
  value: string;
  when: string;
  /** Set only when this row has been closed (by a rule, a self-close, or an explicit supersede). */
  until?: string;
  provenance: Provenance;
  /**
   * The id of the row that closed this one. Absent on an active row AND on
   * an explicit `supersede` — that absence is what tells a retraction
   * ("forgotten") apart from a rule-closure ("superseded by that row").
   */
  closedBy?: string;
}

export interface RecordedStatement extends FactRecord {
  /**
   * Ids of previously-active (or previously rule-closed) rows THIS
   * statement's arrival closed (rule 1) — empty when it closed nothing.
   */
  closes: string[];
}

export interface RecordOutput {
  /** One entry per input statement, in input order. */
  records: RecordedStatement[];
}

export interface RecallInput {
  about?: string;
  /**
   * This engine only ever behaves as if `true` — there is no supported way
   * to fetch closed rows through `recall` yet (TASK-422 territory). The
   * field is accepted for forward-compat; a backend rejects `false` with
   * `invalid-payload` rather than silently ignoring it (a caller who reads
   * this type and asks for history should get a loud "not yet", not fewer
   * rows than requested with no signal).
   */
  activeOnly?: boolean;
  limit: number;
  /**
   * Accepted for forward-compat with TASK-424's fusion recall (FTS/dense/
   * RRF/rerank). This contract never exercises it, and a backend rejects
   * any non-`undefined` value with `invalid-payload` rather than silently
   * returning an unfiltered result set.
   */
  query?: string;
}

export interface RecallOutput {
  statements: FactRecord[];
  /** Always `[]` from this engine — TASK-422 adds real degraded-mode flags. */
  degraded: string[];
}

export interface SupersedeInput {
  ids: string[];
}

export interface SupersedeOutput {
  /** Ids actually closed by this call — a foreign, missing, or already-closed id is silently absent. */
  closed: string[];
}

export type ClearInput = Record<string, never>;

// ---------------------------------------------------------------------------
// runFactsContract
// ---------------------------------------------------------------------------

export function runFactsContract(label: string, factory: FactsBackendFactory): void {
  describe(`${label} — memory:facts contract`, () => {
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

    function makeCtx(agentId = 'a', userId = 'u') {
      return makeAgentContext({
        sessionId: 's',
        agentId,
        userId,
        workspace: { rootPath: '/tmp' },
      });
    }

    async function record(input: RecordInput, ctx = makeCtx()): Promise<RecordOutput> {
      return bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, input);
    }

    async function recall(input: RecallInput, ctx = makeCtx()): Promise<RecallOutput> {
      return bus.call<RecallInput, RecallOutput>('memory:facts:recall', ctx, input);
    }

    async function supersede(ids: string[], ctx = makeCtx()): Promise<SupersedeOutput> {
      return bus.call<SupersedeInput, SupersedeOutput>('memory:facts:supersede', ctx, { ids });
    }

    async function clear(ctx = makeCtx()): Promise<void> {
      await bus.call<ClearInput, void>('memory:facts:clear', ctx, {});
    }

    // One statement, one call — the common case used by most cases below.
    async function recordOne(
      statement: FactStatementInput,
      ctx = makeCtx(),
    ): Promise<RecordedStatement> {
      const out = await record({ statements: [statement] }, ctx);
      return out.records[0]!;
    }

    const JAN = '2023-01-01T00:00:00.000Z';
    const JUN = '2023-06-01T00:00:00.000Z';
    const SEP = '2023-09-01T00:00:00.000Z';

    // -----------------------------------------------------------------------
    // Rule 1 — close the prior, and only the prior
    // -----------------------------------------------------------------------
    describe('rule 1 — close the prior, and only the prior', () => {
      it('closes exactly the previous row of the same (about, slot)', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });
        expect(seattle.closes).toEqual([boston.id]);

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value)).toEqual(['Seattle']);
      });

      it('closes across DIFFERENT relations that share a slot', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        const seattle = await recordOne({
          about: 'user',
          relation: 'resides_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });
        expect(seattle.closes).toEqual([boston.id]);

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value)).toEqual(['Seattle']);
      });

      it('leaves other slots and other subjects alone', async () => {
        await record({
          statements: [
            { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'lives_in' },
            { about: 'user', relation: 'works_at', value: 'Acme', when: JAN, slot: 'works_at' },
            { about: 'alice', relation: 'lives_in', value: 'Denver', when: JAN, slot: 'lives_in' },
          ],
        });
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });

        const userOut = await recall({ about: 'user', limit: 10 });
        expect(userOut.statements.map((s) => s.value).sort()).toEqual(['Acme', 'Seattle']);

        const aliceOut = await recall({ about: 'alice', limit: 10 });
        expect(aliceOut.statements.map((s) => s.value)).toEqual(['Denver']);
      });

      it('records closedBy — the closure is auditable through the return payload', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });
        // The closure is visible on the NEW record's `closes` list — the
        // closed row itself is no longer independently fetchable through
        // this contract (recall is activeOnly-only), so this return payload
        // is the auditability surface.
        expect(seattle.closes).toEqual([boston.id]);
        expect(seattle.closedBy).toBeUndefined();
      });

      it('settles a slot WITHIN one batch, in the order the facts arrive', async () => {
        const out = await record({
          statements: [
            { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'lives_in' },
            { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: 'lives_in' },
          ],
        });
        expect(out.records[1]!.closes).toEqual([out.records[0]!.id]);

        const recallOut = await recall({ about: 'user', limit: 10 });
        expect(recallOut.statements.map((s) => s.value)).toEqual(['Seattle']);
      });
    });

    // -----------------------------------------------------------------------
    // Rule 2 — two-sided closure
    // -----------------------------------------------------------------------
    describe('rule 2 — two-sided closure', () => {
      it('closes the BACKDATED row itself rather than letting both stay active', async () => {
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        expect(boston.closes).toEqual([]);
        expect(boston.until).toBe(JUN);
        expect(boston.closedBy).toBeDefined();

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value)).toEqual(['Seattle']);
      });

      it('bounds the backdated row at the EARLIEST later row, not the latest', async () => {
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Denver',
          when: SEP,
          slot: 'lives_in',
        });
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        // Bounded by Seattle (the earliest row after it), not by Denver.
        expect(boston.until).toBe(JUN);

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value)).toEqual(['Denver']);
      });

      it('reports the closure on the returned record, not just the store', async () => {
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        expect(boston.until).toBe(JUN);
        expect(boston.closedBy).toBeTruthy();
      });

      it('a superseded row (closedBy null) does not bound a later-inserted earlier statement, unlike a rule-closed one', async () => {
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });
        await supersede([seattle.id]);

        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        // An explicit retraction is no longer a reachable peer, so it cannot
        // bound a later-inserted earlier statement the way a rule-closed row
        // would.
        expect(boston.until).toBeUndefined();
        expect(boston.closedBy).toBeUndefined();

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value)).toEqual(['Boston']);
      });
    });

    // -------------------------------------------------------------------------
    // The invariant: exactly one active winner, regardless of arrival order.
    // NOTE what this block can and can't see: `recall` is activeOnly-only, so
    // these assertions observe the ACTIVE row and which ids `supersede` still
    // finds open — not whether two CLOSED intervals overlap. Non-overlap
    // itself (rule 2's "earliest later row, active-or-not") is pinned by the
    // dedicated "bounds the backdated row at the EARLIEST later row" case
    // above, which fails under the overlap-producing "active-only" mutation
    // this block cannot catch.
    // -------------------------------------------------------------------------
    describe('the invariant: exactly one active winner, any arrival order', () => {
      const orders: Array<Array<[string, string]>> = [
        [
          ['Boston', JAN],
          ['Seattle', JUN],
          ['Denver', SEP],
        ],
        [
          ['Boston', JAN],
          ['Denver', SEP],
          ['Seattle', JUN],
        ],
        [
          ['Seattle', JUN],
          ['Boston', JAN],
          ['Denver', SEP],
        ],
        [
          ['Seattle', JUN],
          ['Denver', SEP],
          ['Boston', JAN],
        ],
        [
          ['Denver', SEP],
          ['Boston', JAN],
          ['Seattle', JUN],
        ],
        [
          ['Denver', SEP],
          ['Seattle', JUN],
          ['Boston', JAN],
        ],
      ];

      for (const order of orders) {
        const label = order.map(([city]) => city).join(' -> ');
        it(`holds when the values arrive ${label}`, async () => {
          const ids: string[] = [];
          for (const [city, when] of order) {
            const rec = await recordOne({
              about: 'user',
              relation: 'lives_in',
              value: city,
              when,
              slot: 'lives_in',
            });
            ids.push(rec.id);
          }

          // Whatever order they arrived in, exactly one row is active, and
          // it is the newest (Denver).
          const out = await recall({ about: 'user', limit: 10 });
          expect(out.statements.map((s) => s.value)).toEqual(['Denver']);

          // `recall` can't see the closed rows (activeOnly-only), but
          // `supersede` acts on whatever is still active — attempting to
          // close all three ids and reading back which ones it ACTUALLY
          // closed proves only one was open, regardless of arrival order.
          const result = await supersede(ids);
          const denverId = ids[order.findIndex(([city]) => city === 'Denver')]!;
          expect(result.closed).toEqual([denverId]);
        });
      }
    });

    // -----------------------------------------------------------------------
    // Rule 3 — provenance immunity
    // -----------------------------------------------------------------------
    describe('rule 3 — provenance immunity', () => {
      it('does not let an extracted row close a human one', async () => {
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JAN,
          slot: 'lives_in',
          provenance: 'human',
        });
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JUN,
          slot: 'lives_in',
        });
        expect(boston.closes).toEqual([]);

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value).sort()).toEqual(['Boston', 'Seattle']);
      });

      it('does not let a human row BOUND an extracted one either — immunity is two-directional', async () => {
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
          provenance: 'human',
        });
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        expect(boston.until).toBeUndefined();
        expect(boston.closedBy).toBeUndefined();
      });

      it('lets a human row close an extracted one', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
          provenance: 'human',
        });
        expect(seattle.closes).toEqual([boston.id]);

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value)).toEqual(['Seattle']);
      });

      it('lets an agent row close an extracted one, and not the other way round', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
          provenance: 'agent',
        });
        expect(seattle.closes).toEqual([boston.id]);

        const denver = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Denver',
          when: SEP,
          slot: 'lives_in',
        });
        expect(denver.closes).toEqual([]);

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value).sort()).toEqual(['Denver', 'Seattle']);
      });

      it('defaults to `extracted`, because `record` is the observer\'s door', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        expect(boston.provenance).toBe('extracted');
      });
    });

    // -----------------------------------------------------------------------
    // Rule 4 — equal `when`
    // -----------------------------------------------------------------------
    describe('rule 4 — equal when', () => {
      it('lets the later write win, because that is what a correction is', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JAN,
          slot: 'lives_in',
        });
        expect(seattle.closes).toEqual([boston.id]);

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value)).toEqual(['Seattle']);
      });
    });

    // -----------------------------------------------------------------------
    // Closure reaches retrieval, which is the point of it
    // -----------------------------------------------------------------------
    it('drops a closed row out of memory:facts:recall default (activeOnly) results', async () => {
      await recordOne({
        about: 'user',
        relation: 'lives_in',
        value: 'Boston',
        when: JAN,
        slot: 'lives_in',
      });
      const before = await recall({ about: 'user', limit: 10 });
      expect(before.statements.map((s) => s.value)).toContain('Boston');

      await recordOne({
        about: 'user',
        relation: 'lives_in',
        value: 'Seattle',
        when: JUN,
        slot: 'lives_in',
      });
      const after = await recall({ about: 'user', limit: 10 });
      expect(after.statements.map((s) => s.value)).toContain('Seattle');
      expect(after.statements.map((s) => s.value)).not.toContain('Boston');
    });

    // -----------------------------------------------------------------------
    // memory:facts:supersede — the explicit close
    // -----------------------------------------------------------------------
    describe('memory:facts:supersede', () => {
      it('closes the named ids and reports which it actually closed', async () => {
        const rec = await recordOne({
          about: 'user',
          relation: 'likes_artist',
          value: 'Khalid',
          when: JAN,
        });

        const result = await supersede([rec.id]);
        expect(result.closed).toEqual([rec.id]);

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.id)).not.toContain(rec.id);
      });

      it('refuses a foreign-tenant id (scoped by ctx.agentId, not a payload field)', async () => {
        const ctxA = makeCtx('agent-a', 'user-a');
        const ctxB = makeCtx('agent-b', 'user-b');
        const rec = await recordOne(
          { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN },
          ctxA,
        );

        const result = await supersede([rec.id], ctxB);
        expect(result.closed).toEqual([]);

        const out = await recall({ about: 'user', limit: 10 }, ctxA);
        expect(out.statements.map((s) => s.id)).toContain(rec.id);
      });

      it('is idempotent — closing an already-closed row reports nothing closed', async () => {
        const rec = await recordOne({
          about: 'user',
          relation: 'likes_artist',
          value: 'Khalid',
          when: JAN,
        });
        await supersede([rec.id]);
        const second = await supersede([rec.id]);
        expect(second.closed).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // Per-agent isolation (TASK-186 / TASK-257 pattern)
    // -----------------------------------------------------------------------
    describe('per-agent isolation', () => {
      const ctxA = makeCtx('agent-a', 'user-a');
      const ctxB = makeCtx('agent-b', 'user-b');

      it("agent A's writes/recall/supersede/clear never touch agent B's data", async () => {
        const a = await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'lives_in' },
          ctxA,
        );
        const b = await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Denver', when: JAN, slot: 'lives_in' },
          ctxB,
        );

        const outA = await recall({ about: 'user', limit: 10 }, ctxA);
        expect(outA.statements.map((s) => s.value)).toEqual(['Boston']);
        const outB = await recall({ about: 'user', limit: 10 }, ctxB);
        expect(outB.statements.map((s) => s.value)).toEqual(['Denver']);

        // A's write did not close B's same-slot row (no pooled collision).
        expect(a.closes).toEqual([]);
        expect(b.closes).toEqual([]);

        await supersede([b.id], ctxA);
        const stillThere = await recall({ about: 'user', limit: 10 }, ctxB);
        expect(stillThere.statements.map((s) => s.value)).toEqual(['Denver']);

        await clear(ctxA);
        const aAfterClear = await recall({ about: 'user', limit: 10 }, ctxA);
        expect(aAfterClear.statements).toHaveLength(0);
        const bAfterAClear = await recall({ about: 'user', limit: 10 }, ctxB);
        expect(bAfterAClear.statements.map((s) => s.value)).toEqual(['Denver']);
      });

      // Partition is agentId ALONE (mirrors memory-strata-index-contract's
      // TASK-257 pattern): two users on the SAME agent share one history;
      // the same user on a DIFFERENT agent is isolated. Pinned directly per
      // the TASK-257 lesson — an isolation-only case like the one above is
      // satisfied by the wrong partition (e.g. sha256([userId, agentId])).
      describe('partition is agentId alone', () => {
        const alice = makeCtx('shared-agent', 'user-alice');
        const bob = makeCtx('shared-agent', 'user-bob');
        const otherAgent = makeCtx('other-agent', 'user-alice');

        it("a second user on the SAME agent reads the first user's fact", async () => {
          await recordOne(
            { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN },
            alice,
          );
          const out = await recall({ about: 'user', limit: 10 }, bob);
          expect(out.statements.map((s) => s.value)).toEqual(['Khalid']);
        });

        it('two users on the same agent share ONE slot history, not two', async () => {
          await recordOne(
            {
              about: 'user',
              relation: 'lives_in',
              value: 'Boston',
              when: JAN,
              slot: 'lives_in',
            },
            alice,
          );
          const bobsWrite = await recordOne(
            {
              about: 'user',
              relation: 'lives_in',
              value: 'Seattle',
              when: JUN,
              slot: 'lives_in',
            },
            bob,
          );
          // Bob's write closes Alice's row — one shared history, not two
          // private shards.
          expect(bobsWrite.closes).toHaveLength(1);

          const out = await recall({ about: 'user', limit: 10 }, alice);
          expect(out.statements.map((s) => s.value)).toEqual(['Seattle']);
        });

        it("a supersede by one user removes the other user's fact on the same agent", async () => {
          const rec = await recordOne(
            { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN },
            alice,
          );
          const result = await supersede([rec.id], bob);
          expect(result.closed).toEqual([rec.id]);

          const out = await recall({ about: 'user', limit: 10 }, alice);
          expect(out.statements).toHaveLength(0);
        });

        it('the SAME user on a DIFFERENT agent is still isolated', async () => {
          await recordOne(
            { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN },
            alice,
          );
          const out = await recall({ about: 'user', limit: 10 }, otherAgent);
          expect(out.statements).toHaveLength(0);
        });
      });
    });

    // -----------------------------------------------------------------------
    // invalid-payload rejection at the boundary
    // -----------------------------------------------------------------------
    describe('invalid-payload rejection', () => {
      it('rejects non-positive limit on recall with PluginError code invalid-payload', async () => {
        const expectInvalid = async (limit: number): Promise<void> => {
          try {
            await bus.call('memory:facts:recall', makeCtx(), { about: 'user', limit });
            throw new Error(`expected memory:facts:recall to reject for limit=${limit}`);
          } catch (err) {
            expect(err).toBeInstanceOf(Error);
            expect((err as { code?: string }).code).toBe('invalid-payload');
          }
        };
        await expectInvalid(0);
        await expectInvalid(-5);
      });

      it('rejects a statement missing a required field with PluginError code invalid-payload', async () => {
        try {
          await bus.call('memory:facts:record', makeCtx(), {
            statements: [{ about: 'user', relation: 'lives_in', when: JAN }],
          });
          throw new Error('expected memory:facts:record to reject a statement missing `value`');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as { code?: string }).code).toBe('invalid-payload');
        }
      });

      it('rejects a statement whose `when` is not a parseable instant', async () => {
        try {
          await bus.call('memory:facts:record', makeCtx(), {
            statements: [
              { about: 'user', relation: 'lives_in', value: 'Boston', when: 'not a date' },
            ],
          });
          throw new Error('expected memory:facts:record to reject an unparseable `when`');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as { code?: string }).code).toBe('invalid-payload');
        }
      });

      it('recall rejects `query` — not implemented yet (TASK-424)', async () => {
        try {
          await recall({ query: 'anything', limit: 10 });
          throw new Error('expected memory:facts:recall to reject a `query`');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as { code?: string }).code).toBe('invalid-payload');
        }
      });

      it('recall rejects `activeOnly: false` — history not implemented yet (TASK-422)', async () => {
        try {
          await recall({ activeOnly: false, limit: 10 });
          throw new Error('expected memory:facts:recall to reject activeOnly: false');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as { code?: string }).code).toBe('invalid-payload');
        }
      });
    });
  });
}
