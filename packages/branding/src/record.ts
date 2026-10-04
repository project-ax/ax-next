/**
 * The branding config record. Stored as one JSON blob at storage key
 * `settings:branding` (via storage:get/set). Holds only the logo *pointers*
 * (sha256 + content-type) — the logo bytes live in the blob store. `version`
 * changes on every write so the SPA's `?v=` cache-buster fetches fresh bytes.
 */
import { z } from 'zod';
import {
  ALLOWED_CONTENT_TYPES,
  type AllowedContentType,
} from './image-validation.js';

export interface LogoPointer {
  sha256: string;
  contentType: AllowedContentType;
}

export interface BrandingRecord {
  /** "" → the SPA falls back to the default "ax". */
  name: string;
  /** full = logo includes the wordmark; icon = show the name beside it. */
  logoType: 'full' | 'icon';
  light: LogoPointer | null;
  dark: LogoPointer | null;
  /** ISO updatedAt; cache-buster for logo URLs. "" when never written. */
  version: string;
}

/** Public GET shape — booleans instead of pointers (bytes are served separately). */
export interface WireBranding {
  name: string;
  logoType: 'full' | 'icon';
  light: boolean;
  dark: boolean;
  version: string;
}

export const DEFAULT_RECORD: BrandingRecord = {
  name: '',
  logoType: 'full',
  light: null,
  dark: null,
  version: '',
};

const pointerSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.enum(
    ALLOWED_CONTENT_TYPES as unknown as [
      AllowedContentType,
      ...AllowedContentType[],
    ],
  ),
});

const recordSchema = z.object({
  name: z.string(),
  logoType: z.enum(['full', 'icon']),
  light: pointerSchema.nullable(),
  dark: pointerSchema.nullable(),
  version: z.string(),
});

/**
 * Strict read: `undefined` when nothing is stored (absent or empty bytes), the
 * record when the bytes are a valid one, and a THROW for anything stored that
 * cannot be read as one (not UTF-8, not JSON, wrong shape, a bad logo pointer).
 *
 * This is the read for callers that must tell "nothing here" apart from "there
 * is something here that I cannot read". The `blob:collect-refs` holder is one:
 * answering "no logos" for a record it could not parse would tell a sweep that
 * nothing holds the logo bytes, and the sweep would delete them.
 */
export function parseRecordStrict(
  bytes: Uint8Array | undefined,
): BrandingRecord | undefined {
  if (bytes === undefined || bytes.length === 0) return undefined;
  // `fatal` makes a bad byte a throw instead of a U+FFFD that would then fail
  // the JSON parse with a less useful message.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return recordSchema.parse(JSON.parse(text));
}

/**
 * Tolerant read: undefined / empty / non-JSON / wrong-shape bytes all yield a
 * fresh copy of the default record so the public GET never 500s on a corrupt
 * row. A fresh copy (not the shared default) keeps callers from mutating it.
 * (Not for the blob holder: see `parseRecordStrict`.)
 */
export function parseRecord(bytes: Uint8Array | undefined): BrandingRecord {
  try {
    return parseRecordStrict(bytes) ?? { ...DEFAULT_RECORD };
  } catch {
    return { ...DEFAULT_RECORD };
  }
}

export function serializeRecord(record: BrandingRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

export function toWire(record: BrandingRecord): WireBranding {
  return {
    name: record.name,
    logoType: record.logoType,
    light: record.light !== null,
    dark: record.dark !== null,
    version: record.version,
  };
}
