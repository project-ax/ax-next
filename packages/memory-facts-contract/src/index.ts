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

/**
 * The re-settle half of a write outcome. Both hooks that can invalidate a
 * `(about, slot)` chain — `memory:facts:supersede` and `memory:facts:reindex`
 * — re-derive §3.4 over the whole chain and owe the caller the SAME list, so
 * the field and its caveats are declared once rather than described twice and
 * allowed to drift (Invariant 4, applied to prose).
 */
export interface ResettleOutcome {
  /**
   * Every id whose closure state CHANGED as a result of this call — auditable,
   * like `record`'s `closes`. Empty means nothing moved, which is the ordinary
   * answer: most rows close nothing, and a chain that re-derives to the state
   * it was already in writes nothing.
   *
   * Not "re-closed". The list includes rows that were RE-OPENED, because
   * re-settling a chain re-derives §3.4 from scratch over the rows that still
   * assert something, and a row the caller retracted asserts nothing. So if
   * the row that had closed some older row has since been retracted, that
   * older row comes back ACTIVE (`until`/`closedBy` both cleared) and is named
   * here.
   *
   * The scenario, in one line: `A(lives_in, Jan)`; `B(lives_in, Jun)` closes A;
   * `supersede([B])` retracts B — the replay drops B from the peer set, A's
   * closure has no basis left, and A is re-opened and named in that same
   * call's `resettled`. (`reindex` reaches the same rows from the other side:
   * resolving a pending row into a chain replays that chain too.)
   *
   * That is the intended behaviour, not a wart: nothing should stay closed on
   * the authority of a statement a person asked us to forget. A consumer
   * reading this list must therefore treat it as "go re-read these rows",
   * never as "these rows are now closed".
   */
  resettled: string[];
}

/**
 * The retraction is atomic with the repair it forces: closing a row that had
 * itself closed a neighbour leaves that neighbour ended on the authority of a
 * row that now asserts nothing, so the same call re-derives the `(about, slot)`
 * chains of the rows it closed. A retracted row whose slot is absent or
 * {@link PENDING_SLOT} is inert and has no chain, so it strands nothing and
 * re-settles nothing.
 */
export interface SupersedeOutput extends ResettleOutcome {
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
   * Omitted, this is a STATUS read: nothing is resolved and no chain is
   * re-settled, and the caller learns how many rows are still pending.
   */
  slots?: ResolvedSlot[];
}

/**
 * `resettled` here names the chains a newly-resolved pending row joined —
 * `reindex` re-settles those and nothing else. It is not a tenant-wide repair
 * sweep, and it does not need to be: a retraction repairs its own chains in
 * the `supersede` call that caused it.
 */
export interface ReindexOutput extends ResettleOutcome {
  /** How many pending rows this call actually resolved. */
  resolved: number;
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

    async function reindex(input: ReindexInput = {}, ctx = makeCtx()): Promise<ReindexOutput> {
      return bus.call<ReindexInput, ReindexOutput>('memory:facts:reindex', ctx, input);
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

    /**
     * Read a stored row back as it stands NOW, including `until`/`closedBy`
     * on a CLOSED row — which plain `recall` cannot show, since it filters
     * to active rows. A `batchKey` replay rebuilds every row of that batch
     * from the stored rows and writes nothing, so recording the fixture
     * under a key gives a read-only inspector for the whole chain.
     */
    async function reread(
      batchKey: string,
      statements: FactStatementInput[],
      ctx = makeCtx(),
    ): Promise<RecordedStatement[]> {
      return (await record({ batchKey, statements }, ctx)).records;
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
        // closed row itself is not returned by this DEFAULT `recall`
        // (activeOnly: true; `activeOnly: false` history is exercised
        // separately below), so this return payload is the auditability
        // surface for this case.
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
    // NOTE what this block can and can't see: these assertions use the
    // DEFAULT `recall` (activeOnly: true), so they observe the ACTIVE row
    // and which ids `supersede` still
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

          // This default `recall` (activeOnly: true) can't see the closed
          // rows, but `supersede` acts on whatever is still active — attempting to
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

      // ---------------------------------------------------------------------
      // The retraction repairs the closures it invalidates (TASK-448)
      //
      // Ending a row is not the whole of retracting it. A row that had closed
      // a neighbour leaves that neighbour ended on ITS authority, and a
      // retracted row asserts nothing — so `supersede` re-derives §3.4 over
      // the `(about, slot)` chains of the rows it closed, in the same call.
      //
      // Every case below pairs its `resettled: []` with a positive assertion —
      // `closed: [id]`, or a `reread` of the stored chain. `resettled: []`
      // ALONE is satisfied by a `supersede` that ignores the feature entirely,
      // so on its own it pins nothing.
      // ---------------------------------------------------------------------
      describe('re-settles the chains it invalidates', () => {
        const LIVES_IN = 'lives_in';

        /** Boston (JAN), then Seattle (JUN) which closes it by rule 1. */
        const CHAIN: FactStatementInput[] = [
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: LIVES_IN },
        ];

        // The headline. Before this landed, `recall` here returned NEITHER
        // row — Boston closed, Seattle retracted — which is the user-facing
        // shape of the bug: "I deleted the new fact and my old one disappeared
        // too." An empty answer where Boston is the correct one.
        it('re-OPENS the row a retracted closer had closed, and names it in resettled', async () => {
          const KEY = 'retracted-closer';
          const [boston, seattle] = (await record({ batchKey: KEY, statements: CHAIN }))
            .records as [RecordedStatement, RecordedStatement];
          expect(seattle.closes).toEqual([boston.id]);

          const result = await supersede([seattle.id]);
          expect(result.closed).toEqual([seattle.id]);
          expect(result.resettled).toEqual([boston.id]);

          const [bostonNow, seattleNow] = (await reread(KEY, CHAIN)) as [
            RecordedStatement,
            RecordedStatement,
          ];
          // Genuinely active again: BOTH columns cleared, not merely
          // re-pointed at some other closer.
          expect(bostonNow.until).toBeUndefined();
          expect(bostonNow.closedBy).toBeUndefined();
          // The retracted row stays retracted — the replay drops it rather
          // than re-deriving it back into existence. Un-forgetting something a
          // person asked us to forget is the worst bug available here.
          expect(seattleNow.until).toBeDefined();
          expect(seattleNow.closedBy).toBeUndefined();
          expect(result.resettled).not.toContain(seattle.id);

          const active = await recall({ about: 'user', limit: 10 });
          expect(active.statements.map((s) => s.value)).toEqual(['Boston']);
        });

        it('reports nothing re-settled when the retracted row had closed nothing', async () => {
          const KEY = 'closed-nothing';
          const only: FactStatementInput[] = [CHAIN[0]!];
          const [boston] = (await record({ batchKey: KEY, statements: only })).records as [
            RecordedStatement,
          ];
          expect(boston.closes).toEqual([]);

          const result = await supersede([boston.id]);
          // The positive half: the row really WAS retracted, so the empty
          // `resettled` is "there was nothing to repair" rather than "this
          // call did nothing".
          expect(result.closed).toEqual([boston.id]);
          expect(result.resettled).toEqual([]);

          const [bostonNow] = (await reread(KEY, only)) as [RecordedStatement];
          expect(bostonNow.until).toBeDefined();
          expect(bostonNow.closedBy).toBeUndefined();
          expect((await recall({ about: 'user', limit: 10 })).statements).toHaveLength(0);
        });

        it('re-settles nothing for a row with NO slot — it never joined a chain', async () => {
          const KEY = 'no-slot';
          const statements: FactStatementInput[] = [
            ...CHAIN,
            // Same subject, no slot: stored, retrievable, inert.
            { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN },
          ];
          const [boston, seattle, khalid] = (await record({ batchKey: KEY, statements }))
            .records as [RecordedStatement, RecordedStatement, RecordedStatement];
          expect(seattle.closes).toEqual([boston.id]);
          expect(khalid.closes).toEqual([]);

          const result = await supersede([khalid.id]);
          expect(result.closed).toEqual([khalid.id]);
          expect(result.resettled).toEqual([]);

          // The slotted chain in the same subject is untouched — Boston is
          // still closed, and by Seattle, which still asserts it.
          const [bostonNow, seattleNow, khalidNow] = (await reread(KEY, statements)) as [
            RecordedStatement,
            RecordedStatement,
            RecordedStatement,
          ];
          expect(bostonNow.until).toBe(JUN);
          expect(bostonNow.closedBy).toBe(seattle.id);
          expect(seattleNow.until).toBeUndefined();
          expect(khalidNow.until).toBeDefined();
          expect(khalidNow.closedBy).toBeUndefined();
          expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.id)).toEqual([
            seattle.id,
          ]);
        });

        it('re-settles nothing for a PENDING-slot row — pending rows are inert', async () => {
          const KEY = 'pending-slot';
          const statements: FactStatementInput[] = [
            ...CHAIN,
            { about: 'user', relation: 'lives_in', value: 'Austin', when: SEP, slot: PENDING_SLOT },
          ];
          const [boston, seattle, austin] = (await record({ batchKey: KEY, statements }))
            .records as [RecordedStatement, RecordedStatement, RecordedStatement];
          // The real chain settled normally around it, and the pending row —
          // dated latest of the three — STILL closes nothing: pending is out
          // of the chain until `reindex` resolves it.
          expect(boston.closes).toEqual([]);
          expect(seattle.closes).toEqual([boston.id]);
          expect(austin.closes).toEqual([]);

          const result = await supersede([austin.id]);
          expect(result.closed).toEqual([austin.id]);
          expect(result.resettled).toEqual([]);

          const [bostonNow, seattleNow, austinNow] = (await reread(KEY, statements)) as [
            RecordedStatement,
            RecordedStatement,
            RecordedStatement,
          ];
          expect(bostonNow.until).toBe(JUN);
          expect(bostonNow.closedBy).toBe(seattle.id);
          expect(seattleNow.until).toBeUndefined();
          expect(austinNow.until).toBeDefined();
          expect(austinNow.closedBy).toBeUndefined();
          expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value)).toEqual(
            ['Seattle'],
          );
        });

        // A chain of three, so the repair has to be a REPLAY rather than "undo
        // the closures this row wrote". Dropping C re-opens B, but A stays
        // closed — by B, which still asserts itself.
        it('re-opens only the victim of the retracted row, leaving the rest of the chain closed', async () => {
          const KEY = 'chain-of-three';
          const statements: FactStatementInput[] = [
            ...CHAIN,
            { about: 'user', relation: 'lives_in', value: 'Austin', when: SEP, slot: LIVES_IN },
          ];
          const [boston, seattle, austin] = (await record({ batchKey: KEY, statements }))
            .records as [RecordedStatement, RecordedStatement, RecordedStatement];
          expect(seattle.closes).toEqual([boston.id]);
          expect(austin.closes).toEqual([seattle.id]);

          const result = await supersede([austin.id]);
          expect(result.closed).toEqual([austin.id]);
          expect(result.resettled).toEqual([seattle.id]);

          const [bostonNow, seattleNow, austinNow] = (await reread(KEY, statements)) as [
            RecordedStatement,
            RecordedStatement,
            RecordedStatement,
          ];
          // Boston is still closed, and still by Seattle — the replay
          // reproduced that closure rather than clearing everything it saw.
          expect(bostonNow.until).toBe(JUN);
          expect(bostonNow.closedBy).toBe(seattle.id);
          expect(seattleNow.until).toBeUndefined();
          expect(seattleNow.closedBy).toBeUndefined();
          expect(austinNow.until).toBeDefined();
          expect(austinNow.closedBy).toBeUndefined();
          expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value)).toEqual(
            ['Seattle'],
          );
        });

        // Two retracted rows of ONE chain, so the group is collected twice and
        // must be de-duplicated before the replay. Getting two ACTIVE rows
        // into one chain takes rule 3: the human row is unreachable from the
        // extracted ones, so it neither closes nor is closed, and both ends of
        // the chain are open at once. `supersede` can then retract two rows of
        // the same group in a single call — which it cannot do for a plain
        // chain, where only the newest row is ever open.
        //
        // What this pins is that the chain is re-derived from what SURVIVES
        // both retractions at once, not once per retracted row against a
        // half-repaired chain — and that `resettled` names Denver exactly
        // once, so a caller told to "go re-read these rows" reads it once.
        it('re-settles a chain ONCE when one call retracts two of its rows', async () => {
          const KEY = 'two-of-one-chain';
          const statements: FactStatementInput[] = [
            {
              about: 'user',
              relation: 'lives_in',
              value: 'Boston',
              when: JAN,
              slot: LIVES_IN,
              provenance: 'human',
            },
            { about: 'user', relation: 'lives_in', value: 'Denver', when: JUN, slot: LIVES_IN },
            { about: 'user', relation: 'lives_in', value: 'Seattle', when: SEP, slot: LIVES_IN },
          ];
          const [human, denver, seattle] = (await record({ batchKey: KEY, statements })).records as [
            RecordedStatement,
            RecordedStatement,
            RecordedStatement,
          ];
          // Denver never reached the human row (rule 3) and Seattle closed
          // Denver (rule 1), so the human row and Seattle are both active.
          expect(denver.closes).toEqual([]);
          expect(seattle.closes).toEqual([denver.id]);

          const result = await supersede([human.id, seattle.id]);
          expect(result.closed).toEqual([human.id, seattle.id]);
          expect(result.resettled).toEqual([denver.id]);

          const [humanNow, denverNow, seattleNow] = (await reread(KEY, statements)) as [
            RecordedStatement,
            RecordedStatement,
            RecordedStatement,
          ];
          expect(denverNow.until).toBeUndefined();
          expect(denverNow.closedBy).toBeUndefined();
          for (const row of [humanNow, seattleNow]) {
            expect(row.until).toBeDefined();
            expect(row.closedBy).toBeUndefined();
          }
          expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value)).toEqual(
            ['Denver'],
          );
        });

        // Rule 3 has to survive the repair, not just the original arrival.
        // The human row is unreachable from both lower ranks, so it neither
        // closes nor is closed; a replay that dropped provenance immunity
        // would have the extracted row (JUN) close the human one (JAN) — and
        // this is the only place that shows, because `record` never had the
        // chance to make that mistake.
        it('re-derives across a provenance boundary without closing over it', async () => {
          const KEY = 'provenance-immunity';
          const statements: FactStatementInput[] = [
            {
              about: 'user',
              relation: 'lives_in',
              value: 'Boston',
              when: JAN,
              slot: LIVES_IN,
              provenance: 'human',
            },
            {
              about: 'user',
              relation: 'lives_in',
              value: 'Seattle',
              when: JUN,
              slot: LIVES_IN,
              provenance: 'extracted',
            },
            {
              about: 'user',
              relation: 'lives_in',
              value: 'Austin',
              when: SEP,
              slot: LIVES_IN,
              provenance: 'agent',
            },
          ];
          const [human, extracted, agent] = (await record({ batchKey: KEY, statements }))
            .records as [RecordedStatement, RecordedStatement, RecordedStatement];
          // The agent row outranks the extracted one and closes it; the human
          // row outranks both, so it neither closes nor is closed.
          expect(human.closes).toEqual([]);
          expect(extracted.closes).toEqual([]);
          expect(agent.closes).toEqual([extracted.id]);

          const result = await supersede([agent.id]);
          expect(result.closed).toEqual([agent.id]);
          expect(result.resettled).toEqual([extracted.id]);

          const [humanNow, extractedNow, agentNow] = (await reread(KEY, statements)) as [
            RecordedStatement,
            RecordedStatement,
            RecordedStatement,
          ];
          // The rank boundary held through the replay.
          expect(humanNow.until).toBeUndefined();
          expect(humanNow.closedBy).toBeUndefined();
          expect(extractedNow.until).toBeUndefined();
          expect(extractedNow.closedBy).toBeUndefined();
          expect(agentNow.until).toBeDefined();
          expect(agentNow.closedBy).toBeUndefined();

          // Both survivors are active — newest `when` first.
          expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value)).toEqual(
            ['Seattle', 'Boston'],
          );
        });

        // The re-settle is scoped by `agentScopeKey(ctx)`, exactly like the
        // close it follows. Both tenants hold the SAME chain here, so a
        // re-settle that leaked would re-open the other agent's Boston too.
        it("never re-settles another agent's identical chain", async () => {
          const KEY = 'tenant-scoped-resettle';
          const ctxA = makeCtx('agent-a', 'user-a');
          const ctxB = makeCtx('agent-b', 'user-b');
          const [, aSeattle] = (await record({ batchKey: KEY, statements: CHAIN }, ctxA)).records as [
            RecordedStatement,
            RecordedStatement,
          ];
          const [bBoston, bSeattle] = (await record({ batchKey: KEY, statements: CHAIN }, ctxB))
            .records as [RecordedStatement, RecordedStatement];
          // Each tenant settled its own copy: B's Seattle closed B's Boston.
          expect(bSeattle.closes).toEqual([bBoston.id]);

          const mine = await supersede([aSeattle.id], ctxA);
          expect(mine.closed).toEqual([aSeattle.id]);
          expect(mine.resettled).toHaveLength(1);

          const [bBostonNow, bSeattleNow] = (await reread(KEY, CHAIN, ctxB)) as [
            RecordedStatement,
            RecordedStatement,
          ];
          expect(bBostonNow.until).toBe(JUN);
          expect(bBostonNow.closedBy).toBe(bSeattle.id);
          expect(bSeattleNow.until).toBeUndefined();
          expect((await recall({ about: 'user', limit: 10 }, ctxB)).statements.map((s) => s.value)).toEqual(
            ['Seattle'],
          );

          // And the foreign id is inert in the other direction: agent A
          // retracting agent B's row closes nothing, so there is no chain to
          // collect and B's Boston stays closed.
          const foreign = await supersede([bSeattle.id], ctxA);
          expect(foreign.closed).toEqual([]);
          expect(foreign.resettled).toEqual([]);
          const [bBostonStill] = (await reread(KEY, CHAIN, ctxB)) as [
            RecordedStatement,
            RecordedStatement,
          ];
          expect(bBostonStill.until).toBe(JUN);
          expect(bBostonStill.closedBy).toBe(bSeattle.id);
        });

        it('is idempotent — the second identical call closes and re-settles nothing', async () => {
          const KEY = 'idempotent-resettle';
          const [boston, seattle] = (await record({ batchKey: KEY, statements: CHAIN }))
            .records as [RecordedStatement, RecordedStatement];

          expect(await supersede([seattle.id])).toEqual({
            closed: [seattle.id],
            resettled: [boston.id],
          });
          const afterFirst = await reread(KEY, CHAIN);

          expect(await supersede([seattle.id])).toEqual({ closed: [], resettled: [] });
          // Byte-for-byte: the second call is a true no-op, not a repair that
          // happens to land on the same answer.
          expect(await reread(KEY, CHAIN)).toEqual(afterFirst);
        });

        // The group map inside `supersedeIds` used to key on `${about}\u0000
        // ${slot}`, which only distinguishes the two fields when neither
        // contains a NUL — and `about` is free text (TASK-448). These two
        // groups produce the SAME NUL-joined string:
        //   about = "x\u0000y", slot = "z"      -> "x\u0000y\u0000z"
        //   about = "x",        slot = "y\u0000z" -> "x\u0000y\u0000z"
        // so a bug in that key collapses them to one Map entry and only one
        // chain gets re-settled. One `supersede` call retracts a closer in
        // BOTH groups; both older rows must re-open.
        it('re-settles BOTH groups when their old NUL-joined keys would collide', async () => {
          const KEY1 = 'nul-collision-group-1';
          const KEY2 = 'nul-collision-group-2';
          const ABOUT1 = 'x\u0000y';
          const SLOT1 = 'z';
          const ABOUT2 = 'x';
          const SLOT2 = 'y\u0000z';

          const stmts1: FactStatementInput[] = [
            { about: ABOUT1, relation: 'r', value: 'old1', when: JAN, slot: SLOT1 },
            { about: ABOUT1, relation: 'r', value: 'new1', when: JUN, slot: SLOT1 },
          ];
          const stmts2: FactStatementInput[] = [
            { about: ABOUT2, relation: 'r', value: 'old2', when: JAN, slot: SLOT2 },
            { about: ABOUT2, relation: 'r', value: 'new2', when: JUN, slot: SLOT2 },
          ];

          const [older1, newer1] = (await record({ batchKey: KEY1, statements: stmts1 }))
            .records as [RecordedStatement, RecordedStatement];
          expect(newer1.closes).toEqual([older1.id]);

          const [older2, newer2] = (await record({ batchKey: KEY2, statements: stmts2 }))
            .records as [RecordedStatement, RecordedStatement];
          expect(newer2.closes).toEqual([older2.id]);

          const result = await supersede([newer1.id, newer2.id]);
          expect(result.closed.slice().sort()).toEqual([newer1.id, newer2.id].sort());
          // Against the unfixed NUL-joined key, only ONE of these two groups
          // survives in the Map, so exactly one of these ids is missing here.
          expect(result.resettled.slice().sort()).toEqual([older1.id, older2.id].sort());

          const [older1Now, newer1Now] = (await reread(KEY1, stmts1)) as [
            RecordedStatement,
            RecordedStatement,
          ];
          expect(older1Now.until).toBeUndefined();
          expect(older1Now.closedBy).toBeUndefined();
          expect(newer1Now.until).toBeDefined();
          expect(newer1Now.closedBy).toBeUndefined();

          const [older2Now, newer2Now] = (await reread(KEY2, stmts2)) as [
            RecordedStatement,
            RecordedStatement,
          ];
          expect(older2Now.until).toBeUndefined();
          expect(older2Now.closedBy).toBeUndefined();
          expect(newer2Now.until).toBeDefined();
          expect(newer2Now.closedBy).toBeUndefined();
        });
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
    // memory:facts:recall — activeOnly: false is history mode (design §4.2)
    // -----------------------------------------------------------------------
    describe('memory:facts:recall — activeOnly: false (history)', () => {
      it('activeOnly: true is explicitly equivalent to omitting it', async () => {
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: 'lives_in',
        });

        const omitted = await recall({ about: 'user', limit: 10 });
        const explicitTrue = await recall({ about: 'user', limit: 10, activeOnly: true });
        expect(explicitTrue.statements.map((s) => s.value)).toEqual(
          omitted.statements.map((s) => s.value),
        );
        expect(explicitTrue.statements.map((s) => s.value)).toEqual(['Seattle']);
      });

      it('default recall returns only the active row; activeOnly: false returns both, the closed one carrying until + closedBy', async () => {
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

        const activeOnly = await recall({ about: 'user', limit: 10 });
        expect(activeOnly.statements.map((s) => s.value)).toEqual(['Seattle']);

        const history = await recall({ about: 'user', limit: 10, activeOnly: false });
        expect(history.statements.map((s) => s.value).sort()).toEqual(['Boston', 'Seattle']);

        const bostonRecord = history.statements.find((s) => s.id === boston.id);
        expect(bostonRecord?.until).toBeDefined();
        expect(bostonRecord?.closedBy).toBe(seattle.id);

        const seattleRecord = history.statements.find((s) => s.id === seattle.id);
        expect(seattleRecord?.until).toBeUndefined();
        expect(seattleRecord?.closedBy).toBeUndefined();
      });

      it('history includes an explicitly superseded row, with until set and closedBy ABSENT — that is what distinguishes a retraction from a rule-closure', async () => {
        const rec = await recordOne({
          about: 'user',
          relation: 'likes_artist',
          value: 'Khalid',
          when: JAN,
        });
        expect((await supersede([rec.id])).closed).toEqual([rec.id]);

        const activeOnly = await recall({ about: 'user', limit: 10 });
        expect(activeOnly.statements.map((s) => s.id)).not.toContain(rec.id);

        const history = await recall({ about: 'user', limit: 10, activeOnly: false });
        const retracted = history.statements.find((s) => s.id === rec.id);
        expect(retracted).toBeDefined();
        expect(retracted?.until).toBeDefined();
        expect(retracted?.closedBy).toBeUndefined();
      });

      it('activeOnly: false still honours `about` filtering, the limit clamp, and tenant scoping', async () => {
        const ctxA = makeCtx('agent-a', 'user-a');
        const ctxB = makeCtx('agent-b', 'user-b');

        const boston = await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'lives_in' },
          ctxA,
        );
        await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: 'lives_in' },
          ctxA,
        );
        await recordOne(
          { about: 'alice', relation: 'lives_in', value: 'Denver', when: JAN, slot: 'lives_in' },
          ctxA,
        );
        await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Portland', when: JAN, slot: 'lives_in' },
          ctxB,
        );

        // `about` filtering: only `user`'s two rows, never `alice`'s.
        const aboutFiltered = await recall({ about: 'user', limit: 10, activeOnly: false }, ctxA);
        expect(aboutFiltered.statements.map((s) => s.value).sort()).toEqual(['Boston', 'Seattle']);

        // limit clamp: two rows exist for `user`, cap at 1.
        const limited = await recall({ about: 'user', limit: 1, activeOnly: false }, ctxA);
        expect(limited.statements).toHaveLength(1);

        // tenant scoping: agent B never sees agent A's closed Boston row —
        // or any of agent A's rows at all.
        const crossTenant = await recall({ about: 'user', limit: 10, activeOnly: false }, ctxB);
        expect(crossTenant.statements.map((s) => s.id)).not.toContain(boston.id);
        expect(crossTenant.statements.map((s) => s.value)).toEqual(['Portland']);
      });

      it('after teardown, recall with activeOnly: false rejects store-unavailable rather than resolving []', async () => {
        await recordOne({
          about: 'user',
          relation: 'likes_artist',
          value: 'Khalid',
          when: JAN,
        });
        // Tear the store down mid-test, same pattern as the dedicated
        // "store unavailable" describe below (disarm the shared afterEach —
        // the store is already gone).
        const close = teardown;
        teardown = async () => {};
        await close();

        let resolvedTo: RecallOutput | undefined;
        let caught: unknown;
        try {
          resolvedTo = await recall({ about: 'user', limit: 10, activeOnly: false });
        } catch (err) {
          caught = err;
        }
        expect(resolvedTo).toBeUndefined();
        expect(caught).toBeInstanceOf(Error);
        expect((caught as { code?: string }).code).toBe('store-unavailable');
      });
    });

    // -----------------------------------------------------------------------
    // memory:facts:recall — degraded (design §4.4, the `pending` flag)
    // -----------------------------------------------------------------------
    describe('memory:facts:recall — degraded', () => {
      it('is [] on a clean tenant, flags [\'pending\'] once a pending row exists, and drops back to [] once reindex resolves it', async () => {
        // Before: an ordinary resolved-slot row is not degraded. This is the
        // "before" half of the transition — asserted alone it would pass
        // against the OLD hardcoded `degraded: []` too, so it only earns its
        // place here, as the baseline the next two assertions move away from.
        await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: 'lives_in',
        });
        const clean = await recall({ about: 'user', limit: 10 });
        expect(clean.degraded).toEqual([]);

        // A pending row appears — the tenant's answers are now degraded.
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: PENDING_SLOT,
        });
        const duringPending = await recall({ about: 'user', limit: 10 });
        expect(duringPending.degraded).toEqual(['pending']);

        // Draining it through reindex clears the flag again.
        const drain = await reindex({ slots: [{ id: seattle.id, slot: 'lives_in' }] });
        expect(drain.resolved).toBe(1);
        const afterDrain = await recall({ about: 'user', limit: 10 });
        expect(afterDrain.degraded).toEqual([]);
      });

      it("is per-tenant — agent A's pending row does not flag agent B's recall", async () => {
        const ctxA = makeCtx('agent-a', 'user-a');
        const ctxB = makeCtx('agent-b', 'user-b');

        await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: PENDING_SLOT },
          ctxA,
        );
        await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Denver', when: JAN, slot: 'lives_in' },
          ctxB,
        );

        const outA = await recall({ about: 'user', limit: 10 }, ctxA);
        expect(outA.degraded).toEqual(['pending']);

        const outB = await recall({ about: 'user', limit: 10 }, ctxB);
        expect(outB.degraded).toEqual([]);
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

      // `reindex` has the same problem `recall` does: `{ resolved: 0,
      // resettled: [], pending: 0, degraded: [] }` is a perfectly plausible
      // answer for a clean tenant, so a store outage that came back as that
      // would read as "nothing left to drain" — and the drain would stop.
      it('rejects reindex with store-unavailable rather than reporting an empty drain', async () => {
        const rec = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: PENDING_SLOT,
        });
        await closeTheStore();

        let resolvedTo: ReindexOutput | undefined;
        let caught: unknown;
        try {
          resolvedTo = await reindex();
        } catch (err) {
          caught = err;
        }
        expect(resolvedTo).toBeUndefined();
        expect((caught as { code?: string }).code).toBe('store-unavailable');

        await expectCode('store-unavailable', () =>
          reindex({ slots: [{ id: rec.id, slot: 'lives_in' }] }),
        );
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
        await expectCode('invalid-payload', () => reindex({ slots: [{ id: '', slot: 'lives_in' }] }));
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

    // -----------------------------------------------------------------------
    // The `pending` slot is INERT — it closes nothing and nothing closes it
    // (design §3.5, task 4)
    // -----------------------------------------------------------------------
    describe('pending slot', () => {
      // The failure this exists to prevent: if `pending` were treated as an
      // ordinary slot string, every undrained fact about the same subject
      // would share one `(about, 'pending')` chain and close the one before
      // it — a `lives_in` guess ending a `works_at` guess purely because
      // neither had been normalized yet. That is MIS-closing, the exact
      // opposite of "pending = under-closing, the safe direction".
      it('lets two pending rows about the same subject coexist, whatever their relations', async () => {
        const lives = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: PENDING_SLOT,
        });
        const works = await recordOne({
          about: 'user',
          relation: 'works_at',
          value: 'Acme',
          when: JUN,
          slot: PENDING_SLOT,
        });

        expect(lives.closes).toEqual([]);
        expect(works.closes).toEqual([]);
        expect(lives.until).toBeUndefined();
        expect(lives.closedBy).toBeUndefined();
        expect(works.until).toBeUndefined();
        expect(works.closedBy).toBeUndefined();

        const out = await recall({ about: 'user', limit: 10 });
        expect(out.statements.map((s) => s.value).sort()).toEqual(['Acme', 'Boston']);
      });

      // Same subject, same relation, so the ONLY thing keeping them apart is
      // that `pending` is inert. Both arrival orders, because rule 1 and
      // rule 2 are different code paths and only one of them fires per order.
      for (const pendingFirst of [true, false]) {
        it(`neither closes the other when a pending row meets a real-slot row (pending ${
          pendingFirst ? 'first' : 'second'
        })`, async () => {
          const pendingStatement: FactStatementInput = {
            about: 'user',
            relation: 'lives_in',
            value: 'Boston',
            when: pendingFirst ? JAN : SEP,
            slot: PENDING_SLOT,
          };
          const realStatement: FactStatementInput = {
            about: 'user',
            relation: 'lives_in',
            value: 'Seattle',
            when: pendingFirst ? SEP : JAN,
            slot: 'lives_in',
          };

          const first = await recordOne(pendingFirst ? pendingStatement : realStatement);
          const second = await recordOne(pendingFirst ? realStatement : pendingStatement);

          expect(first.closes).toEqual([]);
          expect(second.closes).toEqual([]);
          expect(first.until).toBeUndefined();
          expect(first.closedBy).toBeUndefined();
          expect(second.until).toBeUndefined();
          expect(second.closedBy).toBeUndefined();

          const out = await recall({ about: 'user', limit: 10 });
          expect(out.statements.map((s) => s.value).sort()).toEqual(['Boston', 'Seattle']);
        });
      }

      // Inert is not the same as invisible. A pending row is a perfectly good
      // fact that simply has not been slotted yet — it must read back and be
      // forgettable like any other. Two rows, so an implementation that let
      // the second pending row close the first would fail here too rather
      // than quietly satisfying a one-row case.
      it('returns a pending row from recall and lets supersede close it', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: PENDING_SLOT,
        });
        const acme = await recordOne({
          about: 'user',
          relation: 'works_at',
          value: 'Acme',
          when: JUN,
          slot: PENDING_SLOT,
        });

        const before = await recall({ about: 'user', limit: 10 });
        expect(before.statements.map((s) => s.id).sort()).toEqual([boston.id, acme.id].sort());

        expect((await supersede([boston.id])).closed).toEqual([boston.id]);

        const after = await recall({ about: 'user', limit: 10 });
        expect(after.statements.map((s) => s.value)).toEqual(['Acme']);
      });
    });

    // -----------------------------------------------------------------------
    // memory:facts:reindex — draining pending back into the closure rules
    // (design §3.5, §2.2, task 5)
    // -----------------------------------------------------------------------
    describe('memory:facts:reindex', () => {
      const LIVES_IN = 'lives_in';

      it('closes the older row of the slot it is resolved into, and names it in resettled', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: LIVES_IN,
        });
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: PENDING_SLOT,
        });
        // Inert on arrival — this is the state reindex is asked to repair.
        expect(seattle.closes).toEqual([]);

        const out = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] });
        expect(out.resolved).toBe(1);
        expect(out.resettled).toEqual([boston.id]);
        expect(out.pending).toBe(0);
        expect(out.degraded).toEqual([]);

        const active = await recall({ about: 'user', limit: 10 });
        expect(active.statements.map((s) => s.value)).toEqual(['Seattle']);
      });

      it('leaves a row resolved to null inert forever — and says it resolved it', async () => {
        const boston = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: LIVES_IN,
        });
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: PENDING_SLOT,
        });

        const out = await reindex({ slots: [{ id: seattle.id, slot: null }] });
        // `resolved: 1` next to `resettled: []` is the pairing that matters:
        // an implementation that silently did nothing would satisfy the empty
        // list but not the count, and it would still be reported as pending.
        expect(out.resolved).toBe(1);
        expect(out.resettled).toEqual([]);
        expect(out.pending).toBe(0);
        expect(out.degraded).toEqual([]);

        expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value).sort()).toEqual(
          ['Boston', 'Seattle'],
        );

        // "No slot after all" is permanent: a later real `lives_in` row closes
        // Boston and walks straight past the resolved-to-null row.
        const denver = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Denver',
          when: SEP,
          slot: LIVES_IN,
        });
        expect(denver.closes).toEqual([boston.id]);
        expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value).sort()).toEqual(
          ['Denver', 'Seattle'],
        );
      });

      // The case that catches a patch-in-place implementation: the resolved
      // row lands BETWEEN two rows that already settled with each other, so
      // it has to close the one before it (rule 1) AND be bounded by the one
      // after it (rule 2) in the same pass, while the later row's own closure
      // is re-derived away.
      //
      // The three rows go in ONE batch on purpose. Re-derivation replays in
      // arrival order, `record` stamps one `transaction_time` per call, and
      // `batch_seq` is what orders rows inside it — so a single batch pins the
      // replay order exactly rather than leaving it to whether two separate
      // calls happened to land in different milliseconds.
      it('re-derives the whole chain when a resolved row is backdated into the middle of it', async () => {
        const KEY = 'chain';
        const statements: FactStatementInput[] = [
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Denver', when: SEP, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: PENDING_SLOT },
        ];
        const [boston, denver, seattle] = (await record({ batchKey: KEY, statements })).records as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        expect(denver.closes).toEqual([boston.id]);
        expect(seattle.closes).toEqual([]);

        const out = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] });
        expect(out.resolved).toBe(1);
        expect(out.resettled).toEqual([boston.id, seattle.id]);
        expect(out.pending).toBe(0);

        const [bostonNow, denverNow, seattleNow] = (await reread(KEY, statements)) as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        // Boston no longer ends at Denver — Seattle took that job.
        expect(bostonNow.until).toBe(JUN);
        expect(bostonNow.closedBy).toBe(seattle.id);
        // ...and Seattle is itself bounded at Denver, per rule 2.
        expect(seattleNow.until).toBe(SEP);
        expect(seattleNow.closedBy).toBe(denver.id);
        // Denver is the one active winner, untouched.
        expect(denverNow.until).toBeUndefined();
        expect(denverNow.closedBy).toBeUndefined();

        const active = await recall({ about: 'user', limit: 10 });
        expect(active.statements.map((s) => s.value)).toEqual(['Denver']);
      });

      // The multi-CALL companion to the case above. That one re-derives a
      // three-row chain inside ONE drain; this one hands the second drain a
      // group the FIRST drain already settled — which is the shape a real
      // caller produces, since the normalizer resolves what it can now and
      // the rest arrives on a later pass.
      //
      // What only this case can catch: an implementation that re-derives from
      // the closure state `record` originally wrote rather than from the state
      // the previous drain left behind, or one that skips a group on the
      // grounds that it has been settled once already. Both look correct
      // against a single-drain fixture.
      //
      // One batch again, so `batch_seq` pins the replay order (see above) and
      // Denver provably "arrived" before Seattle however the two reindex calls
      // are interleaved.
      it('re-derives a group that an earlier reindex call had already settled', async () => {
        const KEY = 'two-drains';
        const statements: FactStatementInput[] = [
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Denver', when: SEP, slot: PENDING_SLOT },
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: PENDING_SLOT },
        ];
        const [boston, denver, seattle] = (await record({ batchKey: KEY, statements })).records as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        // Both pending rows are inert on arrival, so Boston is still the only
        // row `lives_in` has and it is still open-ended.
        expect(denver.closes).toEqual([]);
        expect(seattle.closes).toEqual([]);

        // First drain: Denver joins the chain and closes Boston at SEP. The
        // second pending row is untouched and still flags the tenant degraded.
        const first = await reindex({ slots: [{ id: denver.id, slot: LIVES_IN }] });
        expect(first.resolved).toBe(1);
        expect(first.resettled).toEqual([boston.id]);
        expect(first.pending).toBe(1);
        expect(first.degraded).toEqual(['pending']);

        const midway = (await reread(KEY, statements)) as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        expect(midway[0].until).toBe(SEP);
        expect(midway[0].closedBy).toBe(denver.id);
        expect(midway[1].until).toBeUndefined();
        expect(midway[1].closedBy).toBeUndefined();

        // Second drain: Seattle lands BETWEEN the two rows the first call
        // settled, so Boston's closure has to be re-derived off state this
        // hook wrote a moment ago — SEP/Denver, not the open-ended row
        // `record` left. Boston moving to JUN/Seattle is the assertion that
        // an already-settled group really was re-entered; `resolved: 1` next
        // to it rules out a call that simply did nothing.
        const second = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] });
        expect(second.resolved).toBe(1);
        expect(second.resettled).toEqual([boston.id, seattle.id]);
        expect(second.pending).toBe(0);
        expect(second.degraded).toEqual([]);

        // The whole chain, end to end: Boston ends where Seattle starts,
        // Seattle ends where Denver starts, Denver is the one active row.
        const [bostonNow, denverNow, seattleNow] = (await reread(KEY, statements)) as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        expect(bostonNow.until).toBe(JUN);
        expect(bostonNow.closedBy).toBe(seattle.id);
        expect(seattleNow.until).toBe(SEP);
        expect(seattleNow.closedBy).toBe(denver.id);
        expect(denverNow.until).toBeUndefined();
        expect(denverNow.closedBy).toBeUndefined();

        const drained = await recall({ about: 'user', limit: 10 });
        expect(drained.statements.map((s) => s.value)).toEqual(['Denver']);
      });

      // Rule 3 is not suspended just because the row took the scenic route in.
      // Two subjects, so the two directions cannot interfere: under `user` the
      // resolved extracted row is dated BEFORE the human one (rule 2 would
      // bound it at JUN without immunity), and under `partner` it is dated
      // AFTER (rule 1 would close the human row without immunity).
      //
      // One batch, so the human row provably arrives first: re-derivation
      // replays arrivals, and "a human row recorded first is never closed by
      // an extracted one that shows up later" is exactly what is being pinned.
      it('keeps provenance immunity through a reindex, in both directions', async () => {
        const human = (about: string): FactStatementInput => ({
          about,
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: LIVES_IN,
          provenance: 'human',
        });
        const [userHuman, backdated, partnerHuman, later] = (
          await record({
            statements: [
              human('user'),
              {
                about: 'user',
                relation: 'lives_in',
                value: 'Boston',
                when: JAN,
                slot: PENDING_SLOT,
              },
              human('partner'),
              {
                about: 'partner',
                relation: 'lives_in',
                value: 'Denver',
                when: SEP,
                slot: PENDING_SLOT,
              },
            ],
          })
        ).records as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];

        const out = await reindex({
          slots: [
            { id: backdated.id, slot: LIVES_IN },
            { id: later.id, slot: LIVES_IN },
          ],
        });
        // Two rows really were resolved — the empty `resettled` below is a
        // statement about the rules, not about the drain having skipped them.
        expect(out.resolved).toBe(2);
        expect(out.resettled).toEqual([]);
        expect(out.pending).toBe(0);
        expect(out.degraded).toEqual([]);

        const forUser = await recall({ about: 'user', limit: 10 });
        expect(forUser.statements.map((s) => s.id).sort()).toEqual(
          [userHuman.id, backdated.id].sort(),
        );
        const forPartner = await recall({ about: 'partner', limit: 10 });
        expect(forPartner.statements.map((s) => s.id).sort()).toEqual(
          [partnerHuman.id, later.id].sort(),
        );
      });

      // The worst bug available here is un-forgetting something a person asked
      // us to forget. A retracted row (`closed_by IS NULL`, finite `valid_end`)
      // asserts nothing: the re-derivation must leave its own columns alone AND
      // keep it out of the peer set, so it cannot bound the arriving row.
      it('does not resurrect or consult a retracted row dated AFTER the resolved one', async () => {
        const KEY = 'retracted-later';
        const denverStatement: FactStatementInput = {
          about: 'user',
          relation: 'lives_in',
          value: 'Denver',
          when: SEP,
          slot: LIVES_IN,
        };
        const [denver] = (await record({ batchKey: KEY, statements: [denverStatement] }))
          .records as [RecordedStatement];
        expect((await supersede([denver.id])).closed).toEqual([denver.id]);

        const [retracted] = (await reread(KEY, [denverStatement])) as [RecordedStatement];
        expect(retracted.closedBy).toBeUndefined();
        expect(retracted.until).toBeDefined();

        const SEATTLE_KEY = 'resolved-earlier';
        const seattleStatement: FactStatementInput = {
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: PENDING_SLOT,
        };
        const [seattle] = (await record({ batchKey: SEATTLE_KEY, statements: [seattleStatement] }))
          .records as [RecordedStatement];

        const out = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] });
        expect(out.resolved).toBe(1);
        expect(out.resettled).toEqual([]);
        expect(out.pending).toBe(0);

        // The retraction is byte-for-byte what supersede left behind.
        const [retractedNow] = (await reread(KEY, [denverStatement])) as [RecordedStatement];
        expect(retractedNow.closedBy).toBeUndefined();
        expect(retractedNow.until).toBe(retracted.until);

        // ...and it did not bound the row that arrived after it (rule 2 would
        // have ended Seattle at SEP had Denver still been a peer).
        const [seattleNow] = (await reread(SEATTLE_KEY, [seattleStatement])) as [RecordedStatement];
        expect(seattleNow.until).toBeUndefined();
        expect(seattleNow.closedBy).toBeUndefined();
        expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value)).toEqual(
          ['Seattle'],
        );
      });

      it('does not re-close a retracted row dated BEFORE the resolved one', async () => {
        const KEY = 'retracted-earlier';
        const bostonStatement: FactStatementInput = {
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: LIVES_IN,
        };
        const [boston] = (await record({ batchKey: KEY, statements: [bostonStatement] }))
          .records as [RecordedStatement];
        expect((await supersede([boston.id])).closed).toEqual([boston.id]);
        const [retracted] = (await reread(KEY, [bostonStatement])) as [RecordedStatement];

        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: PENDING_SLOT,
        });
        const out = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] });
        expect(out.resolved).toBe(1);
        // Rule 1 WOULD have closed Boston (JAN <= JUN, and its retraction
        // stamp is later than JUN) if a retracted row were still a peer.
        expect(out.resettled).toEqual([]);

        const [retractedNow] = (await reread(KEY, [bostonStatement])) as [RecordedStatement];
        expect(retractedNow.closedBy).toBeUndefined();
        expect(retractedNow.until).toBe(retracted.until);
      });

      // The two cases above each retract a row that had closed NOTHING. This
      // one retracts a CLOSER, and pins the handover between the two hooks:
      // `supersede` re-opens its victim itself, in the call that caused the
      // problem (TASK-448 — the re-OPEN assertion lives in the
      // `memory:facts:supersede` block, over the same `resettleSlotGroups`),
      // and the later drain then has to place the resolved row into the chain
      // that repair left behind rather than the one it found before it.
      //
      // Reading this as "the drain does the repair" is the stale mental model
      // TASK-448 retired: it left the store observably wrong in between, for
      // an unbounded window, since a chain with no pending row was never
      // revisited at all.
      //
      // One batch, so `batch_seq` pins the replay order: Boston, then Seattle,
      // then the pending row. That ordering is what decides where the pending
      // row lands once Seattle is out of the peer set.
      it('places a drained row beneath the row a retraction had already re-opened', async () => {
        const KEY = 'reopened-by-drain';
        const statements: FactStatementInput[] = [
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JUN, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: SEP, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Austin', when: JAN, slot: PENDING_SLOT },
        ];
        const [boston, seattle, austin] = (await record({ batchKey: KEY, statements })).records as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        // Seattle closed Boston on arrival (rule 1); the pending row is inert.
        expect(seattle.closes).toEqual([boston.id]);
        expect(austin.closes).toEqual([]);

        // Retract the CLOSER. Boston would otherwise be left ended at SEP by a
        // row that now asserts nothing — a closure with no authority behind
        // it — so the retraction re-derives the chain and re-opens Boston
        // then and there. The pending row is not in that chain yet.
        expect(await supersede([seattle.id])).toEqual({
          closed: [seattle.id],
          resettled: [boston.id],
        });
        const afterRetraction = (await reread(KEY, statements)) as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        expect(afterRetraction[0].until).toBeUndefined();
        expect(afterRetraction[0].closedBy).toBeUndefined();
        // A retraction, not a rule-closure: finite `until`, no `closedBy`.
        expect(afterRetraction[1].until).toBeDefined();
        expect(afterRetraction[1].closedBy).toBeUndefined();

        const out = await reindex({ slots: [{ id: austin.id, slot: LIVES_IN }] });
        // The positive half: a drain that silently did nothing would leave
        // every row exactly as it is and could never be told apart otherwise.
        expect(out.resolved).toBe(1);
        expect(out.pending).toBe(0);
        expect(out.degraded).toEqual([]);
        // Only the drained row moved — Boston was already repaired, and a
        // second re-derivation of a chain that is already correct writes
        // nothing, which is what keeps `resettled` meaningful.
        expect(out.resettled).toEqual([austin.id]);

        const [bostonNow, seattleNow, austinNow] = (await reread(KEY, statements)) as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        // Still active after the drain: the replay did not re-close the row
        // the retraction freed, and did not re-point it at some other closer.
        expect(bostonNow.until).toBeUndefined();
        expect(bostonNow.closedBy).toBeUndefined();

        // Where the resolved row lands, with Seattle dropped from the peer
        // set: Austin (JAN) is now the EARLIEST row in the chain, so rule 1
        // closes nothing — Boston starts after it — and rule 2 bounds Austin
        // at the earliest later peer, Boston. The backdated row becomes
        // Boston's predecessor rather than its successor.
        expect(austinNow.until).toBe(JUN);
        expect(austinNow.closedBy).toBe(boston.id);

        // ...and the retraction is byte-for-byte what `supersede` left behind.
        expect(seattleNow.until).toBe(afterRetraction[1].until);
        expect(seattleNow.closedBy).toBeUndefined();

        // The user-visible half: Boston is back in the active set, alone.
        const active = await recall({ about: 'user', limit: 10 });
        expect(active.statements.map((s) => s.value)).toEqual(['Boston']);
      });

      // The two cases above put the retraction on a NEIGHBOUR of the resolved
      // row. This one puts it on the resolved row ITSELF — a row that is both
      // pending and retracted, which is reachable because `supersede` closes a
      // row without touching its `slot`, so the drain's worklist still names
      // it. Two forgiving paths crossing, and neither knows about the other.
      //
      // The answer has to be "drained, and inert": the caller derived a slot
      // for it, so the backlog genuinely shrinks (`resolved`/`pending` move),
      // but a retracted row asserts nothing, so the chain it nominally joined
      // must come out of the replay untouched.
      //
      // Two subjects so BOTH ways it could wrongly participate are visible at
      // once, and one batch so `batch_seq` pins which arrived first. Under
      // `user` the retracted row arrives AFTER the healthy one and is dated
      // later — rule 1 would close Boston at JUN. Under `partner` it arrives
      // BEFORE the healthy one and is dated later — rule 2 would bound Denver
      // at JUN instead. Either bug ends with a healthy row carrying an `until`
      // it never earned.
      it('drains a pending row that was also retracted, and lets it assert nothing', async () => {
        const KEY = 'pending-and-retracted';
        const statements: FactStatementInput[] = [
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: PENDING_SLOT },
          { about: 'partner', relation: 'lives_in', value: 'Austin', when: JUN, slot: PENDING_SLOT },
          { about: 'partner', relation: 'lives_in', value: 'Denver', when: JAN, slot: LIVES_IN },
        ];
        const [boston, seattle, austin, denver] = (await record({ batchKey: KEY, statements }))
          .records as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        // Pending on arrival means inert on arrival, in both directions: the
        // pending row closes nothing, and the healthy row that arrives after
        // one is not closed by it either.
        expect(boston.closes).toEqual([]);
        expect(seattle.closes).toEqual([]);
        expect(denver.closes).toEqual([]);

        expect((await supersede([seattle.id, austin.id])).closed.sort()).toEqual(
          [seattle.id, austin.id].sort(),
        );
        const afterRetraction = (await reread(KEY, statements)) as [
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
          RecordedStatement,
        ];
        // A retraction, not a rule-closure: finite `until`, no `closedBy`.
        for (const row of [afterRetraction[1], afterRetraction[2]]) {
          expect(row.until).toBeDefined();
          expect(row.closedBy).toBeUndefined();
        }

        // Retracted or not, their slot was never derived — so they are still
        // on the drain's worklist and the tenant still reads degraded.
        const before = await reindex();
        expect(before.pending).toBe(2);
        expect(before.degraded).toEqual(['pending']);

        const out = await reindex({
          slots: [
            { id: seattle.id, slot: LIVES_IN },
            { id: austin.id, slot: LIVES_IN },
          ],
        });
        // `resolved: 2` and `pending: 0` are the positive half: a backend that
        // skipped retracted rows outright would report `resolved: 0,
        // pending: 2` here, and would satisfy the empty `resettled` below for
        // entirely the wrong reason.
        expect(out.resolved).toBe(2);
        expect(out.resettled).toEqual([]);
        expect(out.pending).toBe(0);
        expect(out.degraded).toEqual([]);

        // Neither healthy row moved — not closed (rule 1, `user`), not bounded
        // (rule 2, `partner`). Both are still the open-ended answer.
        const [bostonNow, seattleNow, austinNow, denverNow] = (await reread(
          KEY,
          statements,
        )) as [RecordedStatement, RecordedStatement, RecordedStatement, RecordedStatement];
        expect(bostonNow.until).toBeUndefined();
        expect(bostonNow.closedBy).toBeUndefined();
        expect(denverNow.until).toBeUndefined();
        expect(denverNow.closedBy).toBeUndefined();
        expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value)).toEqual(
          ['Boston'],
        );
        expect(
          (await recall({ about: 'partner', limit: 10 })).statements.map((s) => s.value),
        ).toEqual(['Denver']);

        // ...and the retractions are byte-for-byte what `supersede` left: the
        // drain wrote their slot, never their closure. Un-forgetting a row a
        // person asked us to forget is the worst bug available here.
        expect(seattleNow.until).toBe(afterRetraction[1].until);
        expect(seattleNow.closedBy).toBeUndefined();
        expect(austinNow.until).toBe(afterRetraction[2].until);
        expect(austinNow.closedBy).toBeUndefined();

        // The slot really was written, so a repeat of the same drain finds
        // nothing pending and is a no-op — the row has left the worklist for
        // good rather than being skipped afresh every pass.
        expect(
          await reindex({
            slots: [
              { id: seattle.id, slot: LIVES_IN },
              { id: austin.id, slot: LIVES_IN },
            ],
          }),
        ).toEqual({ resolved: 0, resettled: [], pending: 0, degraded: [] });
      });

      it('ignores an id belonging to another agent, and leaves that agent\'s row pending', async () => {
        const ctxA = makeCtx('agent-a', 'user-a');
        const ctxB = makeCtx('agent-b', 'user-b');

        const boston = await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: LIVES_IN },
          ctxA,
        );
        const seattle = await recordOne(
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: PENDING_SLOT },
          ctxA,
        );

        const stolen = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] }, ctxB);
        expect(stolen.resolved).toBe(0);
        expect(stolen.resettled).toEqual([]);
        expect(stolen.pending).toBe(0);
        expect(stolen.degraded).toEqual([]);

        // A's row is untouched — still pending, still flagged...
        const statusA = await reindex({}, ctxA);
        expect(statusA.pending).toBe(1);
        expect(statusA.degraded).toEqual(['pending']);

        // ...and still resolvable BY A, which proves B did not write the slot.
        const drained = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] }, ctxA);
        expect(drained.resolved).toBe(1);
        expect(drained.resettled).toEqual([boston.id]);
      });

      it('ignores an id that is no longer pending, and does not move its slot', async () => {
        const seattle = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Seattle',
          when: JUN,
          slot: PENDING_SLOT,
        });
        expect((await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] })).resolved).toBe(1);

        const again = await reindex({ slots: [{ id: seattle.id, slot: 'works_at' }] });
        expect(again.resolved).toBe(0);
        expect(again.resettled).toEqual([]);

        // If the second call HAD moved the row into `works_at`, this later
        // `works_at` row would have closed it.
        const acme = await recordOne({
          about: 'user',
          relation: 'works_at',
          value: 'Acme',
          when: SEP,
          slot: 'works_at',
        });
        expect(acme.closes).toEqual([]);
        expect((await recall({ about: 'user', limit: 10 })).statements.map((s) => s.value).sort()).toEqual(
          ['Acme', 'Seattle'],
        );
      });

      it('counts pending down and drops the degraded flag when the last one drains', async () => {
        const first = await recordOne({
          about: 'user',
          relation: 'lives_in',
          value: 'Boston',
          when: JAN,
          slot: PENDING_SLOT,
        });
        const second = await recordOne({
          about: 'user',
          relation: 'works_at',
          value: 'Acme',
          when: JUN,
          slot: PENDING_SLOT,
        });

        const status = await reindex();
        expect(status).toEqual({ resolved: 0, resettled: [], pending: 2, degraded: ['pending'] });

        const half = await reindex({ slots: [{ id: first.id, slot: LIVES_IN }] });
        expect(half.resolved).toBe(1);
        expect(half.pending).toBe(1);
        expect(half.degraded).toEqual(['pending']);

        // Even a resolve to `null` drains — the row's slot was derived; the
        // answer was "none".
        const done = await reindex({ slots: [{ id: second.id, slot: null }] });
        expect(done.resolved).toBe(1);
        expect(done.pending).toBe(0);
        expect(done.degraded).toEqual([]);
      });

      it('is a pure status read with no slots — it resolves nothing and changes nothing', async () => {
        const KEY = 'status-read';
        const statements: FactStatementInput[] = [
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: PENDING_SLOT },
        ];
        const [boston, seattle] = (await record({ batchKey: KEY, statements })).records as [
          RecordedStatement,
          RecordedStatement,
        ];

        for (const input of [{}, { slots: [] }] as ReindexInput[]) {
          const out = await reindex(input);
          expect(out).toEqual({ resolved: 0, resettled: [], pending: 1, degraded: ['pending'] });
        }

        // Nothing moved: both rows still active, neither carrying a closure.
        const [bostonNow, seattleNow] = (await reread(KEY, statements)) as [
          RecordedStatement,
          RecordedStatement,
        ];
        expect(bostonNow.until).toBeUndefined();
        expect(bostonNow.closedBy).toBeUndefined();
        expect(seattleNow.until).toBeUndefined();
        expect(seattleNow.closedBy).toBeUndefined();

        // And the pending row is still pending — a status read did not quietly
        // consume it, so the real drain still has work to do.
        const drained = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] });
        expect(drained.resolved).toBe(1);
        expect(drained.resettled).toEqual([boston.id]);
      });

      it('is a complete no-op the second time the same drain runs', async () => {
        const KEY = 'idempotent';
        const statements: FactStatementInput[] = [
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: LIVES_IN },
          { about: 'user', relation: 'lives_in', value: 'Seattle', when: JUN, slot: PENDING_SLOT },
        ];
        const [boston, seattle] = (await record({ batchKey: KEY, statements })).records as [
          RecordedStatement,
          RecordedStatement,
        ];

        const first = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] });
        expect(first).toEqual({
          resolved: 1,
          resettled: [boston.id],
          pending: 0,
          degraded: [],
        });
        const afterFirst = await reread(KEY, statements);

        const second = await reindex({ slots: [{ id: seattle.id, slot: LIVES_IN }] });
        expect(second).toEqual({ resolved: 0, resettled: [], pending: 0, degraded: [] });
        // Same rows, same closures, same everything.
        expect(await reread(KEY, statements)).toEqual(afterFirst);
      });

      // Same NUL-joined-key collision as the `supersede` case above
      // (TASK-448), but through the drain's own group map in `plugin.ts`:
      //   about = "x\u0000y", slot = "z"      -> "x\u0000y\u0000z"
      //   about = "x",        slot = "y\u0000z" -> "x\u0000y\u0000z"
      // One `reindex` call resolves a pending row in EACH group. Against the
      // unfixed key, only one group's older row gets re-derived and closed.
      it('settles BOTH groups when their old NUL-joined keys would collide', async () => {
        const KEY1 = 'reindex-nul-collision-1';
        const KEY2 = 'reindex-nul-collision-2';
        const ABOUT1 = 'x\u0000y';
        const SLOT1 = 'z';
        const ABOUT2 = 'x';
        const SLOT2 = 'y\u0000z';

        const older1Stmt: FactStatementInput = {
          about: ABOUT1,
          relation: 'r',
          value: 'old1',
          when: JAN,
          slot: SLOT1,
        };
        const pending1Stmt: FactStatementInput = {
          about: ABOUT1,
          relation: 'r',
          value: 'new1',
          when: JUN,
          slot: PENDING_SLOT,
        };
        const older2Stmt: FactStatementInput = {
          about: ABOUT2,
          relation: 'r',
          value: 'old2',
          when: JAN,
          slot: SLOT2,
        };
        const pending2Stmt: FactStatementInput = {
          about: ABOUT2,
          relation: 'r',
          value: 'new2',
          when: JUN,
          slot: PENDING_SLOT,
        };

        const [older1, pending1] = (
          await record({ batchKey: KEY1, statements: [older1Stmt, pending1Stmt] })
        ).records as [RecordedStatement, RecordedStatement];
        expect(pending1.closes).toEqual([]);

        const [older2, pending2] = (
          await record({ batchKey: KEY2, statements: [older2Stmt, pending2Stmt] })
        ).records as [RecordedStatement, RecordedStatement];
        expect(pending2.closes).toEqual([]);

        const out = await reindex({
          slots: [
            { id: pending1.id, slot: SLOT1 },
            { id: pending2.id, slot: SLOT2 },
          ],
        });
        expect(out.resolved).toBe(2);
        // Against the unfixed NUL-joined key, only ONE of these two groups
        // survives in the Map, so exactly one of these ids is missing here.
        expect(out.resettled.slice().sort()).toEqual([older1.id, older2.id].sort());
        expect(out.pending).toBe(0);
        expect(out.degraded).toEqual([]);

        const [older1Now, pending1Now] = (await reread(KEY1, [older1Stmt, pending1Stmt])) as [
          RecordedStatement,
          RecordedStatement,
        ];
        expect(older1Now.until).toBe(JUN);
        expect(older1Now.closedBy).toBe(pending1.id);
        expect(pending1Now.until).toBeUndefined();
        expect(pending1Now.closedBy).toBeUndefined();

        const [older2Now, pending2Now] = (await reread(KEY2, [older2Stmt, pending2Stmt])) as [
          RecordedStatement,
          RecordedStatement,
        ];
        expect(older2Now.until).toBe(JUN);
        expect(older2Now.closedBy).toBe(pending2.id);
        expect(pending2Now.until).toBeUndefined();
        expect(pending2Now.closedBy).toBeUndefined();
      });

      describe('invalid-payload rejection', () => {
        it('rejects a non-array slots', async () => {
          await expectCode('invalid-payload', () =>
            reindex({ slots: 'lives_in' as unknown as ResolvedSlot[] }),
          );
        });

        it('rejects an empty id', async () => {
          await expectCode('invalid-payload', () => reindex({ slots: [{ id: '', slot: LIVES_IN }] }));
        });

        it('rejects an empty slot — null is how you say "no slot"', async () => {
          await expectCode('invalid-payload', () => reindex({ slots: [{ id: 'x', slot: '' }] }));
        });

        // Resolving a pending row to "pending" is a caller bug (most likely
        // echoing the row back unchanged), not a no-op: accepting it would
        // report `resolved: 1` for a row that is still undrained.
        it('rejects PENDING_SLOT as a resolved slot', async () => {
          await expectCode('invalid-payload', () =>
            reindex({ slots: [{ id: 'x', slot: PENDING_SLOT }] }),
          );
        });

        // Validation runs before a single slot is written, so a bad entry at
        // position 2 cannot leave position 1 applied.
        it('applies nothing at all when a later entry is invalid', async () => {
          const seattle = await recordOne({
            about: 'user',
            relation: 'lives_in',
            value: 'Seattle',
            when: JUN,
            slot: PENDING_SLOT,
          });
          await expectCode('invalid-payload', () =>
            reindex({
              slots: [
                { id: seattle.id, slot: LIVES_IN },
                { id: '', slot: LIVES_IN },
              ],
            }),
          );
          expect(await reindex()).toEqual({
            resolved: 0,
            resettled: [],
            pending: 1,
            degraded: ['pending'],
          });
        });
      });
    });
  });
}
