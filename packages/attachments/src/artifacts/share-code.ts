import { randomBytes } from 'node:crypto';

/**
 * Share codes (§6.3): a capability, so 192 bits from the CSPRNG (well past the
 * 128-bit floor), URL-safe base64 with no padding. Stored as plaintext so
 * Copy link can hand back the same code, and looked up only through the
 * unique index. Never log one, in full or in part.
 */
export const SHARE_CODE_BYTES = 24;

/** Exactly what `newShareCode` mints: 24 bytes -> 32 base64url characters. */
export const SHARE_CODE_RE = /^[A-Za-z0-9_-]{32}$/;

export function newShareCode(): string {
  return randomBytes(SHARE_CODE_BYTES).toString('base64url');
}

/** Checked before any lookup, so a malformed code never reaches the store. */
export function isShareCode(v: unknown): v is string {
  return typeof v === 'string' && SHARE_CODE_RE.test(v);
}
