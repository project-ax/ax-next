/**
 * The caller-facing memory surface — `memory:recall`, `memory:remember`,
 * `memory:forget`.
 *
 * These shapes are the product layer's whole contract with the rest of the
 * system. They are DELIBERATELY not the engine's shapes:
 *
 * - **Provenance is determined by WHICH HOOK was called, never by a payload
 *   field** (design §2.2/§3.4). There is no `provenance` anywhere below, and
 *   `memory:remember` actively REFUSES a payload that carries one. Provenance
 *   immunity (`human > agent > extracted`) is the only thing making a
 *   person's correction survive the next chat mention; a caller that could
 *   write `provenance: 'human'` could make its own note immune to correction.
 * - **`ownerUserId` is not a payload field either.** It is a SCOPE taken from
 *   `ctx`, not a hint taken from a caller (the `@ax/decisions` phrasing). A
 *   caller that could name an owner could read or retract another person's
 *   memory.
 * - **The tenant (`agentId`) is likewise ambient**, from `ctx`.
 *
 * Nothing here names a backend. No `validStart`, `valid_end`, `bankId`,
 * `rerankPool`, `poolSize`, `RRF`, `vec0`, `FTS5` or `cosine` reaches a
 * payload (CLAUDE.md invariant 1, and the boundary review in design
 * Appendix B).
 */

/**
 * The statement's epistemic category, straight from the extractor.
 *
 * **Optional passthrough, end to end.** `kind` is in the extraction prompt
 * that scored 87.4% and has no measured consumer beyond evidence rendering,
 * so design §10.6 settled that it is carried rather than consumed: the
 * extractor's `network` becomes `kind`, the engine stores it verbatim on
 * `FactStatementInput`/`FactRecord`, and `memory:recall` forwards it. Absent
 * means absent at every hop — a row recorded without one (a human
 * `memory:remember`, a legacy row) comes back with no kind, never an invented
 * `'world'`.
 */
export type MemoryStatementKind = 'world' | 'experience' | 'observation' | 'opinion';

/** One recalled statement, as `memory:recall` renders it. */
export interface MemoryStatement {
  id: string;
  /** Canonical subject. The speaker arrives already rewritten (see `subject.ts`). */
  about: string;
  /** Free text — what retrieval reads. Never a key. */
  relation: string;
  value: string;
  /** ISO-8601 instant the statement became true. */
  when: string;
  /** Set only when this statement has been closed by a later one. */
  until?: string;
  /** See {@link MemoryStatementKind} — absent when the row has none. */
  kind?: MemoryStatementKind;
}

/**
 * ⚠ **`at` is deliberately absent, and the design table is why it looks
 * missing.** Design §2.2's hook row reads `{query?, about?, at?, activeOnly?,
 * limit}`, but §4.2 is the section that decides: point-in-time travel
 * (`at`/`temporalAnchor`) is "the footgun §4.2 keeps off the agent-facing
 * tool", and neither engine implements it — `@ax/memory-facts-contract`'s
 * `RecallInput` has no `at` and says so in as many words. Declaring one here
 * would be a field with nothing behind it: a caller sets it, gets a `200`, and
 * silently receives the un-travelled answer.
 *
 * `activeOnly: false` is the supported neighbour — history, not time travel.
 * It returns closed rows alongside active ones so a question about a
 * TRANSITION ("when did I change jobs") is answerable, without letting a
 * caller ask what we believed on some particular Tuesday.
 *
 * Re-adding `at` is a hook-surface change and needs the engines first. Do not
 * add it here as a passthrough.
 */
export interface MemoryRecallInput {
  /**
   * Free text to retrieve by. Present, the answer is ranked by relevance;
   * absent, it is the recency listing. Whether ranked retrieval is available
   * at all is the engine's business, and its absence surfaces through
   * {@link MemoryRecallOutput.degraded} rather than silently.
   */
  query?: string;
  /**
   * Narrow to one subject. `'user'` is rewritten to the caller's own subject
   * key exactly as a write is, so a read finds what a write stored.
   */
  about?: string;
  /** Defaults to `true` — only currently-active statements. */
  activeOnly?: boolean;
  /** Defaults to {@link DEFAULT_RECALL_LIMIT}. */
  limit?: number;
}

export interface MemoryRecallOutput {
  statements: MemoryStatement[];
  /**
   * What was degraded about THIS answer — empty when nothing was (design
   * §4.4). Passed through from the engine **verbatim**: not re-derived, not
   * re-ordered, not filtered, not "corrected".
   *
   * Typed as `string[]` rather than a copy of the engine's flag union on
   * purpose. The vocabulary is the engine's to grow, and a local copy of the
   * union here would be a second source of truth for it (invariant 4) that
   * silently dropped any flag a newer engine raised.
   *
   * ⚠ **The asymmetry is intentional — do not "fix" it.** On an empty store
   * with no providers a fusion backend raises `'semantic'` but not
   * `'ranking'`, because embedding is store-independent (the *query* is
   * embedded) while reranking is pool-dependent (there is no pool to
   * reorder). It is pinned by an engine contract case.
   */
  degraded: string[];
}

export interface MemoryRememberInput {
  about: string;
  relation: string;
  value: string;
  /** ISO-8601 with an explicit offset. Defaults to now. */
  when?: string;
}

export interface MemoryRememberOutput {
  id: string;
}

export interface MemoryForgetInput {
  ids: string[];
}

/**
 * Deliberately empty. `memory:forget` reports no per-id outcome: an id this
 * caller does not own is REFUSED by not taking effect, and saying which ids
 * were refused would hand a caller an existence oracle for other people's
 * statements. The honest caller cannot hit the case — `memory:recall` is
 * owner-scoped, so the only ids it has ever seen are its own.
 */
export type MemoryForgetOutput = Record<string, never>;

/**
 * How many statements `memory:recall` returns when the caller names no limit.
 * A ceiling the engine may lower further; never a target.
 */
export const DEFAULT_RECALL_LIMIT = 20;
