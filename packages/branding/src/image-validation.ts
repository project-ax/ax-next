/**
 * Logo upload validation — content-type allowlist, base64 decode, per-logo
 * size cap, and a magic-byte sniff that asserts the decoded bytes match the
 * declared content-type. This is the trust boundary for admin-supplied image
 * bytes: a script must not be storable as an "image", and an oversized
 * payload must not slip past the per-route body cap via base64 inflation.
 */

export type AllowedContentType =
  | 'image/png'
  | 'image/webp'
  | 'image/jpeg'
  | 'image/svg+xml';

export const ALLOWED_CONTENT_TYPES = [
  'image/png',
  'image/webp',
  'image/jpeg',
  'image/svg+xml',
] as const;

/** Per-logo decoded byte cap (~1 MiB). The PUT route also caps the whole body. */
export const MAX_LOGO_BYTES = 1 * 1024 * 1024;

export type ValidateResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

export function isAllowedContentType(ct: string): ct is AllowedContentType {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(ct);
}

/**
 * Strict-ish base64 decode. Whitespace is tolerated; anything else outside the
 * base64 alphabet (or a wrong-length payload) is rejected rather than silently
 * dropped the way `Buffer.from(s, 'base64')` would.
 */
function decodeBase64(data: string): Uint8Array | null {
  const stripped = data.replace(/\s+/g, '');
  if (stripped.length === 0) return null;
  if (stripped.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) return null;
  try {
    return new Uint8Array(Buffer.from(stripped, 'base64'));
  } catch {
    return null;
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG = [0xff, 0xd8, 0xff] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"

function looksLikeSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  // trimStart() strips a leading BOM (U+FEFF is JS whitespace); then drop any
  // XML declaration / comments / DOCTYPE and require the first element to be
  // <svg>.
  let s = text.trimStart();
  s = s.replace(/^<\?xml[\s\S]*?\?>/i, '').trimStart();
  let changed = true;
  while (changed) {
    const before = s;
    s = s.replace(/^<!--[\s\S]*?-->/, '').trimStart();
    s = s.replace(/^<!DOCTYPE[\s\S]*?>/i, '').trimStart();
    changed = s !== before;
  }
  return /^<svg[\s/>]/i.test(s);
}

function magicMatches(ct: AllowedContentType, bytes: Uint8Array): boolean {
  switch (ct) {
    case 'image/png':
      return startsWith(bytes, PNG);
    case 'image/jpeg':
      return startsWith(bytes, JPEG);
    case 'image/webp':
      // "RIFF" .... "WEBP"
      return (
        startsWith(bytes, RIFF) &&
        bytes.length >= 12 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case 'image/svg+xml':
      return looksLikeSvg(bytes);
  }
}

export function validateLogoUpload(
  contentType: string,
  dataBase64: string,
): ValidateResult {
  if (!isAllowedContentType(contentType)) {
    return { ok: false, error: `unsupported content-type: ${contentType}` };
  }
  const bytes = decodeBase64(dataBase64);
  if (bytes === null) {
    return { ok: false, error: 'logo data is not valid base64' };
  }
  if (bytes.length === 0) {
    return { ok: false, error: 'logo data is empty' };
  }
  if (bytes.length > MAX_LOGO_BYTES) {
    return {
      ok: false,
      error: `logo is too large (${bytes.length} bytes; max ${MAX_LOGO_BYTES})`,
    };
  }
  if (!magicMatches(contentType, bytes)) {
    return {
      ok: false,
      error: `bytes do not match the declared content-type ${contentType}`,
    };
  }
  return { ok: true, bytes };
}
