import { z } from 'zod';
import type { AgentContext, HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// The admin-changeable limits, persisted as one JSON setting through
// `storage:get` / `storage:set` (the @ax/branding pattern). Reads are cached
// briefly because `chat:start` consults them on every turn; a write refreshes
// this host's cache at once, and other hosts pick it up within the TTL.
//
// Reading NEVER throws: a missing, corrupt or out-of-bounds stored value falls
// back to the default for that field (with a warn). A broken setting must not
// switch the limits off, and must not take chat down either.
// ---------------------------------------------------------------------------

export interface UsageLimits {
  /** Estimated spend per user over a rolling 24 hours, in USD. */
  dailySpendUsd: number;
  /** Estimated spend across all users over a rolling 24 hours. */
  fleetDailySpendUsd: number;
  /** Turns per user per rolling hour. */
  turnsPerHour: number;
  /** Charged for a turn whose loop reported no usage, in USD. */
  assumedTurnCostUsd: number;
}

export const DEFAULT_LIMITS: Readonly<UsageLimits> = Object.freeze({
  dailySpendUsd: 5,
  fleetDailySpendUsd: 100,
  turnsPerHour: 60,
  assumedTurnCostUsd: 0.25,
});

export const LIMITS_STORAGE_KEY = 'settings:usage-limits';

const FIELD_SCHEMAS = {
  dailySpendUsd: z.number().finite().min(0.01).max(10_000),
  fleetDailySpendUsd: z.number().finite().min(0.01).max(1_000_000),
  turnsPerHour: z.number().int().min(1).max(100_000),
  assumedTurnCostUsd: z.number().finite().min(0).max(100),
} as const;

export const UsageLimitsSchema = z
  .object({
    dailySpendUsd: FIELD_SCHEMAS.dailySpendUsd,
    fleetDailySpendUsd: FIELD_SCHEMAS.fleetDailySpendUsd,
    turnsPerHour: FIELD_SCHEMAS.turnsPerHour,
    assumedTurnCostUsd: FIELD_SCHEMAS.assumedTurnCostUsd,
  })
  .strict();

const FIELDS = Object.keys(FIELD_SCHEMAS) as Array<keyof UsageLimits>;

export class InvalidLimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLimitsError';
  }
}

export interface LimitsStore {
  get(): Promise<UsageLimits>;
  set(partial: Partial<UsageLimits>): Promise<UsageLimits>;
}

export function createLimitsStore(opts: {
  bus: HookBus;
  ctx: AgentContext;
  now?: () => Date;
  ttlMs?: number;
}): LimitsStore {
  const { bus, ctx } = opts;
  const now = opts.now ?? (() => new Date());
  const ttlMs = opts.ttlMs ?? 15_000;
  let cached: { value: UsageLimits; at: number } | undefined;

  function parseStored(bytes: Uint8Array | undefined): UsageLimits {
    const out: UsageLimits = { ...DEFAULT_LIMITS };
    if (bytes === undefined) return out;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      ctx.logger.warn('usage_limits_setting_corrupt', {
        key: LIMITS_STORAGE_KEY,
      });
      return out;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      ctx.logger.warn('usage_limits_setting_corrupt', {
        key: LIMITS_STORAGE_KEY,
      });
      return out;
    }
    const rec = raw as Record<string, unknown>;
    for (const field of FIELDS) {
      if (!(field in rec)) continue;
      const parsed = FIELD_SCHEMAS[field].safeParse(rec[field]);
      if (parsed.success) {
        out[field] = parsed.data;
      } else {
        ctx.logger.warn('usage_limits_setting_invalid_field', {
          key: LIMITS_STORAGE_KEY,
          field,
        });
      }
    }
    return out;
  }

  async function readFresh(): Promise<UsageLimits> {
    const res = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: LIMITS_STORAGE_KEY },
    );
    const value = parseStored(res.value);
    cached = { value, at: now().getTime() };
    return { ...value };
  }

  return {
    async get() {
      if (cached !== undefined && now().getTime() - cached.at < ttlMs) {
        return { ...cached.value };
      }
      return readFresh();
    },

    async set(partial) {
      // Merge over what is stored NOW (not a possibly-stale cache), so two
      // admins changing different fields on different hosts don't undo each
      // other beyond the unavoidable last-write-wins on the same field.
      const current = await readFresh();
      const merged: Record<string, unknown> = { ...current };
      for (const field of FIELDS) {
        if (partial[field] !== undefined) merged[field] = partial[field];
      }
      const parsed = UsageLimitsSchema.safeParse(merged);
      if (!parsed.success) {
        throw new InvalidLimitsError(parsed.error.issues[0]?.message ?? 'invalid limits');
      }
      await bus.call('storage:set', ctx, {
        key: LIMITS_STORAGE_KEY,
        value: new TextEncoder().encode(JSON.stringify(parsed.data)),
      });
      cached = { value: parsed.data, at: now().getTime() };
      return { ...parsed.data };
    },
  };
}
