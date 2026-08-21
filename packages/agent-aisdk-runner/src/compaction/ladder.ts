// ---------------------------------------------------------------------------
// The compaction ladder, rungs 1 and 2 (design §7).
//
//   Rung 1 — MASK stale tool outputs. Superseded tool results collapse to
//            their first few hundred characters plus a marker saying what
//            happened. No LLM call, no message removed, no pairing disturbed.
//   Rung 2 — PRUNE. `ai`'s own `pruneMessages` drops old tool call/result
//            PAIRS outright. Strictly more aggressive than rung 1 over the
//            same region, which is what makes it the next rung rather than an
//            alternative to it.
//
// Rung 3 (summarize) lives in summarize.ts, not here, and runs at the TURN
// BOUNDARY rather than per step: it needs an LLM call and a persisted result,
// neither of which has a safe moment inside a tool loop. What it shares with
// these two is `preservedMessageCount` below — all three rungs treat the same
// newest-30% region, and a second window constant would let them drift.
//
// TWO RULES BOTH RUNGS OBEY.
//
// **Nothing is mutated.** These functions are handed the SAME `ModelMessage`
// objects the in-memory transcript holds (`transcript.messages()` copies the
// array, not the messages). The transcript's serialized bytes are the host's
// source of truth and are re-shipped verbatim; editing a message in place here
// would change those bytes, break the host's `prefixHash`, and force a whole-
// file resync on every resume. Every rewrite below builds new objects. The
// tests assert it, because "we were careful" is not a mechanism.
//
// **Tool calls and their results stay paired.** A tool_use with no matching
// tool_result (or the reverse) is a 400 from Anthropic, not a degraded
// response. Rung 1 only rewrites the CONTENT of a result, so pairing is
// untouched by construction; rung 2 delegates the surgery to `pruneMessages`,
// which drops both halves together by tool-call id.
//
// **Reasoning is NOT this module's business.** `pruneMessages` can strip
// reasoning too, and design §7 lists it under rung 2 — but the send-site
// transform in provider.ts (`messagesForProvider`, design §6) already owns
// that policy, and doing it here as well would be a second owner of one
// decision (invariant 4). It would also be actively wrong mid-turn: the
// SDK's `before-last-message` spares only the literal last message, which
// during a tool loop is the tool RESULT — so it would strip the thinking block
// attached to the tool_use that produced it, and Anthropic's thinking blocks
// are signed and required in exactly that position.
// ---------------------------------------------------------------------------

import { pruneMessages, type ModelMessage } from 'ai';

/**
 * Fraction of the message list kept fully intact at the newest end. Gemini
 * CLI's constant for the same job, and the reasoning carries: recent turns are
 * what the model is actually working from, and reclaiming space from them is
 * how compaction turns into amnesia.
 */
const PRESERVE_FRACTION = 0.3;

/**
 * Floor on the preserved window. At small message counts the fraction rounds
 * to nothing, and masking the tool result the model is mid-thought about is
 * the one thing that must never happen.
 */
const MIN_PRESERVED_MESSAGES = 2;

/**
 * How much of a masked tool output survives, in characters (~140 tokens).
 * Enough for a command's first lines, a file's head, or an error — the part a
 * later turn usually needs — without keeping the 40 KB body.
 */
const MASK_BUDGET_CHARS = 500;

/**
 * The tail of the note left in place of what was dropped, used as the sentinel
 * that says "already masked".
 *
 * Without it this rung is NOT idempotent: the note itself pushes the value back
 * over the budget, so the next step would mask the masked value, and the step
 * after that would mask that — nibbling the surviving head away one marker at a
 * time. `prepareStep`'s output carries forward into the next step, so this runs
 * over its own output constantly and idempotence is a correctness property, not
 * a nicety.
 */
const MASK_NOTE_END = 'Run the tool again if you need the rest.]';

/**
 * How many messages at the newest end are left completely alone.
 *
 * Exported because both rungs share it: rung 2 is defined as "the same region
 * rung 1 masked, treated harder", and a second window constant would let the
 * two drift into treating different regions.
 */
export function preservedMessageCount(messageCount: number): number {
  return Math.max(
    MIN_PRESERVED_MESSAGES,
    Math.ceil(messageCount * PRESERVE_FRACTION),
  );
}

/**
 * Rung 1 — collapse tool outputs older than the preserved window.
 *
 * Idempotent by way of the `MASK_NOTE_END` sentinel, which matters because
 * `prepareStep`'s returned messages carry forward to later steps: this runs
 * over its own output every step.
 */
export function maskStaleToolOutputs(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const cutoff = messages.length - preservedMessageCount(messages.length);
  if (cutoff <= 0) return [...messages];

  return messages.map((message, index) => {
    if (index >= cutoff) return message;
    // Tool results live in `tool` messages, and in `assistant` messages when a
    // provider executed the tool itself. Both are in scope.
    if (message.role !== 'tool' && message.role !== 'assistant') return message;
    if (typeof message.content === 'string') return message;

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const masked = maskOutput(part.output);
      if (masked === null) return part;
      changed = true;
      return { ...part, output: masked };
    });
    // Returning the original object when nothing changed keeps the no-mutation
    // contract cheap to verify: an unchanged message is the SAME reference.
    return changed
      ? ({ ...message, content } as ModelMessage)
      : message;
  });
}

/**
 * The masked replacement for one tool output, or `null` when the output is
 * already small enough — or already masked — to leave alone.
 *
 * A JSON output (`json` / `error-json`) comes back as its text counterpart.
 * That is a deliberate shape change: what is left is prose about an elision,
 * not the structured value, and labelling truncated JSON as JSON would invite
 * the model to parse it.
 *
 * ERROR-NESS SURVIVES. An `error-text`/`error-json` output masks to
 * `error-text`, never to plain `text` — the provider renders that flag
 * (Anthropic's `is_error`), so collapsing it would quietly turn an old failed
 * command into one the model reads as having succeeded.
 */
function maskOutput(
  output: unknown,
): { type: 'text' | 'error-text'; value: string } | null {
  const rendered = renderOutput(output);
  if (rendered === null || rendered.text.length <= MASK_BUDGET_CHARS) return null;
  if (rendered.text.endsWith(MASK_NOTE_END)) return null;
  const head = rendered.text.slice(0, MASK_BUDGET_CHARS);
  const elided = rendered.text.length - MASK_BUDGET_CHARS;
  return {
    type: rendered.isError ? 'error-text' : 'text',
    value:
      `${head}\n\n[${elided.toLocaleString('en-US')} more characters were dropped to ` +
      `make room in the context window. ${MASK_NOTE_END}`,
  };
}

/**
 * A tool output as the text it would contribute to the prompt, or `null` for
 * outputs there is no point masking.
 *
 * `execution-denied` is a policy verdict of a few words; a `content` output
 * carrying files is mostly binary parts, which masking cannot shrink (and
 * whose text parts are not worth splitting the shape over).
 */
function renderOutput(
  output: unknown,
): { text: string; isError: boolean } | null {
  if (output === null || typeof output !== 'object') return null;
  const o = output as { type?: unknown; value?: unknown };
  const isError = o.type === 'error-text' || o.type === 'error-json';
  if (o.type === 'text' || o.type === 'error-text') {
    return typeof o.value === 'string' ? { text: o.value, isError } : null;
  }
  if (o.type === 'json' || o.type === 'error-json') {
    try {
      const text = JSON.stringify(o.value);
      return text === undefined ? null : { text, isError };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Rung 2 — drop tool call/result pairs older than the preserved window.
 *
 * `emptyMessages: 'remove'` is what keeps a stripped `tool` message from being
 * sent as an empty one (a 400 at Anthropic). An assistant message that also
 * carried text keeps the text and stays.
 */
export function pruneOldToolCalls(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const keep = preservedMessageCount(messages.length);
  return pruneMessages({
    messages: [...messages],
    // The SDK types this as a template literal, so the count has to be baked
    // into the string; it parses the number back out.
    toolCalls: `before-last-${keep}-messages` as `before-last-${number}-messages`,
    emptyMessages: 'remove',
  });
}
