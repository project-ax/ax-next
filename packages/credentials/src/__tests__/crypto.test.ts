import { describe, it, expect } from 'vitest';
import { encryptWithKey, decryptWithKey, parseKeyFromEnv } from '../crypto.js';

const KEY = Buffer.alloc(32, 0x42); // deterministic test key

describe('encryptWithKey / decryptWithKey', () => {
  it('round-trips short strings', () => {
    const blob = encryptWithKey(KEY, 'sk-hunter2');
    expect(decryptWithKey(KEY, blob)).toBe('sk-hunter2');
  });
  it('round-trips empty strings', () => {
    const blob = encryptWithKey(KEY, '');
    expect(decryptWithKey(KEY, blob)).toBe('');
  });
  it('round-trips utf-8 payloads', () => {
    const blob = encryptWithKey(KEY, '🔐 secret ✨');
    expect(decryptWithKey(KEY, blob)).toBe('🔐 secret ✨');
  });
  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const a = encryptWithKey(KEY, 'same');
    const b = encryptWithKey(KEY, 'same');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
  it('tampering flips auth tag and fails decryption', () => {
    const blob = encryptWithKey(KEY, 'topsecret');
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptWithKey(KEY, blob)).toThrow(/auth|tag|decrypt/i);
  });
  it('rejects ciphertext shorter than iv+tag', () => {
    const tooShort = new Uint8Array(10);
    expect(() => decryptWithKey(KEY, tooShort)).toThrow(/ciphertext/i);
  });
  it('decryption error message does NOT contain plaintext', () => {
    const blob = encryptWithKey(KEY, 'UNIQUE-PLAINTEXT-MARKER');
    blob[blob.length - 1] ^= 0xff;
    try {
      decryptWithKey(KEY, blob);
    } catch (err) {
      expect(String(err)).not.toContain('UNIQUE-PLAINTEXT-MARKER');
    }
  });
});

describe('parseKeyFromEnv', () => {
  it('accepts 64-char hex', () => {
    const hex = '00'.repeat(32);
    expect(parseKeyFromEnv(hex).length).toBe(32);
  });
  it('accepts base64 (44 chars with padding)', () => {
    const b64 = Buffer.alloc(32, 0x41).toString('base64');
    expect(parseKeyFromEnv(b64).length).toBe(32);
  });
  it('rejects wrong-length keys with a redacted error', () => {
    expect(() => parseKeyFromEnv('too-short-to-be-a-key')).toThrow(/32-byte/);
    try {
      parseKeyFromEnv('too-short-to-be-a-key');
    } catch (err) {
      expect(String(err)).not.toContain('too-short-to-be-a-key');
    }
  });
});
