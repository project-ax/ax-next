import { describe, expect, it } from 'vitest';
import { SHARE_CODE_RE, isShareCode } from '../index.js';

// The one share-code shape, used by @ax/attachments (mint + lookup) and
// channel-web's /api/shared routes. Minting itself is tested in attachments.
describe('isShareCode', () => {
  it('accepts 32 base64url characters', () => {
    for (const ok of ['Abcdefghijklmnopqrstuvwxyz012345', `${'a'.repeat(30)}_-`, '0'.repeat(32)]) {
      expect(isShareCode(ok)).toBe(true);
      expect(ok).toMatch(SHARE_CODE_RE);
    }
  });

  it('refuses anything else: wrong length, padding, standard base64, whitespace, traversal, non-strings', () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      'a'.repeat(31),
      'a'.repeat(33),
      `${'a'.repeat(31)}=`,
      `${'a'.repeat(31)}+`,
      `${'a'.repeat(31)}/`,
      `${'a'.repeat(31)}\n`,
      ` ${'a'.repeat(31)}`,
      `../${'a'.repeat(29)}`,
      `${'a'.repeat(31)}\u00e9`,
    ]) {
      expect(isShareCode(bad)).toBe(false);
    }
  });
});
