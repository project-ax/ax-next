import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseCookieKey,
  signCookieValue,
  verifyCookieValue,
} from '../cookies.js';

const KEY = randomBytes(32);

describe('cookies — sign/verify', () => {
  it('roundtrips a plaintext value', () => {
    const wire = signCookieValue(KEY, 'session-abc-123');
    expect(verifyCookieValue(KEY, wire)).toBe('session-abc-123');
  });

  it('returns null when the value segment was tampered', () => {
    const wire = signCookieValue(KEY, 'hello');
    // Flip the first char of the payload; keep the HMAC.
    const dot = wire.indexOf('.');
    const tampered = (wire[0] === 'A' ? 'B' : 'A') + wire.slice(1, dot) + wire.slice(dot);
    expect(verifyCookieValue(KEY, tampered)).toBeNull();
  });

  it('returns null when the HMAC segment was tampered', () => {
    const wire = signCookieValue(KEY, 'hello');
    const flipped = wire.slice(0, -1) + (wire.endsWith('A') ? 'B' : 'A');
    expect(verifyCookieValue(KEY, flipped)).toBeNull();
  });

  it('returns null on missing HMAC segment (no dot)', () => {
    expect(verifyCookieValue(KEY, 'aGVsbG8')).toBeNull();
  });

  it('returns null on empty string', () => {
    expect(verifyCookieValue(KEY, '')).toBeNull();
  });

  it('returns null when verified with the wrong key', () => {
    const wire = signCookieValue(KEY, 'hello');
    const otherKey = randomBytes(32);
    expect(verifyCookieValue(otherKey, wire)).toBeNull();
  });

  it('roundtrips an empty-string value', () => {
    const wire = signCookieValue(KEY, '');
    expect(verifyCookieValue(KEY, wire)).toBe('');
  });

  it('roundtrips multibyte UTF-8', () => {
    const wire = signCookieValue(KEY, 'héllo · 🌶');
    expect(verifyCookieValue(KEY, wire)).toBe('héllo · 🌶');
  });

  it('rejects a value larger than the 4 KiB cap', () => {
    const big = 'x'.repeat(4 * 1024 + 1);
    expect(() => signCookieValue(KEY, big)).toThrow(/4096-byte cap/);
  });

  it('rejects a key shorter than 32 bytes', () => {
    expect(() => signCookieValue(Buffer.alloc(16), 'x')).toThrow(/32 bytes/);
    expect(() => verifyCookieValue(Buffer.alloc(16), 'a.b')).toThrow(/32 bytes/);
  });

  it('rejects HMAC segment with non-base64url characters', () => {
    const wire = signCookieValue(KEY, 'x');
    const dot = wire.indexOf('.');
    // Replace one char of the HMAC with `+` (b64 std, not b64url).
    const bad = `${wire.slice(0, dot + 1)}+${wire.slice(dot + 2)}`;
    expect(verifyCookieValue(KEY, bad)).toBeNull();
  });

  it('returns null when HMAC segment is shorter than 43 chars (length short-circuit)', () => {
    // Targets the `sigPart.length !== HMAC_B64URL_LEN` short-circuit:
    // valid base64url chars but the wrong length must reject BEFORE
    // timingSafeEqual (which would throw on mismatched lengths).
    const wire = `${Buffer.from('hello', 'utf8').toString('base64url')}.aGVsbG8`;
    expect(() => verifyCookieValue(KEY, wire)).not.toThrow();
    expect(verifyCookieValue(KEY, wire)).toBeNull();
  });
});

describe('cookies — parseCookieKey', () => {
  it('parses 64-hex', () => {
    const hex = 'a'.repeat(64);
    const key = parseCookieKey(hex);
    expect(key.length).toBe(32);
  });

  it('parses 44-base64', () => {
    const b64 = randomBytes(32).toString('base64');
    expect(b64.length).toBe(44);
    const key = parseCookieKey(b64);
    expect(key.length).toBe(32);
  });

  it('rejects 16-byte keys', () => {
    expect(() => parseCookieKey('a'.repeat(32))).toThrow(/AX_HTTP_COOKIE_KEY/);
  });

  it('rejects garbage', () => {
    expect(() => parseCookieKey('not a key')).toThrow(/AX_HTTP_COOKIE_KEY/);
  });
});

describe('cookies — buildSetCookieHeader', () => {
  it('always includes HttpOnly + SameSite=Lax + Path=/', () => {
    const h = buildSetCookieHeader('s', 'val', {}, { isSecureRequest: false });
    expect(h).toMatch(/HttpOnly/);
    expect(h).toMatch(/SameSite=Lax/);
    expect(h).toMatch(/Path=\//);
  });

  it('includes Secure when request is HTTPS', () => {
    const h = buildSetCookieHeader('s', 'val', {}, { isSecureRequest: true });
    expect(h).toMatch(/; Secure/);
  });

  it('omits Secure on plain HTTP', () => {
    const h = buildSetCookieHeader('s', 'val', {}, { isSecureRequest: false });
    expect(h).not.toMatch(/Secure/);
  });

  it('honors explicit secure=true override on plain HTTP', () => {
    const h = buildSetCookieHeader(
      's',
      'val',
      { secure: true },
      { isSecureRequest: false },
    );
    expect(h).toMatch(/; Secure/);
  });

  it('honors explicit secure=false override on HTTPS', () => {
    const h = buildSetCookieHeader(
      's',
      'val',
      { secure: false },
      { isSecureRequest: true },
    );
    expect(h).not.toMatch(/Secure/);
  });

  it('translates maxAge into Max-Age=<seconds>', () => {
    const h = buildSetCookieHeader(
      's',
      'val',
      { maxAge: 3600 },
      { isSecureRequest: false },
    );
    expect(h).toMatch(/Max-Age=3600/);
  });

  it('translates expires into a UTC timestamp', () => {
    const dt = new Date('2030-01-02T03:04:05Z');
    const h = buildSetCookieHeader(
      's',
      'val',
      { expires: dt },
      { isSecureRequest: false },
    );
    expect(h).toMatch(/Expires=Wed, 02 Jan 2030 03:04:05 GMT/);
  });

  it('forces Secure when SameSite=None', () => {
    const h = buildSetCookieHeader(
      's',
      'val',
      { sameSite: 'None' },
      { isSecureRequest: false },
    );
    expect(h).toMatch(/SameSite=None/);
    expect(h).toMatch(/; Secure/);
  });

  it('honors path / domain overrides', () => {
    const h = buildSetCookieHeader(
      's',
      'val',
      { path: '/admin', domain: 'example.com' },
      { isSecureRequest: false },
    );
    expect(h).toMatch(/Path=\/admin/);
    expect(h).toMatch(/Domain=example\.com/);
  });

  it('rejects invalid cookie names', () => {
    expect(() =>
      buildSetCookieHeader('bad name', 'v', {}, { isSecureRequest: false }),
    ).toThrow(/illegal/);
    expect(() =>
      buildSetCookieHeader('', 'v', {}, { isSecureRequest: false }),
    ).toThrow(/non-empty/);
  });

  it('rejects non-integer maxAge', () => {
    expect(() =>
      buildSetCookieHeader(
        's',
        'v',
        { maxAge: 1.5 },
        { isSecureRequest: false },
      ),
    ).toThrow(/integer/);
  });
});

describe('cookies — buildClearCookieHeader', () => {
  it('emits Max-Age=0 + Expires in the past', () => {
    const h = buildClearCookieHeader('s', {}, { isSecureRequest: false });
    expect(h).toMatch(/Max-Age=0/);
    expect(h).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    expect(h).toMatch(/HttpOnly/);
    expect(h).toMatch(/SameSite=Lax/);
    expect(h).toMatch(/Path=\//);
  });

  it('honors path override on clear', () => {
    const h = buildClearCookieHeader(
      's',
      { path: '/admin' },
      { isSecureRequest: false },
    );
    expect(h).toMatch(/Path=\/admin/);
  });
});

// ---------------------------------------------------------------------------
// Header-injection regression tests. Cookie name / path / domain all flush
// verbatim into the Set-Cookie header — anything that smuggles \r\n or `;`
// past these validators turns into a header-injection or attribute-spoof
// vulnerability. The tests here pin the validators so a future refactor
// can't quietly weaken them.
// ---------------------------------------------------------------------------

describe('cookies — header injection defenses', () => {
  it('rejects CR/LF in the cookie name', () => {
    expect(() =>
      buildSetCookieHeader('foo\r\nbar', 'v', {}, { isSecureRequest: false }),
    ).toThrow(/illegal/);
  });

  it('rejects `;` in the cookie name', () => {
    expect(() =>
      buildSetCookieHeader('foo;bar', 'v', {}, { isSecureRequest: false }),
    ).toThrow(/illegal/);
  });

  it('rejects CR/LF in opts.path on setSignedCookie', () => {
    expect(() =>
      buildSetCookieHeader(
        's',
        'v',
        { path: '/foo\r\nSet-Cookie: evil=1' },
        { isSecureRequest: false },
      ),
    ).toThrow(/cookie path\/domain/);
  });

  it('rejects `;` in opts.path on setSignedCookie', () => {
    expect(() =>
      buildSetCookieHeader(
        's',
        'v',
        { path: '/foo; HttpOnly=false' },
        { isSecureRequest: false },
      ),
    ).toThrow(/cookie path\/domain/);
  });

  it('rejects path that does not start with `/`', () => {
    expect(() =>
      buildSetCookieHeader(
        's',
        'v',
        { path: 'admin' },
        { isSecureRequest: false },
      ),
    ).toThrow(/cookie path\/domain/);
  });

  it('rejects CR/LF in opts.domain on setSignedCookie', () => {
    expect(() =>
      buildSetCookieHeader(
        's',
        'v',
        { domain: 'example.com\r\nSet-Cookie: evil=1' },
        { isSecureRequest: false },
      ),
    ).toThrow(/cookie path\/domain/);
  });

  it('rejects `;` in opts.domain on setSignedCookie', () => {
    expect(() =>
      buildSetCookieHeader(
        's',
        'v',
        { domain: 'example.com; Path=/admin' },
        { isSecureRequest: false },
      ),
    ).toThrow(/cookie path\/domain/);
  });

  it('rejects CR/LF in opts.path on clearCookie', () => {
    expect(() =>
      buildClearCookieHeader(
        's',
        { path: '/foo\r\nSet-Cookie: evil=1' },
        { isSecureRequest: false },
      ),
    ).toThrow(/cookie path\/domain/);
  });

  it('rejects `;` in opts.domain on clearCookie', () => {
    expect(() =>
      buildClearCookieHeader(
        's',
        { domain: 'example.com; Path=/admin' },
        { isSecureRequest: false },
      ),
    ).toThrow(/cookie path\/domain/);
  });

  it('signCookieValue handles CR/LF in plaintext via base64url encoding', () => {
    // The signed-value segment is base64url, whose alphabet excludes \r\n
    // and `;` by construction — so the encoding IS the defense, no extra
    // validation needed. This test pins that property.
    const wire = signCookieValue(KEY, 'evil\r\nSet-Cookie: x=1');
    expect(wire).not.toMatch(/[\r\n;]/);
    expect(verifyCookieValue(KEY, wire)).toBe('evil\r\nSet-Cookie: x=1');
  });
});
