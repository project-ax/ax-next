import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RECORD,
  parseRecord,
  parseRecordStrict,
  serializeRecord,
  toWire,
  type BrandingRecord,
} from '../record.js';

describe('parseRecord', () => {
  it('returns the default record for undefined bytes', () => {
    expect(parseRecord(undefined)).toEqual(DEFAULT_RECORD);
  });

  it('returns the default record for empty bytes', () => {
    expect(parseRecord(new Uint8Array(0))).toEqual(DEFAULT_RECORD);
  });

  it('returns the default record for non-JSON bytes', () => {
    expect(parseRecord(new TextEncoder().encode('not json {'))).toEqual(
      DEFAULT_RECORD,
    );
  });

  it('returns the default record when the shape is wrong', () => {
    expect(
      parseRecord(new TextEncoder().encode(JSON.stringify({ name: 42 }))),
    ).toEqual(DEFAULT_RECORD);
  });

  it('round-trips a populated record', () => {
    const record: BrandingRecord = {
      name: 'Canopy AI',
      logoType: 'icon',
      light: { sha256: 'a'.repeat(64), contentType: 'image/png' },
      dark: { sha256: 'b'.repeat(64), contentType: 'image/svg+xml' },
      version: '2026-06-25T00:00:00.000Z',
    };
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });
});

// TASK-776: the strict read behind the blob:collect-refs holder. Where
// parseRecord forgives garbage (a corrupt row must not 500 the public GET), this
// tells "nothing stored" apart from "something stored that we cannot read", so
// the holder can fail CLOSED instead of reporting "no logos".
describe('parseRecordStrict', () => {
  it('returns undefined for an absent or empty value (nothing was ever stored)', () => {
    expect(parseRecordStrict(undefined)).toBeUndefined();
    expect(parseRecordStrict(new Uint8Array(0))).toBeUndefined();
  });

  it('throws for stored bytes that are not UTF-8, not JSON, or the wrong shape', () => {
    expect(() => parseRecordStrict(new Uint8Array([0xff, 0xfe]))).toThrow();
    expect(() => parseRecordStrict(new TextEncoder().encode('not json {'))).toThrow();
    expect(() =>
      parseRecordStrict(new TextEncoder().encode(JSON.stringify({ name: 42 }))),
    ).toThrow();
  });

  it('round-trips a populated record', () => {
    const record: BrandingRecord = {
      name: 'Canopy AI',
      logoType: 'icon',
      light: { sha256: 'a'.repeat(64), contentType: 'image/png' },
      dark: null,
      version: '2026-06-25T00:00:00.000Z',
    };
    expect(parseRecordStrict(serializeRecord(record))).toEqual(record);
  });

  it('leaves the tolerant parseRecord forgiving about the same garbage', () => {
    expect(parseRecord(new Uint8Array([0xff, 0xfe]))).toEqual(DEFAULT_RECORD);
    expect(parseRecord(new TextEncoder().encode('null'))).toEqual(DEFAULT_RECORD);
  });
});

describe('toWire', () => {
  it('maps logo pointers to booleans and carries name/type/version', () => {
    const record: BrandingRecord = {
      name: 'Canopy AI',
      logoType: 'full',
      light: { sha256: 'a'.repeat(64), contentType: 'image/png' },
      dark: null,
      version: '2026-06-25T00:00:00.000Z',
    };
    expect(toWire(record)).toEqual({
      name: 'Canopy AI',
      logoType: 'full',
      light: true,
      dark: false,
      version: '2026-06-25T00:00:00.000Z',
    });
  });

  it('reports both logos absent for the default record', () => {
    expect(toWire(DEFAULT_RECORD)).toEqual({
      name: '',
      logoType: 'full',
      light: false,
      dark: false,
      version: '',
    });
  });
});
