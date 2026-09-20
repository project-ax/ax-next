import type { AgentContext, HookBus } from '@ax/core';

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
