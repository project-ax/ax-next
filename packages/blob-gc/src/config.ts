import { z } from 'zod';
import type { AgentContext, HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// `settings:blob-gc` — the admin-changeable GC settings (design D8), one JSON
// value through `storage:get` / `storage:set` (the `settings:disk-quota`
// pattern). No env var: an operator changes it from the admin API, and every
// replica reads the same value.
//
//   mode         'report' (the DEFAULT) or 'enforce'.
//                report:  the sweep runs the whole pipeline and REPORTS what
//                         it would free. It retires nothing and purges
//                         nothing, even rows already retired.
//                enforce: unheld candidates are RETIRED (moved aside, still
//                         recoverable: any read restores them), and retired
//                         blobs past `retentionMs` that a second ask finds
//                         unheld are PURGED (gone for good). Switching back
//                         to report stops both at the next sweep.
//                Only an admin can switch it (PUT /admin/storage/cleanup). A
//                missing or corrupt stored value reads as 'report'.
//   graceMs      a blob put more recently than this is never a candidate.
//   retentionMs  how long a retired blob is kept before purge.
//
// Reading NEVER throws on a bad VALUE: a missing, corrupt or out-of-bounds
// field falls back to its default (with a warn). A failure to read at all
// throws; the sweep logs it and tries again next time.
// ---------------------------------------------------------------------------

export const BLOB_GC_MODES = ['report', 'enforce'] as const;
export type BlobGcMode = (typeof BLOB_GC_MODES)[number];

export interface BlobGcSettings {
  mode: BlobGcMode;
  graceMs: number;
  retentionMs: number;
}

export const DEFAULT_SETTINGS: Readonly<BlobGcSettings> = Object.freeze({
  mode: 'report',
  graceMs: 86_400_000, // 24 h
  retentionMs: 604_800_000, // 7 days
});

export const SETTINGS_BOUNDS = Object.freeze({
  // 1 hour .. 30 days.
  graceMs: Object.freeze({ min: 3_600_000, max: 2_592_000_000 }),
  // 1 day .. 90 days.
  retentionMs: Object.freeze({ min: 86_400_000, max: 7_776_000_000 }),
});

export const SETTINGS_STORAGE_KEY = 'settings:blob-gc';

const FIELD_SCHEMAS = {
  mode: z.enum(BLOB_GC_MODES),
  graceMs: z.number().int().min(SETTINGS_BOUNDS.graceMs.min).max(SETTINGS_BOUNDS.graceMs.max),
  retentionMs: z
    .number()
    .int()
    .min(SETTINGS_BOUNDS.retentionMs.min)
    .max(SETTINGS_BOUNDS.retentionMs.max),
} as const;

export const BlobGcSettingsSchema = z
  .object({
    mode: FIELD_SCHEMAS.mode,
    graceMs: FIELD_SCHEMAS.graceMs,
    retentionMs: FIELD_SCHEMAS.retentionMs,
  })
  .strict();

const FIELDS = Object.keys(FIELD_SCHEMAS) as Array<keyof BlobGcSettings>;

export class InvalidSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSettingsError';
  }
}

export interface SettingsStore {
  get(): Promise<BlobGcSettings>;
  set(partial: Partial<BlobGcSettings>): Promise<BlobGcSettings>;
}

export function createSettingsStore(opts: { bus: HookBus; ctx: AgentContext }): SettingsStore {
  const { bus, ctx } = opts;

  function parseStored(bytes: Uint8Array | undefined): BlobGcSettings {
    const out: BlobGcSettings = { ...DEFAULT_SETTINGS };
    if (bytes === undefined) return out;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      ctx.logger.warn('blob_gc_setting_corrupt', { key: SETTINGS_STORAGE_KEY });
      return out;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      ctx.logger.warn('blob_gc_setting_corrupt', { key: SETTINGS_STORAGE_KEY });
      return out;
    }
    const rec = raw as Record<string, unknown>;
    for (const field of FIELDS) {
      if (!(field in rec)) continue;
      const parsed = FIELD_SCHEMAS[field].safeParse(rec[field]);
      if (parsed.success) {
        (out as unknown as Record<string, unknown>)[field] = parsed.data;
      } else {
        ctx.logger.warn('blob_gc_setting_invalid_field', { key: SETTINGS_STORAGE_KEY, field });
      }
    }
    return out;
  }

  async function read(): Promise<BlobGcSettings> {
    const res = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: SETTINGS_STORAGE_KEY },
    );
    return parseStored(res.value);
  }

  return {
    // Read fresh every time: the sweep reads it once an hour and the admin
    // route on demand, so a cache would buy nothing.
    get: read,

    async set(partial) {
      // Merge over what is stored NOW, so two admins changing different
      // fields don't undo each other.
      const merged: Record<string, unknown> = { ...(await read()) };
      for (const field of FIELDS) {
        if (partial[field] !== undefined) merged[field] = partial[field];
      }
      const parsed = BlobGcSettingsSchema.safeParse(merged);
      if (!parsed.success) {
        throw new InvalidSettingsError(parsed.error.issues[0]?.message ?? 'invalid settings');
      }
      await bus.call('storage:set', ctx, {
        key: SETTINGS_STORAGE_KEY,
        value: new TextEncoder().encode(JSON.stringify(parsed.data)),
      });
      return { ...parsed.data };
    },
  };
}
