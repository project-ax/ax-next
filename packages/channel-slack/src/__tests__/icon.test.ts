import { describe, expect, it } from 'vitest';
import { parseIconPng, type IconRefusal } from '../icon.js';
import { SLACK_ICON_MAX_BYTES } from '../limits.js';
import { pngBase64, pngHeader } from './fake-png.js';

/** The PNG parseIconPng accepted; fails the test when it refused. */
function accepted(value: unknown, label: string): Buffer {
  const parsed = parseIconPng(value);
  if (!parsed.ok) throw new Error(`${label}: refused with ${parsed.code}`);
  expect(Buffer.isBuffer(parsed.png), label).toBe(true);
  return parsed.png;
}

/** Each case is refused with exactly `code`, and nothing else in the answer. */
function refusedAll(cases: Array<[string, unknown]>, code: IconRefusal): void {
  for (const [label, value] of cases) {
    expect(parseIconPng(value), label).toStrictEqual({ ok: false, code });
  }
}

/** The 512 px header padded to 64 bytes: valid on every rule, the start of each test 4 fixture. */
const BASE_64_BYTES = pngHeader(512, 512, 64);

describe('parseIconPng', () => {
  it('a square PNG 512 to 2000 px a side, up to SLACK_ICON_MAX_BYTES, is accepted with its exact bytes', () => {
    const cases: Array<[number, number | undefined]> = [
      [512, undefined],
      [2000, undefined],
      [512, SLACK_ICON_MAX_BYTES],
    ];
    for (const [px, totalBytes] of cases) {
      const label = `${px} px, ${totalBytes ?? 'header only'}`;
      const png = accepted(pngBase64(px, px, totalBytes), label);
      expect(png.equals(pngHeader(px, px, totalBytes)), label).toBe(true);
    }
    // Exactly the cap (1 MiB) gets through.
    expect(accepted(pngBase64(512, 512, SLACK_ICON_MAX_BYTES), 'the cap')).toHaveLength(1_048_576);
  });

  it('anything but standard padded base64 is icon-not-base64', () => {
    // The default header is 45 bytes: 60 characters of base64 and no padding,
    // and it is accepted as it is. Each variant below breaks ONE rule of it.
    const good = pngBase64(512, 512);
    expect(good).toHaveLength(60);
    expect(good).not.toContain('=');
    accepted(good, 'the unbroken header');

    refusedAll(
      [
        ['a number', 42],
        ['null', null],
        ['an object', {}],
        ['empty', ''],
        // Node would decode each of these to the header, or near it.
        ['its last character dropped (59 characters)', good.slice(0, -1)],
        ['its first character URL-safe', `-${good.slice(1)}`],
        ['a newline in the middle', `${good.slice(0, 30)}\n${good.slice(31)}`],
      ],
      'icon-not-base64',
    );
  });

  it('more than SLACK_ICON_MAX_BYTES decoded is icon-too-large', () => {
    // Valid base64, and a valid 512 px header: only the size is wrong.
    refusedAll([['one byte over the cap', pngBase64(512, 512, SLACK_ICON_MAX_BYTES + 1)]], 'icon-too-large');
  });

  it('bytes that are not a PNG are icon-not-png', () => {
    accepted(BASE_64_BYTES.toString('base64'), 'the unbroken 64-byte header');
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    // Each one valid on every other rule, so it can only be refused for its own.
    const jpegSignature = Buffer.from(BASE_64_BYTES);
    jpegMagic.copy(jpegSignature, 0);
    const ihdx = Buffer.from(BASE_64_BYTES);
    ihdx.write('IHDX', 12, 'latin1');
    const length12 = Buffer.from(BASE_64_BYTES);
    length12.writeUInt32BE(12, 8);
    // Signature, IHDR length and type and the width are all there; the height is cut.
    const cut = pngHeader(512, 512).subarray(0, 23);

    const fixtures: Array<[string, Buffer]> = [
      ['JPEG magic, then zeros', Buffer.concat([jpegMagic, Buffer.alloc(60)])],
      ['the 512 header with JPEG magic for a signature', jpegSignature],
      ['the 512 header with chunk type IHDX', ihdx],
      ['the 512 header with chunk length 12', length12],
      ['the first 23 bytes of the 512 header', cut],
    ];
    for (const [label, bytes] of fixtures) {
      expect(bytes, label).toHaveLength(label.startsWith('the first 23') ? 23 : 64);
    }
    refusedAll(
      fixtures.map(([label, bytes]) => [label, bytes.toString('base64')]),
      'icon-not-png',
    );
  });

  it('a PNG outside 512 to 2000 px, or not square, is icon-bad-size', () => {
    refusedAll(
      [
        ['511 x 511', pngBase64(511, 511)],
        ['2001 x 2001', pngBase64(2001, 2001)],
        ['512 x 513', pngBase64(512, 513)],
        ['0 x 0', pngBase64(0, 0)],
      ],
      'icon-bad-size',
    );
  });
});
