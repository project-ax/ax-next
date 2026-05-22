import { describe, it, expect } from 'vitest';
import { findCanaryHit, transformBasicAuthHead, type Replacer } from '../request-framer.js';

// A Replacer that maps a placeholder to a real secret, mirroring SharedCredentialRegistry.
function makeReplacer(map: Record<string, string>): Replacer {
  const replaceAll = (s: string) => {
    let out = s;
    for (const [ph, real] of Object.entries(map)) out = out.split(ph).join(real);
    return out;
  };
  return { replaceAll, replaceAllBuffer: (b) => Buffer.from(replaceAll(b.toString('latin1')), 'latin1') };
}

const PH = 'ax-cred:' + 'a'.repeat(32);
const REAL = 'glpat-REALSECRETVALUE';

function head(...lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
}

describe('findCanaryHit', () => {
  it('returns the matching token', () => {
    expect(findCanaryHit('hello CANARY-123 world', ['CANARY-123'])).toBe('CANARY-123');
  });
  it('returns null when no token matches or token list empty', () => {
    expect(findCanaryHit('nothing here', ['CANARY-123'])).toBeNull();
    expect(findCanaryHit('anything', [])).toBeNull();
  });
  it('scans buffers too', () => {
    expect(findCanaryHit(Buffer.from('x CANARY y'), ['CANARY'])).toBe('CANARY');
  });
});

describe('transformBasicAuthHead', () => {
  it('substitutes a placeholder in the password position', () => {
    const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
    const h = head('GET /info/refs HTTP/1.1', 'Host: gitlab.com', `Authorization: Basic ${b64}`);
    const { head: out, canaryToken } = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []);
    expect(canaryToken).toBeNull();
    const m = out.toString('latin1').match(/Authorization: Basic (\S+)/)!;
    expect(Buffer.from(m[1], 'base64').toString('utf8')).toBe(`oauth2:${REAL}`);
  });
  it('substitutes a placeholder in the username position', () => {
    const b64 = Buffer.from(`${PH}:`).toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`);
    const { head: out } = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []);
    const m = out.toString('latin1').match(/Authorization: Basic (\S+)/)!;
    expect(Buffer.from(m[1], 'base64').toString('utf8')).toBe(`${REAL}:`);
  });
  it('handles Proxy-Authorization and is case-insensitive on scheme', () => {
    const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
    const h = head('GET / HTTP/1.1', `proxy-authorization: basic ${b64}`);
    const { head: out } = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []);
    const wire = out.toString('latin1');
    expect(wire).toMatch(/proxy-authorization: basic /);
    const m = wire.match(/basic (\S+)/)!;
    expect(Buffer.from(m[1], 'base64').toString('utf8')).toBe(`oauth2:${REAL}`);
  });
  it('transforms multiple auth headers in one head', () => {
    const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`, `Proxy-Authorization: Basic ${b64}`);
    const out = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []).head.toString('latin1');
    const realB64 = Buffer.from(`oauth2:${REAL}`).toString('base64');
    expect((out.match(new RegExp(realB64, 'g')) ?? []).length).toBe(2);
  });
  it('leaves Bearer untouched (verbatim path handles Bearer; this fn must not corrupt it)', () => {
    const h = head('GET / HTTP/1.1', `Authorization: Bearer ${PH}`);
    const out = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []).head.toString('latin1');
    expect(out).toContain(`Bearer ${PH}`);
  });
  it('returns the original head unchanged when no placeholder present', () => {
    const b64 = Buffer.from('oauth2:not-a-placeholder').toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`);
    const { head: out } = transformBasicAuthHead(h, makeReplacer({ [PH]: REAL }), []);
    expect(out.equals(h)).toBe(true);
  });
  it('flags a canary token hidden inside a Basic blob', () => {
    const b64 = Buffer.from('oauth2:CANARY-XYZ').toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`);
    const { canaryToken } = transformBasicAuthHead(h, makeReplacer({}), ['CANARY-XYZ']);
    expect(canaryToken).toBe('CANARY-XYZ');
  });
  it('cannot inject CRLF: a replaced value that contains CRLF is re-base64-encoded (no raw CR/LF on the wire)', () => {
    const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
    const h = head('GET / HTTP/1.1', `Authorization: Basic ${b64}`);
    const out = transformBasicAuthHead(h, makeReplacer({ [PH]: 'a\r\nInjected: 1' }), []).head.toString('latin1');
    const authLine = out.split('\r\n').find((l) => /^Authorization:/i.test(l))!;
    expect(authLine).not.toContain('Injected');
  });
});
