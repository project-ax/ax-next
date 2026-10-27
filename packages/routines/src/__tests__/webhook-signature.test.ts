import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '../webhook-signature.js';

const now = new Date('2026-10-27T12:00:00Z');
const body = Buffer.from('{ "ticket": "café" }\n');
const secret = 'fixture-signing-secret';
type App = 'stripe' | 'slack' | 'zendesk';
function signed(app: App, at = now): Record<string, string> {
  const timestamp = app === 'zendesk' ? at.toISOString().replace('.000Z', 'Z') : String(at.getTime() / 1000);
  const base = app === 'stripe' ? `${timestamp}.` : app === 'slack' ? `v0:${timestamp}:` : timestamp;
  const digest = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(base), body])).digest(app === 'zendesk' ? 'base64' : 'hex');
  if (app === 'stripe') return { 'stripe-signature': `t=${timestamp},v1=${digest}` };
  if (app === 'slack') return { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${digest}` };
  return { 'x-zendesk-webhook-signature-timestamp': timestamp, 'x-zendesk-webhook-signature': digest };
}

describe('provider signature protocols', () => {
  it.each(['stripe', 'slack', 'zendesk'] as const)('%s authenticates the raw body and timestamp', app => {
    const headers = signed(app);
    expect(verifyWebhookSignature({ app }, headers, body, secret, now)).toBe(true);
    expect(verifyWebhookSignature({ app }, headers, Buffer.from(JSON.stringify(JSON.parse(body.toString()))), secret, now)).toBe(false);
    expect(verifyWebhookSignature({ app }, headers, body, 'wrong', now)).toBe(false);
    expect(verifyWebhookSignature({ app }, {}, body, secret, now)).toBe(false);
    for (const key of Object.keys(headers)) {
      expect(verifyWebhookSignature({ app }, { ...headers, [key]: '' }, body, secret, now)).toBe(false);
      expect(verifyWebhookSignature({ app }, { ...headers, [key]: headers[key]! + 'x' }, body, secret, now)).toBe(false);
    }
  });
  it.each(['stripe', 'slack', 'zendesk'] as const)('%s bounds timestamp age in both directions, including exactly five minutes', app => {
    for (const seconds of [-301, -300, 300, 301]) {
      expect(verifyWebhookSignature({ app }, signed(app, new Date(now.getTime() + seconds * 1000)), body, secret, now)).toBe(Math.abs(seconds) <= 300);
    }
    expect(verifyWebhookSignature({ app }, signed(app), body, secret, new Date(NaN))).toBe(false);
  });
  it('checks every Stripe v1 during rotation and refuses timestamp ambiguity and downgraded versions', () => {
    const header = signed('stripe')['stripe-signature']!;
    const verify = (value: string) => verifyWebhookSignature({ app: 'stripe' }, { 'stripe-signature': value }, body, secret, now);
    expect(verify(`${header},v1=${'0'.repeat(64)}`)).toBe(true);
    expect(verify(`v1=${'0'.repeat(64)}, ${header},v0=ignored`)).toBe(true);
    expect(verify(header.replace('v1=', 'v0='))).toBe(false);
    expect(verify(`${header},t=${now.getTime() / 1000}`)).toBe(false);
    expect(verify(`${header},v1=${'0'.repeat(8192)}`)).toBe(false);
    expect(verify(header.replace('t=', 'timestamp='))).toBe(false);
  });
  it('matches Slack’s published vector independently of our signer', () => {
    // https://docs.slack.dev/authentication/verifying-requests-from-slack/
    const bytes = Buffer.from('token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c');
    expect(verifyWebhookSignature({ app: 'slack' }, { 'x-slack-request-timestamp': '1531420618', 'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503' }, bytes, '8f742231b10e8888abcd99yyyzzz85a5', new Date(1531420618000))).toBe(true);
  });
  it('preserves custom SHA1/SHA256, optional prefixes and case handling', () => {
    for (const algorithm of ['sha1', 'sha256'] as const) {
      const digest = createHmac(algorithm, secret).update(body).digest('hex').toUpperCase();
      for (const prefix of [undefined, 'sha256=']) {
        const config = { header: 'X-Signature', algorithm, ...(prefix === undefined ? {} : { prefix }) };
        expect(verifyWebhookSignature(config, { 'x-signature': `${prefix ?? ''}${digest}` }, body, secret, now)).toBe(true);
        expect(verifyWebhookSignature(config, { 'x-signature': digest }, body, secret, now)).toBe(true);
      }
    }
  });
  it('uses Zendesk’s UTF-8 secret as given, not decoded base64', () => {
    const timestamp = '2026-10-27T12:00:00Z';
    const encodedSecret = Buffer.from(secret).toString('base64');
    const signature = createHmac('sha256', encodedSecret).update(timestamp).update(body).digest('base64');
    const headers = { 'x-zendesk-webhook-signature-timestamp': timestamp, 'x-zendesk-webhook-signature': signature };
    expect(verifyWebhookSignature({ app: 'zendesk' }, headers, body, encodedSecret, now)).toBe(true);
    expect(verifyWebhookSignature({ app: 'zendesk' }, headers, body, secret, now)).toBe(false);
  });
  it('refuses malformed authenticated timestamps and unsupported Slack versions', () => {
    for (const timestamp of ['NaN', 'Infinity', '1e9', '1793102400.0', ' 1793102400', '1793102400,1793102400']) {
      const slack = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex');
      expect(verifyWebhookSignature({ app: 'slack' }, { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${slack}` }, body, secret, now)).toBe(false);
      const stripe = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
      expect(verifyWebhookSignature({ app: 'stripe' }, { 'stripe-signature': `t=${timestamp},v1=${stripe}` }, body, secret, now)).toBe(false);
    }
    const unsupported = signed('slack');
    unsupported['x-slack-signature'] = unsupported['x-slack-signature']!.replace('v0=', 'v1=');
    expect(verifyWebhookSignature({ app: 'slack' }, unsupported, body, secret, now)).toBe(false);
    const impossible = '2026-02-30T12:00:00Z';
    const signature = createHmac('sha256', secret).update(impossible).update(body).digest('base64');
    expect(verifyWebhookSignature({ app: 'zendesk' }, { 'x-zendesk-webhook-signature-timestamp': impossible, 'x-zendesk-webhook-signature': signature }, body, secret, new Date(impossible))).toBe(false);
  });
  it('signs bytes even when UTF-8 replacement characters would hide a change', () => {
    const original = Buffer.from([0xff]), changed = Buffer.from([0xfe]);
    expect(original.toString()).toBe(changed.toString());
    const timestamp = String(now.getTime() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(original).digest('hex');
    const headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` };
    expect(verifyWebhookSignature({ app: 'stripe' }, headers, original, secret, now)).toBe(true);
    expect(verifyWebhookSignature({ app: 'stripe' }, headers, changed, secret, now)).toBe(false);
  });
});
