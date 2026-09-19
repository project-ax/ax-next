// Shared contract test-suite for any plugin that registers the four
// memory:facts:* service hooks (design doc `docs/plans/2026-09-18-dem-first-
// memory-design.md` §2.1-2.2, §3.4). Scope of THIS contract, per
// `.claude/memory/decisions.md`'s "TASK-421 memory-facts contract + sqlite
// engine" section: the closure/tenancy contract only.
//
//  - `memory:facts:recall` here is a simple filtered listing (tenant scope +
//    optional `about` + activeOnly), sorted by `when` desc, capped at
//    `limit`. No FTS, no dense/vector search, no RRF fusion, no rerank —
//    those are TASK-434.
//  - No `temporalAnchor`/`at` time-travel — DEM's `invalidatesPrevious` mode
//    and temporal-anchor recall are explicitly not built here (see
//    decisions.md; `dem-memory/tests/temporal-invalidation.test.ts` is NOT
//    ported).
//
// TASK-422 extends that scope with the write-path/signal half of the design:
// batch idempotency + atomicity (§3.5), the `pending` slot sentinel and the
// `memory:facts:reindex` drain (§3.5), `activeOnly: false` history (§4.2),
// a real `degraded` signal and `store-unavailable` errors (§4.4). Still no
// FTS/dense/RRF/rerank — TASK-434.
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
  /**
   * ISO-8601 instant the statement became true (dem-memory's `validStart`),
   * with an EXPLICIT `Z` or `+HH:MM`/`-HH:MM` offset — a backend rejects an
   * offsetless local-time string rather than guess a timezone. Seconds are
   * required (no `2023-06-01T12:00Z`); a colon-less or hour-only offset
   * (`+0530`, `+05`) is also rejected even though both are valid ISO-8601.
   */
  when: string;
  /**
   * The slot-supersession key. Derivation lives OUTSIDE this engine (in
   * `@ax/memory`) — a statement arrives with `slot` already set, or absent.
   * Absent means "no slot": stored, retrievable, inert — it closes nothing
   * and nothing closes it.
   *
   * {@link PENDING_SLOT} is the one reserved value: "the caller's normalizer
   * could not derive a slot yet" (design §3.5). It behaves exactly like an
   * absent slot — inert — until `memory:facts:reindex` resolves it. Pending
   * is the SAFE direction: under-closing, never mis-closing.
   */
  slot?: string;
  /** Defaults to `extracted` — `record` is the observer's door. */
  provenance?: Provenance;
  ownerUserId?: string;
  conversationId?: string;
}

export interface RecordInput {
  /**
   * Idempotency key for the whole batch (design §3.5) — `chat:end` can fire
   * twice on the same conversation. Recording a batch whose key this tenant
   * has already seen writes NOTHING and returns the ORIGINAL rows, in input
   * order. Scoped per tenant: two agents may reuse a key independently.
   *
   * Omitted means "no dedup" — every call is a fresh batch.
   *
   * A batch is also ALL-OR-NOTHING: if any statement fails to settle, none of
   * them are stored, so a retry under the same key is a clean retry rather
   * than a permanently half-written batch.
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
   * Defaults to `true`: only currently-active rows. `false` is the `history`
   * mode of design §4.2 — no validity filter at all, so closed rows come back
   * alongside active ones, each carrying its `until` and (for a rule-closure)
   * `closedBy`.
   *
   * History exists because closing a row correctly can still lose the answer:
   * a question about a TRANSITION ("when did I change jobs") needs the row the
   * slot rule superseded. Only slot-mapped statements are ever closed, so this
   * is a no-op for the overwhelming majority of rows.
   *
   * Deliberately NOT point-in-time travel (`at`/`temporalAnchor`) — that is
   * the footgun §4.2 keeps off the agent-facing tool.
   */
  activeOnly?: boolean;
  limit: number;
  /**
   * Accepted for forward-compat with TASK-434's fusion recall (FTS/dense/
   * RRF/rerank). This contract never exercises it, and a backend rejects
   * any non-`undefined` value with `invalid-payload` rather than silently
   * returning an unfiltered result set.
   */
  query?: string;
}

export interface RecallOutput {
  statements: FactRecord[];
  /**
   * What was degraded about THIS answer — empty when nothing was (design
   * §4.4). Never a reason to return fewer rows silently.
   */
  degraded: DegradedFlag[];
}

export interface SupersedeInput {
  ids: string[];
}

export interface SupersedeOutput {
  /** Ids actually closed by this call — a foreign, missing, or already-closed id is silently absent. */
  closed: string[];
}

export type ClearInput = Record<string, never>;

/**
 * The reserved `slot` value meaning "not derived yet" (design §3.5). A row
 * carrying it is stored and retrievable but INERT for closure — it closes
 * nothing and nothing closes it — until `memory:facts:reindex` is handed the
 * resolved slot.
 *
 * It cannot collide with a real slot: the slot list is a fixed eight entries
 * in `@ax/memory` (design §3.3) — `name`, `pronouns`, `lives_in`, `works_at`,
 * `role`, `timezone`, `language`, `birthday`.
 *
 * One spelling, shared by every backend (Invariant 4).
 */
export const PENDING_SLOT = 'pending';

/**
 * What was degraded about a `recall` answer (design §4.4). Degraded mode is a
 * SIGNAL — the caller still gets rows, and still gets told the answer was
 * built on less than the full machinery.
 *
 * - `'pending'` — this tenant holds rows whose slot is {@link PENDING_SLOT},
 *   so supersession has not fully run: a value a later statement should have
 *   closed may still read as active. Under-closing, the safe direction.
 *   Produced by every backend that implements the pending drain.
 * - `'semantic'` — the dense/embedding channel was skipped because the
 *   embedder was unavailable. **Not produced yet**: there is no dense channel
 *   until TASK-434 builds one. Reserved here so both backends and the product
 *   layer agree on the spelling before there are two of them.
 * - `'ranking'` — the cross-encoder rerank was skipped and the lexical order
 *   stands. **Not produced yet**, same reason.
 *
 * A store that is unavailable is NOT a degraded flag — it is a thrown
 * `PluginError` (`code: 'store-unavailable'`). An empty table is a valid
 * answer; a failed store is not.
 */
export type DegradedFlag = 'semantic' | 'ranking' | 'pending';

/** One caller-resolved slot for a row that was recorded as {@link PENDING_SLOT}. */
export interface ResolvedSlot {
  id: string;
  /**
   * The derived slot, or `null` for "no slot after all" — a legitimate
   * outcome of the normalizer, and the row stays inert forever.
   */
  slot: string | null;
}

export interface ReindexInput {
  /**
   * Slots the CALLER derived for rows it previously recorded as pending.
   * Derivation is not the engine's job (design §3.3) — the engine applies
   * these and re-settles the affected `(about, slot)` chains.
   *
   * An id that is foreign to this tenant, missing, or no longer pending is
   * ignored rather than an error — the same forgiving shape `supersede` has.
   *
   * Omitted, this is a STATUS read: nothing is resolved or re-closed, and the
   * caller learns how many rows are still pending.
   */
  slots?: ResolvedSlot[];
}

export interface ReindexOutput {
  /** How many pending rows this call actually resolved. */
  resolved: number;
  /** Ids whose closure changed as a result — auditable, like `record`'s `closes`. */
  reclosed: string[];
  /** Rows still pending in this tenant AFTER the call. */
  pending: number;
  /** Same vocabulary as `recall` — `['pending']` while any row is still undrained. */
  degraded: DegradedFlag[];
}

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

    /**
     * Assert a hook call rejects with a specific `PluginError.code`. Written
     * as an explicit resolve-then-throw rather than `rejects.toThrow` so a
     * call that RESOLVES fails loudly — several cases below exist precisely
     * because resolving is the bug.
     */
    async function expectCode(code: string, run: () => Promise<unknown>): Promise<void> {
      let threw = false;
      try {
        await run();
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe(code);
      }
      expect(threw).toBe(true);
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

      it('rejects a `when` with no explicit Z/offset — bare local time is a TZ-shift footgun', async () => {
        // Regression guard: `Date.parse` alone ACCEPTS this (as host-local
        // time), which would silently shift the stored instant by the
        // server's timezone. A test asserting only 'not a date' rejects
        // does not exercise this branch — Date.parse already rejects that
        // string on its own, so it passes with or without the offset check.
        try {
          await bus.call('memory:facts:record', makeCtx(), {
            statements: [
              { about: 'user', relation: 'lives_in', value: 'Boston', when: '2023-06-01T12:00:00' },
            ],
          });
          throw new Error('expected memory:facts:record to reject an offsetless `when`');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as { code?: string }).code).toBe('invalid-payload');
        }
      });

      it('accepts a `when` with an explicit non-Z offset, normalized to the equivalent UTC instant', async () => {
        const recorded = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: '2023-06-01T12:00:00+05:30',
        });
        expect(recorded.when).toBe('2023-06-01T06:30:00.000Z');
      });

      it('recall rejects a non-boolean `activeOnly`', async () => {
        try {
          await recall({ activeOnly: 'true' as unknown as boolean, limit: 10 });
          throw new Error('expected memory:facts:recall to reject a non-boolean activeOnly');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as { code?: string }).code).toBe('invalid-payload');
        }
      });

      it('recall rejects `query` — not implemented yet (TASK-434)', async () => {
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

      it('record rejects a non-string batchKey', async () => {
        await expectCode('invalid-payload', () =>
          bus.call('memory:facts:record', makeCtx(), {
            batchKey: 7,
            statements: [{ about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN }],
          }),
        );
      });

      // An empty key is NOT "no key": it is a perfectly storable value that
      // would pool every accidentally-empty-keyed batch into one dedup bucket,
      // so the second such call would silently record nothing.
      it('record rejects an EMPTY batchKey rather than treating it as absent', async () => {
        await expectCode('invalid-payload', () =>
          record({
            batchKey: '',
            statements: [{ about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN }],
          }),
        );
      });
    });

    // -----------------------------------------------------------------------
    // A failed store is an ERROR, never a quiet empty answer (design §4.4)
    // -----------------------------------------------------------------------
    describe('store unavailable', () => {
      // Each case tears the store down MID-TEST, so the shared afterEach must
      // not run the backend's teardown a second time — not every backend
      // promises that is safe. Disarm it here; the store is already gone.
      async function closeTheStore(): Promise<void> {
        const close = teardown;
        teardown = async () => {};
        await close();
      }

      it('rejects record / supersede / clear with store-unavailable once the store is closed', async () => {
        // Prove the store WAS working first, so a failure below is about the
        // closure and not about a backend that never came up.
        const rec = await recordOne({
          about: 'user',
          relation: 'likes_artist',
          value: 'Khalid',
          when: JAN,
        });
        await closeTheStore();

        await expectCode('store-unavailable', () =>
          record({
            statements: [{ about: 'user', relation: 'lives_in', value: 'Boston', when: JAN }],
          }),
        );
        await expectCode('store-unavailable', () => supersede([rec.id]));
        await expectCode('store-unavailable', () => clear());
      });

      // The whole point of the case: `{ statements: [] }` and "the memory was
      // unreachable" render identically to a model, and one of them is a lie.
      // An empty table is a valid answer; a failed store is not.
      it('makes recall REJECT rather than resolve to an empty result set', async () => {
        await recordOne({
          about: 'user',
          relation: 'likes_artist',
          value: 'Khalid',
          when: JAN,
        });
        await closeTheStore();

        let resolvedTo: RecallOutput | undefined;
        let caught: unknown;
        try {
          resolvedTo = await recall({ about: 'user', limit: 10 });
        } catch (err) {
          caught = err;
        }
        expect(resolvedTo).toBeUndefined();
        expect(caught).toBeInstanceOf(Error);
        expect((caught as { code?: string }).code).toBe('store-unavailable');
      });

      // Validation has to run BEFORE the store is touched, or a caller with a
      // malformed payload gets told to go investigate an outage that isn't
      // theirs. `invalid-payload` outranks `store-unavailable`.
      it('still reports a malformed payload as invalid-payload, not as store-unavailable', async () => {
        await closeTheStore();

        await expectCode('invalid-payload', () => recall({ about: 'user', limit: 0 }));
        await expectCode('invalid-payload', () =>
          record({ statements: [{ about: '', relation: 'r', value: 'v', when: JAN }] }),
        );
      });
    });

    // -----------------------------------------------------------------------
    // batchKey idempotency + all-or-nothing batches (design §3.5)
    // -----------------------------------------------------------------------
    describe('batch idempotency', () => {
      // Slot-less statements: nothing closes anything, so "how many rows are
      // there" is exactly "how many active rows does recall return".
      const KHALID: FactStatementInput = {
        about: 'user',
        relation: 'likes_artist',
        value: 'Khalid',
        when: JAN,
      };
      const RAMEN: FactStatementInput = {
        about: 'user',
        relation: 'likes_food',
        value: 'ramen',
        when: JAN,
      };

      async function activeCount(ctx = makeCtx()): Promise<number> {
        const out = await recall({ about: 'user', limit: 200 }, ctx);
        return out.statements.length;
      }

      // `chat:end` can fire twice on one conversation (§3.5). Row count alone
      // is a weak assertion — a second call that happened to be a no-op for an
      // unrelated reason satisfies it — so the ids are what is pinned here.
      it('writes nothing and returns the FIRST call\'s ids when a batchKey repeats', async () => {
        const first = await record({ batchKey: 'turn-1', statements: [KHALID, RAMEN] });
        const second = await record({ batchKey: 'turn-1', statements: [KHALID, RAMEN] });

        expect(second.records.map((r) => r.id)).toEqual(first.records.map((r) => r.id));
        expect(await activeCount()).toBe(2);
      });

      // The replay describes the rows that EXIST, in the order they were
      // written — not the order this call happened to pass them in.
      it('replays in the ORIGINAL insertion order even when the retry reorders its statements', async () => {
        const first = await record({ batchKey: 'turn-2', statements: [KHALID, RAMEN] });
        const second = await record({ batchKey: 'turn-2', statements: [RAMEN, KHALID] });

        expect(second.records.map((r) => r.value)).toEqual(['Khalid', 'ramen']);
        expect(second.records.map((r) => r.id)).toEqual(first.records.map((r) => r.id));
        expect(await activeCount()).toBe(2);
      });

      it('rebuilds closes/until/closedBy from the stored rows on a replay', async () => {
        const statements: FactStatementInput[] = [
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'lives_in' },
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: 'lives_in' },
        ];
        const first = await record({ batchKey: 'turn-3', statements });
        expect(first.records[1]!.closes).toEqual([first.records[0]!.id]);

        const replay = await record({ batchKey: 'turn-3', statements });
        expect(replay.records.map((r) => r.id)).toEqual(first.records.map((r) => r.id));
        expect(replay.records[1]!.closes).toEqual([first.records[0]!.id]);
        // Honest difference from the first response: a replay reports the rows
        // as they stand NOW. Boston was closed by Seattle AFTER the first call
        // had already described it, so only the replay can say so.
        expect(replay.records[0]!.until).toBe(JUN);
        expect(replay.records[0]!.closedBy).toBe(first.records[1]!.id);

        const out = await recall({ about: 'user', limit: 200 });
        expect(out.statements.map((s) => s.value)).toEqual(['Seattle']);
      });

      it('does NOT dedup across different batchKeys, identical statements or not', async () => {
        await record({ batchKey: 'turn-a', statements: [KHALID] });
        await record({ batchKey: 'turn-b', statements: [KHALID] });
        expect(await activeCount()).toBe(2);
      });

      it('does NOT dedup when no batchKey is given — every call is a fresh batch', async () => {
        await record({ statements: [KHALID] });
        await record({ statements: [KHALID] });
        expect(await activeCount()).toBe(2);
      });

      it('scopes dedup per tenant — one agent\'s key never consumes another\'s', async () => {
        const ctxA = makeCtx('agent-a', 'user-a');
        const ctxB = makeCtx('agent-b', 'user-b');

        const a1 = await record({ batchKey: 'shared', statements: [KHALID] }, ctxA);
        const b1 = await record({ batchKey: 'shared', statements: [KHALID] }, ctxB);

        // B's write is its own row, not a replay of A's.
        expect(b1.records[0]!.id).not.toBe(a1.records[0]!.id);
        expect(await activeCount(ctxA)).toBe(1);
        expect(await activeCount(ctxB)).toBe(1);

        // ...and B using the key did not consume it for A: A's own retry still
        // dedups to A's original row.
        const a2 = await record({ batchKey: 'shared', statements: [KHALID] }, ctxA);
        expect(a2.records.map((r) => r.id)).toEqual(a1.records.map((r) => r.id));
        expect(await activeCount(ctxA)).toBe(1);
      });

      // All-or-nothing, the payload-validation half: every statement is
      // checked before ANY of them is written, so a bad statement at position
      // 2 cannot leave position 1 behind. (The store-failure half — a batch
      // that dies mid-WRITE — is backend-specific and lives in the backend's
      // own tests, since it takes a forced store fault to reach.)
      it('writes NOTHING when a later statement in the batch is invalid', async () => {
        await expectCode('invalid-payload', () =>
          record({
            batchKey: 'turn-doomed',
            statements: [KHALID, { about: 'user', relation: 'likes_food', value: '', when: JAN }],
          }),
        );
        expect(await activeCount()).toBe(0);

        // And the failed key is not poisoned — a corrected retry under the
        // same key records for real rather than replaying an empty batch.
        const retry = await record({ batchKey: 'turn-doomed', statements: [KHALID, RAMEN] });
        expect(retry.records).toHaveLength(2);
        expect(await activeCount()).toBe(2);
      });
    });
  });
}
