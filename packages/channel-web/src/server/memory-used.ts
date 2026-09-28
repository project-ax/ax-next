/**
 * TASK-628 — "Used N memories" under an answer.
 *
 * `@ax/memory` records a RECALL RECEIPT every time `memory_recall` answers
 * inside a conversation: `{ at, statements }`, the exact rows the model was
 * handed. It serves them back over `memory:recall-receipts`. This module does
 * the channel-web half: decide which answer each receipt belongs to, and copy
 * the statements onto that answer's thread message.
 *
 * ATTRIBUTION IS BY TIME. A receipt taken at `t` belongs to the exchange opened
 * by the last person turn at or before `t` (an exchange runs up to the next
 * person turn), and the chip goes on the LAST `agent` | `steps` message of that
 * exchange — the answer the person actually reads. A receipt with no answer in
 * its exchange yet (the turn is still live) attaches to nothing; the thread
 * re-read at turn end picks it up.
 *
 * "Person turn" is decided by the thread, not re-derived here: `buildThread`
 * already decided which user-role turns carry the person's content (text or a
 * file) and emitted a `user` message for exactly those, with `id = turnId`. A
 * second copy of that rule here would be two definitions of one boundary.
 *
 * THE PAYLOAD IS ANOTHER PLUGIN'S (invariant 2 — no import from @ax/memory;
 * the types below are local and structural). Every statement field is checked
 * and copied one at a time, never spread, so nothing rides to the browser that
 * this file did not name.
 */
import type {
  MemoryUsed,
  MemoryUsedStatement,
  ThreadMessage,
} from '../lib/workspace-types.js';

/** The most statements one answer's chip carries. */
export const MEMORY_USED_MAX_STATEMENTS = 100;

/** The slice of a stored turn attribution needs. */
export interface MemoryUsedTurn {
  turnId: string;
  role: string;
  createdAt: string;
}

/** One receipt as it arrives off the hook — statements still untrusted. */
export interface RecallReceiptLike {
  at: string;
  statements: readonly unknown[];
}

export interface RecallReceiptsReply {
  receipts: RecallReceiptLike[];
  visibility?: 'personal' | 'team';
}

const CLOSED_SINCE = new Set(['replaced', 'forgotten', 'retracted']);
const SAVED_BY = new Set(['person', 'agent']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate the `memory:recall-receipts` reply. Returns `null` for a reply that
 * is not the documented shape at all; a malformed individual receipt is
 * dropped rather than sinking the rest.
 */
export function parseRecallReceiptsReply(reply: unknown): RecallReceiptsReply | null {
  if (!isRecord(reply) || !Array.isArray(reply.receipts)) return null;
  const receipts: RecallReceiptLike[] = [];
  for (const r of reply.receipts as unknown[]) {
    if (!isRecord(r)) continue;
    if (typeof r.at !== 'string' || !Array.isArray(r.statements)) continue;
    receipts.push({ at: r.at, statements: r.statements as unknown[] });
  }
  const v = reply.visibility;
  return {
    receipts,
    ...(v === 'personal' || v === 'team' ? { visibility: v } : {}),
  };
}

function toStatement(raw: unknown): MemoryUsedStatement | null {
  if (!isRecord(raw)) return null;
  const { id, about, relation, value, when } = raw;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof about !== 'string' ||
    typeof relation !== 'string' ||
    typeof value !== 'string' ||
    typeof when !== 'string'
  ) {
    return null;
  }
  const out: MemoryUsedStatement = { id, about, relation, value, when };
  if (typeof raw.until === 'string') out.until = raw.until;
  if (typeof raw.kind === 'string') out.kind = raw.kind;
  if (typeof raw.slot === 'string') out.slot = raw.slot;
  if (typeof raw.aboutText === 'string') out.aboutText = raw.aboutText;
  if (typeof raw.savedBy === 'string' && SAVED_BY.has(raw.savedBy)) {
    out.savedBy = raw.savedBy as 'person' | 'agent';
  }
  if (typeof raw.closedSince === 'string' && CLOSED_SINCE.has(raw.closedSince)) {
    out.closedSince = raw.closedSince as 'replaced' | 'forgotten' | 'retracted';
  }
  return out;
}

/**
 * Return a copy of `thread` with `memoryUsed` set on each answer that had
 * recall receipts in its exchange. Messages without receipts are returned
 * untouched (same object).
 */
export function attachMemoryUsed(
  thread: readonly ThreadMessage[],
  turns: readonly MemoryUsedTurn[],
  receipts: readonly RecallReceiptLike[],
  visibility: 'personal' | 'team' | undefined,
): ThreadMessage[] {
  if (receipts.length === 0) return [...thread];

  const personIds = new Set<string>();
  const answerIds = new Set<string>();
  for (const m of thread) {
    if (m.kind === 'user') personIds.add(m.id);
    else if (m.kind === 'agent' || m.kind === 'steps') answerIds.add(m.id);
  }

  /*
    Each person turn opens an exchange; the answer is the LAST assistant
    message whose turn falls before the next person turn. Turns are in
    conversation order (the event log's), which is the order that decides
    "last" — not their timestamps, which several turns can share.
  */
  const exchanges: Array<{ openedAt: number; answerId: string | null }> = [];
  for (const t of turns) {
    if (personIds.has(t.turnId)) {
      exchanges.push({ openedAt: Date.parse(t.createdAt), answerId: null });
    } else if (exchanges.length > 0 && answerIds.has(t.turnId)) {
      exchanges[exchanges.length - 1]!.answerId = t.turnId;
    }
  }

  const byAnswer = new Map<string, { seen: Set<string>; statements: MemoryUsedStatement[] }>();
  for (const r of receipts) {
    const at = Date.parse(r.at);
    if (Number.isNaN(at)) continue;
    let target: (typeof exchanges)[number] | undefined;
    for (const ex of exchanges) {
      // An exchange whose opening instant is unreadable can never be chosen,
      // but it still ends the exchange before it.
      if (!Number.isNaN(ex.openedAt) && ex.openedAt <= at) target = ex;
    }
    if (target === undefined || target.answerId === null) continue;
    let acc = byAnswer.get(target.answerId);
    for (const raw of r.statements) {
      const s = toStatement(raw);
      if (s === null) continue;
      if (acc === undefined) {
        acc = { seen: new Set(), statements: [] };
        byAnswer.set(target.answerId, acc);
      }
      if (acc.seen.has(s.id)) continue;
      if (acc.statements.length >= MEMORY_USED_MAX_STATEMENTS) break;
      acc.seen.add(s.id);
      acc.statements.push(s);
    }
  }

  return thread.map((m) => {
    if (m.kind !== 'agent' && m.kind !== 'steps') return m;
    const acc = byAnswer.get(m.id);
    if (acc === undefined || acc.statements.length === 0) return m;
    const memoryUsed: MemoryUsed = {
      statements: acc.statements,
      ...(visibility !== undefined ? { visibility } : {}),
    };
    return { ...m, memoryUsed };
  });
}
