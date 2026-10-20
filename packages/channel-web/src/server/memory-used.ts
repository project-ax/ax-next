/**
 * TASK-628 — "Used N memories" under an answer.
 *
 * `@ax/memory` returns receipts containing only evidence the model explicitly
 * selected with `memory_use`, not the broader search candidates. This module
 * associates those snapshots with answers in the transcript.
 *
 * ATTRIBUTION IS BY TIME — see `exchanges.ts`: a receipt taken at `t` goes
 * on the answer of the exchange open at `t`.
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
import { answerFor, buildExchanges, type ExchangeTurn } from './exchanges.js';

/** The most statements one answer's chip carries. */
export const MEMORY_USED_MAX_STATEMENTS = 100;

/** The slice of a stored turn attribution needs. */
export type MemoryUsedTurn = ExchangeTurn;

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

  const exchanges = buildExchanges(thread, turns);

  const byAnswer = new Map<string, { seen: Set<string>; statements: MemoryUsedStatement[] }>();
  for (const r of receipts) {
    const answerId = answerFor(exchanges, r.at);
    if (answerId === null) continue;
    let acc = byAnswer.get(answerId);
    for (const raw of r.statements) {
      const s = toStatement(raw);
      if (s === null) continue;
      if (acc === undefined) {
        acc = { seen: new Set(), statements: [] };
        byAnswer.set(answerId, acc);
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
