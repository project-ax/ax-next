import { crc32 } from 'node:zlib';

/** Every PNG starts with these eight bytes. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk: its data's length, its type, the data, and a CRC over type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * The start of a PNG, as a test fixture: the signature, an IHDR chunk saying
 * `width` x `height` (8-bit RGBA, no interlace), an empty IEND chunk, then
 * zero bytes up to `totalBytes`. 45 bytes when `totalBytes` is left out.
 * Not an image anyone could draw: parseIconPng reads no further than the
 * IHDR, and Slack, which does read further, is faked wherever these are used.
 */
export function pngHeader(width: number, height: number, totalBytes?: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // Compression, filter and interlace methods: 0 each (already zero).
  const head = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
  if (totalBytes === undefined) return head;
  if (totalBytes < head.length) throw new RangeError(`pngHeader: totalBytes must be at least ${head.length}`);
  return Buffer.concat([head, Buffer.alloc(totalBytes - head.length)]);
}

/** `pngHeader(...)` as standard, padded base64: what Connect's `iconPng` carries. */
export function pngBase64(width: number, height: number, totalBytes?: number): string {
  return pngHeader(width, height, totalBytes).toString('base64');
}
