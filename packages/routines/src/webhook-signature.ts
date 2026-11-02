import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookDetectedApp, WebhookTrigger } from '@ax/routines-contract';

// Slack and Stripe recommend five minutes. Apply the same bounded replay window
// to Zendesk's authenticated timestamp, in both clock directions.
const TOLERANCE_MS = 5 * 60 * 1000;
const MAX_SIGNATURE_HEADER = 8192;
/** The body-only check visits at most this many own header entries, skipped ones included. */
export const MAX_SCANNED_HEADERS = 100;
type Signature = NonNullable<WebhookTrigger['hmac']>;
type TimestampedApp = 'stripe' | 'slack' | 'zendesk';

/** How a delivery verified: the app detected, and whether its signed timestamp was checked too. */
export interface VerifiedSignature { readonly app: WebhookDetectedApp; readonly timestamp: boolean }

/** Any one of an app's headers, as an own property of any length, means that app sent the delivery. */
const TIMESTAMPED_APPS: ReadonlyArray<readonly [TimestampedApp, readonly string[]]> = [
  ['stripe', ['stripe-signature']],
  ['slack', ['x-slack-signature', 'x-slack-request-timestamp']],
  ['zendesk', ['x-zendesk-webhook-signature', 'x-zendesk-webhook-signature-timestamp']],
];
/**
 * Blocks a downgrade from a timestamped protocol to the body-only check.
 * Stripe signs `t.`+body, Slack `v0:t:`+body and Zendesk `t`+body. Move that
 * prefix into the body of a captured delivery and strip the app's headers, and
 * the body-only HMAC matches with no clock check, so the delivery could be
 * replayed forever. No real JSON or form body starts this way.
 */
const TIMESTAMPED_SIGNING_INPUT = /^(?:\d+\.|v0:|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z)/;
// A Set and a Map, never object literals: an own header named `constructor` or
// `__proto__` would read Object.prototype values from a literal, and an app
// outside the enum would break the evidence that records it.
/** Credentials and hop-by-hop headers are never read as signatures. */
const NOT_SCANNED: ReadonlySet<string> = new Set<string>([
  'authorization', 'proxy-authorization', 'proxy-authenticate', 'cookie', 'set-cookie',
  'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const BODY_ONLY_APPS: ReadonlyMap<string, WebhookDetectedApp> = new Map<string, WebhookDetectedApp>([
  ['x-hub-signature-256', 'github'], ['linear-signature', 'linear'],
]);
const SHA256_PREFIX = /^sha256=/i;

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  if (!Object.hasOwn(headers, name)) return undefined;
  const value = headers[name];
  return typeof value === 'string' && value.length <= MAX_SIGNATURE_HEADER ? value : undefined;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function fresh(at: number, now: Date): boolean {
  return Number.isFinite(at) && Number.isFinite(now.getTime()) && Math.abs(now.getTime() - at) <= TOLERANCE_MS;
}
function unixTimestamp(value: string | undefined, now: Date): value is string {
  return value !== undefined && /^\d{1,12}$/.test(value) && fresh(Number(value) * 1000, now);
}

/** Verify before parsing the body. Headers are lowercased by the HTTP adapter. */
export function verifyWebhookSignature(config: Signature, headers: Record<string, string>, body: Buffer, secret: string, now: Date): boolean {
  if (!('app' in config)) {
    const header = headerValue(headers, config.header.toLowerCase());
    if (!header || header.length > MAX_SIGNATURE_HEADER) return false;
    const bare = config.prefix !== undefined && header.startsWith(config.prefix) ? header.slice(config.prefix.length) : header;
    // Preserve the existing custom/GitHub protocol, including case and prefix handling.
    return same(bare.toLowerCase(), createHmac(config.algorithm, secret).update(body).digest('hex'));
  }
  return verifyTimestamped(config.app, headers, body, secret, now);
}

/** The app's full TASK-981 protocol, including its five-minute window. */
function verifyTimestamped(app: TimestampedApp, headers: Record<string, string>, body: Buffer, secret: string, now: Date): boolean {
  if (app === 'stripe') {
    const header = headerValue(headers, 'stripe-signature');
    if (!header || header.length > MAX_SIGNATURE_HEADER) return false;
    const parts = header.split(',').map(part => part.trim());
    const timestamps = parts.filter(part => part.startsWith('t='));
    if (timestamps.length !== 1) return false;
    const timestamp = timestamps[0]!.slice(2);
    if (!unixTimestamp(timestamp, now)) return false;
    const digest = createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
    // Stripe includes multiple v1 signatures during secret rotation. Ignore other versions.
    let valid = false;
    for (const part of parts) if (part.startsWith('v1=')) valid = same(part.slice(3), digest) || valid;
    return valid;
  }
  if (app === 'slack') {
    const timestamp = headerValue(headers, 'x-slack-request-timestamp');
    const signature = headerValue(headers, 'x-slack-signature');
    if (!unixTimestamp(timestamp, now) || !signature || signature.length > MAX_SIGNATURE_HEADER) return false;
    const digest = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex');
    return same(signature, `v0=${digest}`);
  }
  const timestamp = headerValue(headers, 'x-zendesk-webhook-signature-timestamp');
  const signature = headerValue(headers, 'x-zendesk-webhook-signature');
  // Accept Zendesk's UTC ISO timestamp only, rather than Date.parse's loose date grammar.
  if (!timestamp || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(timestamp)
    || !fresh(Date.parse(timestamp), now) || !signature || signature.length > MAX_SIGNATURE_HEADER) return false;
  if (new Date(timestamp).toISOString() !== (timestamp.length === 20 ? timestamp.replace('Z', '.000Z') : timestamp)) return false;
  return same(signature, createHmac('sha256', secret).update(timestamp).update(body).digest('base64'));
}

/**
 * Verify a delivery with the task's saved signing secret, detecting from its
 * headers which app signed it (TASK-1026). Null refuses. Verify before parsing
 * the body. Header names arrive lowercased from the HTTP adapter.
 */
export function verifyWebhookDelivery(headers: Record<string, string>, body: Buffer, secret: string, now: Date): VerifiedSignature | null {
  // Anyone can sign with an empty key.
  if (secret.length === 0) return null;
  const present = TIMESTAMPED_APPS.filter(([, names]) => names.some(name => Object.hasOwn(headers, name)));
  if (present.length > 1) return null;
  // A timestamped app's header decides, pass or fail. Never fall through to the body-only check.
  if (present.length === 1) {
    const app = present[0]![0];
    return verifyTimestamped(app, headers, body, secret, now) ? { app, timestamp: true } : null;
  }
  if (TIMESTAMPED_SIGNING_INPUT.test(body.subarray(0, 40).toString('latin1'))) return null;
  // SHA-256 only: a SHA-1 signature never matches.
  const digest = createHmac('sha256', secret).update(body).digest();
  const hex = digest.toString('hex'), base64 = digest.toString('base64');
  const names = Object.keys(headers);
  const visits = Math.min(names.length, MAX_SCANNED_HEADERS);
  for (let i = 0; i < visits; i++) {
    const name = names[i]!;
    if (NOT_SCANNED.has(name)) continue;
    const value = headerValue(headers, name);
    if (value === undefined) continue;
    const bare = SHA256_PREFIX.test(value) ? value.slice('sha256='.length) : value;
    // Hex in any case, or padded standard base64 as sent. `same` compares equal-length bytes only.
    if (bare.length === 64 ? same(bare.toLowerCase(), hex) : bare.length === 44 && same(bare, base64)) {
      return { app: BODY_ONLY_APPS.get(name) ?? 'other', timestamp: false };
    }
  }
  return null;
}
