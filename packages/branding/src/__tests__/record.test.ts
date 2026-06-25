import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RECORD,
  parseRecord,
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
