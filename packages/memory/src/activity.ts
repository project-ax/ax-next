import type { AgentContext, HookBus } from '@ax/core';

import { conversationOf } from './conversation.js';
import type {
  MemoryConversationActivity,
  MemoryConversationExtractionState,
} from './types.js';

/**
 * Per-conversation extraction activity — TASK-626.
 *
 * The chat's "What I learned in this chat" block needs two things the rest of
 * the memory surface does not give it: a push when a pass starts and ends
 * (so it can show "noting…" and then refresh), and a pull for the state right
 * now (so a page that loads mid-pass, or after a failed one, is not blank).
 * This file owns both, from ONE tracker, so the push and the pull cannot
 * disagree (invariant 4).
 *
 * What it deliberately does NOT own is "paused": that is per USER, not per
 * conversation (credential resolution is per user), and `pausedUsers` in
 * `plugin.ts` already answers it through `memory:status.extraction`. A second
 * copy here would be two answers to one question.
 */

/**
 * Subscriber hook, fired by `@ax/memory` around each incremental pass.
 *
 * Payload: {@link MemoryConversationActivity}. `statementIds` rides only on
 * `recorded`, and no statement TEXT is ever on it — the rows are extracted
 * from untrusted dialogue, and a subscriber that logged the payload would
 * otherwise be logging what a person said. A consumer that wants the rows
 * reads them back through `memory:recall({ conversationId })`, which is
 * owner-scoped.
 */
export const MEMORY_CONVERSATION_ACTIVITY_HOOK = 'memory:conversation-activity';

/** How a started pass ended. */
export type ConversationPassTerminal = Exclude<MemoryConversationActivity['state'], 'extracting'>;

/** The conversation a pass reports on, or `undefined` when it reports on none. */
export interface ActivityTarget {
  userId: string;
  conversationId: string;
}

/**
 * Who a pass reports to — or `undefined`, and then nothing is fired or
 * tracked.
 *
 * A routine run is skipped for the same reason its rows carry no
 * conversation (TASK-616, `conversation.ts`): its hidden per-fire
 * conversation is not one a person has open, so there is no chat to show a
 * feed in. A context with no user has nobody the state could belong to.
 */
export function activityTarget(
  ctx: Pick<AgentContext, 'conversationId' | 'source' | 'userId'>,
): ActivityTarget | undefined {
  const conversationId = conversationOf(ctx);
  if (typeof conversationId !== 'string' || conversationId === '') return undefined;
  const userId = ctx.userId;
  if (typeof userId !== 'string' || userId === '') return undefined;
  return { userId, conversationId };
}

export interface ConversationActivityTracker {
  /** The state `memory:status({ conversationId })` reports. Absent = `idle`. */
  state(target: ActivityTarget): MemoryConversationExtractionState;
  begin(target: ActivityTarget): void;
  end(target: ActivityTarget, terminal: ConversationPassTerminal): void;
}

/** Enough for every conversation a host has open at once, many times over. */
export const DEFAULT_ACTIVITY_MAX_ENTRIES = 1000;

/**
 * The in-process state behind both signals.
 *
 * In-process, like `pausedUsers`, and honest for the same reason: the host is
 * single-replica (the chart's `ax-next.validateHostReplicas` refuses more), and
 * incremental passes already serialize per conversation in-process (see
 * `incremental.ts`). A host restart forgets it, which reads as `idle` — true
 * for the passes that were running (they died with the process) and a lost
 * `failed` for the ones that had failed, which the next pass re-establishes.
 *
 * Keyed by user AND conversation so a caller can only ever read their own
 * state, and bounded so a long-lived host with many failed conversations
 * cannot grow it forever: past the cap the OLDEST insertion is dropped. A
 * dropped `failed` reads as `idle` — the cheap way to be wrong.
 */
export function createConversationActivityTracker(
  maxEntries: number = DEFAULT_ACTIVITY_MAX_ENTRIES,
): ConversationActivityTracker {
  // Only the two non-default states are stored; `idle` is the absence.
  const states = new Map<string, 'extracting' | 'failed'>();
  // NUL cannot appear in either id's ordinary form, so no two distinct
  // (user, conversation) pairs share a key.
  const keyOf = (t: ActivityTarget): string => `${t.userId}\u0000${t.conversationId}`;
  const put = (key: string, state: 'extracting' | 'failed'): void => {
    // Delete first so a re-set moves the key to the newest position — the
    // cap drops the entry touched longest ago, not the one created first.
    states.delete(key);
    states.set(key, state);
    while (states.size > maxEntries) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
  };
  return {
    state: (target) => states.get(keyOf(target)) ?? 'idle',
    begin: (target) => put(keyOf(target), 'extracting'),
    end: (target, terminal) => {
      // `failed` stays until a later pass for the conversation ends some other
      // way. Every other ending is `idle`: `recorded` and `idle` moved the
      // cursor, and `paused` is reported per user through `extraction`.
      if (terminal === 'failed') put(keyOf(target), 'failed');
      else states.delete(keyOf(target));
    },
  };
}

/**
 * Fire one activity event. **Never throws.**
 *
 * Called on the pass's failure paths too, so a throw here would turn a
 * reported failure into an unreported one. `HookBus.fire` already isolates a
 * throwing subscriber; the catch is for the fire itself.
 */
export async function fireConversationActivity(
  bus: HookBus,
  ctx: AgentContext,
  payload: MemoryConversationActivity,
): Promise<void> {
  try {
    await bus.fire<MemoryConversationActivity>(MEMORY_CONVERSATION_ACTIVITY_HOOK, ctx, payload);
  } catch {
    // Nothing to report to: the signal is advisory, and the pass it describes
    // has already logged its own outcome.
  }
}
