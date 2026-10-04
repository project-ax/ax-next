// ---------------------------------------------------------------------------
// `blob:collect-refs` — "which of these blobs do you still reference, and for
// whom?" (TASK-723 design, D1/D2: docs/plans/2026-10-03-blob-gc-design.md).
//
// A SUBSCRIBER hook used as a transform. The caller (today @ax/disk-quota's
// ledger release; later @ax/blob-gc) fires it with a batch of candidate shas
// and an empty `answers` list. Every plugin that stores a blob sha in its own
// rows (a "holder") APPENDS exactly one answer and returns the payload:
//
//   { holder: '<its plugin name>', ok: true,  refs: [{ sha256, userIds }] }
//   { holder: '<its plugin name>', ok: false, refs: [] }   // "I could not check"
//
// Rules every holder follows (and `answerBlobCollectRefs` below enforces):
//   - Only APPEND. Never rewrite, reorder or drop another holder's answer, and
//     never read one to decide your own.
//   - Never throw. `HookBus.fire` swallows a throw and carries on, which would
//     read as "no references". Catch your own errors and answer `ok: false`.
//   - `userIds` names the people the reference belongs to; `[]` means "held,
//     but not by a person" (a global skill, a branding logo). Bytes held that
//     way are kept, and no ledger charge is released for that sha.
//
// The caller fails CLOSED (`readBlobCollectRefsAnswers` gives it what it needs):
// any `ok: false` answer, any answer it cannot read, and any holder it has seen
// answer before that did not answer this time (a crashed or unloaded holder,
// tracked in the caller's own persisted roster) abort the decision.
//
// The payload carries no storage vocabulary: a sha256 is the blob's own
// content digest (the same in every backend), and `userIds` are the bus's own
// user identities.
// ---------------------------------------------------------------------------

export const BLOB_COLLECT_REFS_HOOK = 'blob:collect-refs';

/** A caller asks about at most this many shas per fire. */
export const BLOB_COLLECT_REFS_MAX_CANDIDATES = 1000;

/** A holder name longer than this is not a plugin name. */
const MAX_HOLDER_NAME = 200;

export interface BlobRef {
  sha256: string;
  /** Who holds it. `[]` = held, but not by a person. */
  userIds: string[];
}

export interface BlobCollectRefsAnswer {
  /** The answering plugin's own name. */
  holder: string;
  /** false = "I could not check" — the caller aborts. */
  ok: boolean;
  refs: BlobRef[];
}

export interface BlobCollectRefsPayload {
  /** At most BLOB_COLLECT_REFS_MAX_CANDIDATES lowercase-hex sha256 values. */
  candidates: string[];
  answers: BlobCollectRefsAnswer[];
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function isBlobSha256(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v);
}

/**
 * The candidate list of an untrusted payload, or undefined when it is not a
 * list of at most BLOB_COLLECT_REFS_MAX_CANDIDATES sha256 values. Rejected
 * WHOLE: a holder never answers "the valid part" of a list it does not trust.
 */
export function parseBlobCandidates(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > BLOB_COLLECT_REFS_MAX_CANDIDATES) return undefined;
  for (const s of v) if (!isBlobSha256(s)) return undefined;
  return [...(v as string[])];
}

/**
 * The holder side. Reads the (untrusted) payload, runs `lookup` over the
 * candidates, and returns the payload with this holder's answer appended.
 * Never throws: a bad payload or a failing lookup becomes `ok: false`.
 *
 * `lookup` may return refs in any order, with duplicates; they are filtered to
 * the candidates and merged per sha. Empty-string user ids are dropped.
 */
export async function answerBlobCollectRefs(
  payload: unknown,
  holder: string,
  lookup: (candidates: string[]) => Promise<BlobRef[]>,
): Promise<BlobCollectRefsPayload> {
  const p =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const rawCandidates = Array.isArray(p.candidates) ? (p.candidates as string[]) : [];
  const answers: BlobCollectRefsAnswer[] = Array.isArray(p.answers)
    ? [...(p.answers as BlobCollectRefsAnswer[])]
    : [];
  const out = (answer: BlobCollectRefsAnswer): BlobCollectRefsPayload => ({
    ...(p as object),
    candidates: rawCandidates,
    answers: [...answers, answer],
  });
  const failed: BlobCollectRefsAnswer = { holder, ok: false, refs: [] };

  const candidates = parseBlobCandidates(p.candidates);
  if (candidates === undefined) return out(failed);
  if (candidates.length === 0) return out({ holder, ok: true, refs: [] });

  let found: BlobRef[];
  try {
    found = await lookup(candidates);
    if (!Array.isArray(found)) return out(failed);
  } catch {
    return out(failed);
  }

  const wanted = new Set(candidates);
  const merged = new Map<string, Set<string>>();
  for (const ref of found) {
    if (ref === null || typeof ref !== 'object') return out(failed);
    if (!wanted.has(ref.sha256)) continue;
    if (!Array.isArray(ref.userIds)) return out(failed);
    let users = merged.get(ref.sha256);
    if (users === undefined) {
      users = new Set();
      merged.set(ref.sha256, users);
    }
    for (const u of ref.userIds) {
      if (typeof u !== 'string') return out(failed);
      if (u.length > 0) users.add(u);
    }
  }
  const refs: BlobRef[] = [...merged].map(([sha256, users]) => ({
    sha256,
    userIds: [...users].sort(),
  }));
  return out({ holder, ok: true, refs });
}

export interface BlobHolding {
  /** Every person any holder said holds this sha. */
  userIds: Set<string>;
  /** Some holder holds it for nobody in particular (`userIds: []`). */
  unattributed: boolean;
}

export interface BlobCollectRefsOutcome {
  /** Every holder name that answered at all (ok or not). */
  answered: Set<string>;
  /** Holders that answered `ok: false`, or whose answer could not be read. */
  failed: string[];
  /** Answers with no readable holder name, or a payload with no answer list. */
  malformed: number;
  /** Candidate sha -> who holds it. A candidate with no entry is held by nobody. */
  held: Map<string, BlobHolding>;
}

/**
 * The caller side. Reads the payload a `fire` returned and judges it against
 * the caller's OWN candidate list (a subscriber can rewrite the payload's
 * list; the caller's is the one that counts). Refs for other shas are ignored.
 *
 * Fail-closed reading: an answer that is not exactly `{ holder, ok, refs }`
 * with well-formed refs is counted as `failed` (or `malformed` when it has no
 * usable holder name), never as "no references". The caller still has to
 * compare `answered` against its roster: a holder that threw is simply absent.
 */
export function readBlobCollectRefsAnswers(
  payload: unknown,
  candidates: readonly string[],
): BlobCollectRefsOutcome {
  const outcome: BlobCollectRefsOutcome = {
    answered: new Set(),
    failed: [],
    malformed: 0,
    held: new Map(),
  };
  const answers =
    payload !== null && typeof payload === 'object'
      ? (payload as { answers?: unknown }).answers
      : undefined;
  if (!Array.isArray(answers)) {
    outcome.malformed++;
    return outcome;
  }
  const wanted = new Set(candidates);
  const failed = new Set<string>();

  for (const raw of answers as unknown[]) {
    const a = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
    const holder = a?.holder;
    if (typeof holder !== 'string' || holder.length === 0 || holder.length > MAX_HOLDER_NAME) {
      outcome.malformed++;
      continue;
    }
    outcome.answered.add(holder);
    const refs = a!.refs;
    if (a!.ok !== true || !Array.isArray(refs)) {
      failed.add(holder);
      continue;
    }
    // Validate the whole answer before taking anything from it.
    let readable = true;
    for (const r of refs as unknown[]) {
      const ref = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : undefined;
      if (
        ref === undefined ||
        !isBlobSha256(ref.sha256) ||
        !Array.isArray(ref.userIds) ||
        !(ref.userIds as unknown[]).every((u) => typeof u === 'string')
      ) {
        readable = false;
        break;
      }
    }
    if (!readable) {
      failed.add(holder);
      continue;
    }
    for (const r of refs as BlobRef[]) {
      if (!wanted.has(r.sha256)) continue;
      let h = outcome.held.get(r.sha256);
      if (h === undefined) {
        h = { userIds: new Set(), unattributed: false };
        outcome.held.set(r.sha256, h);
      }
      const users = r.userIds.filter((u) => u.length > 0);
      if (users.length === 0) h.unattributed = true;
      for (const u of users) h.userIds.add(u);
    }
  }
  outcome.failed = [...failed].sort();
  return outcome;
}
