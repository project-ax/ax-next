/**
 * Which answer a moment in a conversation belongs to — shared by the chips
 * that hang under an answer ("Used N memories", TASK-628; "Updated project
 * memory", W3d-2).
 *
 * ATTRIBUTION IS BY TIME. A moment `t` belongs to the exchange opened by the
 * last person turn at or before `t` (an exchange runs up to the next person
 * turn), and the chip goes on the LAST `agent` | `steps` message of that
 * exchange — the answer the person actually reads. A moment whose exchange
 * has no answer yet (the turn is still live) attaches to nothing; the thread
 * re-read at turn end picks it up.
 *
 * "Person turn" is decided by the thread, not re-derived here: `buildThread`
 * already decided which user-role turns carry the person's content (text or a
 * file) and emitted a `user` message for exactly those, with `id = turnId`. A
 * second copy of that rule here would be two definitions of one boundary.
 */
import type { ThreadMessage } from '../lib/workspace-types.js';

/** The slice of a stored turn attribution needs. */
export interface ExchangeTurn {
  turnId: string;
  role: string;
  createdAt: string;
}

export interface Exchange {
  openedAt: number;
  answerId: string | null;
}

/**
 * The thread's exchanges, in conversation order. Each person turn opens one;
 * its answer is the LAST assistant message whose turn falls before the next
 * person turn. Turns are in conversation order (the event log's), which is
 * the order that decides "last" — not their timestamps, which several turns
 * can share.
 */
export function buildExchanges(
  thread: readonly ThreadMessage[],
  turns: readonly ExchangeTurn[],
): Exchange[] {
  const personIds = new Set<string>();
  const answerIds = new Set<string>();
  for (const m of thread) {
    if (m.kind === 'user') personIds.add(m.id);
    else if (m.kind === 'agent' || m.kind === 'steps') answerIds.add(m.id);
  }
  const exchanges: Exchange[] = [];
  for (const t of turns) {
    if (personIds.has(t.turnId)) {
      exchanges.push({ openedAt: Date.parse(t.createdAt), answerId: null });
    } else if (exchanges.length > 0 && answerIds.has(t.turnId)) {
      exchanges[exchanges.length - 1]!.answerId = t.turnId;
    }
  }
  return exchanges;
}

/**
 * The answer message id the ISO instant `at` belongs to, or `null` (an
 * unreadable instant, a moment before the first exchange, or an exchange with
 * no answer yet).
 */
export function answerFor(exchanges: readonly Exchange[], at: string): string | null {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  let target: Exchange | undefined;
  for (const ex of exchanges) {
    // An exchange whose opening instant is unreadable can never be chosen.
    if (!Number.isNaN(ex.openedAt) && ex.openedAt <= t) target = ex;
  }
  return target === undefined ? null : target.answerId;
}
