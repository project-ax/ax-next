// @vitest-environment node
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildStoreZip, StoreZipWriter, uniqueNames } from '../../server/zip-store.js';

interface Parsed {
  locals: Array<{ name: string; crc: number; size: number; method: number; data: Buffer }>;
  central: Array<{ name: string; crc: number; size: number; offset: number; method: number }>;
  eocdCount: number;
  eocdTotal: number;
}

/** Reads a zip the plain way: EOCD at the end, then the central directory, then each local header it points at. */
function parseZip(zip: Buffer): Parsed {
  const eocdAt = zip.length - 22;
  expect(zip.readUInt32LE(eocdAt)).toBe(0x06054b50);
  const eocdCount = zip.readUInt16LE(eocdAt + 8);
  const eocdTotal = zip.readUInt16LE(eocdAt + 10);
  const cdSize = zip.readUInt32LE(eocdAt + 12);
  const cdOffset = zip.readUInt32LE(eocdAt + 16);
  expect(cdOffset + cdSize).toBe(eocdAt);

  const central: Parsed['central'] = [];
  const locals: Parsed['locals'] = [];
  let p = cdOffset;
  for (let i = 0; i < eocdTotal; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const entry = {
      method: zip.readUInt16LE(p + 10),
      crc: zip.readUInt32LE(p + 16),
      size: zip.readUInt32LE(p + 24),
      offset: zip.readUInt32LE(p + 42),
      name: zip.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
    };
    central.push(entry);
    p += 46 + nameLen + extraLen + commentLen;

    const l = entry.offset;
    expect(zip.readUInt32LE(l)).toBe(0x04034b50);
    const lNameLen = zip.readUInt16LE(l + 26);
    const lExtraLen = zip.readUInt16LE(l + 28);
    const size = zip.readUInt32LE(l + 22);
    const dataAt = l + 30 + lNameLen + lExtraLen;
    locals.push({
      method: zip.readUInt16LE(l + 8),
      crc: zip.readUInt32LE(l + 14),
      size,
      name: zip.subarray(l + 30, l + 30 + lNameLen).toString('utf8'),
      data: zip.subarray(dataAt, dataAt + size),
    });
  }
  return { locals, central, eocdCount, eocdTotal };
}

describe('buildStoreZip', () => {
  it('a two-file zip has matching local headers, a central directory with zlib.crc32 CRCs and an EOCD count of 2', () => {
    const a = new TextEncoder().encode('# Hello\n');
    const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const zip = buildStoreZip([
      { name: 'Notes.md', bytes: a, modified: new Date('2026-11-05T10:20:30Z') },
      { name: 'Chart.png', bytes: b, modified: new Date('2026-11-05T10:20:30Z') },
    ]);
    const parsed = parseZip(zip);
    expect(parsed.eocdCount).toBe(2);
    expect(parsed.eocdTotal).toBe(2);
    expect(parsed.central).toEqual([
      { name: 'Notes.md', crc: crc32(a), size: a.length, offset: 0, method: 0 },
      { name: 'Chart.png', crc: crc32(b), size: b.length, offset: 30 + 'Notes.md'.length + a.length, method: 0 },
    ]);
    expect(parsed.locals).toEqual([
      { name: 'Notes.md', crc: crc32(a), size: a.length, method: 0, data: Buffer.from(a) },
      { name: 'Chart.png', crc: crc32(b), size: b.length, method: 0, data: Buffer.from(b) },
    ]);
  });

  it('is byte-identical to the archive the first (concat-based) writer produced for the two-file fixture', () => {
    const a = new TextEncoder().encode('# Hello\n');
    const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const entries = [
      { name: 'Notes.md', bytes: a, modified: new Date('2026-11-05T10:20:30Z') },
      { name: 'Chart.png', bytes: b, modified: new Date('2026-11-05T10:20:30Z') },
    ];
    // Recorded from bf266f923's buildStoreZip before the one-buffer rewrite.
    const BASELINE = '1064a926acadb55120166dfa2d1f76db5f294b7c2a192e478cd2d44838149494';
    const zip = buildStoreZip(entries);
    expect({ length: zip.length, sha256: createHash('sha256').update(zip).digest('hex') }).toEqual({
      length: 224,
      sha256: BASELINE,
    });

    // The writer the route uses gives the same bytes, whether its first
    // allocation is roomy or too small and has to grow.
    for (const capacity of [10_000, 1]) {
      const w = new StoreZipWriter(capacity);
      for (const e of entries) w.add(e);
      expect(createHash('sha256').update(w.finish()).digest('hex')).toBe(BASELINE);
    }
  });

  it('writes the modified time as a DOS date and time', () => {
    const zip = buildStoreZip([{ name: 'a.txt', bytes: new Uint8Array([1]), modified: new Date('2026-11-05T10:20:30Z') }]);
    expect(zip.readUInt16LE(10)).toBe((10 << 11) | (20 << 5) | 15);
    expect(zip.readUInt16LE(12)).toBe(((2026 - 1980) << 9) | (11 << 5) | 5);
  });

  it('an empty bundle is a valid zip with an EOCD count of 0', () => {
    const zip = buildStoreZip([]);
    expect(zip.length).toBe(22);
    expect(parseZip(zip).eocdTotal).toBe(0);
  });

  it('refuses an entry name that could escape the folder it is unzipped into', () => {
    for (const name of ['../evil.txt', 'a/b.txt', 'a\\b.txt', 'a\u0000b', '']) {
      expect(() => buildStoreZip([{ name, bytes: new Uint8Array(), modified: new Date() }])).toThrow();
    }
  });
});

describe('uniqueNames', () => {
  it('flattens names with / \\ .. and control characters', () => {
    const out = uniqueNames(['../../etc/passwd', 'a\\b\\c.txt', 'x\r\ny\u0007.md', '..', 'a..b.pdf']);
    for (const n of out) {
      expect(n).not.toMatch(/[/\\]/);
      expect(n).not.toContain('..');
      expect(n).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(n.length).toBeGreaterThan(0);
    }
    expect(out).toEqual(['._._etc_passwd', 'a_b_c.txt', 'x__y_.md', 'download', 'a.b.pdf']);
    // What it hands back, buildStoreZip accepts.
    expect(() => buildStoreZip(out.map((name) => ({ name, bytes: new Uint8Array(), modified: new Date() })))).not.toThrow();
  });

  it('the second "Report.pdf" becomes "Report (2).pdf", and so on', () => {
    expect(uniqueNames(['Report.pdf', 'Report.pdf', 'report.PDF', 'Notes', 'Notes'])).toEqual([
      'Report.pdf',
      'Report (2).pdf',
      'report (3).PDF',
      'Notes',
      'Notes (2)',
    ]);
  });
});
