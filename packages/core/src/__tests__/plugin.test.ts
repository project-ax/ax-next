import { describe, it, expect } from 'vitest';
import { PluginManifestSchema } from '../plugin.js';

describe('PluginManifestSchema — optionalCalls', () => {
  const base = { name: '@ax/x', version: '0.0.0' };

  it('omits optionalCalls when not provided (optional, treated as empty by bootstrap)', () => {
    const parsed = PluginManifestSchema.parse(base);
    expect(parsed.optionalCalls).toBeUndefined();
  });

  it('accepts optionalCalls entries with a hook + degradation note', () => {
    const parsed = PluginManifestSchema.parse({
      ...base,
      optionalCalls: [
        { hook: 'storage:get', degradation: 'first-boot wipe skipped; no impact on new installs' },
      ],
    });
    expect(parsed.optionalCalls).toEqual([
      { hook: 'storage:get', degradation: 'first-boot wipe skipped; no impact on new installs' },
    ]);
  });

  it('rejects an optionalCall with an empty hook', () => {
    const r = PluginManifestSchema.safeParse({
      ...base,
      optionalCalls: [{ hook: '', degradation: 'x' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an optionalCall with an empty degradation note', () => {
    // The degradation note is the point — a blank note is a manifest bug.
    const r = PluginManifestSchema.safeParse({
      ...base,
      optionalCalls: [{ hook: 'storage:get', degradation: '' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a hook listed in BOTH calls and optionalCalls (contradiction)', () => {
    const r = PluginManifestSchema.safeParse({
      ...base,
      calls: ['storage:get'],
      optionalCalls: [{ hook: 'storage:get', degradation: 'falls back to memory' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // The error names the offending hook so the author can find it.
      expect(JSON.stringify(r.error.issues)).toContain('storage:get');
    }
  });

  it('allows a hook in calls and a DIFFERENT hook in optionalCalls', () => {
    const parsed = PluginManifestSchema.parse({
      ...base,
      calls: ['credentials:store-blob:get'],
      optionalCalls: [{ hook: 'storage:get', degradation: 'wipe skipped' }],
    });
    expect(parsed.calls).toContain('credentials:store-blob:get');
    expect(parsed.optionalCalls).toHaveLength(1);
  });
});
