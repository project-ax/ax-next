import { describe, it, expect } from 'vitest';
import { findCanaryHit, transformBasicAuthHead, RequestFramer, type Replacer } from '../request-framer.js';

// A Replacer that maps a placeholder to a real secret, mirroring SharedCredentialRegistry —
// including its identity contract: replaceAllBuffer returns the SAME buffer by reference
// when nothing was substituted (the `injected`/`credentialInjected` signal relies on this).
function makeReplacer(map: Record<string, string>): Replacer {
  const replaceAll = (s: string) => {
    let out = s;
    for (const [ph, real] of Object.entries(map)) out = out.split(ph).join(real);
    return out;
  };
  return {
    replaceAll,
    replaceAllBuffer: (b) => {
      const s = b.toString('latin1');
      const r = replaceAll(s);
      return r === s ? b : Buffer.from(r, 'latin1');
    },
  };
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

  it('substitutes placeholders in the head but leaves the body verbatim (header-only)', () => {
    // Substitution is HEADER-ONLY. A placeholder in an auth header is resolved;
    // the same placeholder leaked into the body is left as the inert fake token.
    const f = new RequestFramer(replacer, []);
    const body = `{"token":"${PH2}"}`;
    const post =
      `POST /api HTTP/1.1\r\nHost: x\r\n` +
      `Authorization: Bearer ${PH}\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const { out } = f.process(Buffer.from(post, 'latin1'));
    const wire = out.toString('latin1');
    expect(wire).toContain(`Bearer ${REAL}`); // header placeholder substituted
    expect(wire).toContain(`"token":"${PH2}"`); // body placeholder LEFT VERBATIM
    expect(wire).not.toContain(REAL2); // real secret never written into the body
  });

  it('leaves a body placeholder verbatim so Content-Length stays exact (Anthropic 400 regression)', () => {
    // Regression for the production outage: a credential placeholder that leaked
    // into the request BODY (e.g. the model dumped its env into the transcript)
    // must NOT be substituted there. Substituting `ax-cred:<32hex>` for the real
    // secret would change the body's byte length while the already-forwarded
    // Content-Length stayed put, so the upstream reads the wrong number of body
    // bytes and rejects with "request body is not valid JSON: unexpected end of
    // data". It persists (placeholder stays in the transcript) and the reported
    // column grows (the transcript grows each turn).
    const f = new RequestFramer(replacer, []);
    const body = `{"messages":[{"role":"user","content":"my key is ${PH}"}]}`;
    const declared = Buffer.byteLength(body);
    const post =
      `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n` +
      `Content-Length: ${declared}\r\n\r\n${body}`;
    const { out } = f.process(Buffer.from(post, 'latin1'));
    const wire = out.toString('latin1');
    const actualBody = wire.slice(wire.indexOf('\r\n\r\n') + 4);
    // Body is byte-identical to what the client sent, and Content-Length still
    // describes it exactly — the upstream sees a well-framed request.
    expect(Buffer.byteLength(actualBody, 'latin1')).toBe(declared);
    const m = wire.match(/Content-Length: (\d+)\r\n/i)!;
    expect(Number(m[1])).toBe(Buffer.byteLength(actualBody, 'latin1'));
    expect(wire).not.toContain(REAL); // real secret never written into the body
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

  describe('injected flag (audit accuracy)', () => {
    it('reports injected=true when a Basic placeholder is substituted', () => {
      const f = new RequestFramer(replacer, []);
      const { injected } = f.process(Buffer.from(basicHead('GET', '/'), 'latin1'));
      expect(injected).toBe(true);
    });

    it('reports injected=true when a Bearer placeholder in the head is substituted', () => {
      const f = new RequestFramer(replacer, []);
      const h = `GET / HTTP/1.1\r\nAuthorization: Bearer ${PH}\r\n\r\n`;
      expect(f.process(Buffer.from(h, 'latin1')).injected).toBe(true);
    });

    // TASK-14 (CLI-1 part 2) — RESOLVED, root cause (a). A live decrypted-bytes
    // trace on the kind cluster confirmed the bug was UPSTREAM of this pure
    // function: when the model ran `git clone https://github.com/...`, git had
    // the slot placeholder `GIT_TOKEN=ax-cred:<hex>` in its env but NEVER sent
    // it — git doesn't read slot env vars for auth, and with
    // `GIT_TERMINAL_PROMPT=0` and no credential helper / URL userinfo wired in,
    // it died with `fatal: could not read Username ... terminal prompts
    // disabled` BEFORE opening any connection. There was no `GET /info/refs`
    // egress at all (so `credentialInjected:false` was vacuous), and the
    // placeholder WAS registered in the SharedCredentialRegistry — ruling out
    // (b) and (c). The fix wires a host-scoped git `url.<base>.insteadOf`
    // rewrite carrying the placeholder for each credentialed allowedHost
    // (@ax/sandbox-protocol buildGitCredentialEnv, stamped by both sandbox
    // backends). This test stays as the framer-side guard: it confirms the
    // framer was always correct — a git-shaped `GET /info/refs` whose Basic
    // password is a registered placeholder DOES report injected=true and
    // round-trips to the real value. If it ever fails, the regression is in
    // this file; the upstream wiring is covered by the sandbox-{k8s,subprocess}
    // git-credentials regression tests.
    it('TASK-14: git GET /info/refs with a registered Basic placeholder reports injected=true', () => {
      const f = new RequestFramer(replacer, []);
      const b64 = Buffer.from(`oauth2:${PH}`).toString('base64');
      const wire =
        'GET /myproject.git/info/refs?service=git-upload-pack HTTP/1.1\r\n' +
        'Host: gitlab.com\r\n' +
        'User-Agent: git/2.43.0\r\n' +
        `Authorization: Basic ${b64}\r\n` +
        'Accept: */*\r\n\r\n';
      const { out, injected } = f.process(Buffer.from(wire, 'latin1'));
      expect(injected).toBe(true);
      expect(decodeAuth(out.toString('latin1'))).toBe(`oauth2:${REAL}`);
    });

    it('reports injected=false when a placeholder is only in the body (header-only substitution)', () => {
      // A placeholder in the body is never substituted, so it must not count as
      // an injection — credentialInjected must reflect header substitution only.
      const f = new RequestFramer(replacer, []);
      const body = `{"leaked":"${PH}"}`;
      const post = `POST /api HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      const { injected, out } = f.process(Buffer.from(post, 'latin1'));
      expect(injected).toBe(false);
      expect(out.toString('latin1')).toContain(PH); // body placeholder left verbatim
    });

    it('reports injected=false when no placeholder is present, even though bytes are reframed', () => {
      // The head spans two chunks: the first holds nothing (buffered), the second
      // completes it. Output bytes differ from each input chunk (reframing), but
      // nothing was substituted — injected must stay false (audit must not over-report).
      const f = new RequestFramer(replacer, []);
      const plain = 'GET / HTTP/1.1\r\nHost: x\r\nAuthorization: Basic ' +
        Buffer.from('oauth2:not-a-placeholder').toString('base64') + '\r\n\r\n';
      const mid = Math.floor(plain.length / 2);
      const r1 = f.process(Buffer.from(plain.slice(0, mid), 'latin1'));
      const r2 = f.process(Buffer.from(plain.slice(mid), 'latin1'));
      expect(r1.injected).toBe(false);
      expect(r2.injected).toBe(false);
      expect(r2.out.length).toBeGreaterThan(0); // bytes WERE reframed/emitted
    });
  });
});
