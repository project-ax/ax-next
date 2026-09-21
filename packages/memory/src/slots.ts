/**
 * The slot vocabulary, and the normalizer that derives a slot from a relation.
 *
 * A slot is the key supersession matches on (design §3.4). `relation` cannot be
 * that key: it is free text — 84,561 distinct values over 130,779 facts, 86.8%
 * of them singletons — and exact matching on it fails in both directions. So the
 * design splits the two jobs: `relation` stays the free-text label retrieval
 * reads, and `slot` is a derived, closed, single-valued key.
 *
 * ---------------------------------------------------------------------------
 * ## THE NORMALIZER IS THE EXACT-SYNONYM TABLE ALONE. No embedder. No LLM.
 *
 * Design §3.3 also proposed an embedding nearest-neighbour behind the table, to
 * catch relations the table does not spell. **That stage was measured at rung 0
 * and killed** (`docs/plans/2026-09-18-dem-rung0-report.md` §2). Do not build
 * it, and do not add a `@ax/embeddings` dependency here to try.
 *
 * The decisive check needed no hand-labelling. Run the nearest-neighbour over
 * this table's OWN keys — which are canonical spellings of their slot, so the
 * answer is known by construction — and it disagrees on **6 of 32**:
 *
 *     first name -> birthday (0.834)     full name -> birthday (0.815)
 *     last name  -> birthday (0.816)     born on   -> name     (0.719)
 *     goes by    -> timezone (0.658)     works as  -> name     (0.647)
 *
 * Those errors score HIGHER than almost every true positive, so no threshold
 * separates them. Hand-checked precision at threshold 0.78 was **13.2%** (7/53,
 * uniform random) and **20.9%** (9/43, top-by-fact-volume); at >= 0.88 the
 * embedding half maps nothing at all, which is to say the survivors ARE this
 * table. The failure is structural rather than a wording accident: eight
 * descriptions partition the whole relation space into eight nearest-neighbour
 * cells and a slot cannot *refuse* a relation, only be further away — so
 * `birthday` became the cell for anything date- or number-shaped about a person
 * (home_address 0.811, death_date 0.813, annual_gross_income 0.799).
 *
 * ## Why under-mapping is the right failure
 *
 * The error here is **asymmetric**. A false positive CLOSES A TRUE FACT and no
 * read path can recover it; a false negative leaves the row with no slot, which
 * is exactly the state the 87.4% baseline was measured in (DEM's supersession
 * fired on 0.11% of rows). Under-closing is the measured status quo.
 * Over-closing is a new way to lose data.
 *
 * So: an exact table hit, or **no slot**. Never a nearest guess.
 *
 * ## Measured coverage — a zero is not a bug
 *
 * Per-slot user-subject coverage over the corpus: `lives_in` 175, `role` 118,
 * `works_at` 51, `birthday` 2, `name` 1, `timezone` 1, and **zero** for
 * `pronouns` and `language`. A zero-coverage slot is not a defect and is not a
 * reason to widen the table.
 */

/**
 * The slot list. Eight entries, **all single-valued**: a person has one current
 * home, one current employer, one birthday. That is the whole justification for
 * "close the previous one".
 *
 * A multi-valued relation (`likes_artist`, `has_sibling`, `visited`) must never
 * gain a slot, because closure would delete true facts — the exact failure the
 * replay found in DEM's `invalidatesPrevious`.
 *
 * **This list IS the profile whitelist of design §4.1** — the same constant, not
 * a copy (CLAUDE.md invariant 4). Adding a slot here makes it appear in the
 * injected profile block; removing one stops it closing rows. The consumer that
 * renders the profile block must import this, and
 * `__tests__/slot-vocabulary.test.ts` fails if a second copy of the list appears
 * anywhere under `packages/`.
 *
 * What each slot means, in words — kept as documentation rather than as an
 * exported `SLOT_DESCRIPTIONS` record, because that record's only ever role was
 * as the killed stage's scoring surface and re-exporting it hands the next
 * reader the embedder's input already assembled:
 *
 * | slot       | the property it holds                                        |
 * |------------|--------------------------------------------------------------|
 * | `name`     | the person's name; what this person is called                |
 * | `pronouns` | the person's pronouns; how this person is referred to        |
 * | `lives_in` | where the person lives — city, country, place of residence   |
 * | `works_at` | the organisation, company or employer they work for          |
 * | `role`     | their job title, role, occupation or profession              |
 * | `timezone` | their time zone                                              |
 * | `language` | the language they speak or prefer to be addressed in         |
 * | `birthday` | their date of birth                                          |
 *
 * The vocabulary is deliberately generic. LongMemEval is a consumer chatting
 * with an assistant and cannot tell us what an ax agent's slots should be;
 * anything domain-shaped (`prefers_backend`) waits for evidence.
 */
export const SLOTS = [
  'name',
  'pronouns',
  'lives_in',
  'works_at',
  'role',
  'timezone',
  'language',
  'birthday',
] as const;

export type Slot = (typeof SLOTS)[number];

/**
 * The reserved `slot` value meaning "the caller's normalizer could not derive a
 * slot yet" (design §3.5). A row carrying it is stored and retrievable but INERT
 * for closure, exactly like a no-slot row, until `memory:facts:reindex` is handed
 * the resolved slot.
 *
 * **Nothing here produces it, and this file is the reason it cannot.** Derivation
 * is a synchronous table lookup with no producer behind it, so there is no
 * "could not reach the embedder" state to defer — {@link deriveSlot} answers a
 * slot or `null`. The constant is declared anyway so the one rule that outlives
 * that fact is testable: `pending` must never be reusable as a real slot, and
 * `__tests__/slot-vocabulary.test.ts` pins that it is not in {@link SLOTS}.
 *
 * DUPLICATED from `@ax/memory-facts-contract`'s `PENDING_SLOT`, deliberately and
 * following the precedent `@ax/memory-facts-sqlite`'s `src/pending.ts` already
 * set. That package is the spelling of record for every backend (invariant 4),
 * but it ships the shared vitest suite and therefore depends on `vitest` at
 * RUNTIME — it is a devDependency here, and `eslint.config.mjs`'s
 * `crossPluginImports` allowlist does not name it, so only `import type` from it
 * is legal in `src/`. A parity test asserts the two spellings are equal, so a
 * drift is a failing test rather than a silent split-brain.
 */
export const PENDING_SLOT = 'pending';

/**
 * `some_relation_name` -> `some relation name`.
 *
 * The extraction contract makes the relation snake_case, so its underscores are
 * separators rather than content. Lowercased and whitespace-collapsed so
 * `Lives_In`, `lives in` and `  lives   in ` all reach the same key.
 */
export function relationToWords(relation: string): string {
  return relation.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Exact spellings that map. This table is the entire normalizer.
 *
 * Deliberately SMALL, and 100% precise by construction: every line is one a
 * person wrote and a reviewer can read. It is not a hand-built ontology, and
 * widening it to chase coverage is how a `visited` gets in.
 *
 * Written as an object literal because that is the readable audit surface, and
 * immediately frozen into a `Map` because that is the safe lookup surface — see
 * {@link SLOT_SYNONYMS}.
 */
const SLOT_SYNONYM_TABLE: Record<string, Slot> = {
  // name
  'name': 'name',
  'full name': 'name',
  'first name': 'name',
  'last name': 'name',
  'is named': 'name',
  'goes by': 'name',
  // pronouns
  'pronouns': 'pronouns',
  'uses pronouns': 'pronouns',
  'preferred pronouns': 'pronouns',
  // lives_in
  'lives in': 'lives_in',
  'lives at': 'lives_in',
  'resides in': 'lives_in',
  'based in': 'lives_in',
  'city of residence': 'lives_in',
  // works_at
  'works at': 'works_at',
  'works for': 'works_at',
  'employed by': 'works_at',
  'employer': 'works_at',
  // role
  'role': 'role',
  'job title': 'role',
  'works as': 'role',
  'occupation': 'role',
  'profession': 'role',
  // timezone
  'timezone': 'timezone',
  'time zone': 'timezone',
  // language
  'language': 'language',
  'preferred language': 'language',
  'native language': 'language',
  // birthday
  'birthday': 'birthday',
  'birth date': 'birthday',
  'date of birth': 'birthday',
  'born on': 'birthday',
};

/**
 * The lookup table, as a `Map`.
 *
 * ⚠ **A `Map`, not the object, and this is a correctness fix rather than a
 * style choice.** `relation` is MODEL OUTPUT (design §6.3 — prompt injection is
 * the threat this design is *for*), and indexing a plain object with attacker-
 * influenced text walks `Object.prototype`: `SLOT_SYNONYM_TABLE['constructor']`
 * is the `Object` constructor, not `undefined`, so a `?? null` behind it is
 * never reached and a statement whose relation is `constructor` would be handed
 * a FUNCTION as its supersession key. `Object.entries` copies own enumerable
 * keys only, so the `Map` holds exactly the lines above and
 * `Map.prototype.get` has no prototype chain to walk.
 */
export const SLOT_SYNONYMS: ReadonlyMap<string, Slot> = new Map(
  Object.entries(SLOT_SYNONYM_TABLE),
);

/**
 * Derive the supersession slot for a relation. `null` means "no slot", which
 * means this statement closes nothing and nothing closes it.
 *
 * Exact table hit or nothing — see the file header for why there is no nearest
 * neighbour behind it. Deterministic, synchronous, and it touches no producer:
 * no embedder, no model, no network, no store.
 *
 * **It cannot throw.** A non-string relation (only reachable across a boundary
 * that erases types — an IPC action, a tool argument) answers `null` rather than
 * raising, because this runs INSIDE the record path: a derivation that threw
 * would take the whole write down with it, which is exactly how TASK-434's
 * embedder bug became a deployment-wide write outage. Degrading here costs one
 * unclosed row.
 */
export function deriveSlot(relation: string): Slot | null {
  if (typeof relation !== 'string') return null;
  return SLOT_SYNONYMS.get(relationToWords(relation)) ?? null;
}
