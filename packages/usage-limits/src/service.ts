import { z } from 'zod';
import type { AgentContext } from '@ax/core';
import type { LimitsStore } from './config.js';
import { costMicros } from './pricing.js';
import type { AdmitRefusal, UsageStore } from './store.js';

// ---------------------------------------------------------------------------
// The gate and the meter, kept apart from the plugin wiring so they can be
// tested with a fake store, a fixed clock and a capturing logger.
//
//   admitTurn       — `chat:start`: refuse before a token is spent.
//   recordTurnEnd   — `chat:turn-end`: charge what an agent turn cost.
//   recordLlmUsage  — `llm:usage`: charge a host-side helper call.
//
// Error posture is deliberately lopsided:
//   - The GATE fails CLOSED. HookBus.fire isolates a throwing subscriber and
//     carries on, which on a money control would mean "database down = no
//     limits". So admitTurn never throws; any failure becomes a refusal.
//   - The METERS never throw. A metering hiccup is one error line, never a
//     failed turn or a failed helper call.
// ---------------------------------------------------------------------------

export type AdmitReason = AdmitRefusal | 'usage-check-unavailable';
export type AdmitDecision = { ok: true } | { ok: false; reason: AdmitReason };

const MAX_TOKENS = 1_000_000_000;

/** A whole, finite token count, clamped into [0, 1e9]. Anything else fails. */
const TokenCount = z
  .number()
  .int()
  .transform((n) => Math.min(MAX_TOKENS, Math.max(0, n)));

/**
 * Runner-reported usage on the assistant `chat:turn-end`. UNTRUSTED: it was
 * minted inside the sandbox. Declared here rather than imported from
 * @ax/ipc-protocol (no cross-plugin imports), and stricter in one place on
 * purpose: an unusable `model` is dropped (and so priced at the top tier)
 * instead of discarding the token counts that came with it.
 */
const TurnUsageSchema = z.object({
  model: z.string().max(200).optional().catch(undefined),
  inputTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  cacheReadTokens: TokenCount.optional(),
  cacheWriteTokens: TokenCount.optional(),
});

const LlmUsageSchema = z.object({
  model: z.string().max(200).optional().catch(undefined),
  usage: z.object({
    inputTokens: TokenCount,
    outputTokens: TokenCount,
  }),
});

export interface UsageService {
  admitTurn(ctx: AgentContext): Promise<AdmitDecision>;
  recordTurnEnd(ctx: AgentContext, payload: unknown): Promise<void>;
  recordLlmUsage(ctx: AgentContext, event: unknown): Promise<void>;
}

function hasUser(ctx: AgentContext): boolean {
  return typeof ctx.userId === 'string' && ctx.userId.length > 0;
}

export function createUsageService(deps: {
  store: UsageStore;
  limits: LimitsStore;
  now?: () => Date;
}): UsageService {
  const { store, limits } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async admitTurn(ctx) {
      if (!hasUser(ctx)) return { ok: false, reason: 'usage-check-unavailable' };
      try {
        const current = await limits.get();
        return await store.admit({ userId: ctx.userId, limits: current, now: now() });
      } catch (err) {
        try {
          ctx.logger.error('usage_admit_failed', { err });
        } catch {
          /* a broken logger must not turn a refusal into a pass */
        }
        return { ok: false, reason: 'usage-check-unavailable' };
      }
    },

    async recordTurnEnd(ctx, payload) {
      try {
        if (payload === null || typeof payload !== 'object') return;
        const p = payload as { role?: unknown; usage?: unknown };
        // Only the assistant turn-end closes a model turn. The role='tool'
        // turn-end (and heartbeats, which carry no role) cost nothing extra.
        if (p.role !== 'assistant') return;
        if (!hasUser(ctx)) return;

        const parsed =
          p.usage === undefined || p.usage === null ? undefined : TurnUsageSchema.safeParse(p.usage);
        // A usage object carrying no token figure at all (`{}`, or just a model
        // name) is not a measurement, so it is treated like an absent one. Only
        // an explicit count, zero included, says "this turn cost that much".
        const measured =
          parsed !== undefined &&
          parsed.success &&
          (parsed.data.inputTokens !== undefined ||
            parsed.data.outputTokens !== undefined ||
            parsed.data.cacheReadTokens !== undefined ||
            parsed.data.cacheWriteTokens !== undefined);
        if (parsed === undefined || !parsed.success || !measured) {
          // "Could not tell" is never "free": charge the flat assumed cost.
          const { assumedTurnCostUsd } = await limits.get();
          ctx.logger.info('usage_unreported', {
            cause: parsed === undefined ? 'absent' : 'invalid',
          });
          await store.record({
            userId: ctx.userId,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costMicros: Math.ceil(assumedTurnCostUsd * 1_000_000),
            },
            now: now(),
          });
          return;
        }
        const u = {
          inputTokens: parsed.data.inputTokens ?? 0,
          outputTokens: parsed.data.outputTokens ?? 0,
          cacheReadTokens: parsed.data.cacheReadTokens ?? 0,
          cacheWriteTokens: parsed.data.cacheWriteTokens ?? 0,
        };
        await store.record({
          userId: ctx.userId,
          usage: { ...u, costMicros: costMicros(parsed.data.model, u) },
          now: now(),
        });
      } catch (err) {
        try {
          ctx.logger.error('usage_record_failed', { err });
        } catch {
          /* never throw from a meter */
        }
      }
    },

    async recordLlmUsage(ctx, event) {
      try {
        if (!hasUser(ctx)) return;
        const parsed = LlmUsageSchema.safeParse(event);
        if (!parsed.success) {
          ctx.logger.warn('llm_usage_invalid');
          return;
        }
        const u = {
          inputTokens: parsed.data.usage.inputTokens,
          outputTokens: parsed.data.usage.outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        await store.record({
          userId: ctx.userId,
          usage: { ...u, costMicros: costMicros(parsed.data.model, u) },
          now: now(),
        });
      } catch (err) {
        try {
          ctx.logger.error('usage_record_failed', { err });
        } catch {
          /* never throw from a meter */
        }
      }
    },
  };
}
