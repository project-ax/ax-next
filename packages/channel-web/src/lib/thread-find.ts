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
 * marks. Both call `fieldRanges`, so they cannot disagree about what matched —
 * a reader told "4 matches" who can only see three has been lied to twice.
 *
 * `fieldRanges` is `findRanges` for a field drawn as a plain string, and
 * `markdownFindRanges` for one drawn through `<Markdown>` (TASK-405 — an agent
 * turn is parsed before it is drawn, so only the matches that survive parsing
 * can carry a `<mark>`). The choice is made ONCE, from `field.markdown`, which
 * is written in one place and read in two.
 */
import { isOpenDecision, type Decision, type ThreadMessage } from '@/lib/workspace-types';
import { HOST_WALL_EXPLANATION, grantTitle } from '@/lib/grant-copy';
import { isRenderedRange, markdownTextRuns } from '@/lib/markdown-find';
import type { WorkspaceGrant } from '@/lib/workspace-grant-store';

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
 * which can silently miss a match the reader can see.
 *
 * ONLY THE HAYSTACK'S LENGTH IS CHECKED, and an earlier draft that also checked
 * the needle's was wrong — it cost matches for nothing. The haystack is the
 * string the offsets index into, so if it lowercases one-for-one then positions
 * in the copy ARE positions in the original, and a run of `pin.length`
 * characters in the copy is the same run of characters in the original however
 * long the needle became. Checking the needle too only forced a needle like
 * 'İ' down the case-sensitive path, missing a hit the copy would have found.
 * (A contraction would break the 1:1 argument, but `toLowerCase` has no
 * contracting mappings — a sweep of every BMP and astral code point finds
 * exactly one that expands, U+0130, and none that shrink.)
 */
export function findRanges(haystack: string, needle: string): FindRange[] {
  const out: FindRange[] = [];
  if (needle.length === 0 || haystack.length === 0) return out;

  const lowerHay = haystack.toLowerCase();
  const positionsHold = lowerHay.length === haystack.length;
  const hay = positionsHold ? lowerHay : haystack;
  const pin = positionsHold ? needle.toLowerCase() : needle;

  let from = 0;
  for (;;) {
    const at = hay.indexOf(pin, from);
    if (at === -1) return out;
    out.push({ start: at, end: at + pin.length });
    from = at + pin.length;
  }
}

/**
 * Every match in `markdown` that will survive into the rendered output
 * (TASK-405).
 *
 * The same `findRanges` result, filtered to the matches that lie wholly inside
 * one rendered text run. That filter is what keeps the count and the marks two
 * readings of one calculation now that an agent turn is PARSED before it is
 * drawn: `**` is a real match in the source and can never carry a `<mark>`, and
 * a match straddling `**` could only carry two. `markdown-find.ts` explains the
 * mapping and the gap it leaves.
 *
 * Lives here rather than in `markdown-find.ts` for one reason: this module owns
 * matching ("ONE MATCHER, TWO READERS", above), and a second file exporting a
 * second range function is how a third one appears.
 */
export function markdownFindRanges(markdown: string, needle: string): FindRange[] {
  const all = findRanges(markdown, needle);
  if (all.length === 0) return all;
  const runs = markdownTextRuns(markdown);
  return all.filter((range) => isRenderedRange(range, runs));
}

/** One searchable run of text, keyed by the node that renders it. */
export interface FindField {
  key: string;
  text: string;
  /**
   * True when the node that renders this field renders it as MARKDOWN, so the
   * field's matches go through `markdownFindRanges` rather than `findRanges`.
   * Set by `threadFindFields` for the kinds `AgentConversation` draws through
   * `<Markdown>`; every other field is drawn as a plain string and is matched
   * as one.
   */
  markdown?: boolean;
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
 *
 * AND THE SAME KEY IS REACT'S KEY, which is the half an earlier draft missed.
 * Making the INDEX independent of id-uniqueness while the renderer still said
 * `key={m.id}` bought nothing: on a duplicate id React drops or duplicates a
 * `Message`, the painted marks stop matching the total the index computed, and
 * that is precisely the count-vs-marks drift this key exists to make
 * impossible — reintroduced one line below the claim. Both now read the same
 * key, so the claim covers the whole path.
 *
 * The cost of a position-bearing React key is a remount whenever a message's
 * POSITION changes. TURNS only ever grow at the end (streaming appends, and
 * the turn-end re-read swaps the transient rows for server ones at the tail) —
 * but the server appends approval pointers after every turn, so a new turn
 * lands ABOVE an open card, and an earlier version of this note that called the
 * whole thread append-only hid exactly that remount (TASK-543: it dropped a
 * reopened question's focus). `keepAnsweredApprovals` now holds each pointer in
 * its previous slot across a re-read, so ordinary use remounts nothing. A compaction rewrite that replaces the head does remount the tail,
 * and what that costs is now ONE thing rather than nothing (TASK-352, which
 * gave the `steps` variant its first producer): `Steps` is an uncontrolled
 * `Collapsible defaultOpen`, so a reader who had shut a step panel finds it
 * open again after such a rewrite. That is a lost preference on a rare event,
 * not lost data, and lifting the flag into state keyed by something stabler is
 * a worse trade than the count-vs-marks drift this key exists to prevent.
 * `ApprovalCard`'s `useDecisionClock` still costs nothing — it is derived from
 * `Date.now()` and the decision row, so a remount re-reads the clock rather
 * than losing a countdown.
 */
export function findFieldKey(index: number, id: string): string {
  return `${index}:${id}`;
}

/**
 * The prefix a grant's find-index entries share (TASK-390) — `grant:${key}`,
 * not a `ThreadMessage` position, because grants are not thread turns at all
 * (see `grantFindFields` below). Exported so `AgentConversation` computes the
 * exact same base it hands to `GrantRow`, rather than a second literal
 * `` `grant:${g.key}` `` living in two files.
 */
export function grantFieldKeyBase(grantKey: string): string {
  return `grant:${grantKey}`;
}

/**
 * A grant's visible prose, as find-index entries (TASK-390).
 *
 * Grants are not `ThreadMessage`s — `AgentConversation` takes them as a
 * separate `grants` prop off a presence-routed store (see
 * `workspace-grant-store.ts`) and renders them below the transcript, out of
 * band. They are appended here in the same position: last, because that is
 * where `AgentConversation` draws them.
 *
 * TITLE comes from `lib/grant-copy.ts`'s `grantTitle`, the SAME function
 * `GrantRow.tsx` calls to decide what to render — one computation, not two
 * copies that could drift (invariant 4).
 *
 * ONLY THE TITLE, EVEN THOUGH THE MAIN RENDER SHOWS MORE (description, the
 * packages line, the reassurance line). This function sees `WorkspaceGrant` —
 * the STORE's data — and the store has no `stalled` field: that flag is
 * `GrantRow`'s own local React state, set after a `connect()` whose resume
 * failed (TASK-374), and the row STAYS ON SCREEN wearing only its title and
 * `GRANT_NOT_RESUMED` — "drops everything else — the reach badges, the key
 * field, the reassurance line" (`GrantRow.tsx`'s own comment). An earlier
 * version of this function indexed description/packages/reassurance
 * unconditionally: while a grant sat stalled, that indexed a reassurance- or
 * packages-line word with no `<mark>` on screen to match it — count > marks,
 * the exact lie this file exists to prevent, and newly introduced by TASK-390
 * rather than inherited. Title survives every render arm (host, main,
 * stalled), so it is the only field safe to index without also threading
 * stalled-ness up into the store. If description/packages/reassurance start
 * to matter, the fix is to make `stalled` visible to the indexer (lift it
 * into the store, or pass a stalled-keys set into `buildFindIndex`), not to
 * index them and hope the state never diverges.
 *
 * DELIBERATELY NOT INDEXED, for the same or a smaller reason: description,
 * the packages line, the reassurance line (see above), the `stalled` sentence
 * itself, slot labels/hints, badges, the authored-warning banner, and
 * `REACH_LEAD_IN` + host badges. Real prose, still uncovered — same kind of
 * accepted gap as the collapsible `steps` panel below, not silently dropped.
 */
function grantFindFields(grants: readonly WorkspaceGrant[]): FindField[] {
  const out: FindField[] = [];
  for (const g of grants) {
    const base = grantFieldKeyBase(g.key);
    const { request } = g;
    out.push({ key: `${base}:title`, text: grantTitle(request) });
    if (request.kind === 'host') {
      out.push({ key: `${base}:explanation`, text: HOST_WALL_EXPLANATION });
    }
  }
  return out;
}

/**
 * The text of the thread that a reader can actually see, in render order.
 *
 * WHAT IS IN: `user` and `agent` turns — in production these are the only two
 * kinds that reach this wire at all (`buildThread` in `routes-workspace.ts`
 * emits nothing else) — plus a `steps` turn's bubble text and the `fold`
 * marker, both of which render as ordinary always-visible prose. Also in, as
 * of TASK-390: an OPEN `approval` turn's decision summary/detail (see below),
 * and every grant's visible prose, appended last (see `grantFindFields`).
 *
 * WHAT IS OUT, and why each:
 *
 *   - `status` — the transient placeholder this client invents while a reply is
 *     in flight ('Thinking…', 'Opening…'). It is chrome, not something the
 *     agent said, and counting it would make the total tick up mid-stream and
 *     back down when the turn lands: a number that moves on its own.
 *   - `approval`, ONCE RESOLVED. TASK-354 originally skipped every `approval`
 *     turn outright — its words came from the GLOBAL decisions queue, a
 *     separate fetch, and a pointer whose row had not arrived rendered
 *     nothing. TASK-390 widened this: `decisions` is now a required argument,
 *     and while the pointer resolves to a row that `isOpenDecision` (still a
 *     QUESTION — pending or stale), `d.summary` and non-empty `d.detail` are
 *     indexed under `${findFieldKey(index, m.id)}:summary` / `:detail` — the
 *     exact prose `ApprovalCard` renders in that state. Once resolved, the
 *     card swaps to an outcome sentence (`decisionOutcome`) instead of the raw
 *     summary/detail, so those two fields drop out of the index the same turn
 *     they drop off the screen — counting them anyway would name a match the
 *     reader can no longer see, the same failure mode the `steps` exclusion
 *     below exists to avoid. A pointer with no matching row (never arrived, or
 *     already resolved and removed from the open list) still contributes
 *     nothing, same as before.
 *   - a `steps` turn's `stepsLabel` and `steps[]` — that panel is COLLAPSIBLE
 *     (it renders open and the reader can shut it), so a count including it can
 *     name a match that is not on the screen at the moment it is counted.
 */
export function threadFindFields(
  thread: readonly ThreadMessage[],
  decisions: readonly Decision[],
  grants: readonly WorkspaceGrant[],
): FindField[] {
  const out: FindField[] = [];
  thread.forEach((m, index) => {
    switch (m.kind) {
      /*
        MARKDOWN vs PLAIN, and the split is not cosmetic (TASK-405). An `agent`
        turn — and a `steps` turn's bubble, which is the same renderer arm —
        goes through `<Markdown>`, so only the slices of it that survive
        parsing can carry a mark. A `user` bubble and a `fold` marker are still
        drawn as plain strings, so every match in them is paintable and the
        original matcher is the right one. Getting this backwards in either
        direction reintroduces count-vs-marks drift, which is why the kinds are
        enumerated here instead of inferred at the render site.
      */
      case 'agent':
      case 'steps':
        out.push({ key: findFieldKey(index, m.id), text: m.text, markdown: true });
        break;
      case 'user':
      case 'fold':
        out.push({ key: findFieldKey(index, m.id), text: m.text });
        break;
      case 'status':
        break;
      /*
        A replayed turn failure (TASK-498). OUT, and for the mechanical reason
        the `steps` panel is out rather than the editorial one `status` is:
        the row does not paint marks. It renders authored copy straight from
        `turnErrorText` with no `FindHighlight` around it, so counting it
        would name a match the reader can never be walked to — the
        count-vs-marks drift this file exists to prevent. Wiring the highlight
        is what would earn it a place here, not adding a case.
      */
      case 'error':
        break;
      case 'approval': {
        const d = decisions.find((x) => x.id === m.decisionId);
        if (d !== undefined && isOpenDecision(d)) {
          const base = findFieldKey(index, m.id);
          out.push({ key: `${base}:summary`, text: d.summary });
          if (d.detail.length > 0) out.push({ key: `${base}:detail`, text: d.detail });
        }
        break;
      }
    }
  });
  out.push(...grantFindFields(grants));
  return out;
}

/**
 * The matcher a field is entitled to, picked from the field itself.
 *
 * Exported so `FindHighlight` paints with the SAME choice the count was taken
 * with rather than deciding for itself from a prop that could disagree —
 * `field.markdown` is written in exactly one place (`threadFindFields`) and
 * read in exactly two.
 */
export function fieldRanges(field: FindField, query: string): FindRange[] {
  return field.markdown === true
    ? markdownFindRanges(field.text, query)
    : findRanges(field.text, query);
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
  decisions: readonly Decision[],
  grants: readonly WorkspaceGrant[],
  query: string,
): FindIndex {
  const firstMatch = new Map<string, number>();
  if (query.trim().length === 0) return { total: 0, firstMatch };

  let total = 0;
  for (const field of threadFindFields(thread, decisions, grants)) {
    const hits = fieldRanges(field, query).length;
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
