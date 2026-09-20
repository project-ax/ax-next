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
 * NOTHING DELETES THESE, and the obvious way to start would be wrong.
 * Reclaiming a marker (when the subject is granted, or uninstalled) is a
 * tracked follow-up, and whoever picks it up should not reach for
 * `storage:delete-prefix` with an exact key: `subjectId` is variable-length,
 * so `…:abc` is a PREFIX of `…:abcd` and a "delete this one" would silently
 * take a sibling grant's refusal with it. It needs a real single-key delete,
 * or a scan that matches the whole key.
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
 * Every marker this user owns, as `key → declinedAt`, in ONE `list-prefix`.
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
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
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
      declinedAt,
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
 * ONE implementation, and that is the point of it living here. TWO server
 * paths put a pending card in front of somebody, and they have to agree:
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
 * and the drift is invisible from either side.
 *
 * ONE `list-prefix` per call, then a comparison per row: the marker wins while
 * `declinedAt >= raisedAt`. A grant re-raised after the refusal carries the
 * newer `raisedAt` and comes straight back — that is the whole need-trigger,
 * and it takes no write, no timer and no second decision.
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
 * Without `storage:list-prefix` this is exactly the pre-TASK-444 behaviour,
 * and the manifest declares that degradation.
 */
export async function withoutDeclinedGrants<
  T extends { agentId: string; card: PermissionRequest; raisedAt: number },
>(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  rows: readonly T[],
): Promise<readonly T[]> {
  if (rows.length === 0 || !bus.hasService('storage:list-prefix')) return rows;
  try {
    const declines = await readGrantDeclines(bus, ctx, userId);
    return rows.filter((row) => {
      const subjectId = grantSubjectId(row.card);
      if (subjectId === null) return true;
      const declinedAt = declines.get(
        grantDeclineKey(
          userId,
          row.agentId,
          row.card.kind as DeclinableGrantKind,
          subjectId,
        ),
      );
      return declinedAt === undefined || declinedAt < row.raisedAt;
    });
  } catch (err) {
    // Fall through UNFILTERED rather than failing the read. Losing the grants
    // list entirely is the worse outcome by a distance: a question shown twice
    // is a small annoyance, a question the person cannot see at all is an agent
    // stuck with nobody able to unstick it. The `filter` is inside the `try`
    // deliberately — `grantDeclineKey` runs `encodeURIComponent` over an id out
    // of an agent-authored manifest, which throws on a lone surrogate, and on
    // the SSE path that throw would land after the stream is already open.
    ctx.logger.warn('workspace_grant_declines_read_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return rows;
  }
}
