// Pure translators between our canonical `LlmCallInput`/`LlmCallOutput` and
// the Anthropic SDK's `messages.create` request/response shapes. Keeping
// these in their own file means we can unit-test them without ever touching
// the network or constructing a real client.

import type Anthropic from '@anthropic-ai/sdk';
import type { LlmCallInput, LlmCallOutput } from '@ax/core';
import type { LlmAnthropicConfig } from './plugin.js';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_MAX_TOKENS = 4096;

const KNOWN_STOP_REASONS = new Set<LlmCallOutput['stopReason']>([
  'end_turn',
  'max_tokens',
  'tool_use',
  'stop_sequence',
]);

export function toAnthropicRequest(
  input: LlmCallInput,
  cfg: LlmAnthropicConfig,
): Anthropic.MessageCreateParamsNonStreaming {
  const req: Anthropic.MessageCreateParamsNonStreaming = {
    model: input.model ?? cfg.defaultModel ?? DEFAULT_MODEL,
    max_tokens: input.maxTokens ?? cfg.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (input.system !== undefined) req.system = input.system;
  if (input.temperature !== undefined) req.temperature = input.temperature;
  return req;
}

export function fromAnthropicResponse(res: Anthropic.Message): LlmCallOutput {
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    text,
    stopReason: mapStopReason(res.stop_reason),
    usage: {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    },
  };
}

function mapStopReason(reason: Anthropic.StopReason | null): LlmCallOutput['stopReason'] {
  if (reason === null) return 'unknown';
  if (KNOWN_STOP_REASONS.has(reason as LlmCallOutput['stopReason'])) {
    return reason as LlmCallOutput['stopReason'];
  }
  // Provider-specific values like 'pause_turn' or 'refusal' collapse to
  // 'unknown' so subscribers can stay exhaustive.
  return 'unknown';
}
