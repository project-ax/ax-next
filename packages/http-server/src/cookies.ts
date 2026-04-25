import { createHmac, timingSafeEqual } from 'node:crypto';
import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/http-server';
const KEY_LEN = 32;
// HMAC-SHA256 -> 32 bytes -> base64url is 43 chars (no padding).
const HMAC_B64URL_LEN = 43;
// RFC 6265 says servers MAY accept >= 4096-byte values. We cap at 4 KiB
// of pre-encoded plaintext so a runaway caller can't fill cookie storage.
const MAX_COOKIE_VALUE_BYTES = 4 * 1024;

export interface SignedCookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  /** Override Secure derivation. When omitted, derived from request protocol. */
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export interface CookieEnv {
  /** True iff the underlying connection / proxy chain is HTTPS. */
  isSecureRequest: boolean;
}

/**
 * Parse a 32-byte signing key from an env-var string. Accepts 64 hex chars
 * OR 44 base64 chars. Mirrors @ax/credentials/src/crypto.ts parseKeyFromEnv,
 * intentionally reimplemented inline to honor invariant I2 (no cross-plugin
 * imports).
 */
export function parseCookieKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === KEY_LEN) return b64;
  throw new PluginError({
    code: 'invalid-cookie-key',
    plugin: PLUGIN_NAME,
    message:
      'AX_HTTP_COOKIE_KEY must be a 32-byte key (64 hex chars or 44 base64 chars)',
  });
}

export function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LEN) {
    throw new PluginError({
      code: 'invalid-cookie-key',
      plugin: PLUGIN_NAME,
      message: `cookie signing key must be ${KEY_LEN} bytes; got ${key.length}`,
    });
  }
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer | null {
  // Reject anything that has b64 padding or non-url-safe chars; base64url
  // is strict here and silent decoding can mask tamper attempts.
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    return Buffer.from(s, 'base64url');
  } catch {
    return null;
  }
}

function computeHmac(key: Buffer, payload: Buffer): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

/**
 * Sign `value` with `key` and return the cookie-safe wire form
 * `<base64url(value)>.<base64url(hmac)>`. Throws if value exceeds
 * MAX_COOKIE_VALUE_BYTES (pre-encoding).
 */
export function signCookieValue(key: Buffer, value: string): string {
  assertKeyLength(key);
  const payload = Buffer.from(value, 'utf8');
  if (payload.length > MAX_COOKIE_VALUE_BYTES) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `signed cookie value exceeds ${MAX_COOKIE_VALUE_BYTES}-byte cap`,
    });
  }
  const sig = computeHmac(key, payload);
  return `${b64urlEncode(payload)}.${b64urlEncode(sig)}`;
}

/**
 * Verify `wire` against `key`. Returns the recovered plaintext string on
 * success, or null on any tamper (length mismatch, malformed segments,
 * HMAC mismatch). Never throws.
 */
export function verifyCookieValue(key: Buffer, wire: string): string | null {
  assertKeyLength(key);
  if (typeof wire !== 'string' || wire.length === 0) return null;
  // Use lastIndexOf so any '.' inside a base64url payload (none, but
  // guard anyway) doesn't fool the split — but accept an empty payload
  // segment (dot at index 0) so empty-string values roundtrip.
  const dot = wire.lastIndexOf('.');
  if (dot < 0 || dot === wire.length - 1) return null;
  const payloadPart = wire.slice(0, dot);
  const sigPart = wire.slice(dot + 1);
  // Length check before timingSafeEqual: it throws on mismatched lengths,
  // which would leak structure via exception type.
  if (sigPart.length !== HMAC_B64URL_LEN) return null;
  const payload = b64urlDecode(payloadPart);
  const sig = b64urlDecode(sigPart);
  if (payload === null || sig === null) return null;
  if (sig.length !== 32) return null;
  const expected = computeHmac(key, payload);
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(expected, sig)) return null;
  return payload.toString('utf8');
}

/**
 * Build a Set-Cookie header value for `(name, signedValue)` with the
 * locked defaults: HttpOnly, SameSite=Lax, Path=/. Secure is derived from
 * env.isSecureRequest unless opts.secure overrides.
 */
export function buildSetCookieHeader(
  name: string,
  signedValue: string,
  opts: SignedCookieOptions,
  env: CookieEnv,
): string {
  validateCookieName(name);
  const path = opts.path ?? '/';
  validateCookiePath(path);
  if (opts.domain !== undefined) validateCookieDomain(opts.domain);
  const parts: string[] = [`${name}=${signedValue}`];
  parts.push(`Path=${path}`);
  if (opts.domain !== undefined) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge !== undefined) {
    if (!Number.isFinite(opts.maxAge) || !Number.isInteger(opts.maxAge)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'cookie maxAge must be an integer (seconds)',
      });
    }
    parts.push(`Max-Age=${opts.maxAge}`);
  }
  if (opts.expires !== undefined) {
    parts.push(`Expires=${opts.expires.toUTCString()}`);
  }
  parts.push('HttpOnly');
  const sameSite = opts.sameSite ?? 'Lax';
  parts.push(`SameSite=${sameSite}`);
  // SameSite=None requires Secure per the spec; modern browsers reject
  // otherwise. Force Secure on so the cookie isn't silently dropped.
  const secure = opts.secure ?? (env.isSecureRequest || sameSite === 'None');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build a Set-Cookie header that immediately invalidates `name`. Sets
 * Max-Age=0 and an Expires in the distant past so legacy clients that
 * don't honor Max-Age still drop the cookie.
 */
export function buildClearCookieHeader(
  name: string,
  opts: Pick<SignedCookieOptions, 'path' | 'domain' | 'sameSite' | 'secure'>,
  env: CookieEnv,
): string {
  validateCookieName(name);
  const path = opts.path ?? '/';
  validateCookiePath(path);
  if (opts.domain !== undefined) validateCookieDomain(opts.domain);
  const parts: string[] = [`${name}=`];
  parts.push(`Path=${path}`);
  if (opts.domain !== undefined) parts.push(`Domain=${opts.domain}`);
  parts.push('Max-Age=0');
  parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  parts.push('HttpOnly');
  const sameSite = opts.sameSite ?? 'Lax';
  parts.push(`SameSite=${sameSite}`);
  const secure = opts.secure ?? (env.isSecureRequest || sameSite === 'None');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function validateCookieName(name: string): void {
  // RFC 6265 §4.1.1 token: ASCII, no separators / CTLs / spaces.
  if (typeof name !== 'string' || name.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'cookie name must be a non-empty string',
    });
  }
  if (!/^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `cookie name contains illegal characters: ${JSON.stringify(name)}`,
    });
  }
}

// Path / Domain attributes are flushed verbatim into the Set-Cookie header.
// Anything that could embed a CR/LF or a `;` would let a caller forge new
// header lines or inject extra cookie attributes — header-injection 101.
// We restrict to the conservative subsets the spec uses for these fields.
function validateCookiePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'cookie path must be a non-empty string',
    });
  }
  if (!/^\/[A-Za-z0-9._~/\-%]*$/.test(path)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'cookie path/domain contains invalid chars',
    });
  }
}

function validateCookieDomain(domain: string): void {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'cookie domain must be a non-empty string',
    });
  }
  if (!/^[A-Za-z0-9.\-]+$/.test(domain)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'cookie path/domain contains invalid chars',
    });
  }
}

export {
  KEY_LEN as COOKIE_KEY_LEN,
  MAX_COOKIE_VALUE_BYTES,
  HMAC_B64URL_LEN,
};
