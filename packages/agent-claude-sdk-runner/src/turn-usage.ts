import type { TurnUsage } from '@ax/agent-runner-core';

// ---------------------------------------------------------------------------
// Per-turn token accounting for the Claude Agent SDK loop (TASK-692, per-user
// spend limits).
//
// The loop reports what a turn cost through `EndTurnInput.usage`. This module
// is the pure part of producing that number: it watches the SDK's `assistant`
// messages and sums their Anthropic `usage` blocks.
//
// The one trap: ONE Anthropic API response reaches us as SEVERAL SDK
// `assistant` messages — one per content block (thinking, text, each tool_use)
// — and they all carry the SAME `message.id` and the SAME `usage`. Summing per
// message would bill a three-block response three times. So we de-duplicate by
// `message.id`, keeping the MAX per field per id: usage counters only grow
// within a response, and a later message of the same id may carry the final
// `output_tokens` where an earlier one carried a placeholder.
//
// Sub-agent messages (`parent_tool_use_id` set) are deliberately INCLUDED. A
// Task sub-agent's tokens are billed to the same key.
//
// Field mapping (Anthropic -> `TurnUsage`, whose buckets are disjoint):
//   input_tokens                -> inputTokens      (excludes cache reads/writes)
//   output_tokens               -> outputTokens     (includes thinking)
//   cache_read_input_tokens     -> cacheReadTokens
//   cache_creation_input_tokens -> cacheWriteTokens
// ---------------------------------------------------------------------------

/**
 * The slice of an SDK `assistant` message this module reads. Structural on
 * purpose: `SDKAssistantMessage` satisfies it, and the unit tests need not
 * fabricate a whole `BetaMessage`.
 */
export interface AssistantUsageSource {
  message?: { id?: unknown; usage?: unknown } | null;
}

export interface TurnUsageAccumulator {
  /** Fold one SDK `assistant` message into the running turn total. */
  observeAssistant(msg: AssistantUsageSource): void;
  /**
   * The turn's total so far, then RESET (the next turn starts from zero and does
   * not inherit message ids). `null` when nothing usable was observed: the loop
   * cannot tell what the turn cost, and the host then charges a flat assumed
   * cost rather than treating an unobserved turn as free.
   */
  drain(): TurnUsage | null;
}

interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A token count from an untrusted-shaped field: anything unreadable is 0. */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function readCounts(usage: Record<string, unknown>): Counts {
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
  };
}

export function createTurnUsageAccumulator(model: string): TurnUsageAccumulator {
  // Keyed by message id. Messages with no usable id go in `anonymous` instead,
  // each its own entry: with nothing to key on we cannot prove two are the same
  // response, and over-counting is the safe direction.
  let byId = new Map<string, Counts>();
  let anonymous: Counts[] = [];

  return {
    observeAssistant(msg: AssistantUsageSource): void {
      const message = msg?.message;
      if (message === null || message === undefined || typeof message !== 'object') return;
      const usage = message.usage;
      // No usage object at all: nothing to count. Not the same as a usage
      // object whose fields are null (that is a real, zero-cost observation).
      if (usage === null || usage === undefined || typeof usage !== 'object') return;

      const next = readCounts(usage as Record<string, unknown>);
      const id = message.id;
      if (typeof id !== 'string' || id.length === 0) {
        anonymous.push(next);
        return;
      }
      const prev = byId.get(id);
      if (prev === undefined) {
        byId.set(id, next);
        return;
      }
      prev.input = Math.max(prev.input, next.input);
      prev.output = Math.max(prev.output, next.output);
      prev.cacheRead = Math.max(prev.cacheRead, next.cacheRead);
      prev.cacheWrite = Math.max(prev.cacheWrite, next.cacheWrite);
    },

    drain(): TurnUsage | null {
      const entries = [...byId.values(), ...anonymous];
      byId = new Map();
      anonymous = [];
      if (entries.length === 0) return null;
      const total: TurnUsage = {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      for (const e of entries) {
        total.inputTokens += e.input;
        total.outputTokens += e.output;
        total.cacheReadTokens += e.cacheRead;
        total.cacheWriteTokens += e.cacheWrite;
      }
      return total;
    },
  };
}
