import { describe, expect, it } from 'vitest';
import { STDERR_REDACTED, STDERR_TAIL_MAX, createStderrTail } from '../stderr-tail.js';

const PROXY_TOKEN = '0123456789abcdef0123456789abcdef';
const AUTH_TOKEN = 'auth-' + 'z'.repeat(59);

describe('createStderrTail (TASK-784)', () => {
  it('returns short stderr verbatim', () => {
    const t = createStderrTail([PROXY_TOKEN]);
    t.append('runner: invalid env: AX_PROXY_TOKEN (expected 32 lowercase hex characters)\n');
    expect(t.text()).toBe(
      'runner: invalid env: AX_PROXY_TOKEN (expected 32 lowercase hex characters)\n',
    );
  });

  it('returns an empty string when nothing was written', () => {
    expect(createStderrTail([]).text()).toBe('');
  });

  it('redacts host-minted secrets, including one split across chunks', () => {
    const t = createStderrTail([PROXY_TOKEN, AUTH_TOKEN]);
    t.append(`AX_PROXY_TOKEN=${PROXY_TOKEN.slice(0, 10)}`);
    t.append(`${PROXY_TOKEN.slice(10)}\nAX_AUTH_TOKEN=${AUTH_TOKEN}\n`);
    const out = t.text();
    expect(out).not.toContain(PROXY_TOKEN);
    expect(out).not.toContain(AUTH_TOKEN);
    expect(out).toBe(
      `AX_PROXY_TOKEN=${STDERR_REDACTED}\nAX_AUTH_TOKEN=${STDERR_REDACTED}\n`,
    );
  });

  it('caps the tail at STDERR_TAIL_MAX and keeps the END of the stream', () => {
    const t = createStderrTail([]);
    for (let i = 0; i < 1000; i++) t.append(`line ${i} ${'x'.repeat(40)}\n`);
    t.append('runner: fatal: the real reason\n');
    const out = t.text();
    expect(out.length).toBeLessThanOrEqual(STDERR_TAIL_MAX);
    expect(out.endsWith('runner: fatal: the real reason\n')).toBe(true);
    expect(out).not.toContain('line 0 ');
  });

  it('never leaks a fragment of a secret that straddles the trim point', () => {
    // max 2000 + slack 1024 → the window keeps the last 3024 units. Put the
    // first secret so the cut lands INSIDE it (its last k units fall inside
    // the window), then follow it with 60 more copies: redacting those shrinks
    // the window by ~1300 units, so a plain "last `max` units" would reach
    // back into the un-matchable fragment at the front. For every k.
    const max = 2000;
    const keep = max + 1024;
    const many = PROXY_TOKEN.repeat(60);
    for (let k = 4; k < PROXY_TOKEN.length; k++) {
      const t = createStderrTail([PROXY_TOKEN], max);
      t.append('a'.repeat(100) + PROXY_TOKEN + many + 'b'.repeat(keep - k - many.length));
      const out = t.text();
      // No run of 4+ chars of the secret survives anywhere in the tail.
      for (let i = 0; i + 4 <= PROXY_TOKEN.length; i++) {
        expect(out).not.toContain(PROXY_TOKEN.slice(i, i + 4));
      }
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  it('does not start the tail on a lone low surrogate', () => {
    const t = createStderrTail([], 3);
    t.append('a😀😀'); // a + 2 astral chars = 5 code units
    const out = t.text();
    const first = out.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(out.length).toBeLessThanOrEqual(3);
  });
});
