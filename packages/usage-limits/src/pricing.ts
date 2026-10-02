import { z } from 'zod';
import type { AgentContext, HookBus } from '@ax/core';
// ---------------------------------------------------------------------------
// Estimated spend, in integer micro-USD (1 USD = 1_000_000 micros).
//
// This is an ABUSE CONTROL, not billing. The one rule it must never break is
// "unknown is never cheap": anything we cannot confidently name is priced at
// the top tier, so a new model or a renamed ref over-counts instead of hiding.
//
// Rates are USD per million tokens, which is numerically the same as micro-USD
// per token: 1 token at $15/M costs 15 micros.
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Rates are stored in HUNDREDTHS of a micro-USD per token so every rate is an
 * integer (0.3 -> 30, 18.75 -> 1875). The sum is then exact integer math and
 * divided once at the end; naive float math (10 x 0.3 = 3.0000000000000004)
 * would let Math.ceil round an exact price up a whole micro.
 */
interface Rate {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

// Opus is priced at the OLDER, higher Opus rate ($15/$75) on purpose. Newer
// Opus releases are cheaper, but a family match cannot tell the generations
// apart reliably, and this table's job is to err high: over-estimating an
// expensive model trips a cap a bit early, under-estimating one lets a runaway
// loop spend real money past it. Opus is also the fallback for anything
// unrecognised, so this is the "we don't know what that is" price too.
const OPUS: Rate = { in: 1500, out: 7500, cacheRead: 150, cacheWrite: 1875 };
const SONNET: Rate = { in: 300, out: 1500, cacheRead: 30, cacheWrite: 375 };
const HAIKU: Rate = { in: 100, out: 500, cacheRead: 10, cacheWrite: 125 };

// Exact provider/model references, never substring or wildcard matches. The
// proxy sees a bare provider model id; runners and helpers add a transport
// prefix. Ignore the known provider prefixes (including OpenRouter’s Claude
// namespace), preserving all other vendor namespaces.
export function priceModelId(model: string): string {
  return model.toLowerCase().replace(/^(?:(?:openrouter|anthropic)\/)+/, '');
}
const Price = z.number().finite().min(0).max(10_000).multipleOf(0.01);
export const ModelPriceSchema = z
  .object({
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]*$/),
    inputUsdPerMillion: Price,
    outputUsdPerMillion: Price,
    cacheReadUsdPerMillion: Price,
    cacheWriteUsdPerMillion: Price,
  })
  .strict();
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export const PricesSchema = z
  .array(ModelPriceSchema)
  .max(100)
  .refine(
    (prices) => new Set(prices.map((p) => priceModelId(p.model))).size === prices.length,
    'Duplicate model prices',
  );
export interface PriceStore {
  get(): Promise<ModelPrice[]>;
  set(prices: ModelPrice[]): Promise<ModelPrice[]>;
}
export function createPriceStore({ bus, ctx }: { bus: HookBus; ctx: AgentContext }): PriceStore {
  const key = 'settings:usage-prices';
  // No process cache: saved prices apply on every host to the next settlement.
  return {
    async get() {
      const { value } = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
        'storage:get',
        ctx,
        { key },
      );
      if (value === undefined) return [];
      try {
        return PricesSchema.parse(JSON.parse(new TextDecoder().decode(value)));
      } catch {
        ctx.logger.warn('usage_prices_setting_corrupt');
        return [];
      }
    },
    async set(prices) {
      const saved = PricesSchema.parse(prices);
      await bus.call('storage:set', ctx, {
        key,
        value: new TextEncoder().encode(JSON.stringify(saved)),
      });
      return saved;
    },
  };
}

function rateFor(model: string | undefined, prices: ModelPrice[]): Rate {
  const custom =
    typeof model === 'string'
      ? prices.find((p) => priceModelId(p.model) === priceModelId(model))
      : undefined;
  if (custom)
    return {
      in: Math.round(custom.inputUsdPerMillion * 100),
      out: Math.round(custom.outputUsdPerMillion * 100),
      cacheRead: Math.round(custom.cacheReadUsdPerMillion * 100),
      cacheWrite: Math.round(custom.cacheWriteUsdPerMillion * 100),
    };
  if (typeof model !== 'string') return OPUS;
  const m = model.toLowerCase();
  // Require "claude" as well as the family word, so a third-party model that
  // happens to be called "sonnet-something" is not priced as a cheap Claude.
  if (!m.includes('claude')) return OPUS;
  if (m.includes('haiku')) return HAIKU;
  if (m.includes('sonnet')) return SONNET;
  // "opus" and every unrecognised Claude name land here.
  return OPUS;
}

/** A finite, non-negative whole token count; anything else counts as 0. */
function tokens(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  // Round a fractional count UP: never under-count.
  return Math.ceil(n);
}

/** Estimated cost of one call or turn, in whole micro-USD (rounded up). */
export function costMicros(
  model: string | undefined,
  usage: TokenUsage,
  prices: ModelPrice[] = [],
): number {
  const r = rateFor(model, prices);
  const hundredths =
    tokens(usage.inputTokens) * r.in +
    tokens(usage.outputTokens) * r.out +
    tokens(usage.cacheReadTokens) * r.cacheRead +
    tokens(usage.cacheWriteTokens) * r.cacheWrite;
  return Math.ceil(hundredths / 100);
}
