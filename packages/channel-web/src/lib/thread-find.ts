/**
 * Finding something in a long agent thread (TASK-354).
 *
 * Conversations live inside agents now and compaction folds them, so "what did
 * it say three weeks ago" is a question this surface gets asked more than chat
 * ever was. This module is the whole of the answer's logic: it is pure, it is
 * client-side, and it looks only at the thread the reader already has on
 * screen.
 *
 * WHAT THIS IS NOT. It is not a port of chat's `SearchBar` / `search-store.ts`.
 * Those never filtered anything — `search-store.ts` says so in its own header
 * ("actual message-text filtering is deferred until assistant-ui exposes a
 * stable message-iteration API") — so porting them would have ported an
 * affordance that lies about what it does.
 *
 * And it is deliberately not the front half of a server-side search. There is
 * no route, no index, no embeddings, no cross-conversation reach, and nothing
 * here is shaped to grow one quietly: `buildFindIndex` takes the array the
 * component is already rendering and returns numbers about it. Searching every
 * conversation an agent ever had is a real feature with a real backend decision
 * behind it, and it deserves its own design rather than a disabled control
 * here implying one exists.
 *
 * ONE MATCHER, TWO READERS. The bar prints a count and the renderer paints
 * marks. Both call `findRanges`, so they cannot disagree about what matched —
 * a reader told "4 matches" who can only see three has been lied to twice.
 */
import type { ThreadMessage } from '@/lib/workspace-types';

/** Half-open `[start, end)` offsets into the string that was searched. */
export interface FindRange {
  start: number;
  end: number;
}

/**
 * Every place `needle` occurs in `haystack`, in order, without overlapping.
 *
 * The query is LITERAL text, never a pattern. People searching a transcript for
 * `(per run)` or `.*` mean those characters; a `RegExp` built from the query
 * would either throw on the first unbalanced paren or match something the
 * reader never typed.
 *
 * NON-OVERLAPPING because the ranges are painted as DOM nodes: 'aaaa' contains
 * three 'aa' but only two can be drawn, and a count of three over two marks is
 * the exact drift this module exists to prevent.
 *
 * THE LOWERCASE TRAP. Case-insensitive matching normally means searching a
 * lowercased copy — but `String.prototype.toLowerCase` is not length-preserving
 * in Unicode ('İ' lowercases to two code units, `i` + a combining dot), so the
 * offsets found in the copy would point one character to the left of the truth
 * in the original for every match after it, and the highlight would land on the
 * wrong letters. When the copy's length differs we fall back to a
 * case-SENSITIVE scan of the original, which is a smaller wrong than a
 * confidently misplaced highlight.
 *
 * Be honest about the size of that smaller wrong: the fallback drops case
 * insensitivity for the WHOLE message, not just around the offending character.
 * One 'İ' anywhere in a turn makes every search of that turn case-sensitive,
 * which can silently miss a match the reader can see. Both lengths are checked
 * because only an expanding needle and an expanding haystack together could
 * cancel out — no known mapping CONTRACTS, so this is belt and braces.
 */
export function findRanges(haystack: string, needle: string): FindRange[] {
  const out: FindRange[] = [];
  if (needle.length === 0 || haystack.length === 0) return out;

  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const lengthPreserved =
    lowerHay.length === haystack.length && lowerNeedle.length === needle.length;
  const hay = lengthPreserved ? lowerHay : haystack;
  const pin = lengthPreserved ? lowerNeedle : needle;

  let from = 0;
  for (;;) {
    const at = hay.indexOf(pin, from);
    if (at === -1) return out;
    out.push({ start: at, end: at + pin.length });
    from = at + pin.length;
  }
}

/** One searchable run of text, keyed by the node that renders it. */
export interface FindField {
  key: string;
  text: string;
}

/**
 * The key a rendered message and the index agree to call the same field by.
 *
 * It carries the message's POSITION as well as its id, and the position is the
 * load-bearing half. The whole count-cannot-drift-from-the-marks argument rests
 * on every field having a distinct key: if two messages shared one, the later
 * `firstMatch.set` would overwrite the earlier, both renderers would number
 * their marks from the second base, and the thread could show two "current"
 * matches or none while the bar reported a total that fits neither.
 *
 * Ids ARE unique today — the server's are turn ids, and the client's handful of
 * transient ones (`pending-user`, `pending-agent`, `pending-status`,
 * `past-loading`) are distinct constants. But that is an invariant held in four
 * other files, and this module's one job is to not depend on invariants it
 * cannot see. Position is unique by construction.
 */
export function findFieldKey(index: number, id: string): string {
  return `${index}:${id}`;
}

/**
 * The text of the thread that a reader can actually see, in render order.
 *
 * WHAT IS IN: `user` and `agent` turns — in production these are the only two
 * kinds that reach this wire at all (`buildThread` in `routes-workspace.ts`
 * emits nothing else) — plus a `steps` turn's bubble text and the `fold`
 * marker, both of which render as ordinary always-visible prose.
 *
 * WHAT IS OUT, and why each:
 *
 *   - `status` — the transient placeholder this client invents while a reply is
 *     in flight ('Thinking…', 'Opening…'). It is chrome, not something the
 *     agent said, and counting it would make the total tick up mid-stream and
 *     back down when the turn lands: a number that moves on its own.
 *   - `approval` — an approval card carries no text of its own. Its words come
 *     from the GLOBAL decisions queue, which is a separate fetch, and a pointer
 *     whose row has not arrived renders nothing at all. A count that included
 *     them would change when an unrelated read landed.
 *
 *     STATE THE COST PLAINLY: an approval card DOES render visible prose (the
 *     decision's summary), so a reader looking at "Deploy the site?" on a card
 *     and searching "deploy" is told "No matches" about text on their own
 *     screen. That is a real limitation, accepted because the alternative is a
 *     count that moves on its own. If it starts to bite, the fix is to make the
 *     queue read part of this thread's read, not to reach into `decisions` from
 *     here.
 *   - a `steps` turn's `stepsLabel` and `steps[]` — that panel is COLLAPSIBLE
 *     (it renders open and the reader can shut it), so a count including it can
 *     name a match that is not on the screen at the moment it is counted.
 */
export function threadFindFields(thread: readonly ThreadMessage[]): FindField[] {
  const out: FindField[] = [];
  thread.forEach((m, index) => {
    switch (m.kind) {
      case 'user':
      case 'agent':
      case 'steps':
      case 'fold':
        out.push({ key: findFieldKey(index, m.id), text: m.text });
        break;
      case 'status':
      case 'approval':
        break;
    }
  });
  return out;
}

export interface FindIndex {
  /** How many matches there are in the whole thread. */
  total: number;
  /**
   * For each field that matched, where its FIRST match falls in the thread-wide
   * numbering. A field's nth match is therefore `firstMatch.get(key)! + n`,
   * which is how the renderer knows whether a given mark is the one the reader
   * is standing on without anyone having to number the marks twice.
   */
  firstMatch: ReadonlyMap<string, number>;
}

/**
 * Count the thread's matches and number them in reading order.
 *
 * A query that is blank once trimmed is not a query — it is a reader who opened
 * the bar, or leaned on the space bar — so it matches nothing rather than
 * matching every space in the transcript. The query is otherwise used verbatim,
 * because ' the ' with its spaces is a perfectly good thing to look for.
 */
export function buildFindIndex(
  thread: readonly ThreadMessage[],
  query: string,
): FindIndex {
  const firstMatch = new Map<string, number>();
  if (query.trim().length === 0) return { total: 0, firstMatch };

  let total = 0;
  for (const field of threadFindFields(thread)) {
    const hits = findRanges(field.text, query).length;
    if (hits === 0) continue;
    firstMatch.set(field.key, total);
    total += hits;
  }
  return { total, firstMatch };
}

/**
 * Where the reader is standing, normalized.
 *
 * `step` is a free-running counter the bar bumps on next/prev, so it is allowed
 * to run off either end and past the total the thread had a moment ago (a
 * streaming reply changes the total underneath it). Wrapping here — rather than
 * clamping at the call sites — is what makes "next" at the last match go back
 * to the first instead of dead-ending on a button that stops working.
 *
 * Returns -1 when there is nothing to stand on.
 */
export function activeMatch(step: number, total: number): number {
  if (total <= 0) return -1;
  return ((step % total) + total) % total;
}
