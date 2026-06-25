import { describe, it, expect } from 'vitest';
import { validateLogoUpload, MAX_LOGO_BYTES } from '../image-validation.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

const PNG_MAGIC = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_MAGIC = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00,
]);
const SVG_PLAIN = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
);
const SVG_XML_DECL = new TextEncoder().encode(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg></svg>',
);

describe('validateLogoUpload — accepts well-formed logos', () => {
  it('accepts PNG with matching magic bytes', () => {
    const r = validateLogoUpload('image/png', b64(PNG_MAGIC));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.from(r.bytes)).toEqual(Array.from(PNG_MAGIC));
  });

  it('accepts JPEG with matching magic bytes', () => {
    expect(validateLogoUpload('image/jpeg', b64(JPEG_MAGIC)).ok).toBe(true);
  });

  it('accepts WebP with RIFF/WEBP framing', () => {
    expect(validateLogoUpload('image/webp', b64(WEBP_MAGIC)).ok).toBe(true);
  });

  it('accepts SVG starting with <svg>', () => {
    expect(validateLogoUpload('image/svg+xml', b64(SVG_PLAIN)).ok).toBe(true);
  });

  it('accepts SVG that opens with an XML declaration', () => {
    expect(validateLogoUpload('image/svg+xml', b64(SVG_XML_DECL)).ok).toBe(true);
  });
});

describe('validateLogoUpload — rejects bad uploads', () => {
  it('rejects when magic bytes do not match the declared type', () => {
    const r = validateLogoUpload('image/png', b64(JPEG_MAGIC));
    expect(r.ok).toBe(false);
  });

  it('rejects a content-type outside the allowlist', () => {
    const r = validateLogoUpload('text/plain', b64(new TextEncoder().encode('hi')));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/content.?type/i);
  });

  it('rejects SVG whose body is not an <svg> document', () => {
    const r = validateLogoUpload(
      'image/svg+xml',
      b64(new TextEncoder().encode('<html><body>nope</body></html>')),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects non-base64 input', () => {
    expect(validateLogoUpload('image/png', '!!!not base64!!!').ok).toBe(false);
  });

  it('rejects empty input', () => {
    expect(validateLogoUpload('image/png', '').ok).toBe(false);
  });

  it('rejects a payload larger than the per-logo cap', () => {
    const big = new Uint8Array(MAX_LOGO_BYTES + 1);
    big.set(PNG_MAGIC, 0);
    const r = validateLogoUpload('image/png', b64(big));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/large|size|cap|big/i);
  });
});
