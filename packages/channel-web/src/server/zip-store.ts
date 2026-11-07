import { crc32 } from 'node:zlib';
import { sanitizeContentDispositionFilename } from '@ax/core';

// ---------------------------------------------------------------------------
// A tiny STORE-only zip writer for the artifacts "Download all" route.
//
// Why hand-rolled: the format we need is three fixed-layout records (local
// header, central directory entry, end-of-central-directory) with no
// compression, so a dependency would be more surface than the code it saves
// (supply chain, invariant 5). Node's `zlib.crc32` supplies the checksum.
//
// What it refuses rather than gets wrong:
//   - zip64. The route caps a bundle at 100 MiB and 500 entries, far below the
//     classic format's 4 GiB / 65,535 limits; anything past them throws.
//   - unsafe entry names. Every name a caller hands in must already be a flat
//     file name (`uniqueNames` makes them so). A `/`, `\`, `..` or control
//     character here would be a zip-slip — an archive that writes outside the
//     folder it is extracted into — so it throws instead of writing one.
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  modified: Date;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 2.0: the version a STORE entry needs, and the one we "made" it with. */
const ZIP_VERSION = 20;
const METHOD_STORE = 0;
const LOCAL_HEADER_LEN = 30;
const CENTRAL_HEADER_LEN = 46;
const EOCD_LEN = 22;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isFlatName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !CONTROL_CHARS.test(name)
  );
}

/** MS-DOS date and time, in UTC; clamped to 1980-01-01, the format's epoch. */
function dosDateTime(d: Date): { date: number; time: number } {
  const t = Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1980 ? new Date(Date.UTC(1980, 0, 1)) : d;
  const date = ((t.getUTCFullYear() - 1980) << 9) | ((t.getUTCMonth() + 1) << 5) | t.getUTCDate();
  const time = (t.getUTCHours() << 11) | (t.getUTCMinutes() << 5) | Math.floor(t.getUTCSeconds() / 2);
  return { date, time };
}

/** The bytes one entry adds besides its data: its local header, its central entry and its name twice. */
export function zipEntryOverhead(nameBytes: number): number {
  return LOCAL_HEADER_LEN + CENTRAL_HEADER_LEN + 2 * nameBytes;
}

/** The bytes the end-of-central-directory record adds. */
export const ZIP_END_OVERHEAD = EOCD_LEN;

interface CentralRecord {
  name: Buffer;
  crc: number;
  size: number;
  date: number;
  time: number;
  offset: number;
}

/**
 * Writes a STORE zip into ONE buffer, allocated up front from a size the
 * caller knows (entry sizes plus `zipEntryOverhead` each plus
 * `ZIP_END_OVERHEAD`). Each entry's bytes are copied in as they are added, so
 * the caller can let go of them straight away: peak memory is the archive plus
 * the entry being added, never every entry plus a second full copy. If an
 * entry turns out bigger than the room left, the buffer grows (one copy) — a
 * correctness fallback, not the expected path.
 */
export class StoreZipWriter {
  private buf: Buffer;
  private used = 0;
  private readonly central: CentralRecord[] = [];

  constructor(capacity: number) {
    this.buf = Buffer.alloc(Math.max(capacity, EOCD_LEN));
  }

  /** Bytes written so far, local records only (the central directory comes at `finish`). */
  get size(): number {
    return this.used;
  }

  private ensure(more: number): void {
    const need = this.used + more;
    if (need <= this.buf.length) return;
    const grown = Buffer.alloc(need);
    this.buf.copy(grown, 0, 0, this.used);
    this.buf = grown;
  }

  add(entry: ZipEntry): void {
    if (this.central.length >= U16_MAX) throw new Error('too many zip entries');
    if (!isFlatName(entry.name)) throw new Error('zip entry name is not a flat file name');
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.bytes;
    if (data.byteLength > U32_MAX || this.used > U32_MAX) throw new Error('zip too large');
    const crc = crc32(data);
    const { date, time } = dosDateTime(entry.modified);
    // Room for this record and its central entry, so `finish` never has to grow.
    this.ensure(LOCAL_HEADER_LEN + name.length + data.byteLength + CENTRAL_HEADER_LEN + name.length + EOCD_LEN);

    const b = this.buf;
    const at = this.used;
    b.writeUInt32LE(LOCAL_HEADER_SIG, at);
    b.writeUInt16LE(ZIP_VERSION, at + 4);
    b.writeUInt16LE(0, at + 6); // flags
    b.writeUInt16LE(METHOD_STORE, at + 8);
    b.writeUInt16LE(time, at + 10);
    b.writeUInt16LE(date, at + 12);
    b.writeUInt32LE(crc, at + 14);
    b.writeUInt32LE(data.byteLength, at + 18); // compressed size
    b.writeUInt32LE(data.byteLength, at + 22); // uncompressed size
    b.writeUInt16LE(name.length, at + 26);
    b.writeUInt16LE(0, at + 28); // extra length
    name.copy(b, at + LOCAL_HEADER_LEN);
    b.set(data, at + LOCAL_HEADER_LEN + name.length);

    this.central.push({ name, crc, size: data.byteLength, date, time, offset: at });
    this.used = at + LOCAL_HEADER_LEN + name.length + data.byteLength;
  }

  /** The archive: a view of the one buffer, not a copy. The writer is spent after this. */
  finish(): Buffer {
    const cdStart = this.used;
    const cdSize = this.central.reduce((n, c) => n + CENTRAL_HEADER_LEN + c.name.length, 0);
    this.ensure(cdSize + EOCD_LEN);
    if (cdStart > U32_MAX || cdSize > U32_MAX) throw new Error('zip too large');
    const b = this.buf;
    let at = cdStart;
    for (const c of this.central) {
      b.writeUInt32LE(CENTRAL_HEADER_SIG, at);
      b.writeUInt16LE(ZIP_VERSION, at + 4); // made by
      b.writeUInt16LE(ZIP_VERSION, at + 6); // needed
      b.writeUInt16LE(0, at + 8); // flags
      b.writeUInt16LE(METHOD_STORE, at + 10);
      b.writeUInt16LE(c.time, at + 12);
      b.writeUInt16LE(c.date, at + 14);
      b.writeUInt32LE(c.crc, at + 16);
      b.writeUInt32LE(c.size, at + 20);
      b.writeUInt32LE(c.size, at + 24);
      b.writeUInt16LE(c.name.length, at + 28);
      b.writeUInt16LE(0, at + 30); // extra length
      b.writeUInt16LE(0, at + 32); // comment length
      b.writeUInt16LE(0, at + 34); // disk number start
      b.writeUInt16LE(0, at + 36); // internal attributes
      b.writeUInt32LE(0, at + 38); // external attributes
      b.writeUInt32LE(c.offset, at + 42);
      c.name.copy(b, at + CENTRAL_HEADER_LEN);
      at += CENTRAL_HEADER_LEN + c.name.length;
    }
    b.writeUInt32LE(EOCD_SIG, at);
    b.writeUInt16LE(0, at + 4); // this disk
    b.writeUInt16LE(0, at + 6); // central directory disk
    b.writeUInt16LE(this.central.length, at + 8);
    b.writeUInt16LE(this.central.length, at + 10);
    b.writeUInt32LE(cdSize, at + 12);
    b.writeUInt32LE(cdStart, at + 16);
    b.writeUInt16LE(0, at + 20); // comment length
    return b.subarray(0, at + EOCD_LEN);
  }
}

/** A zip archive of `entries`, every one STOREd (uncompressed). */
export function buildStoreZip(entries: ReadonlyArray<ZipEntry>): Buffer {
  if (entries.length > U16_MAX) throw new Error('too many zip entries');
  const capacity = entries.reduce(
    (n, e) => n + e.bytes.byteLength + zipEntryOverhead(Buffer.byteLength(e.name, 'utf8')),
    ZIP_END_OVERHEAD,
  );
  const writer = new StoreZipWriter(capacity);
  for (const e of entries) writer.add(e);
  return writer.finish();
}

/**
 * One flat, header-safe file name: the shared Content-Disposition sanitizer
 * (only `[A-Za-z0-9._ -]` survive, so no `/`, `\` or control character), and
 * then any run of dots squeezed to one so no `..` survives either.
 */
function flatName(name: string): string {
  return sanitizeContentDispositionFilename(sanitizeContentDispositionFilename(name).replace(/\.{2,}/g, '.'));
}

/** `Report.pdf` → `Report (n).pdf`; a name with no extension gets the suffix at the end. */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** A name longer than this is cut by the sanitizer; the `(n)` suffix adds a few characters more. */
export const ZIP_ENTRY_NAME_MAX_BYTES = 255 + 16;

/**
 * Flat, distinct entry names, one at a time, in the order asked: the same
 * names `uniqueNames` gives for the same sequence.
 */
export function createNameDeduper(): (name: string) => string {
  const taken = new Set<string>();
  return (raw) => {
    const base = flatName(raw);
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = numbered(base, n);
    taken.add(candidate.toLowerCase());
    return candidate;
  };
}

/**
 * Flat, distinct entry names, in input order. The second `Report.pdf` becomes
 * `Report (2).pdf`, the third `Report (3).pdf`. Distinct ignoring case, since
 * the folder it is unzipped into often is.
 */
export function uniqueNames(names: readonly string[]): string[] {
  return names.map(createNameDeduper());
}
