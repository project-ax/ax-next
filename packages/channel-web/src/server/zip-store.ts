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
//   - zip64. The route caps a bundle at 256 MiB and 500 entries, far below the
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

/** A zip archive of `entries`, every one STOREd (uncompressed). */
export function buildStoreZip(entries: ReadonlyArray<ZipEntry>): Buffer {
  if (entries.length > U16_MAX) throw new Error('too many zip entries');
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (!isFlatName(entry.name)) throw new Error('zip entry name is not a flat file name');
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    if (data.length > U32_MAX || offset > U32_MAX) throw new Error('zip too large');
    const crc = crc32(data);
    const { date, time } = dosDateTime(entry.modified);

    const local = Buffer.alloc(LOCAL_HEADER_LEN);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const cd = Buffer.alloc(CENTRAL_HEADER_LEN);
    cd.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    cd.writeUInt16LE(ZIP_VERSION, 4); // made by
    cd.writeUInt16LE(ZIP_VERSION, 6); // needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(METHOD_STORE, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42);

    parts.push(local, name, data);
    central.push(cd, name);
    offset += LOCAL_HEADER_LEN + name.length + data.length;
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0);
  if (offset > U32_MAX || cdSize > U32_MAX) throw new Error('zip too large');
  const eocd = Buffer.alloc(EOCD_LEN);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // central directory disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, ...central, eocd]);
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

/**
 * Flat, distinct entry names, in input order. The second `Report.pdf` becomes
 * `Report (2).pdf`, the third `Report (3).pdf`. Distinct ignoring case, since
 * the folder it is unzipped into often is.
 */
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((raw) => {
    const base = flatName(raw);
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = numbered(base, n);
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
