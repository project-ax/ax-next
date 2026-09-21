// "Is this an answer?" — the shape checks every remote driver runs on a
// provider response before it becomes a vector or a score.
//
// These live apart from `remote.ts` on purpose: that file is about TRANSPORT
// (which URL, which header, when to give up), this one is about TRUST. A
// provider response crosses a trust boundary (Invariant 5), so it is checked
// rather than cast, and both drivers — plus whatever third one lands next —
// check it the same way in one place.
//
// Every function here answers `undefined` for every malformed input and throws
// for none of them. That is the contract the consumer is built on: its
// `embedTexts`/`rerankDocuments` treat a nullish producer answer as "the
// producer did not answer" and degrade, while a THROW out of a producer is a
// far blunter instrument.

/**
 * Loose `== null`, NOT `=== undefined`, and that is deliberate everywhere in
 * this file.
 *
 * `HookBus.call` returns a handler's raw value when the hook declares no
 * `returns` schema (ours declares none), and `JSON.parse` happily produces
 * `null` for a body of `null` — so a `null` travels all the way here intact. A
 * strict `=== undefined` is `false` for it, control falls through to
 * `value.length`, and the TypeError escapes from outside anybody's try. That
 * exact bug, on the consumer side, briefly turned one misconfigured provider
 * into a deployment-wide WRITE outage on TASK-434 — see the same comment on
 * `packages/memory-facts-sqlite/src/producers.ts`'s `embedTexts`.
 *
 * HONESTY ABOUT WHICH GUARD ACTUALLY FIRES (TASK-487 mutation pass): today it
 * is not this one. Every call site below reads `isNullish(x) || !Array.isArray(x)`,
 * and `Array.isArray` is already `false` for `null` — so flipping this function
 * to `=== undefined` changes no observable behavior and no test can catch it.
 * It is an equivalent mutant, not a coverage gap.
 *
 * It stays anyway, and the reason is the one above: the moment a call site
 * stops being an array check — a scalar score, a `{ data: [...] }` envelope, a
 * `.length` read — `Array.isArray` stops covering `null` and this becomes the
 * only thing standing between a provider's `null` and a TypeError that escapes
 * the handler. `validate.test.ts` pins the PAIR jointly: remove both and it
 * goes red on the throw.
 */
function isNullish(value: unknown): boolean {
  return value == null;
}

/**
 * `expectedCount` vectors of exactly `dimensions` finite numbers, or
 * `undefined`.
 *
 * The count check is not pedantry: a short batch silently misaligns vectors
 * with their texts, so text 3 gets text 4's embedding forever. The width check
 * is the fixed-width `vec0` column the consumer writes into — a wrong width is
 * rejected there too, and we would rather it never travel.
 */
export function validateVectors(
  value: unknown,
  expectedCount: number,
  dimensions: number,
): number[][] | undefined {
  if (isNullish(value) || !Array.isArray(value)) return undefined;
  if (value.length !== expectedCount) return undefined;
  const vectors: number[][] = [];
  for (const entry of value) {
    if (isNullish(entry) || !Array.isArray(entry)) return undefined;
    if (entry.length !== dimensions) return undefined;
    for (const component of entry) {
      // `typeof` first: `Number.isFinite('1')` is `false`, but
      // `Number.isFinite` on a boxed/coerced value is not a type check, and a
      // string that slips through compares as garbage in the vector index.
      if (typeof component !== 'number' || !Number.isFinite(component)) return undefined;
    }
    vectors.push(entry as number[]);
  }
  return vectors;
}

/** Exactly `expectedCount` finite numbers, or `undefined`. */
export function validateScores(value: unknown, expectedCount: number): number[] | undefined {
  if (isNullish(value) || !Array.isArray(value)) return undefined;
  if (value.length !== expectedCount) return undefined;
  for (const score of value) {
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
  }
  return value as number[];
}
