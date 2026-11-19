/**
 * The bot's picture, as Connect takes it: `iconPng`, a square PNG in
 * standard, padded base64, drawn by the admin's browser (channel-web's
 * lib/slack-avatar-draw.ts). This is the trust check on those bytes before
 * Connect hands them to Slack's `apps.icon.set` (admin-routes.ts).
 *
 * The bytes are only ever forwarded to Slack, never decoded past the IHDR,
 * stored or logged; Slack does the full image check. So this reads no
 * further than the PNG signature and the IHDR chunk's length, type, width and
 * height: enough to refuse what Slack would refuse for its size (square,
 * 512 to 2000 px a side; `invalid_icon_size`) and anything that isn't a PNG,
 * without a decoder. A refusal is a code, never the value.
 *
 * There is no length check before decoding: the connect route's body cap
 * (ADMIN_CONNECT_BODY_MAX_BYTES) already bounds the string.
 */
import { SLACK_ICON_MAX_BYTES, SLACK_ICON_MAX_PX, SLACK_ICON_MIN_PX } from './limits.js';

export type IconRefusal = 'icon-not-base64' | 'icon-too-large' | 'icon-not-png' | 'icon-bad-size';
export type ParsedIcon = { ok: true; png: Buffer } | { ok: false; code: IconRefusal };

/**
 * Standard base64's alphabet, padding only at the end. Node's own decoder
 * would also take the URL-safe alphabet and skip whitespace; neither is what
 * a browser's `toDataURL` gives, so neither gets in.
 */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Every PNG starts with these eight bytes. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The signature, then the IHDR chunk's length, type, width and height. */
const HEADER_BYTES = 24;
/** The IHDR chunk's data is always 13 bytes. */
const IHDR_LENGTH = 13;

const refuse = (code: IconRefusal): ParsedIcon => ({ ok: false, code });

/** `value` as the PNG bytes it carries, or the first rule it breaks. */
export function parseIconPng(value: unknown): ParsedIcon {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) {
    return refuse('icon-not-base64');
  }
  const png = Buffer.from(value, 'base64');
  if (png.length > SLACK_ICON_MAX_BYTES) return refuse('icon-too-large');
  if (
    png.length < HEADER_BYTES ||
    !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    png.readUInt32BE(8) !== IHDR_LENGTH ||
    png.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return refuse('icon-not-png');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== height || width < SLACK_ICON_MIN_PX || width > SLACK_ICON_MAX_PX) {
    return refuse('icon-bad-size');
  }
  return { ok: true, png };
}
