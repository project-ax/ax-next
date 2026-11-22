import { createHash } from 'node:crypto';
import { LINK_CODE_RE } from '@ax/apps-bridge-contract';
import { describe, expect, it, vi } from 'vitest';
import { LINK_CODE_TTL_MS, base32Lower, hashLinkCode, newLinkCode } from '../link-codes.js';

describe('link codes', () => {
  it('base32Lower follows RFC 4648', () => {
    // RFC 4648 section 10 vectors, lowercased, no padding.
    const enc = (s: string) => base32Lower(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('my');
    expect(enc('fo')).toBe('mzxq');
    expect(enc('foo')).toBe('mzxw6');
    expect(enc('foob')).toBe('mzxw6yq');
    expect(enc('fooba')).toBe('mzxw6ytb');
    expect(enc('foobar')).toBe('mzxw6ytboi');
    expect(base32Lower(new Uint8Array(20))).toBe('a'.repeat(32));
    expect(base32Lower(new Uint8Array(20).fill(0xff))).toBe('7'.repeat(32));
  });

  it('newLinkCode is axl_ plus 32 base32 characters from 20 random bytes', () => {
    const random = vi.fn((n: number) => new Uint8Array(n).fill(0x42));
    const code = newLinkCode(random);
    expect(random).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledWith(20);
    expect(code).toHaveLength(36);
    expect(code).toMatch(LINK_CODE_RE);
    expect(code).toBe(`axl_${base32Lower(new Uint8Array(20).fill(0x42))}`);

    // The default source is the platform CSPRNG: two codes differ.
    const a = newLinkCode();
    const b = newLinkCode();
    expect(a).toMatch(LINK_CODE_RE);
    expect(b).toMatch(LINK_CODE_RE);
    expect(a).not.toBe(b);
  });

  it('newLinkCode refuses a random source that returns the wrong number of bytes', () => {
    expect(() => newLinkCode(() => new Uint8Array(19))).toThrow();
  });

  it('hashLinkCode is sha256 hex', () => {
    const code = 'axl_' + 'a'.repeat(32);
    const hash = hashLinkCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(code, 'utf8').digest('hex'));
  });

  it('a code lives 15 minutes', () => {
    expect(LINK_CODE_TTL_MS).toBe(900_000);
  });
});
