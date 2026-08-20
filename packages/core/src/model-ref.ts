import { PluginError } from './errors.js';

// Provider-agnostic `provider/model-id` reference parsing.
// See docs/plans/2026-08-18-provider-agnostic-runner-design.md §6.
//
// The split is on the FIRST `/`, matching the AI SDK's
// `createProviderRegistry(providers, { separator: '/' })` semantics, so a
// routing-style ref like `openrouter/x-ai/grok-4.6` yields
// provider=`openrouter`, modelId=`x-ai/grok-4.6` — the nested vendor slug
// stays intact in the model id rather than being chopped at every slash.
// `/` was chosen over `:` as the provider separator because ~19% of
// OpenRouter model slugs already use `:` for variant suffixes (`:free`,
// `:batch`); splitting on `:` would collide with those.
//
// This was previously duplicated in `@ax/conversation-titles` (the
// `settings:fast-model` value has always used this shape). `@ax/core` is the
// kernel every plugin may import, and already owns LLM vocabulary
// (`LlmCallInput`/`LlmCallOutput`), so it is the single home for this parser
// (Invariant 4 — one source of truth).

const PLUGIN_NAME = 'core';

export interface ParsedModelRef {
  provider: string;
  modelId: string;
}

/**
 * Parse a `provider/model-id` reference. Splits on the FIRST `/` so a
 * routing-style value like `openrouter/x-ai/grok-4.6` yields
 * provider=`openrouter`, modelId=`x-ai/grok-4.6`.
 *
 * Throws `PluginError({ code: 'invalid-payload' })` on:
 *   - empty or whitespace-only input
 *   - missing `/`
 *   - leading `/` (empty provider)
 *   - trailing `/` (empty model-id)
 */
export function parseModelRef(ref: string): ParsedModelRef {
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `model ref must be 'provider/model-id' (got empty value)`,
    });
  }
  // Reject embedded whitespace rather than trimming it. A ref like
  // ' anthropic/claude-sonnet-4-6' would otherwise parse to provider
  // ' anthropic', which matches no `llm:call:<provider>` hook and no
  // allow-list entry — a silent mis-route instead of a loud rejection.
  if (/\s/.test(ref)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `model ref must not contain whitespace (got: ${ref})`,
    });
  }
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx === ref.length - 1) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `model ref must be 'provider/model-id' (got: ${ref})`,
    });
  }
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/**
 * Non-throwing predicate for validators that want to raise their own error
 * text instead of catching `parseModelRef`'s `PluginError`. Acceptance is
 * identical to `parseModelRef`.
 */
export function isModelRef(ref: string): boolean {
  try {
    parseModelRef(ref);
    return true;
  } catch {
    return false;
  }
}
