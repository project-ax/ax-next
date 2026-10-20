import { describe, expect, it } from 'vitest';
import { describeFailure, redactedError } from '../storage-node/describe-failure.js';

describe('describeFailure redaction', () => {
  it('redacts a secret-named value at any non-empty length', () => {
    const text = describeFailure(new Error('rejected token abcde for session'), { AX_AUTH_TOKEN: 'abcde' });
    expect(text).not.toContain('abcde');
    expect(text).toContain('[redacted]');
  });
  it.each(['AX_PROXY_TOKEN', 'DB_SECRET', 'API_KEY', 'X_AUTH', 'PASSWORD', 'AWS_CREDS', 'SESSION_COOKIE', 'my_api_key'])(
    'treats %s as a secret name', (name) => {
      expect(describeFailure(new Error('saw xyz'), { [name]: 'xyz' })).not.toContain('xyz');
    });
  // Short NON-secret values (session ids, small ports) stay: they are what an
  // operator correlates a failure by, and redacting every short token would
  // shred ordinary words out of the message.
  it('leaves a short non-secret value readable', () => {
    const text = describeFailure(new Error('session sess1 failed'), { AX_SESSION_ID: 'sess1' });
    expect(text).toContain('sess1');
  });
  it('still redacts every long value whatever its name', () => {
    const endpoint = 'http://proxy.internal:8888';
    const text = describeFailure(new Error(`connect ${endpoint} refused`), { AX_PROXY_ENDPOINT: endpoint });
    expect(text).not.toContain(endpoint);
  });
  it('redacts longer values first, so a short secret inside a long one leaves no fragment', () => {
    // The short token is a substring of the long value: replacing it first
    // would split the long value and leave its remainder in the log.
    const env = { AX_AUTH_TOKEN: 'abc', AX_RUNNER_ENDPOINT: 'http://abc.example:80' };
    const text = describeFailure(new Error('failed http://abc.example:80 with abc'), env);
    expect(text).not.toContain('example');
    expect(text).not.toContain('abc');
  });
  it('ignores empty values', () => {
    expect(describeFailure(new Error('plain message'), { AX_AUTH_TOKEN: '' })).toContain('plain message');
  });
  it('keeps a report to one line of at most 1024 characters', () => {
    const text = describeFailure(new Error(`first\nsecond\r\n${'x'.repeat(5000)}`), {});
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text).toContain('first second');
  });
});

describe('redactedError', () => {
  it('is a fresh Error carrying the redacted message, name and code — never the original', () => {
    const original = Object.assign(new Error('mount failed for secret-token'), { code: 'EACCES' });
    const red = redactedError(original, { AX_AUTH_TOKEN: 'secret-token' });
    expect(red).not.toBe(original);
    expect(red.message).not.toContain('secret-token');
    expect(red.message).toContain('mount failed');
    expect((red as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(red.cause).toBeUndefined();
  });
});
