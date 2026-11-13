import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNATURE_HEADER_MAX, SIGNATURE_TOLERANCE_S } from './limits.js';

/**
 * Slack's v0 request signature (docs.slack.dev, "Verifying requests from
 * Slack"), checked the way @ax/routines' webhook-signature.ts checks it.
 * Copied, not imported (invariant 2).
 *
 *   - The HMAC-SHA256 is over `v0:<timestamp>:` and then the RAW body bytes,
 *     never a re-serialization or a decoded string.
 *   - The timestamp is 1 to 12 plain digits and within SIGNATURE_TOLERANCE_S
 *     of our clock in BOTH directions, so a captured delivery can't be
 *     replayed later and a future-dated one can't be banked.
 *   - The comparison is constant-time over equal-length bytes.
 *   - Headers are read only as own properties, each at most
 *     SIGNATURE_HEADER_MAX characters. Names arrive lowercased from the
 *     HTTP adapter.
 *   - An empty signing secret verifies nothing: anyone can sign with it.
 *
 * Call it BEFORE parsing the body.
 */

const TIMESTAMP = /^\d{1,12}$/;

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  if (!Object.hasOwn(headers, name)) return undefined;
  const value = headers[name];
  return typeof value === 'string' && value.length <= SIGNATURE_HEADER_MAX ? value : undefined;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifySlackSignature(i: {
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  signingSecret: string;
  nowMs: number;
}): boolean {
  if (i.signingSecret.length === 0 || !Number.isFinite(i.nowMs)) return false;
  const timestamp = headerValue(i.headers, 'x-slack-request-timestamp');
  const signature = headerValue(i.headers, 'x-slack-signature');
  if (timestamp === undefined || signature === undefined || !TIMESTAMP.test(timestamp)) {
    return false;
  }
  if (Math.abs(i.nowMs - Number(timestamp) * 1000) > SIGNATURE_TOLERANCE_S * 1000) return false;
  const digest = createHmac('sha256', i.signingSecret)
    .update(`v0:${timestamp}:`)
    .update(i.body)
    .digest('hex');
  return same(signature, `v0=${digest}`);
}
