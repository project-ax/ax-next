import { randomBytes } from 'node:crypto';
import type { LlmCallResponse } from '@ax/ipc-protocol';
import type {
  AnthropicResponse,
  AnthropicResponseContentBlock,
  AnthropicStopReason,
  AnthropicUsage,
} from './anthropic-schemas.js';

export interface TranslateResponseOptions {
  genId?: () => string;
}

const KNOWN_STOP_REASONS = new Set<AnthropicStopReason>([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
]);

// Anthropic response consumers treat usage as required; zeros are safer than an omitted field.
const ZERO_USAGE: AnthropicUsage = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
});

export function translateLlmResponse(
  resp: LlmCallResponse,
  requestedModel: string,
  options: TranslateResponseOptions = {},
): AnthropicResponse {
  const genId = options.genId ?? defaultGenId;

  const content: AnthropicResponseContentBlock[] = [];
  const text = resp.assistantMessage.content;
  if (text.length > 0) {
    content.push({ type: 'text', text });
  }
  for (const call of resp.toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input ?? {},
    });
  }

  return {
    id: genId(),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    stop_reason: computeStopReason(resp),
    stop_sequence: null,
    content,
    usage: resp.usage
      ? {
          input_tokens: resp.usage.inputTokens ?? 0,
          output_tokens: resp.usage.outputTokens ?? 0,
        }
      : ZERO_USAGE,
  };
}

function computeStopReason(resp: LlmCallResponse): AnthropicStopReason {
  const raw = resp.stopReason;
  if (typeof raw === 'string' && KNOWN_STOP_REASONS.has(raw as AnthropicStopReason)) {
    return raw as AnthropicStopReason;
  }
  return resp.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
}

function defaultGenId(): string {
  return `msg_${randomBytes(12).toString('hex')}`;
}
