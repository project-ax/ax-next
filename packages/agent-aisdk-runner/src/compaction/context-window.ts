// ---------------------------------------------------------------------------
// How much context each model we can be pointed at actually holds.
//
// Neither the AI SDK nor our own `models:list-supported:<provider>` hook
// carries a context window: `LanguageModel` exposes `provider` and `modelId`
// and nothing about limits, and the models hook returns `{ id, label, kind }`
// for the admin picker. So the number has to come from somewhere, and this is
// it.
//
// Why a static table and not a lookup:
//
//   - OpenRouter DOES publish `context_length` on `GET /api/v1/models`, but
//     reading it would mean a network call from inside the sandbox, on the
//     boot path, against an egress allow-list, for a number that changes when
//     a model ships — not per session. The failure modes (slow boot, a 502
//     turning into a dead runner) cost more than the staleness.
//   - Anthropic publishes nothing equivalent.
//
// This table lives in the RUNNER rather than in `@ax/core` next to
// `PROVIDER_ENDPOINTS` on purpose. `PROVIDER_ENDPOINTS` is shared because two
// sides of the sandbox wall have to agree on it (host egress + runner dial) and
// drift shows up as a MITM 403. Nothing on the host reads a context window: it
// is consumed here and only here, so a shared copy would be a second source of
// truth for no benefit (invariant 4). Move it when a second reader appears —
// not before.
//
// Being WRONG here is not a cliff in either direction. Too small and
// compaction runs earlier than it needed to (we lose some old tool output).
// Too large and the provider's own context-length error is the backstop. The
// unknown-model default is deliberately on the small side for that reason.
// ---------------------------------------------------------------------------

import { parseModelRef } from '@ax/core';

/**
 * What we assume when the ref names a model we have no entry for. Small on
 * purpose: an unknown model is far more likely to be a small one than a
 * 1M-token one, and the cost of guessing low is some lost tool output while
 * the cost of guessing high is a failed request.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

interface ProviderWindows {
  /** Exact model ids (provider prefix already stripped). */
  models: Readonly<Record<string, number>>;
  /** Used for a model id this provider serves but we have no entry for. */
  fallback: number;
}

const CONTEXT_WINDOWS: Readonly<Record<string, ProviderWindows>> = Object.freeze(
  {
    anthropic: Object.freeze({
      // Every shipping Claude model is 200k, so the per-model map is empty and
      // the fallback does the work — including for model ids released after
      // this line was written, which is the case a per-model map handles worst.
      // (Sonnet's 1M-token beta is opt-in via a request header we do not send.)
      models: Object.freeze({}),
      fallback: 200_000,
    }),
    openrouter: Object.freeze({
      models: Object.freeze({
        'x-ai/grok-4.6': 500_000,
        'moonshotai/kimi-k3': 1_000_000,
      }),
      // OpenRouter fronts hundreds of models across every size class, so there
      // is no honest provider-wide number — an unknown slug gets the
      // conservative default.
      fallback: DEFAULT_CONTEXT_WINDOW_TOKENS,
    }),
  },
);

/**
 * The context window, in tokens, for a `provider/model-id` ref.
 *
 * Never throws for an unparseable ref — it returns the default. This runs on
 * the compaction path, where the ref has already been through `resolveModel`
 * and cannot be malformed; making a size lookup capable of killing a turn
 * would be trading a real failure for an imaginary one.
 */
export function contextWindowFor(modelRef: string): number {
  let modelId: string;
  let provider: string;
  try {
    ({ provider, modelId } = parseModelRef(modelRef));
  } catch {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  // Own-property lookups throughout: both halves of the ref are ultimately
  // admin-supplied, and `CONTEXT_WINDOWS['constructor']` is not `undefined`.
  // Same guard as `providerEndpointFor` in @ax/core and `providerEntryFor` in
  // provider.ts.
  const windows = Object.prototype.hasOwnProperty.call(CONTEXT_WINDOWS, provider)
    ? CONTEXT_WINDOWS[provider]
    : undefined;
  if (windows === undefined) return DEFAULT_CONTEXT_WINDOW_TOKENS;

  // OpenRouter variant suffixes (`…:free`, `…:batch`, `…:thinking`) select a
  // routing flavour of the SAME underlying model, so they share its window.
  // Strip before the exact-id lookup rather than listing every variant.
  const baseId = stripVariantSuffix(modelId);
  const exact = Object.prototype.hasOwnProperty.call(windows.models, baseId)
    ? windows.models[baseId]
    : undefined;
  return exact ?? windows.fallback;
}

function stripVariantSuffix(modelId: string): string {
  const idx = modelId.indexOf(':');
  return idx === -1 ? modelId : modelId.slice(0, idx);
}
