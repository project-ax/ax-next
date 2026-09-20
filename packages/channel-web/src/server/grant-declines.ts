import type { AgentContext, HookBus } from '@ax/core';
import type { PermissionRequest } from './types.js';

// ---------------------------------------------------------------------------
// "Not now", written down (TASK-444).
//
// Turning a capability grant down used to be purely local: the row vanished
// from the browser and the server never heard. The card was still pending, so
// the next workspace mount read it straight back and asked again — and the
// only way to find out was to reload.
//
// So a refusal is recorded, on the `(user, agent, grant)` triple, and it
// survives a reload and a sign-out. It is NOT a snooze: there is no timer here
// and no expiry field, deliberately. The question returns when an agent action
// genuinely needs the grant again, which the pending card's `raisedAt` says all
// by itself — a newer raise outranks an older decline (see
// `ChunkBuffer.pendingGrantsForUser`).
//
// WHERE IT LIVES. The generic KV hooks `storage:set` / `storage:list-prefix` —
// the same substrate @ax/branding and @ax/audit-log persist through, present in
// both presets (@ax/storage-sqlite in the CLI, @ax/storage-postgres in k8s).
// The conventional shape would be a @ax/grant-declines plugin with its own
// table; it is the right answer the day declines need listing or revoking from
// Settings, and it costs a migration plus ten registration points for one
// timestamp today. The wire payload is storage-agnostic either way (invariant
// 1), so that move needs no field to change.
//
// THE KEY IS ENCODED, AND THAT IS LOAD-BEARING. `agentId`, `kind` and
// `subjectId` all come out of a manifest an agent authored — untrusted at every
// hop (invariant 5) — and `userId` decides whose namespace we are in. Pasted in
// raw, an id carrying a `:` could spell itself across a segment boundary:
// `(agent "a:skill:evil", subject "s")` and `(agent "a", subject
// "evil:skill:s")` are two different grants that would share one marker, so
// declining either would silently answer the other. `encodeURIComponent` on
// EVERY segment removes the ambiguity rather than trusting the ids not to
// contain a colon.
// ---------------------------------------------------------------------------

/** The grant kinds that can be deferred. `host` cards are turn-scoped and
 *  deliberately excluded — see `ChunkBuffer.pendingGrantsForUser`. */
export type DeclinableGrantKind = 'skill' | 'connector';

const KEY_NAMESPACE = 'grant-decline';

/** Every marker this user owns, and nobody else's. The trailing `:` matters:
 *  without it `u-ann`'s prefix would also match `u-annette`'s keys. */
export function grantDeclineUserPrefix(userId: string): string {
  return `${KEY_NAMESPACE}:${encodeURIComponent(userId)}:`;
}

/** `grant-decline:<enc(userId)>:<enc(agentId)>:<enc(kind)>:<enc(subjectId)>`. */
export function grantDeclineKey(
  userId: string,
  agentId: string,
  kind: DeclinableGrantKind,
  subjectId: string,
): string {
  return (
    grantDeclineUserPrefix(userId) +
    [agentId, kind, subjectId].map(encodeURIComponent).join(':')
  );
}

/**
 * The inverse, used to validate what came back out of the store. Anything that
 * is not exactly our four encoded segments is somebody else's row (or a
 * corrupt one) and is reported as `null` rather than guessed at.
 */
export function parseGrantDeclineKey(key: string): {
  userId: string;
  agentId: string;
  kind: string;
  subjectId: string;
} | null {
  if (typeof key !== 'string') return null;
  const prefix = `${KEY_NAMESPACE}:`;
  if (!key.startsWith(prefix)) return null;
  const segments = key.slice(prefix.length).split(':');
  if (segments.length !== 4) return null;
  let decoded: string[];
  try {
    decoded = segments.map(decodeURIComponent);
  } catch {
    // A malformed escape (`%E0%A4%A`). Not ours to interpret.
    return null;
  }
  const [userId, agentId, kind, subjectId] = decoded as [
    string,
    string,
    string,
    string,
  ];
  return { userId, agentId, kind, subjectId };
}

/** What we store under the key. One field, and it stays one field: a second
 *  one ("until") is the timer this design does not have. */
interface DeclineRecord {
  declinedAt: number;
}

/**
 * Write one marker. Requires `storage:set` — the caller checks
 * `bus.hasService` first and answers 503 rather than reporting a success it
 * did not have (a refusal we failed to record is one that will come back).
 *
 * THESE ARE RECLAIMED, and the obvious way to do it is still wrong (TASK-482).
 * `reclaimGrantDeclines` below drops the markers that can no longer suppress
 * anything, and it deletes them one EXACT key at a time through
 * `storage:delete`. It must never reach for `storage:delete-prefix` with an
 * exact key: `subjectId` is variable-length, so `…:abc` is a PREFIX of
 * `…:abcd` and a "delete this one" would silently take a sibling grant's
 * refusal with it. That is not a comment any more — `grant-declines.test.ts`
 * pins it with a marker pair that differs only by a trailing character.
 */
export async function recordGrantDecline(
  bus: HookBus,
  ctx: AgentContext,
  decline: {
    userId: string;
    agentId: string;
    kind: DeclinableGrantKind;
    subjectId: string;
    declinedAt: number;
  },
): Promise<void> {
  const record: DeclineRecord = { declinedAt: decline.declinedAt };
  await bus.call<{ key: string; value: Uint8Array }, void>('storage:set', ctx, {
    key: grantDeclineKey(
      decline.userId,
      decline.agentId,
      decline.kind,
      decline.subjectId,
    ),
    value: new TextEncoder().encode(JSON.stringify(record)),
  });
}

/**
 * One marker as it was read back, and BOTH fields are load-bearing.
 *
 * `raw` is the exact bytes the store handed over, kept so the reclaim can ask
 * for a compare-and-delete rather than an unconditional one. It is not a
 * cache of `declinedAt` — re-encoding `{declinedAt}` would round-trip to
 * different bytes for a row some other version of this code wrote, and the
 * guard would then never match. The bytes are carried, never rebuilt.
 */
export interface StoredDecline {
  declinedAt: number;
  /** The stored value, verbatim. Never parsed twice, never re-encoded. */
  raw: Uint8Array;
}

/**
 * Every marker this user owns, as `key → StoredDecline`, in ONE `list-prefix`.
 * Keys are re-built from the parsed segments, so a caller can look one up with
 * `grantDeclineKey(...)` and get a hit regardless of how the stored spelling
 * was encoded.
 *
 * DEFENSIVE ON PURPOSE. These are bytes out of a store that other versions of
 * this code, and a corrupted row, can both reach. A row we cannot read is
 * skipped and logged — never crashed on, and never counted as "declined",
 * because reading a broken row as a refusal would hide a question the person
 * never answered.
 */
export async function readGrantDeclines(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
): Promise<Map<string, StoredDecline>> {
  const out = new Map<string, StoredDecline>();
  const { entries } = await bus.call<
    { prefix: string },
    { entries: Array<{ key: string; value: Uint8Array }> }
  >('storage:list-prefix', ctx, { prefix: grantDeclineUserPrefix(userId) });

  for (const entry of entries ?? []) {
    const parsed = parseGrantDeclineKey(entry.key);
    if (parsed === null || parsed.userId !== userId) continue;
    const declinedAt = parseDeclinedAt(entry.value);
    if (declinedAt === null) {
      ctx.logger.warn('workspace_grant_decline_unreadable', {
        // The KEY, never the value: the value is the thing we just failed to
        // parse, and logging unparsed bytes is how a log becomes a payload.
        agentId: parsed.agentId,
        kind: parsed.kind,
      });
      continue;
    }
    out.set(
      grantDeclineKey(
        parsed.userId,
        parsed.agentId,
        parsed.kind as DeclinableGrantKind,
        parsed.subjectId,
      ),
      { declinedAt, raw: entry.value },
    );
  }
  return out;
}

function parseDeclinedAt(value: Uint8Array | undefined): number | null {
  if (value === undefined) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(value)) as unknown;
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  const at = (decoded as { declinedAt?: unknown }).declinedAt;
  // `Number.isFinite` rather than `typeof === 'number'`: NaN and Infinity are
  // numbers that would compare wrong against a raise instant forever.
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return at;
}

/**
 * The subject a grant card is about — a skill's `skillId`, a connector's
 * `connectorId`. `null` for a host card, which has no durable subject: host
 * cards are turn-scoped and are never declined durably (see
 * `DeclinableGrantKind`).
 */
export function grantSubjectId(card: PermissionRequest): string | null {
  if (card.kind === 'skill') return card.skillId;
  if (card.kind === 'connector') return card.connectorId;
  return null;
}

/**
 * Drop the grants this person has already said "Not now" to (TASK-444).
 *
 * THE ONE COMPARISON, AND IT LIVES HERE ONLY. TWO server paths put a pending
 * card in front of somebody, and they have to agree:
 *
 *   - `GET /api/workspace/grants` → `ChunkBuffer.pendingGrantsForUser` — the
 *     workspace-mount read-back (TASK-373).
 *   - the SSE replay on stream open → `ChunkBuffer.tailPermissionCardEntries`
 *     — the TASK-82 cold-boot replay, which runs again every time the person
 *     sends another message to the same agent. Declining does NOT evict the
 *     card (the marker is the record, not the deletion), so without this
 *     filter that replay hands the answered question straight back.
 *
 * A second copy of the comparison below is exactly how those two drift apart,
 * and the drift is invisible from either side. The two paths reach it
 * differently — the mount read-back through `withoutDeclinedGrants`, the SSE
 * replay by reading the markers before it opens the stream and calling this
 * function once the stream is open — but they land on the same three lines.
 *
 * SYNCHRONOUS AND TOTAL, BOTH LOAD-BEARING. The SSE caller runs this with the
 * response already streaming and its live subscribers not yet attached, so it
 * can neither wait nor throw: an `await` here would reopen the frame-loss
 * window this split exists to close, and a throw would abort the setup span
 * mid-way. `grantDeclineKey` runs `encodeURIComponent` over ids out of an
 * agent-authored manifest, and that throws `URIError` on a lone surrogate —
 * so a row we cannot key is KEPT and logged. Failing open is the only honest
 * direction: a question we could not evaluate is a question we have no
 * grounds to suppress.
 *
 * The comparison itself: the marker wins while `declinedAt >= raisedAt`. A
 * grant re-raised after the refusal carries the newer `raisedAt` and comes
 * straight back — that is the whole need-trigger, and it takes no write, no
 * timer and no second decision.
 *
 * THE TWO INSTANTS ARE WALL-CLOCK, AND WALL CLOCKS MOVE. Both come from this
 * one host process (channel-web is single-replica by construction — the chart
 * refuses to render replicas > 1, see the J7/J8 note in plugin.ts and
 * chunk-buffer.ts), and the pending cards live in that process's memory
 * anyway, so there is no SECOND clock to disagree with. What we do assume is
 * that this clock runs forwards: `Date.now()` is not monotonic, so a backward
 * NTP step or a hand-set clock after a decline can stamp a later, genuine
 * re-raise with a `raisedAt` BELOW the `declinedAt` already stored, and the
 * needed grant stays suppressed until the clock catches back up. We take that
 * over a timer: the alternative fixes are a monotonic source that cannot
 * survive a restart, or an expiry, and an expiry is the thing this design
 * deliberately does not have.
 *
 * Host cards pass through untouched — `grantSubjectId` returns `null` for
 * them and `null` means "keep".
 *
 * `ctx` is first (rather than the bare `(declines, userId, rows)` the split was
 * sketched as) for the one reason that it carries the logger the fail-open
 * branch needs; it does no I/O.
 *
 * `stillSuppressing`, when given, collects the marker keys that ACTUALLY
 * dropped a row (TASK-482). It is an out-parameter rather than a second return
 * value for two reasons: the SSE caller passes nothing and keeps the exact
 * call it has today, and `Set.prototype.add` cannot throw — a callback could,
 * and this function's guarantee is that it does not throw with the stream
 * already open. It is filled ONLY on the paths that reach the comparison, so a
 * caller that short-circuits gets an empty set, which is the truth: no
 * comparison ran, so no marker was observed doing work.
 */
export function filterDeclinedGrants<
  T extends { agentId: string; card: PermissionRequest; raisedAt: number },
>(
  ctx: AgentContext,
  declines: ReadonlyMap<string, StoredDecline>,
  userId: string,
  rows: readonly T[],
  stillSuppressing?: Set<string>,
): readonly T[] {
  if (rows.length === 0 || declines.size === 0) return rows;
  return rows.filter((row) => {
    let key: string;
    try {
      // `grantSubjectId` is inside the `try` as well, even though the type
      // says `card` is always there. The guarantee this function offers is
      // "cannot throw out of it", and it is relied on with the SSE stream
      // already open — so it is bought from the code, not from the types.
      const subjectId = grantSubjectId(row.card);
      if (subjectId === null) return true;
      key = grantDeclineKey(
        userId,
        row.agentId,
        row.card.kind as DeclinableGrantKind,
        subjectId,
      );
    } catch (err) {
      // An id that cannot be percent-encoded (a lone surrogate). We have no
      // key to look up, so we have no refusal to honour — keep the card.
      // Neither id is logged: one of them is the thing that just failed to
      // encode, and `kind` is a two-value enum that cannot be.
      ctx.logger.warn('workspace_grant_decline_key_failed', {
        kind: row.card.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
    const stored = declines.get(key);
    if (stored === undefined || stored.declinedAt < row.raisedAt) return true;
    stillSuppressing?.add(key);
    return false;
  });
}

/**
 * How many markers one read may reclaim. A bound, not a tuning knob: the very
 * first prune on a store that grew before TASK-482 shipped could otherwise
 * stall a workspace mount behind thousands of sequential deletes. Whatever is
 * left over is reclaimed by the next read, and the next — it converges, and
 * nothing is ever wrong in the meantime, because an unreclaimed marker is
 * inert rather than incorrect.
 */
const RECLAIM_MAX_PER_READ = 64;

/**
 * Drop the markers that can no longer suppress anything (TASK-482).
 *
 * WHY "NO LONGER SUPPRESSING" IS THE SAME THING AS "DEAD", exactly and not
 * heuristically. `raisedAt` is stamped from the host clock every time a card
 * is appended OR replaced (`ChunkBuffer.appendPermissionCard` — a re-proposal
 * re-stamps deliberately), and the pending-card buffer lives in this one
 * process's memory. So every future raise of the same `(user, agent, kind,
 * subject)` carries a `raisedAt` newer than an already-stored `declinedAt`,
 * and a marker that is not winning its comparison now can never win one again.
 * There is no agent-exists or skill-exists probe here, and there should not be
 * one: a marker for a perfectly live agent whose card was re-raised is just as
 * dead as a marker for an agent that was deleted.
 *
 * That reasoning is about the SNAPSHOT, and a snapshot is a past tense. It
 * says the marker was dead when we read it, which is not the same as "is dead
 * when we delete it" — see the compare-and-delete paragraph below for the
 * decline that can land in between.
 *
 * WHAT THE CALLER MUST HAVE HANDED THE FILTER. `stillSuppressing` is only
 * meaningful if the rows it was computed over were the COMPLETE user-wide
 * pending set (`ChunkBuffer.pendingGrantsForUser`). Give it the SSE replay's
 * per-conversation tail instead and every other conversation's live markers
 * look unreferenced, and get deleted. That is why this is reached from the
 * mount read-back only, behind an explicit opt-in, and never from the stream.
 *
 * EXACT KEYS ONLY. `storage:delete-prefix` on one of these keys would also
 * take every key that EXTENDS it — `…:abc` is a prefix of `…:abcd` — so this
 * needs the equality delete, and degrades to a no-op without it.
 *
 * AND COMPARE-AND-DELETE, because the snapshot goes stale while we work. The
 * decision to drop a marker is made from `declines`, read one round trip ago,
 * but the row it names is live: nothing holds a lock, and the person can press
 * "Not now" on the very grant this loop has already written off. The sequence
 * is the ORDINARY lifecycle of a deferred grant, not an exotic one — decline,
 * agent re-proposes, decline again — and the second refusal lands while a
 * workspace mount is mid-read:
 *
 *   1. the marker says `declinedAt = D1`, the re-raised card says
 *      `raisedAt = R1 > D1`, so the card is on screen and the marker is dead;
 *   2. the grants read snapshots both, keeps the card, and lists the marker
 *      for reclamation;
 *   3. the person presses "Not now" again — the route writes `D2 > R1` and
 *      answers 200, so as far as they are concerned it stuck;
 *   4. this loop deletes the key, and `D2` goes with it. The question they
 *      just answered is back on the next mount.
 *
 * So every delete carries the bytes the read actually saw. A row rewritten in
 * the meantime no longer matches, the delete takes nothing, and the fresh
 * refusal survives — it is simply reclaimed on a later read, if it ever goes
 * dead. The guard fails in the safe direction by construction: a mismatch
 * always means KEEP, and keeping a marker is at worst a row we sweep next
 * time, while dropping one loses a decision the person made.
 *
 * This is why the bytes are carried rather than re-encoded from `declinedAt`
 * (see `StoredDecline`), and why a store without `ifValueEquals` support must
 * not silently ignore it — a guard that is dropped rather than honoured is a
 * guard that is not there.
 *
 * IT CAN ONLY DELETE KEYS IT COULD HAVE WRITTEN. Every key here came back out
 * of `readGrantDeclines`, which rebuilds it with `grantDeclineKey` from the
 * authenticated `userId` — a spelling is never echoed back out of the store.
 * So a row written under some other encoding of the same triple (a `%7E`
 * where we write a `~`) is not reclaimed: the delete names the canonical
 * spelling, misses, and changes nothing. Inert either way, and it means no
 * value in the store can steer this at a key we could not have written.
 *
 * Returns how many rows the store reported deleting.
 */
export async function reclaimGrantDeclines(
  bus: HookBus,
  ctx: AgentContext,
  declines: ReadonlyMap<string, StoredDecline>,
  stillSuppressing: ReadonlySet<string>,
): Promise<number> {
  if (declines.size === 0 || !bus.hasService('storage:delete')) return 0;
  let deleted = 0;
  let considered = 0;
  for (const [key, stored] of declines) {
    if (stillSuppressing.has(key)) continue;
    if (considered >= RECLAIM_MAX_PER_READ) break;
    considered += 1;
    const res = await bus.call<
      { key: string; ifValueEquals?: Uint8Array },
      { deleted: number }
    >('storage:delete', ctx, { key, ifValueEquals: stored.raw });
    deleted += res.deleted;
  }
  if (deleted > 0) {
    // The COUNT, never the keys: a key is `(user, agent, kind, subject)` and
    // three of those four belong to somebody.
    ctx.logger.debug('workspace_grant_declines_reclaimed', { count: deleted });
  }
  return deleted;
}

/**
 * `readGrantDeclines` + `filterDeclinedGrants`, for a caller that can simply
 * await in place — today that is `GET /api/workspace/grants`, which has not
 * written a byte of its response yet.
 *
 * The SSE replay deliberately does NOT use this: it has to do the read BEFORE
 * it opens the stream, because everything from the stream opening to the last
 * `subscribe()` call has to stay one synchronous span (see the step-4a comment
 * in sse.ts). It reads and filters as two steps instead, and the step that
 * matters — the comparison — is the same function.
 *
 * Without `storage:list-prefix` this is exactly the pre-TASK-444 behaviour,
 * and the manifest declares that degradation.
 *
 * RECLAMATION RIDES THIS SCAN AND NEVER BUYS ONE (TASK-482). The empty-list
 * short-circuit below is load-bearing and stays exactly where it is: TASK-444
 * lost it once and turned one KV scan per grants-read into one per turn.
 * Pruning therefore happens only on a read that was going to scan anyway, so
 * it costs zero extra round trips — and the read that does scan is precisely
 * the read whose cost the pruning is there to bound. A person with nothing
 * pending never prunes, and never scans either, so the markers they are
 * sitting on cost them nothing until the next read that has to look.
 *
 * `reclaimAgainstCompleteSet` is a FUNCTION rather than a boolean, and that is
 * the whole of it: it re-samples every pending grant this person has, across
 * every conversation, at a moment this code chooses rather than one the caller
 * chose. A boolean could only ever mean "the rows I handed you a while ago
 * were complete THEN", and "then" is one storage round trip ago — see the
 * re-sample comment in the body for the decline that falls into that gap.
 *
 * Its presence is also the opt-in, so a caller that has not thought about it
 * does not prune. The grants route passes one only when it actually holds a
 * buffer — with no buffer it would sample `[]`, which is indistinguishable
 * from "nothing pending" and would reclaim the lot.
 */
export async function withoutDeclinedGrants<
  T extends { agentId: string; card: PermissionRequest; raisedAt: number },
>(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  rows: readonly T[],
  options: {
    reclaimAgainstCompleteSet?: (() => readonly T[]) | undefined;
  } = {},
): Promise<readonly T[]> {
  if (rows.length === 0 || !bus.hasService('storage:list-prefix')) return rows;
  let declines: ReadonlyMap<string, StoredDecline>;
  try {
    declines = await readGrantDeclines(bus, ctx, userId);
  } catch (err) {
    // Fall through UNFILTERED rather than failing the read. Losing the grants
    // list entirely is the worse outcome by a distance: a question shown twice
    // is a small annoyance, a question the person cannot see at all is an agent
    // stuck with nobody able to unstick it.
    ctx.logger.warn('workspace_grant_declines_read_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return rows;
  }
  // RE-SAMPLED AFTER THE READ, AND THAT ORDER IS THE POINT. `rows` was taken
  // before the scan above, so judging the markers against it judges them
  // against a set that is one round trip stale — and a card raised AND
  // declined inside that window is absent from it while its brand-new marker
  // is present in `declines`. The marker then looks unreferenced, its bytes
  // have not changed since it was written, so the compare-and-delete guard
  // matches, and the refusal the person just gave is deleted.
  //
  // Sampling after the read closes it, and the argument is small: every
  // marker in `declines` was written no later than the read, so a card it
  // could suppress (`raisedAt <= declinedAt`) was raised no later than the
  // read either, and is therefore in any snapshot taken from here on. A card
  // raised AFTER this point cannot be suppressed by anything in `declines`,
  // and a decline written after this point is not in `declines` to be deleted
  // — that later window is what the compare-and-delete covers.
  //
  // The stale `rows` is still what the cheap emptiness guard above runs on:
  // that guard exists to avoid the scan entirely, so it has to come first, and
  // "was anything pending a moment ago" is the right question for it.
  const complete = options.reclaimAgainstCompleteSet?.();
  const stillSuppressing = new Set<string>();
  const kept = filterDeclinedGrants(
    ctx,
    declines,
    userId,
    complete ?? rows,
    stillSuppressing,
  );
  if (complete !== undefined) {
    try {
      await reclaimGrantDeclines(bus, ctx, declines, stillSuppressing);
    } catch (err) {
      // Housekeeping never fails the read. A marker we could not delete is a
      // marker we will delete next time; a grants list we did not answer is a
      // person who cannot unstick their agent. Whatever was deleted before the
      // throw stays deleted — there is nothing to undo, because every delete
      // here was of a row that had already stopped doing anything.
      ctx.logger.warn('workspace_grant_declines_reclaim_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return kept;
}
