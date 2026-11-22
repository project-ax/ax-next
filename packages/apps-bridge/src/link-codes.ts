import { createHash, randomBytes } from 'node:crypto';

/**
 * Link codes: `axl_` + 32 lowercase base32 characters (20 random bytes, 160
 * bits). A code is shown once to the person who minted it and stored only as
 * its sha256 (`hashLinkCode`). It expires LINK_CODE_TTL_MS after minting and
 * links one app.
 */

export const LINK_CODE_TTL_MS = 15 * 60_000;

const CODE_BYTES = 20;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding. */
export function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** A fresh code. `random` is a test seam; the default is the platform CSPRNG. */
export function newLinkCode(random: (bytes: number) => Uint8Array = (n) => randomBytes(n)): string {
  const bytes = random(CODE_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== CODE_BYTES) {
    throw new Error('newLinkCode: the random source must return 20 bytes');
  }
  return `axl_${base32Lower(bytes)}`;
}

/** sha256 of the code's UTF-8 bytes, lowercase hex: the only form the store keeps. */
export function hashLinkCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}
