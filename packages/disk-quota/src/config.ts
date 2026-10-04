import { z } from 'zod';
import type { AgentContext, HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// The admin-changeable storage limits, persisted as one JSON setting through
// `storage:get` / `storage:set` (the @ax/usage-limits and @ax/branding
// pattern). Reads are cached briefly because the write gates consult them on
// every commit and upload; a write refreshes this host's cache at once, and
// other hosts pick it up within the TTL.
//
// Reading NEVER throws on a bad VALUE: a missing, corrupt or out-of-bounds
// stored value falls back to the default for that field (with a warn). A
// broken setting must not switch the limit off. (A failure to read at all is
// different: that throws, and the gate turns it into a refusal.)
// ---------------------------------------------------------------------------

export interface DiskQuotaLimits {
  /** Hard limit per owner, in megabytes. Writes past it are refused. */
  limitMb: number;
  /** The "getting full" notice starts at this percentage of the limit. */
  warnPercent: number;
  /**
   * How long a stored file's charge is left alone before the blob pass may
   * release it, in milliseconds. A charge whose row was written (or re-put)
   * more recently than this is never even asked about, which protects a put
   * whose holder row has not landed yet (design D6).
   */
  graceMs: number;
}

export const DEFAULT_LIMITS: Readonly<DiskQuotaLimits> = Object.freeze({
  limitMb: 1024,
  warnPercent: 80,
  graceMs: 86_400_000, // 24 h
});

/** 1 MB is 1048576 bytes everywhere in this plugin. */
export const BYTES_PER_MB = 1_048_576;

export const LIMIT_BOUNDS = Object.freeze({
  limitMb: Object.freeze({ min: 64, max: 10_485_760 }),
  warnPercent: Object.freeze({ min: 1, max: 99 }),
  // 1 hour .. 30 days.
  graceMs: Object.freeze({ min: 3_600_000, max: 2_592_000_000 }),
});

export const LIMITS_STORAGE_KEY = 'settings:disk-quota';

const FIELD_SCHEMAS = {
  limitMb: z.number().int().min(LIMIT_BOUNDS.limitMb.min).max(LIMIT_BOUNDS.limitMb.max),
  warnPercent: z.number().int().min(LIMIT_BOUNDS.warnPercent.min).max(LIMIT_BOUNDS.warnPercent.max),
  graceMs: z.number().int().min(LIMIT_BOUNDS.graceMs.min).max(LIMIT_BOUNDS.graceMs.max),
} as const;

export const DiskQuotaLimitsSchema = z
  .object({
    limitMb: FIELD_SCHEMAS.limitMb,
    warnPercent: FIELD_SCHEMAS.warnPercent,
    graceMs: FIELD_SCHEMAS.graceMs,
  })
  .strict();

const FIELDS = Object.keys(FIELD_SCHEMAS) as Array<keyof DiskQuotaLimits>;

export class InvalidLimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLimitsError';
  }
}

export interface LimitBytes {
  limitBytes: number;
  warnBytes: number;
}

export function limitBytesOf(limits: Pick<DiskQuotaLimits, 'limitMb' | 'warnPercent'>): LimitBytes {
  const limitBytes = limits.limitMb * BYTES_PER_MB;
  return { limitBytes, warnBytes: Math.floor((limitBytes * limits.warnPercent) / 100) };
}

export type StorageStatus = 'ok' | 'near-limit' | 'full';

/** 'full' at the limit itself, 'near-limit' from the warn line up, else 'ok'. */
export function statusOf(usedBytes: number, bytes: LimitBytes): StorageStatus {
  if (usedBytes >= bytes.limitBytes) return 'full';
  if (usedBytes >= bytes.warnBytes) return 'near-limit';
  return 'ok';
}

export interface LimitsStore {
  get(): Promise<DiskQuotaLimits>;
  set(partial: Partial<DiskQuotaLimits>): Promise<DiskQuotaLimits>;
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
  let cached: { value: DiskQuotaLimits; at: number } | undefined;

  function parseStored(bytes: Uint8Array | undefined): DiskQuotaLimits {
    const out: DiskQuotaLimits = { ...DEFAULT_LIMITS };
    if (bytes === undefined) return out;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      ctx.logger.warn('disk_quota_setting_corrupt', { key: LIMITS_STORAGE_KEY });
      return out;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      ctx.logger.warn('disk_quota_setting_corrupt', { key: LIMITS_STORAGE_KEY });
      return out;
    }
    const rec = raw as Record<string, unknown>;
    for (const field of FIELDS) {
      if (!(field in rec)) continue;
      const parsed = FIELD_SCHEMAS[field].safeParse(rec[field]);
      if (parsed.success) {
        out[field] = parsed.data;
      } else {
        ctx.logger.warn('disk_quota_setting_invalid_field', { key: LIMITS_STORAGE_KEY, field });
      }
    }
    return out;
  }

  async function readFresh(): Promise<DiskQuotaLimits> {
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
      const parsed = DiskQuotaLimitsSchema.safeParse(merged);
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
