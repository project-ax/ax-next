import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookDelivery } from '../webhook-signature.js';

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
  const verify = (headers: Record<string, string>, bytes: Buffer = body, key: string = secret, at: Date = now) => verifyWebhookDelivery(headers, bytes, key, at);
  it.each(['constructor', '__proto__'])('refuses a missing or inherited %s header and names an own one a signed app', header => {
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    expect(verify({})).toBeNull();
    expect(verify(Object.create({ [header]: digest }) as Record<string, string>)).toBeNull();
    const own: Record<string, string> = Object.create(null) as Record<string, string>;
    own[header] = digest;
    expect(verify(own)).toStrictEqual({ app: 'other', timestamp: false });
  });
  it.each(['stripe', 'slack', 'zendesk'] as const)('%s authenticates the raw body and timestamp', app => {
    const headers = signed(app);
    expect(verify(headers)).toStrictEqual({ app, timestamp: true });
    expect(verify(headers, Buffer.from(JSON.stringify(JSON.parse(body.toString()))))).toBeNull();
    expect(verify(headers, body, 'wrong')).toBeNull();
    for (const key of Object.keys(headers)) {
      expect(verify({ ...headers, [key]: '' }), key).toBeNull();
      expect(verify({ ...headers, [key]: headers[key]! + 'x' }), key).toBeNull();
    }
  });
  it('checks every Stripe v1 during rotation and refuses timestamp ambiguity and downgraded versions', () => {
    const header = signed('stripe')['stripe-signature']!;
    const stripe = (value: string) => verify({ 'stripe-signature': value });
    expect(stripe(`${header},v1=${'0'.repeat(64)}`)).toStrictEqual({ app: 'stripe', timestamp: true });
    expect(stripe(`v1=${'0'.repeat(64)}, ${header},v0=ignored`)).toStrictEqual({ app: 'stripe', timestamp: true });
    expect(stripe(header.replace('v1=', 'v0='))).toBeNull();
    expect(stripe(`${header},t=${now.getTime() / 1000}`)).toBeNull();
    expect(stripe(`${header},v1=${'0'.repeat(8192)}`)).toBeNull();
    expect(stripe(header.replace('t=', 'timestamp='))).toBeNull();
  });
  it('matches Slack’s published vector independently of our signer', () => {
    // https://docs.slack.dev/authentication/verifying-requests-from-slack/
    const bytes = Buffer.from('token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c');
    expect(verifyWebhookDelivery({ 'x-slack-request-timestamp': '1531420618', 'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503' }, bytes, '8f742231b10e8888abcd99yyyzzz85a5', new Date(1531420618000))).toStrictEqual({ app: 'slack', timestamp: true });
  });
  it('uses Zendesk’s UTF-8 secret as given, not decoded base64', () => {
    const timestamp = '2026-10-27T12:00:00Z';
    const encodedSecret = Buffer.from(secret).toString('base64');
    const signature = createHmac('sha256', encodedSecret).update(timestamp).update(body).digest('base64');
    const headers = { 'x-zendesk-webhook-signature-timestamp': timestamp, 'x-zendesk-webhook-signature': signature };
    expect(verify(headers, body, encodedSecret)).toStrictEqual({ app: 'zendesk', timestamp: true });
    expect(verify(headers, body, secret)).toBeNull();
  });
  it('refuses malformed authenticated timestamps and unsupported Slack versions', () => {
    for (const timestamp of ['NaN', 'Infinity', '1e9', '1793102400.0', ' 1793102400', '1793102400,1793102400']) {
      const slack = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex');
      expect(verify({ 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${slack}` }), timestamp).toBeNull();
      const stripe = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
      expect(verify({ 'stripe-signature': `t=${timestamp},v1=${stripe}` }), timestamp).toBeNull();
    }
    const unsupported = signed('slack');
    unsupported['x-slack-signature'] = unsupported['x-slack-signature']!.replace('v0=', 'v1=');
    expect(verify(unsupported)).toBeNull();
    const impossible = '2026-02-30T12:00:00Z';
    const signature = createHmac('sha256', secret).update(impossible).update(body).digest('base64');
    expect(verify({ 'x-zendesk-webhook-signature-timestamp': impossible, 'x-zendesk-webhook-signature': signature }, body, secret, new Date(impossible))).toBeNull();
  });
  it('signs bytes even when UTF-8 replacement characters would hide a change', () => {
    const original = Buffer.from([0xff]), changed = Buffer.from([0xfe]);
    expect(original.toString()).toBe(changed.toString());
    const timestamp = String(now.getTime() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(original).digest('hex');
    const headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` };
    expect(verify(headers, original)).toStrictEqual({ app: 'stripe', timestamp: true });
    expect(verify(headers, changed)).toBeNull();
  });
});

/** What each timestamped app signs ahead of the raw body, written out apart from `signed`. */
function signingPrefix(app: App, at = now): Buffer {
  const seconds = String(at.getTime() / 1000);
  if (app === 'stripe') return Buffer.from(`${seconds}.`);
  if (app === 'slack') return Buffer.from(`v0:${seconds}:`);
  return Buffer.from(at.toISOString().replace('.000Z', 'Z'));
}

describe('host-detected signatures', () => {
  const apps = ['stripe', 'slack', 'zendesk'] as const;
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  const b64 = createHmac('sha256', secret).update(body).digest('base64');
  const sha1hex = createHmac('sha1', secret).update(body).digest('hex');
  const notScanned = ['authorization', 'proxy-authorization', 'proxy-authenticate', 'cookie', 'set-cookie', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  const verify = (headers: Record<string, string>, bytes: Buffer = body, key: string = secret) => verifyWebhookDelivery(headers, bytes, key, now);
  const github = { app: 'github', timestamp: false };
  const linear = { app: 'linear', timestamp: false };
  const other = { app: 'other', timestamp: false };
  const bodySigned = { 'x-hub-signature-256': `sha256=${hex}` };
  const junk = (count: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`x-junk-${i}`, 'a'.repeat(64)]));

  it('accepts a Linear-shaped signature', () => {
    expect(verify({ 'linear-signature': hex })).toStrictEqual(linear);
    expect(verify({ 'linear-signature': hex.toUpperCase() })).toStrictEqual(linear);
  });
  it('accepts a GitHub-shaped signature', () => {
    expect(verify({ 'x-hub-signature': `sha1=${sha1hex}`, 'x-hub-signature-256': `sha256=${hex}` })).toStrictEqual(github);
  });
  it('names any other signing header a signed app', () => {
    expect(verify({ 'x-signature': hex })).toStrictEqual(other);
    expect(verify({ 'x-shopify-hmac-sha256': b64 })).toStrictEqual(other);
    expect(verify({ 'x-signature': `sha256=${b64}` })).toStrictEqual(other);
    expect(verify({ 'x-signature': `SHA256=${hex}` })).toStrictEqual(other);
  });
  it('refuses a wrong secret, a changed body, SHA-1 and no signature', () => {
    expect(verify({ 'linear-signature': hex }, body, 'wrong-secret')).toBeNull();
    expect(verify({ 'linear-signature': hex }, Buffer.concat([body, Buffer.from(' ')]))).toBeNull();
    expect(verify({ 'x-hub-signature': `sha1=${sha1hex}` })).toBeNull();
    expect(verify({})).toBeNull();
  });
  it('strips one leading sha256= only, and compares base64 exactly', () => {
    expect(verify({ 'x-signature': `sha256=sha256=${hex}` })).toBeNull();
    expect(verify({ 'x-signature': `v1=${hex}` })).toBeNull();
    expect(b64.toLowerCase()).not.toBe(b64);
    expect(verify({ 'x-signature': b64.toLowerCase() })).toBeNull();
    expect(verify({ 'x-signature': b64.replace(/=+$/, '') })).toBeNull();
  });
  it('compares equal-length bytes only, so wide characters never throw', () => {
    for (const value of ['é'.repeat(64), 'é'.repeat(44), `sha256=${'é'.repeat(64)}`]) expect(verify({ 'x-signature': value })).toBeNull();
  });
  it('never verifies with an empty secret', () => {
    const forged = createHmac('sha256', '').update(body).digest('hex');
    expect(verify({ 'linear-signature': forged }, body, '')).toBeNull();
    const timestamp = String(now.getTime() / 1000);
    const slack = createHmac('sha256', '').update(`v0:${timestamp}:`).update(body).digest('hex');
    expect(verify({ 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${slack}` }, body, '')).toBeNull();
  });
  it('never reads credential or hop-by-hop headers', () => {
    for (const name of notScanned) expect(verify({ [name]: hex }), name).toBeNull();
  });

  it.each(apps)('%s: verifies the full protocol', app => {
    expect(verify(signed(app))).toStrictEqual({ app, timestamp: true });
    expect(verify({ ...signed(app), ...bodySigned })).toStrictEqual({ app, timestamp: true });
    expect(verify(signed(app), body, 'wrong-secret')).toBeNull();
  });
  it.each(apps)('%s: a present header that fails refuses even beside a valid body signature', app => {
    // The body signature alone is accepted, so only the app's own header can refuse these.
    expect(verify(bodySigned)).toStrictEqual(github);
    const valid = signed(app);
    const failing = [signed(app, new Date(now.getTime() - 301_000))];
    for (const [name, value] of Object.entries(valid)) {
      // Present at any length: one character over the 8192 cap.
      failing.push({ ...valid, [name]: value + ' '.repeat(8193 - value.length) });
      // Present alone: Slack's or Zendesk's timestamp or signature without the other.
      if (Object.keys(valid).length > 1) failing.push({ [name]: value });
    }
    for (const headers of failing) expect(verify({ ...headers, ...bodySigned }), Object.keys(headers).join()).toBeNull();
  });
  it.each(apps)('%s: bounds timestamp age', app => {
    const sentAt = (seconds: number) => signed(app, new Date(now.getTime() + seconds * 1000));
    expect(verify(sentAt(-300))).toStrictEqual({ app, timestamp: true });
    expect(verify(sentAt(300))).toStrictEqual({ app, timestamp: true });
    expect(verify(sentAt(-301))).toBeNull();
    expect(verify(sentAt(301))).toBeNull();
    expect(verifyWebhookDelivery(signed(app), body, secret, new Date(NaN))).toBeNull();
  });
  it.each(apps)('%s: a captured signature re-sent as a body-only one is refused', app => {
    // Zendesk's timestamp may carry milliseconds; the guard covers both forms.
    for (const at of app === 'zendesk' ? [now, new Date(now.getTime() + 123)] : [now]) {
      const delivery = signed(app, at);
      expect(verify(delivery)).toStrictEqual({ app, timestamp: true });
      const captured = app === 'stripe' ? delivery['stripe-signature']!.split(',v1=')[1]!
        : app === 'slack' ? delivery['x-slack-signature']!.slice('v0='.length) : delivery['x-zendesk-webhook-signature']!;
      const prefixed = Buffer.concat([signingPrefix(app, at), body]);
      // The body-only comparison alone would accept this replay: the captured digest IS the HMAC of the prefixed body.
      expect(createHmac('sha256', secret).update(prefixed).digest(app === 'zendesk' ? 'base64' : 'hex')).toBe(captured);
      expect(verify({ 'x-hub-signature-256': captured }, prefixed)).toBeNull();
    }
  });
  it('refuses two timestamped apps at once', () => {
    for (const [first, second] of [['stripe', 'slack'], ['stripe', 'zendesk'], ['slack', 'zendesk']] as const) {
      expect(verify({ ...signed(first), ...signed(second) }), `${first}+${second}`).toBeNull();
    }
  });
  it('refuses a doubled signature header', () => {
    // Node joins a repeated header's values with ", ".
    expect(verify({ 'linear-signature': `${hex}, ${hex}` })).toBeNull();
    expect(verify({ 'x-hub-signature-256': `sha256=${hex}, sha256=${hex}` })).toBeNull();
  });
  it('bounds the header scan', () => {
    expect(verify({ ...junk(10_000), 'linear-signature': hex })).toBeNull();
    expect(verify({ 'linear-signature': hex, ...junk(10_000) })).toStrictEqual(linear);
    expect(verify({ 'x-junk': 'a'.repeat(9000) })).toBeNull();
    expect(verify({ 'x-junk': 'a'.repeat(9000), 'linear-signature': hex })).toStrictEqual(linear);
    // Every visited entry counts, skipped ones included: names never read,
    // values that aren't strings, and values over the 8192-character cap.
    const skipped: Record<string, unknown> = {
      ...Object.fromEntries(notScanned.map(name => [name, 'a'.repeat(64)])),
      'x-undefined': undefined, 'x-null': null, 'x-number': 64, 'x-array': [hex], 'x-object': {},
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`x-long-${i}`, 'a'.repeat(9000)])),
    };
    const before = (count: number) => ({ ...skipped, ...junk(count - Object.keys(skipped).length) }) as Record<string, string>;
    expect(Object.keys(before(99))).toHaveLength(99);
    expect(verify({ ...before(99), 'linear-signature': hex })).toStrictEqual(linear);
    expect(verify({ ...before(100), 'linear-signature': hex })).toBeNull();
  });
  it('reads only own header properties', () => {
    expect(verify(Object.create({ 'linear-signature': hex }) as Record<string, string>)).toBeNull();
    for (const app of apps) {
      expect(verify(Object.create(signed(app)) as Record<string, string>), app).toBeNull();
      // Inherited headers neither verify nor trigger detection.
      for (const [name, value] of Object.entries(signed(app))) {
        const headers = Object.create({ [name]: value }) as Record<string, string>;
        headers['linear-signature'] = hex;
        expect(verify(headers), name).toStrictEqual(linear);
      }
    }
  });
  it.each(['constructor', '__proto__'])('an own %s header is a signed app, never a prototype value', name => {
    const headers = Object.create(null) as Record<string, string>;
    headers[name] = hex;
    expect(verify(headers)).toStrictEqual(other);
  });
});
