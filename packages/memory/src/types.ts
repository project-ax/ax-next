/**
 * The caller-facing memory surface — `memory:recall`, `memory:remember`,
 * `memory:correct`, `memory:forget`.
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
 *   memory. On a personal agent it is also the READ filter; on a team agent
 *   the read filter is the agent itself and `ownerUserId` is attribution.
 * - **Sharing is never a payload field either.** No `scope`, `visibility`,
 *   `teamId` or `agentId` below: whether memory is shared is a property of
 *   the resolved agent (`agents:resolve` on every call), not of the request.
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
  slot?: string;
  closedBy?: string;
  /**
   * Why a row is not current. `replaced`/`forgotten`/`retracted` describe a
   * closed row (`until` set):
   *
   * - `replaced` — a later row in the same slot closed it (`closedBy`).
   * - `forgotten` — a person retracted it (`memory:forget`), which says
   *   nothing about whether it once held.
   * - `retracted` — a person said it was NEVER right (`memory:correct` with
   *   `reason: 'never-right'`). Same closure columns as `forgotten`; told
   *   apart by the engine's stored never-true bit, never by guessing.
   *
   * `overridden` appears only on history reads (`activeOnly: false`), on a
   * row that is still ACTIVE but that the equivalent active read hides
   * because a higher-provenance row outranks it.
   */
  closure?: 'replaced' | 'forgotten' | 'retracted' | 'overridden';
  /**
   * Who saved a row that was not extracted from a conversation: `person` for
   * `memory:remember`, `agent` for `memory_note`. Absent for extracted rows
   * and unknown provenance. A read-only display coarsening of provenance —
   * provenance itself is still never accepted on any input payload.
   */
  savedBy?: 'person' | 'agent';
  whenText?: string;
  aboutText?: string;
  /**
   * A 1-based ordinal LOCAL TO ONE ANSWER. Two statements carrying the same
   * number in the same `memory:recall` answer were recorded in the same
   * conversation; that is all this number claims. It is not an id, it is not
   * stable across answers (a different recall may hand the same underlying
   * conversation a different number, or none at all if it falls outside the
   * page), and it reveals nothing about WHICH conversation a row came from —
   * the raw conversation id never reaches this payload. Absent when the row
   * was recorded outside a conversation (`memory:remember`, `memory_note`
   * without one) or during a routine run, whose hidden per-fire conversation
   * is not one the person had (TASK-616) — otherwise skill-reflection's own
   * passes would count toward the gate below.
   *
   * Exists so recurrence — "this procedure showed up in 2+ distinct
   * conversations", the gate the `skill-reflection` routine reads — is
   * answerable from `memory:recall` alone, without handing callers a
   * conversation id to key off of.
   */
  conversation?: number;
  /**
   * The source turn's id in the conversation's display log — the id the chat
   * UI keys its messages on, so a feed can point at the message a statement
   * came from (TASK-626). Opaque: memory never parses it. Present only on
   * rows extracted incrementally from the canonical transcript (TASK-625);
   * absent on `chat:end`-only extraction, `memory:remember` and
   * `memory_note` rows.
   */
  sourceTurnId?: string;
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
  profile?: boolean;
  /** Defaults to {@link DEFAULT_RECALL_LIMIT}. */
  limit?: number;
  /**
   * Only the statements extracted from THIS conversation — the feed behind
   * "What I learned in this chat" (TASK-626). A non-empty string when set;
   * cannot combine with `query` or `profile`.
   *
   * Always owner-scoped to the caller, on a team agent too: a conversation
   * belongs to one person, so the answer is only the caller's own rows from
   * it, and a teammate's conversation id answers nothing rather than their
   * facts. The id is an opaque handle the caller already holds; it is a
   * filter, never an authority field — ownership still comes from `ctx`.
   */
  conversationId?: string;
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
  visibility?: 'personal' | 'team';
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

/**
 * `memory:correct` — a person fixing ONE memory they were shown, and saying
 * why it was wrong.
 *
 * Provenance is `human` because of the hook, exactly as for
 * `memory:remember`; it is never a field, and a payload carrying one is
 * refused. `when` is deliberately absent: a correction is true from now.
 *
 * - `id` names the row being corrected — the id `memory:recall` handed out.
 *   It is a scope-checked reference, not a capability: on a personal agent a
 *   row owned by somebody else is not retracted (the owner scope goes down
 *   with the call, as for `memory:forget`), and the correction write still
 *   lands under the caller.
 * - `reason: 'changed'` — the old value WAS true and stopped being. This is
 *   exactly the `memory:remember` write: the slot rule closes the old row as
 *   `replaced`. ⚠ Known limitation: a SLOT-LESS old row closes nothing and is
 *   closed by nothing, so it stays active beside the new one.
 * - `reason: 'never-right'` — the old value was never true. The old row is
 *   retracted as never-true BEFORE the new write, so the `(about, slot)`
 *   chain re-settles around it: whatever it had closed re-opens, and the
 *   correction then closes THAT row. Boston → Seattle (wrong) → Denver reads
 *   Boston replaced by Denver, Seattle `retracted`.
 *
 * `reason` is required: the hook does not guess which of the two a person
 * meant.
 *
 * ⚠ **Failure window.** never-right is two engine calls. If the retract
 * lands and the write fails, the old row is retracted and the new value is
 * unsaved, and the caller sees the error. A retry converges: the second
 * retract is a no-op (the row is no longer active) and the write lands.
 */
export interface MemoryCorrectInput {
  id: string;
  about: string;
  relation: string;
  value: string;
  reason: 'changed' | 'never-right';
}

/** The id of the NEW row the correction wrote. */
export interface MemoryCorrectOutput {
  id: string;
}

export interface MemoryForgetInput {
  ids: string[];
}

/**
 * Deliberately empty. `memory:forget` reports no per-id outcome: an id this
 * caller may not touch is REFUSED by not taking effect, and saying which ids
 * were refused would hand a caller an existence oracle. The honest caller
 * cannot hit the case — on a personal agent `memory:recall` is owner-scoped
 * so the only ids it has ever seen are its own, and on a team agent every id
 * it has seen is one it may retract.
 */
export type MemoryForgetOutput = Record<string, never>;

/**
 * `memory:unforget` input (TASK-630) — Undo for a Forget. Puts the forgotten
 * memories back AS THEY WERE: same id, and the same "who saved it" — an
 * agent-saved memory comes back agent-saved, not re-saved as the person who
 * pressed Undo. Scoped exactly like `memory:forget`: whoever could forget a
 * memory can bring it back, and nobody else.
 */
export interface MemoryUnforgetInput {
  ids: string[];
}

/**
 * `restored` lists the ids that are no longer forgotten, in the caller's
 * order. An id that was not forgotten (still in effect, replaced by a newer
 * value, missing) or that the caller may not touch is simply absent.
 *
 * Unlike `memory:forget`, this names ids, because Undo has to know whether it
 * worked. That is no existence oracle: an id outside the caller's scope is
 * absent whether it exists or not, and every id inside it is one the caller
 * can already read back from its own History.
 */
export interface MemoryUnforgetOutput {
  restored: string[];
}

/**
 * `memory:status` output — whether background extraction is working for the
 * CALLER. Answers only for `ctx.userId`; the input carries no user id, so no
 * caller can probe another person's state.
 *
 * `'ok'` means "not known to be paused", not "verified working": right after
 * a host restart, before any `chat:end` has run, every user reads `'ok'`.
 *
 * `conversation` is present only when the input named a `conversationId`
 * (TASK-626): the caller's own extraction state for that conversation, read
 * from the same tracker `memory:conversation-activity` is fired from. It has
 * no `'paused'` — pausing is per user and is `extraction` above, one source
 * of truth.
 */
export type MemoryStatusOutput = (
  | { extraction: 'paused'; reason: 'missing-credential' }
  | { extraction: 'ok' }
) & { conversation?: { state: MemoryConversationExtractionState } };

/**
 * `memory:status` input. Every field optional, and `{}` / no input at all
 * mean what they always did. There is deliberately no user id: the answer is
 * for `ctx.userId`, so nobody can probe another person's state.
 */
export interface MemoryStatusInput {
  /** A non-empty string when set. Adds `conversation` to the output. */
  conversationId?: string;
}

/**
 * A conversation's extraction state as `memory:status` reports it. Absent
 * any tracked pass, `'idle'` — including right after a host restart, since
 * the tracker is in-process.
 */
export type MemoryConversationExtractionState = 'idle' | 'extracting' | 'failed';

/**
 * Payload of `memory:conversation-activity` (TASK-626), fired by
 * `@ax/memory` around each incremental extraction pass that had new turns to
 * extract — never for a routine run, never for a pass with nothing new.
 *
 * - `extracting` — a pass started;
 * - then EXACTLY ONE of: `recorded` (with the ids written), `idle` (the pass
 *   finished without recording — nothing durable, a timeout, an unreadable
 *   answer; those turns are done), `failed` (something threw; the turns are
 *   retried by the next pass), or `paused` (the caller has no usable
 *   credential — see `memory:status.extraction`).
 *
 * `statementIds` only on `recorded`. Never statement text: the rows come from
 * untrusted dialogue, and a subscriber is free to log its payload. Read them
 * back with `memory:recall({ conversationId })`, which is owner-scoped.
 */
export interface MemoryConversationActivity {
  conversationId: string;
  userId: string;
  state: 'extracting' | 'recorded' | 'idle' | 'failed' | 'paused';
  statementIds?: string[];
}

/**
 * How many statements `memory:recall` returns when the caller names no limit.
 * A ceiling the engine may lower further; never a target.
 */
export const DEFAULT_RECALL_LIMIT = 20;
