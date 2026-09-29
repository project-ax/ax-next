import { z } from 'zod';
import type { AgentContext } from '@ax/core';
import type { LimitsStore } from './config.js';
import { costMicros } from './pricing.js';
import type { AdmitRefusal, ProviderVerdict, UsageStore } from './store.js';

// ---------------------------------------------------------------------------
// The gate and the meter, kept apart from the plugin wiring so they can be
// tested with a fake store, a fixed clock and a capturing logger.
//
//   admitTurn       — `chat:start`: refuse before a token is spent.
//   recordTurnEnd   — `chat:turn-end`: charge what an agent turn cost.
//   recordLlmUsage  — `llm:usage`: charge a host-side helper call.
//   providerStatus  — `usage:provider-status`: may the credential proxy still
//                     unlock this user's provider key?
//   providerRecord  — `usage:provider-record`: charge what the proxy measured
//                     on one model response, and answer the same question.
//
// Error posture is deliberately lopsided:
//   - The GATE fails CLOSED. HookBus.fire isolates a throwing subscriber and
//     carries on, which on a money control would mean "database down = no
//     limits". So admitTurn never throws; any failure becomes a refusal.
//   - The PROVIDER VERDICT fails closed the same way: providerStatus and
//     providerRecord never throw, and any failure (no user, database down,
//     limits unreadable) answers `blocked: true`. The proxy retries a 429, so
//     a blip heals itself; "cannot tell" must never mean "keep the key".
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

/**
 * One model response as the credential proxy measured it. The proxy runs on
 * the host, but it parsed bytes that came from the provider (and, for the
 * request size, from the sandbox), so this is parsed defensively too. `usage`
 * is `null` when the response was billable but could not be read; a payload
 * that does not match this at all is treated exactly like that.
 */
const ProviderRecordSchema = z.object({
  model: z.string().max(200).optional().catch(undefined),
  usage: z
    .object({
      inputTokens: TokenCount,
      outputTokens: TokenCount,
      cacheReadTokens: TokenCount,
      cacheWriteTokens: TokenCount,
    })
    .nullable(),
  requestBytes: z.number().finite().nonnegative().nullable(),
  /**
   * Present only when the response ended before it was complete: how much of it
   * arrived. The counters that would say what the model generated may be the
   * part that never did, so the bytes that did are the evidence. A malformed
   * value is ignored (`.catch`), never trusted and never fatal.
   */
  partial: z
    .object({ bytes: z.number().finite().nonnegative(), streamed: z.boolean() })
    .nullable()
    .optional()
    .catch(undefined),
});

/**
 * The stand-in for a billable response nobody could read ("unknown is never
 * free"): the request's size over ~3 bytes per token, or a large flat guess
 * when even that is unknown, plus a generous output. Always priced at the top
 * tier whatever the model claims to be.
 */
const UNMEASURED_INPUT_TOKENS_UNKNOWN_SIZE = 200_000;
const UNMEASURED_OUTPUT_TOKENS = 4096;
const UNMEASURED_BYTES_PER_TOKEN = 3;

/**
 * A response that ended early is floored at the output its bytes could have held.
 * The bytes-per-token figures are deliberately LOW so the floor over-counts: a
 * server-sent-events delta carries a JSON envelope of ~120 bytes around a few
 * tokens of text (so a real stream is 30-100+ bytes per token), and ordinary JSON
 * text is ~4 bytes per token. Over-counting only ever costs someone who hung up
 * mid-response; under-counting would let a client read every token and hang up
 * just before the final usage event.
 */
const PARTIAL_STREAMED_BYTES_PER_TOKEN = 8;
const PARTIAL_OTHER_BYTES_PER_TOKEN = 3;

function partialOutputFloor(partial: { bytes: number; streamed: boolean } | null | undefined): number {
  if (partial === null || partial === undefined) return 0;
  const perToken = partial.streamed ? PARTIAL_STREAMED_BYTES_PER_TOKEN : PARTIAL_OTHER_BYTES_PER_TOKEN;
  return Math.min(MAX_TOKENS, Math.ceil(partial.bytes / perToken));
}

function unmeasuredCostMicros(
  requestBytes: number | null,
  partial: { bytes: number; streamed: boolean } | null | undefined,
): number {
  const inputTokens =
    requestBytes === null
      ? UNMEASURED_INPUT_TOKENS_UNKNOWN_SIZE
      : Math.min(MAX_TOKENS, Math.ceil(requestBytes / UNMEASURED_BYTES_PER_TOKEN));
  const outputTokens = Math.max(UNMEASURED_OUTPUT_TOKENS, partialOutputFloor(partial));
  return costMicros(undefined, { inputTokens, outputTokens });
}

export interface UsageService {
  admitTurn(ctx: AgentContext): Promise<AdmitDecision>;
  recordTurnEnd(ctx: AgentContext, payload: unknown): Promise<void>;
  recordLlmUsage(ctx: AgentContext, event: unknown): Promise<void>;
  /** Read-only verdict for `ctx.userId`. Never throws; fails closed. */
  providerStatus(ctx: AgentContext): Promise<ProviderVerdict>;
  /** Charge one proxy-measured response to `ctx.userId`, then return the verdict. Never throws; fails closed. */
  providerRecord(ctx: AgentContext, payload: unknown): Promise<ProviderVerdict>;
}

const PROVIDER_UNAVAILABLE: ProviderVerdict = {
  blocked: true,
  reason: 'usage-check-unavailable',
};

function hasUser(ctx: AgentContext): boolean {
  return typeof ctx.userId === 'string' && ctx.userId.length > 0;
}

/** Log without ever throwing: a broken logger must not change a money decision. */
function logQuietly(
  ctx: AgentContext,
  level: 'info' | 'error',
  msg: string,
  bindings?: Record<string, unknown>,
): void {
  try {
    ctx.logger[level](msg, bindings);
  } catch {
    /* a broken logger must not change the answer */
  }
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
        // Helper calls never cross the credential proxy, so their cost is kept
        // apart from the runner-reported column: the spend expression adds it
        // OUTSIDE the "larger of runner / proxy" comparison.
        await store.recordHelper({
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

    async providerStatus(ctx) {
      try {
        if (!hasUser(ctx)) return PROVIDER_UNAVAILABLE;
        const current = await limits.get();
        return await store.providerStatus({ userId: ctx.userId, limits: current, now: now() });
      } catch (err) {
        logQuietly(ctx, 'error', 'usage_provider_status_failed', { err });
        return PROVIDER_UNAVAILABLE;
      }
    },

    async providerRecord(ctx, payload) {
      try {
        if (!hasUser(ctx)) return PROVIDER_UNAVAILABLE;

        const parsed = ProviderRecordSchema.safeParse(payload);
        let cost: number;
        if (parsed.success && parsed.data.usage !== null) {
          const u = parsed.data.usage;
          cost = costMicros(parsed.data.model, {
            ...u,
            outputTokens: Math.max(u.outputTokens, partialOutputFloor(parsed.data.partial)),
          });
        } else {
          // Billable but unread, or not a payload we understand: charge the
          // estimate rather than nothing. An unparseable payload also forgets
          // its requestBytes (we cannot trust any of it), so it pays the flat
          // guess, never a cheaper one.
          const requestBytes = parsed.success ? parsed.data.requestBytes : null;
          cost = unmeasuredCostMicros(requestBytes, parsed.success ? parsed.data.partial : undefined);
          logQuietly(ctx, 'info', 'usage_provider_unmeasured', {
            cause: parsed.success ? 'unreadable' : 'invalid',
          });
        }
        await store.recordProvider({ userId: ctx.userId, costMicros: cost, now: now() });
        // Written BEFORE the verdict is read, so the verdict includes this call.
        const current = await limits.get();
        return await store.providerStatus({ userId: ctx.userId, limits: current, now: now() });
      } catch (err) {
        logQuietly(ctx, 'error', 'usage_provider_record_failed', { err });
        return PROVIDER_UNAVAILABLE;
      }
    },
  };
}
