import { describe, it, expect } from 'vitest';
import { findCanaryHit, transformBasicAuthHead, RequestFramer, type Replacer } from '../request-framer.js';

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

const PH2 = 'ax-cred:' + 'b'.repeat(32);
const REAL2 = 'glpat-SECOND';

function basicHead(method: string, path: string, ...extra: string[]): string {
  const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
  return [`${method} ${path} HTTP/1.1`, 'Host: gitlab.com', `Authorization: Basic ${b64}`, ...extra, '', ''].join('\r\n');
}

function decodeAuth(wire: string): string {
  const m = wire.match(/Authorization: Basic (\S+)/)!;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

describe('RequestFramer', () => {
  const replacer = makeReplacer({ [PH]: REAL, [PH2]: REAL2 });

  it('transforms a single bodyless GET head', () => {
    const f = new RequestFramer(replacer, []);
    const { out } = f.process(Buffer.from(basicHead('GET', '/info/refs?service=git-upload-pack'), 'latin1'));
    expect(decodeAuth(out.toString('latin1'))).toBe(`oauth2:${REAL}`);
  });

  it('transforms BOTH heads on a keep-alive connection (GET then POST)', () => {
    const f = new RequestFramer(replacer, []);
    const get = basicHead('GET', '/info/refs?service=git-upload-pack'); // no body -> re-arm
    const body = '0011want abcd\n0000';
    const post = basicHead('POST', '/git-upload-pack', `Content-Length: ${Buffer.byteLength(body)}`) + body;
    const { out } = f.process(Buffer.from(get + post, 'latin1'));
    const wire = out.toString('latin1');
    const auths = [...wire.matchAll(/Authorization: Basic (\S+)/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
    expect(auths).toEqual([`oauth2:${REAL}`, `oauth2:${REAL}`]); // both transformed
    expect(wire).toContain(body); // body forwarded verbatim
  });

  it('substitutes a placeholder split across two chunks (latent-bug regression)', () => {
    const f = new RequestFramer(replacer, []);
    const full = basicHead('GET', '/');
    const split = Math.floor(full.length / 2);
    const r1 = f.process(Buffer.from(full.slice(0, split), 'latin1'));
    expect(r1.out.length).toBe(0); // held until end-of-head
    const r2 = f.process(Buffer.from(full.slice(split), 'latin1'));
    expect(decodeAuth(r2.out.toString('latin1'))).toBe(`oauth2:${REAL}`);
  });

  it('streams a chunked body verbatim and does not re-arm', () => {
    const f = new RequestFramer(replacer, []);
    const post = basicHead('POST', '/git-upload-pack', 'Transfer-Encoding: chunked');
    const chunkedBody = `5\r\nhello\r\n0\r\n\r\n`;
    const { out } = f.process(Buffer.from(post + chunkedBody, 'latin1'));
    const wire = out.toString('latin1');
    expect(decodeAuth(wire)).toBe(`oauth2:${REAL}`); // head transformed
    expect(wire).toContain(chunkedBody); // body verbatim
  });

  it('passes an oversized head through verbatim and fires onOversizedHead', () => {
    let oversized = false;
    const f = new RequestFramer(replacer, [], { maxHeadBytes: 64, onOversizedHead: () => { oversized = true; } });
    const big = 'GET / HTTP/1.1\r\nX-Pad: ' + 'z'.repeat(200); // no end-of-head within 64 bytes
    const { out } = f.process(Buffer.from(big, 'latin1'));
    expect(oversized).toBe(true);
    expect(out.toString('latin1')).toContain('z'.repeat(50)); // flushed verbatim
  });

  it('runs verbatim substitution on body bytes (Bearer-in-body keeps working)', () => {
    const f = new RequestFramer(replacer, []);
    const body = `{"token":"${PH2}"}`;
    const post = `POST /api HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const { out } = f.process(Buffer.from(post, 'latin1'));
    expect(out.toString('latin1')).toContain(`"token":"${REAL2}"`);
  });

  it('flags a canary in a Basic blob and stops at the head', () => {
    const f = new RequestFramer(replacer, ['CANARY-9']);
    const b64 = Buffer.from('oauth2:CANARY-9').toString('base64');
    const h = `GET / HTTP/1.1\r\nAuthorization: Basic ${b64}\r\n\r\n`;
    const { canaryToken } = f.process(Buffer.from(h, 'latin1'));
    expect(canaryToken).toBe('CANARY-9');
  });

  it('runs verbatim substitution on a placeholder carried in the head (Bearer-in-head keeps working)', () => {
    // Regression: the head must still get verbatim placeholder substitution for
    // non-Basic headers (the pre-framer code ran replaceAllBuffer over the whole
    // chunk). A Bearer token in the head must reach the upstream as the real value.
    const f = new RequestFramer(replacer, []);
    const h = `GET / HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${PH}\r\n\r\n`;
    const { out } = f.process(Buffer.from(h, 'latin1'));
    expect(out.toString('latin1')).toContain(`Bearer ${REAL}`);
    expect(out.toString('latin1')).not.toContain('ax-cred:');
  });
});
