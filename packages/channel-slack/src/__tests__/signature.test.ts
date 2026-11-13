import { createHmac, timingSafeEqual } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNATURE_HEADER_MAX } from '../limits.js';
import { verifySlackSignature } from '../signature.js';

// The real implementation, watched: the comparison must be constant-time, and
// a `===` would pass every functional test here.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

/** Slack's published example (docs.slack.dev, "Verifying requests from Slack"). */
const VECTOR = {
  secret: '8f742231b10e8888abcd99yyyzzz85a5',
  timestamp: '1531420618',
  nowMs: 1531420618000,
  signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
  body: Buffer.from(
    'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c',
  ),
};

const SECRET = 'test-signing-secret-not-real-01';
const NOW_MS = Date.parse('2026-11-13T12:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const BODY = Buffer.from(
  '{"token":"Jhj5dZrVaK7ZwHHjRyZWjbDl","team_id":"T07ABCDEF12","type":"event_callback","event_id":"Ev07ABCDEF12"}',
);

/** Our own signer, written out apart from the code under test. */
function sign(o: { ts?: string; secret?: string; body?: Buffer } = {}): Record<string, string> {
  const ts = o.ts ?? String(NOW_S);
  const digest = createHmac('sha256', o.secret ?? SECRET)
    .update(`v0:${ts}:`)
    .update(o.body ?? BODY)
    .digest('hex');
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${digest}` };
}

function verify(
  headers: Record<string, string>,
  o: { body?: Buffer; secret?: string; nowMs?: number } = {},
): boolean {
  return verifySlackSignature({
    headers,
    body: o.body ?? BODY,
    signingSecret: o.secret ?? SECRET,
    nowMs: o.nowMs ?? NOW_MS,
  });
}

describe('verifySlackSignature', () => {
  // A block body: a function returned from beforeEach is run as its teardown,
  // and mockClear() returns the mock itself.
  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockClear();
  });

  it("matches Slack's published vector", () => {
    expect(
      verifySlackSignature({
        headers: {
          'x-slack-request-timestamp': VECTOR.timestamp,
          'x-slack-signature': VECTOR.signature,
        },
        body: VECTOR.body,
        signingSecret: VECTOR.secret,
        nowMs: VECTOR.nowMs,
      }),
    ).toBe(true);
  });

  it('accepts up to 300 s of skew either way and refuses past it', () => {
    const headers = sign();
    for (const skewMs of [0, 1, 299_999, 300_000]) {
      expect(verify(headers, { nowMs: NOW_MS + skewMs }), `+${skewMs}`).toBe(true);
      expect(verify(headers, { nowMs: NOW_MS - skewMs }), `-${skewMs}`).toBe(true);
    }
    // A stale delivery (we are ahead) and a future-dated one (we are behind).
    for (const skewMs of [300_001, 301_000, 86_400_000]) {
      expect(verify(headers, { nowMs: NOW_MS + skewMs }), `+${skewMs}`).toBe(false);
      expect(verify(headers, { nowMs: NOW_MS - skewMs }), `-${skewMs}`).toBe(false);
    }
  });

  it('refuses a timestamp that is not 1 to 12 plain digits, even when it is signed', () => {
    // Every one of these is NOW to Number(), so only the digit rule refuses it.
    const now = String(NOW_S);
    const spellings = [
      `${NOW_S / 1000}e3`,
      ` ${now}`,
      `${now} `,
      `${now}.0`,
      `+${now}`,
      `0x${NOW_S.toString(16)}`,
      `000${now}`,
    ];
    for (const ts of spellings) {
      expect(Number(ts), ts).toBe(NOW_S);
      expect(verify(sign({ ts })), JSON.stringify(ts)).toBe(false);
    }
    for (const ts of ['1e9', `-${now}`, '', 'NaN', 'Infinity']) {
      expect(verify(sign({ ts })), JSON.stringify(ts)).toBe(false);
    }
    // Twelve digits with leading zeros is still plain digits.
    expect(verify(sign({ ts: `00${now}` }))).toBe(true);
  });

  it('refuses an empty signing secret, which anyone can sign with', () => {
    expect(verify(sign({ secret: '' }), { secret: '' })).toBe(false);
  });

  it('refuses a header over the cap without reading it', () => {
    const headers = sign();
    const padded = headers['x-slack-signature']!.padEnd(SIGNATURE_HEADER_MAX + 1, '0');
    expect(verify({ ...headers, 'x-slack-signature': padded })).toBe(false);
    const ts = '0'.repeat(SIGNATURE_HEADER_MAX + 1);
    expect(verify({ ...sign(), 'x-slack-request-timestamp': ts })).toBe(false);
  });

  it('refuses a flipped byte in the body or the signature', () => {
    const flipped = Buffer.from(BODY);
    flipped[10] = flipped[10]! ^ 0x01;
    expect(verify(sign(), { body: flipped })).toBe(false);

    const headers = sign();
    const sig = headers['x-slack-signature']!;
    const last = sig.at(-1) === '0' ? '1' : '0';
    expect(verify({ ...headers, 'x-slack-signature': sig.slice(0, -1) + last })).toBe(false);
  });

  it('signs the raw bytes, not their text', () => {
    // Two bodies that decode to the same replacement character.
    const original = Buffer.from([0x7b, 0xff, 0x7d]);
    const changed = Buffer.from([0x7b, 0xfe, 0x7d]);
    expect(original.toString()).toBe(changed.toString());
    const headers = sign({ body: original });
    expect(verify(headers, { body: original })).toBe(true);
    expect(verify(headers, { body: changed })).toBe(false);
  });

  it('refuses a missing header, an inherited one, another version and another secret', () => {
    const headers = sign();
    expect(verify({ 'x-slack-signature': headers['x-slack-signature']! })).toBe(false);
    expect(verify({ 'x-slack-request-timestamp': headers['x-slack-request-timestamp']! })).toBe(false);
    expect(verify({})).toBe(false);
    // Present only on the prototype: never an own header.
    expect(verify(Object.create(headers) as Record<string, string>)).toBe(false);
    expect(verify({ ...headers, 'x-slack-signature': headers['x-slack-signature']!.replace('v0=', 'v1=') })).toBe(false);
    expect(verify({ ...headers, 'x-slack-signature': headers['x-slack-signature']!.toUpperCase() })).toBe(false);
    expect(verify(headers, { secret: 'test-signing-secret-not-real-02' })).toBe(false);
  });

  it('refuses when our own clock is not a number', () => {
    expect(verify(sign(), { nowMs: Number.NaN })).toBe(false);
    expect(verify(sign(), { nowMs: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('compares the signature in constant time', () => {
    expect(verify(sign())).toBe(true);
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(1);

    const headers = sign();
    const sig = headers['x-slack-signature']!;
    vi.mocked(timingSafeEqual).mockClear();
    expect(verify({ ...headers, 'x-slack-signature': `${sig.slice(0, -1)}${sig.at(-1) === 'a' ? 'b' : 'a'}` })).toBe(false);
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(1);
  });
});
