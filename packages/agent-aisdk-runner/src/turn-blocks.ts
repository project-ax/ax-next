// ---------------------------------------------------------------------------
// AI SDK response messages -> the host's canonical ContentBlock shape.
//
// `EndTurnInput` carries the turn's assistant blocks and tool-result blocks in
// @ax/ipc-protocol's `ContentBlock` vocabulary (Anthropic-compatible, which is
// what @ax/conversations persists and channel-web renders). This module is the
// one place that maps the AI SDK's `ModelMessage` content parts onto it.
//
// WHY DERIVE FROM THE RESPONSE MESSAGES AND NOT FROM THE STREAM: the stream is
// for live UX (per-delta `event.stream-chunk`), the messages are for the
// record. Deriving both from the stream would mean the persisted turn and the
// transcript could disagree whenever a stream part was dropped or coalesced
// differently — a class of bug this repo has already paid for once in the
// transcript-loss lineage. The messages we persist here are byte-for-byte the
// ones we hand back to the model next turn.
//
// Unknown part kinds are DROPPED rather than guessed at. The canonical schema
// (`ContentBlockSchema`) validates at the storage boundary, so a future AI SDK
// part type must be mapped deliberately rather than smuggled through.
// ---------------------------------------------------------------------------

import type { ContentBlock } from '@ax/ipc-protocol';
import type { ModelMessage } from 'ai';

export interface TurnBlocks {
  /** text / thinking / tool_use observed in the turn's assistant messages. */
  contentBlocks: ContentBlock[];
  /** tool_result blocks, from the turn's `role: 'tool'` messages. */
  toolResultBlocks: ContentBlock[];
  /** The turn's assistant text, for the `event.chat-end` outcome history. */
  assistantText: string;
}

/**
 * Flatten an AI SDK tool-result `output` into the string the host stores.
 *
 * The SDK wraps outputs in a tagged shape (`{type:'text', value}`,
 * `{type:'error-text', value}`, `{type:'json', value}`, …). `error-text` is how
 * a thrown executor surfaces, which is exactly the case that must set
 * `is_error` downstream — see `isErrorOutput`.
 */
function flattenToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || typeof output !== 'object') return String(output);
  const o = output as { type?: unknown; value?: unknown };
  if (o.type === 'text' || o.type === 'error-text') {
    return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  }
  if (o.type === 'content' && Array.isArray(o.value)) {
    // A content-array output (text + media parts). Keep the text; the media
    // parts have no ContentBlock counterpart on the tool-result path today.
    return (o.value as Array<{ type?: unknown; text?: unknown }>)
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
  }
  return JSON.stringify(o.value ?? o);
}

function isErrorOutput(output: unknown): boolean {
  return (
    output !== null &&
    typeof output === 'object' &&
    (output as { type?: unknown }).type === 'error-text'
  );
}

/**
 * Map the messages a turn produced onto the host's block vocabulary.
 *
 * `messages` is `(await result.steps).flatMap(s => s.response.messages)` — NOT
 * `result.response.messages`, which carries only the LAST step's messages and
 * would silently drop every tool call and tool result from a multi-step turn.
 * (Verified against ai@7.0.70.)
 */
export function toTurnBlocks(messages: readonly ModelMessage[]): TurnBlocks {
  const contentBlocks: ContentBlock[] = [];
  const toolResultBlocks: ContentBlock[] = [];
  const assistantTexts: string[] = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        if (message.content.length > 0) {
          contentBlocks.push({ type: 'text', text: message.content });
          assistantTexts.push(message.content);
        }
        continue;
      }
      for (const part of message.content) {
        if (part.type === 'text') {
          contentBlocks.push({ type: 'text', text: part.text });
          assistantTexts.push(part.text);
        } else if (part.type === 'reasoning') {
          // The host's `thinking` block wants a signature when the provider
          // supplied one; the AI SDK keeps provider-specific fields under
          // providerOptions, so we persist the text and omit the signature
          // rather than inventing one.
          contentBlocks.push({ type: 'thinking', thinking: part.text });
        } else if (part.type === 'tool-call') {
          contentBlocks.push({
            type: 'tool_use',
            id: part.toolCallId,
            name: part.toolName,
            input: (part.input ?? {}) as Record<string, unknown>,
          });
        }
        // file / tool-approval-* parts have no ContentBlock counterpart —
        // dropped deliberately (see the module note).
      }
      continue;
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        const isError = isErrorOutput(part.output);
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: flattenToolOutput(part.output),
          ...(isError ? { is_error: true } : {}),
        });
      }
    }
  }

  return {
    contentBlocks,
    toolResultBlocks,
    assistantText: assistantTexts.join('\n'),
  };
}
