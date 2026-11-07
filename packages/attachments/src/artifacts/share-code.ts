import { randomBytes } from 'node:crypto';

/**
 * Share codes (§6.3): a capability, so 192 bits from the CSPRNG (well past the
 * 128-bit floor), URL-safe base64 with no padding. Stored as plaintext so
 * Copy link can hand back the same code, and looked up only through the
 * unique index. Never log one, in full or in part.
 *
 * The shape check (`SHARE_CODE_RE` / `isShareCode`) lives in @ax/ipc-protocol,
 * shared with channel-web's link-holder routes.
 */
export const SHARE_CODE_BYTES = 24;

/** Always matches `SHARE_CODE_RE` (@ax/ipc-protocol): 24 bytes -> 32 base64url characters. */
export function newShareCode(): string {
  return randomBytes(SHARE_CODE_BYTES).toString('base64url');
}
