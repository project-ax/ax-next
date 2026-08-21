// ---------------------------------------------------------------------------
// A cheap, tokenizer-free size estimate for a message list.
//
// Design §7 says the compaction TRIGGER needs no tokenizer, because the
// provider reports `usage.inputTokens` on every step. True — but only from the
// SECOND step onward. `agent.stream()` is a fresh call every turn, so step 0 of
// EVERY turn has no previous step and therefore no reported usage, and step 0
// is exactly where a resumed long conversation would blow the window. Without a
// fallback signal the compactor would be blind on the one request that matters
// most.
//
// So: this estimator is the FALLBACK signal, never the primary one. It is used
// for two things and nothing else.
//
//   1. The step-0 trigger, when the provider has not reported yet.
//   2. RELATIVE change — how much a rung of the ladder reclaimed. Applied as a
//      ratio against the provider's real number
//      (`projected = reported * after / before`), so the absolute error mostly
//      cancels and the accurate figure stays in charge.
//
// It deliberately does NOT gate the ceiling error. Failing a conversation on
// the strength of a chars-per-token guess would be the worst kind of wrong, so
// the ceiling fires only on a number the provider actually reported (see
// compactor.ts).
//
// Binary parts (images, PDFs) are the one place a naive `JSON.stringify().length`
// estimate goes badly wrong: a 1 MB base64 image reads as ~285k tokens and is
// really ~1.5k. They get a flat allowance instead.
// ---------------------------------------------------------------------------

import type { ModelMessage } from 'ai';

/**
 * Characters per token. English prose is ~4; code, JSON and file paths — most
 * of what a coding agent's transcript is made of — tokenize closer to 3. 3.5
 * splits the difference. The exact value matters less than it looks: it is a
 * common factor in the ratio this module is mostly used for.
 */
const CHARS_PER_TOKEN = 3.5;

/** Per-message envelope (role, delimiters) charged on top of the content. */
const PER_MESSAGE_TOKENS = 4;

/**
 * Flat allowance for one image / file / audio part. Real cost depends on
 * dimensions and the provider's tiling, and we have neither here — but it is
 * O(1000) tokens, not O(base64 length), and that is the part worth getting
 * roughly right.
 */
const BINARY_PART_TOKENS = 1_500;

/**
 * Flat allowance per tool DEFINITION in the request (name + description +
 * JSON schema). Tool schemas are handed to the provider on every step and can
 * add up to several thousand tokens across a full catalog, so leaving them out
 * would make the fallback estimate read low exactly when it must not.
 *
 * A flat number rather than a real measurement: `Tool.inputSchema` is a
 * `FlexibleSchema` (zod object, JSON schema, or a lazily-resolved thunk), and
 * serializing one is neither cheap nor guaranteed to work. This is an estimate
 * being estimated — precision here would be false precision.
 */
const TOOL_DEFINITION_TOKENS = 150;

/** Tokens for a plain string. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The fixed overhead of every request that is NOT the message list: the system
 * prompt and the tool definitions. Constant across the turn, so it does not
 * shrink when the ladder runs — which is precisely why it belongs on BOTH
 * sides of the before/after ratio.
 */
export function estimatePromptOverheadTokens(opts: {
  instructions: string;
  toolCount: number;
}): number {
  return (
    estimateTextTokens(opts.instructions) +
    opts.toolCount * TOOL_DEFINITION_TOKENS
  );
}

/** Tokens for a whole message list. */
export function estimateMessageTokens(
  messages: readonly ModelMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    total += PER_MESSAGE_TOKENS;
    total +=
      typeof message.content === 'string'
        ? estimateTextTokens(message.content)
        : sumParts(message.content);
  }
  return total;
}

function sumParts(parts: readonly unknown[]): number {
  let total = 0;
  for (const part of parts) total += estimatePartTokens(part);
  return total;
}

/**
 * One content part.
 *
 * Written against SHAPE rather than an exhaustive switch on `part.type`: the
 * AI SDK adds part types between minors (`tool-approval-request` arrived that
 * way), and an estimator that silently returns 0 for an unrecognised part
 * under-reads exactly when something new and large shows up. Every branch here
 * ends in a number.
 */
function estimatePartTokens(part: unknown): number {
  if (typeof part === 'string') return estimateTextTokens(part);
  if (part === null || typeof part !== 'object') return 0;

  const p = part as {
    type?: unknown;
    text?: unknown;
    input?: unknown;
    output?: unknown;
  };

  if (p.type === 'image' || p.type === 'file') return BINARY_PART_TOKENS;
  // `text` covers text, reasoning, and anything else the SDK models as prose.
  if (typeof p.text === 'string') return estimateTextTokens(p.text);
  if (p.type === 'tool-call') return estimateTextTokens(safeJson(p.input));
  if (p.type === 'tool-result') return estimateToolOutputTokens(p.output);
  return estimateTextTokens(safeJson(part));
}

/** Tokens for a `ToolResultPart.output` (the tagged union in provider-utils). */
export function estimateToolOutputTokens(output: unknown): number {
  if (output === null || typeof output !== 'object') return 0;
  const o = output as { type?: unknown; value?: unknown; reason?: unknown };
  if (o.type === 'text' || o.type === 'error-text') {
    return estimateTextTokens(typeof o.value === 'string' ? o.value : '');
  }
  if (o.type === 'json' || o.type === 'error-json') {
    return estimateTextTokens(safeJson(o.value));
  }
  if (o.type === 'execution-denied') {
    return estimateTextTokens(typeof o.reason === 'string' ? o.reason : '');
  }
  if (o.type === 'content' && Array.isArray(o.value)) return sumParts(o.value);
  return estimateTextTokens(safeJson(output));
}

/**
 * `JSON.stringify` that cannot throw and never returns `undefined`.
 *
 * Tool inputs arrive as parsed provider JSON, so a cycle is not reachable
 * today — but this runs on the path that decides whether a conversation gets
 * compacted, and a throw here would fail a turn over a size estimate.
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
