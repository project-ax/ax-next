import { describe, it, expect } from 'vitest';
import {
  ModelsListSupportedOutputSchema,
  type ModelsListSupportedOutput,
} from '../plugin.js';

// ARCH-13 drift guard for the `models:list-supported` returns schema. A
// fully-populated value (one entry per `kind`) must round-trip without losing
// a field.

describe('ModelsListSupportedOutputSchema', () => {
  it('round-trips a fully-populated ModelsListSupportedOutput', () => {
    const full: ModelsListSupportedOutput = {
      models: [
        { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', kind: 'fast' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', kind: 'either' },
        { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', kind: 'default' },
      ],
    };
    expect(ModelsListSupportedOutputSchema.parse(full)).toEqual(full);
  });

  it('accepts an empty models array', () => {
    expect(ModelsListSupportedOutputSchema.parse({ models: [] })).toEqual({ models: [] });
  });

  it('rejects an invalid kind', () => {
    expect(
      ModelsListSupportedOutputSchema.safeParse({
        models: [{ id: 'm', label: 'M', kind: 'slow' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing label', () => {
    expect(
      ModelsListSupportedOutputSchema.safeParse({ models: [{ id: 'm', kind: 'fast' }] }).success,
    ).toBe(false);
  });
});
