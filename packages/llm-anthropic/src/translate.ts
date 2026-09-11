// Pure translators between our canonical `LlmCallInput`/`LlmCallOutput` and
// the Anthropic SDK's `messages.create` request/response shapes. Keeping
// these in their own file means we can unit-test them without ever touching
// the network or constructing a real client.

import type Anthropic from '@anthropic-ai/sdk';
import { PluginError, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import type { LlmAnthropicConfig } from './plugin.js';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Our normalized `ReasoningEffort` ladder, in Anthropic's units.
 *
 * Anthropic has no `effort` parameter — it has an explicit token budget for
 * extended thinking — so the mapping is effort → budget. 1024 is the API's
 * documented minimum for an enabled budget, which is what makes it `'low'`.
 *
 * `'minimal'` is deliberately ABSENT from this table: extended thinking is off
 * by default on the Messages API, so the minimal-effort request is the absence
 * of the field. Sending `thinking: {type:'disabled'}` would read the same for
 * a model that supports thinking and 400 for one that doesn't — and the floor
 * rung of the ladder has to degrade rather than fail the call.
 */
const THINKING_BUDGET_TOKENS: Readonly<Record<'low' | 'medium' | 'high', number>> = Object.freeze({
  low: 1024,
  medium: 4096,
  high: 16384,
});

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

  // Reasoning. `'minimal'` (and an unset field) leave the request untouched —
  // see THINKING_BUDGET_TOKENS for why absence is the right translation of
  // "deliberate as little as possible" here.
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== 'minimal') {
    // Own-property lookup, the same hygiene `@ax/llm-openrouter`'s
    // `mapFinishReason` uses: `Object.freeze` does not stop a prototype walk,
    // so a caller that got past the type (plain JS, a JSON-decoded config) and
    // passed 'constructor' would otherwise put a FUNCTION in `budget_tokens`
    // and NaN in `max_tokens` — a corrupt request, which is the one outcome
    // worse than a rejected one.
    const budget = Object.prototype.hasOwnProperty.call(
      THINKING_BUDGET_TOKENS,
      input.reasoningEffort,
    )
      ? THINKING_BUDGET_TOKENS[input.reasoningEffort]
      : undefined;
    if (budget === undefined) {
      // Refuse rather than quietly drop the caller's request. An unrecognized
      // rung is a caller bug — TypeScript rejects it, so only plain JS or a
      // JSON-decoded config can get here — and the sibling provider is loud
      // about it too: @ax/llm-openrouter forwards whatever it was given and
      // OpenRouter answers 400. Degrading to a no-op here would make the same
      // bug silent on one provider and loud on the other, which is exactly the
      // kind of asymmetry nobody discovers until it matters.
      throw new PluginError({
        code: 'invalid-payload',
        plugin: '@ax/llm-anthropic',
        hookName: 'llm:call:anthropic',
        message: `unknown reasoningEffort ${JSON.stringify(input.reasoningEffort)} — expected 'minimal', 'low', 'medium' or 'high'`,
      });
    }
    req.thinking = { type: 'enabled', budget_tokens: budget };
    // The API requires max_tokens > budget_tokens, STRICTLY, and the caller's
    // `maxTokens` is an allowance for the ANSWER — it was never sized to also
    // cover thinking. Spending the budget on top of it keeps the caller's
    // stated intent intact; capping at their number instead would either 400
    // (budget >= max) or silently leave no room for a reply. The `max(_, 1)`
    // is what keeps `maxTokens: 0` from landing exactly ON the budget and
    // tripping that strict inequality.
    req.max_tokens = budget + Math.max(req.max_tokens, 1);
    // Anthropic rejects a temperature other than 1 alongside extended
    // thinking. The caller asked for thinking explicitly and for a temperature
    // only incidentally, so the temperature is what gives way.
    delete req.temperature;
  }
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
