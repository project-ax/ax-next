// Recurrence signal for skill-crystallization (TASK-187).
//
// The skill-reflection routine (see @ax/routines `SKILL_REFLECTION_PROMPT`)
// crystallizes a procedure into a durable skill ONLY when it recurred across
// ≥2 DISTINCT conversations. The signal it reads is materialized on each
// consolidated doc as `DocFrontmatter.source_conversations` — the set of
// distinct conversation ids whose observations were merged into that doc.
//
// WHY a distinct-CONVERSATION count and not `source_observations.length >= 2`:
// the memory observer fires per message (one `chat:end` per message — see
// `@ax/agent-claude-sdk-runner` main.ts "exactly once per agent:invoke" and
// `debounce.ts` "one chat:end per message"), so a SINGLE multi-message
// conversation can yield ≥2 inbox observations. A naive observation-count gate
// would crystallize a one-off (the negative walk case). Counting distinct
// conversation ids is the correct recurrence semantics.
//
// WHY materialize here and not resolve at reflection time: the inbox
// observation that carried each `conversation_id` is DELETED once it's promoted
// into a doc (Invariant I12 — docs/ is the single source of truth). The doc is
// therefore the only surviving home for the conversation grouping; the
// reflection turn reads it straight from `/agent/memory/docs/…` with no new
// transcript-read surface (the whole point of TASK-187 / option b′).

import type { DocFrontmatter } from './types.js';

/**
 * Merge a new conversation id into an existing distinct-conversation list,
 * preserving first-seen order and deduping. `undefined`/empty contributes
 * nothing (an observation with no conversation can't prove recurrence). Pure;
 * never mutates the input array.
 */
export function mergeConversationId(
  existing: readonly string[] | undefined,
  conversationId: string | undefined,
): string[] {
  const out = [...(existing ?? [])];
  if (conversationId === undefined || conversationId.length === 0) return out;
  if (!out.includes(conversationId)) out.push(conversationId);
  return out;
}

/**
 * Distinct conversation ids that contributed to a doc. Reads the materialized
 * `source_conversations` field, tolerating a missing value (pre-TASK-187 docs)
 * as the empty set.
 */
export function distinctConversations(fm: Pick<DocFrontmatter, 'source_conversations'>): string[] {
  return fm.source_conversations ?? [];
}

/**
 * How many DISTINCT conversations a doc's procedure recurred across — the
 * recurrence count the ≥2 gate compares against.
 */
export function recurrenceCount(fm: Pick<DocFrontmatter, 'source_conversations'>): number {
  return distinctConversations(fm).length;
}

/** Minimum distinct conversations a procedure must recur across to crystallize. */
export const RECURRENCE_THRESHOLD = 2;

/**
 * Whether a doc satisfies the skill-crystallization recurrence gate: its
 * procedure recurred across at least {@link RECURRENCE_THRESHOLD} distinct
 * conversations.
 */
export function meetsRecurrenceGate(fm: Pick<DocFrontmatter, 'source_conversations'>): boolean {
  return recurrenceCount(fm) >= RECURRENCE_THRESHOLD;
}
