import { randomUUID } from 'node:crypto';
import { ApiException } from '@kubernetes/client-node';
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
  it('keeps the description to one line of at most 1024 characters', () => {
    const text = describeFailure(new Error(`first\nsecond\r\n${'x'.repeat(5000)}`), {});
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text).toContain('first second');
  });
  // NEL (U+0085) and the Unicode line and paragraph separators end a line in some log
  // viewers; the other C1 controls (U+0080–U+009F) are terminal escapes, like C0's.
  it('strips C1 controls and the Unicode line and paragraph separators too', () => {
    const text = describeFailure(new Error('a\u0080b\u0085c\u009bd\u009fe\u2028f\u2029g'), {});
    expect(text).toBe('Error: a b c d e f g');
  });
});

// @kubernetes/client-node's ApiException puts the whole response in its message:
// "HTTP-Code: …\nMessage: …\nBody: <JSON>\nHeaders: <JSON>". An apiserver's headers
// carry a per-request audit-id and date, so the same failure never read the same twice.
describe('describeFailure on a Kubernetes API error', () => {
  const forbidden = 'pods "standby" is forbidden: User "system:serviceaccount:ax:storage" cannot get resource "pods" in the namespace "ax"';
  const status = { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: forbidden, reason: 'Forbidden', code: 403 };
  /** The headers an apiserver answers with: new on every request. */
  const headers = () => ({ 'audit-id': randomUUID(), date: new Date().toUTCString(), 'content-type': 'application/json' });

  // The generated API classes pass the response text; the log and metrics helpers pass the parsed Status.
  it.each<[string, unknown]>([['the response text', `${JSON.stringify(status)}\n`], ['a parsed object', status]])(
    'describes a Status body (%s) as its HTTP code and message, the same on every request', (_shape, body) => {
      const describeOne = () => describeFailure(new ApiException(403, 'Unknown API Status Code!', body, headers()), {});
      const first = describeOne();
      expect(first).toBe(`HTTP 403: ${forbidden}`);
      expect(describeOne()).toBe(first);
    });
  it.each<[string, number, string, unknown, string]>([
    ['an HTML page from a proxy', 502, 'Unknown API Status Code!', '<html><body>502 Bad Gateway</body></html>',
      '502: HTTP-Code: 502 Message: Unknown API Status Code! Body: "<html><body>502 Bad Gateway</body></html>"'],
    ['no body, as a 401 has', 401, 'Unauthorized', undefined, '401: HTTP-Code: 401 Message: Unauthorized Body: undefined'],
  ])('keeps a body that is not a Status (%s) but drops the headers', (_shape, code, message, body, expected) => {
    const describeOne = () => describeFailure(new ApiException(code, message, body, headers()), {});
    expect(describeOne()).toBe(expected);
    expect(describeOne()).toBe(expected);
  });
  it('still redacts the Status message, keeps it to one line and caps it', () => {
    const body = JSON.stringify({ ...status, message: `webhook denied tok42\nsee ${'x'.repeat(5000)}` });
    const text = describeFailure(new ApiException(403, 'Unknown API Status Code!', body, headers()), { AX_AUTH_TOKEN: 'tok42' });
    expect(text.startsWith('HTTP 403: webhook denied [redacted] see x')).toBe(true);
    expect(text).toHaveLength(1024);
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
