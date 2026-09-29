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

function rateFor(model: string | undefined): Rate {
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
export function costMicros(model: string | undefined, usage: TokenUsage): number {
  const r = rateFor(model);
  const hundredths =
    tokens(usage.inputTokens) * r.in +
    tokens(usage.outputTokens) * r.out +
    tokens(usage.cacheReadTokens) * r.cacheRead +
    tokens(usage.cacheWriteTokens) * r.cacheWrite;
  return Math.ceil(hundredths / 100);
}
