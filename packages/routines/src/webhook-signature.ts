import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookTrigger } from '@ax/routines-contract';

// Slack and Stripe recommend five minutes. Apply the same bounded replay window
// to Zendesk's authenticated timestamp, in both clock directions.
const TOLERANCE_MS = 5 * 60 * 1000;
const MAX_SIGNATURE_HEADER = 8192;
type Signature = NonNullable<WebhookTrigger['hmac']>;

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
  if (config.app === 'stripe') {
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
  if (config.app === 'slack') {
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
