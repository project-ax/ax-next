/**
 * TASK-862 — a CONNECT target's port is validated when the request is parsed.
 *
 * Before this, the listener took the port with `parseInt`, which only refused
 * a port with no leading digit. `host:99999` and `host:0` sailed through to the
 * dial, and so did `host:-1` and `host:443abc` (parsed as 443). On the MITM
 * path that is a malformed response stream: the proxy writes
 * `200 Connection Established`, then `tls.connect` throws ERR_SOCKET_BAD_PORT
 * and the catch writes a raw `502 Bad Gateway` onto the same socket. On the
 * bypass path `net.connect` threw the same way and the client got a 502 for
 * what is really a malformed request.
 *
 * Now the port must be 1–5 ASCII digits naming 1–65535, or the client gets a
 * clean 400 (one `invalid_target` audit row) — before any 200, before the
 * allowlist check, before DNS. An injected resolver that counts its calls is
 * the proof that nothing past the parse ran.
 *
 * TASK-874 extends the same parse step to the whole target: strict
 * authority-form `host:port` / `[v6]:port` with the port REQUIRED (RFC 9110
 * §9.3.6). `host:443:x` (which `split(':')` read as `host:443`), unbracketed
 * IPv6 and a port-less target now get the same 400; a bracketed IPv6 literal,
 * which `split(':')` mangled, now parses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import {
  startProxyListener,
  type ProxyListener,
  type ProxyAuditEntry,
  type SessionConfig,
} from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';
import { rawConnect, tokenFor } from './proxy-auth-helpers.js';

/** An allowlisted hostname that only the injected resolver knows. */
const HOST = 'api.port-check.test';

let listener: ProxyListener | undefined;
const clients: net.Socket[] = [];

afterEach(() => {
  listener?.stop();
  listener = undefined;
  for (const c of clients.splice(0)) c.destroy();
});

/**
 * Literal-IP hosts, allowlisted in their UNBRACKETED canonical spelling (the
 * same spelling the HTTP forward path checks). Both are private, so a target
 * that gets past the parse ends in the SSRF block's 403 — deterministic, and
 * with no resolver call (literals skip DNS) and no dial.
 */
const V4_LITERAL = '127.0.0.1';
const V6_LITERAL = '::1';
/** `::ffff:127.0.0.1` in canonical (hex) form — what the parser hands the SSRF check. */
const V6_MAPPED = '::ffff:7f00:1';

function session(mode: 'mitm' | 'bypass'): Map<string, SessionConfig> {
  const hosts = [HOST, V4_LITERAL, V6_LITERAL, V6_MAPPED];
  return new Map([
    [
      's1',
      {
        allowlist: new Set(hosts),
        ...(mode === 'bypass' ? { bypassMITM: new Set(hosts) } : {}),
        sessionId: 's1',
        userId: 'u1',
        proxyToken: tokenFor('s1'),
      },
    ],
  ]);
}

/**
 * Start a listener whose resolver records each lookup and then FAILS it, so a
 * target that gets past the parse ends in a deterministic 502 (DNS failure)
 * without any upstream dial — and one that does not get past it never calls
 * the resolver at all.
 */
async function start(mode: 'mitm' | 'bypass') {
  const audits: ProxyAuditEntry[] = [];
  const lookups: string[] = [];
  listener = await startProxyListener({
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    registry: new SharedCredentialRegistry(),
    // Never reached: every case here ends before a leaf cert is minted.
    ca: { key: 'unused-key', cert: 'unused-cert' },
    sessions: session(mode),
    resolver: async (host) => {
      lookups.push(host);
      throw new Error(`no such host: ${host}`);
    },
    onAudit: (e) => audits.push(e),
  });
  return { audits, lookups, port: listener.port };
}

/** Write one raw CONNECT and collect everything the proxy sends until it closes. */
function connect(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(rawConnect(target, tokenFor('s1')));
    });
    clients.push(sock);
    let acc = '';
    sock.on('data', (c: Buffer) => {
      acc += c.toString('latin1');
    });
    sock.on('end', () => {
      sock.end();
      resolve(acc);
    });
    sock.on('error', reject);
  });
}

/**
 * TASK-875 — the `invalid_target` 400 says what was wrong and what form is
 * expected, instead of arriving as a bare status line the agent can only call
 * "the proxy said no". Pinned verbatim so a change to the wording is a
 * deliberate one. It is FIXED text: the target is untrusted (the agent wrote
 * it), so none of it is echoed back.
 */
const INVALID_TARGET_BODY =
  'Egress was blocked: the CONNECT target was not in a form this proxy accepts. ' +
  'It must be host:port, where host is a hostname, an IPv4 address, or an IPv6 ' +
  'address in [brackets], and port is a number from 1 to 65535 ' +
  '(for example: api.example.com:443).';

/** Split a raw response into its header block (status line included) and body. */
function splitResponse(raw: string): { head: string; body: string } {
  const i = raw.indexOf('\r\n\r\n');
  if (i < 0) return { head: raw, body: '' };
  return { head: raw.slice(0, i), body: raw.slice(i + 4) };
}

/**
 * The actionable 400: right status, framed (Content-Length matches the body's
 * bytes, the connection is closed), and the body is the fixed explanation.
 */
function expectInvalidTargetResponse(response: string): void {
  const { head, body } = splitResponse(response);
  const lines = head.split('\r\n');
  expect(lines[0]).toBe('HTTP/1.1 400 Bad Request');
  expect(lines).toContain('Content-Type: text/plain');
  expect(lines).toContain(`Content-Length: ${Buffer.byteLength(INVALID_TARGET_BODY)}`);
  expect(lines).toContain('Connection: close');
  expect(body).toBe(INVALID_TARGET_BODY);
}

/**
 * TASK-874 — whole targets that are not strict authority-form `host:port`.
 * Each is refused at the same parse step, with the same audited 400, before
 * any lookup. (The full grammar table is in connect-target.test.ts; these are
 * the shapes the old `split(':')` let through or mangled.)
 */
const BAD_TARGETS: Array<[string, string]> = [
  ['an extra colon segment', `${HOST}:443:x`],
  ['two ports', `${HOST}:443:443`],
  ['an unbracketed IPv6', '::1:443'],
  ['an empty host', ':443'],
  ['a missing port (RFC 9110 requires it)', HOST],
  ['a bracketed IPv6 with no port', '[::1]'],
  ['a bracketed IPv6 with an extra segment', '[::1]:443:x'],
  ['an IPv6 zone id', '[fe80::1%eth0]:443'],
  ['userinfo', `user@${HOST}:443`],
  ['an IPv4 shorthand the resolver would expand', '127.1:443'],
];

const BAD_PORTS: Array<[string, string]> = [
  ['zero', '0'],
  ['one past the top', '65536'],
  ['far out of range', '99999'],
  ['non-numeric', 'https'],
  ['trailing garbage after digits', '443abc'],
  ['negative', '-1'],
  ['signed', '+443'],
  ['fractional', '443.5'],
  ['too many digits', '000443'],
  ['empty', ''],
];

for (const mode of ['mitm', 'bypass'] as const) {
  describe(`CONNECT port validation — ${mode} path`, () => {
    const badTargets: Array<[string, string]> = [
      ...BAD_PORTS.map(([label, portStr]): [string, string] => [label, `${HOST}:${portStr}`]),
      ...BAD_TARGETS,
    ];
    for (const [label, target] of badTargets) {
      it(`refuses ${label} (${JSON.stringify(target)}) with a clean 400 before any 200`, async () => {
        const { audits, lookups, port } = await start(mode);

        const response = await connect(port, target);

        // One status line, and it is the 400 — no 200 ahead of it, no 502 after.
        expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
        expect(response).not.toContain('200 Connection Established');
        expect(response.match(/HTTP\/1\.1 /g)).toHaveLength(1);
        // TASK-875: and it explains itself.
        expectInvalidTargetResponse(response);

        // Refused at the parse: the allowlisted host was never even looked up.
        expect(lookups).toEqual([]);

        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 400,
          requestBytes: 0,
          responseBytes: 0,
          blocked: 'invalid_target',
          sessionId: 's1',
          userId: 'u1',
        });
      });
    }

    for (const portStr of ['1', '443', '65535']) {
      it(`lets a valid port (${portStr}) past the parse`, async () => {
        const { audits, lookups, port } = await start(mode);
        const target = `${HOST}:${portStr}`;

        const response = await connect(port, target);

        // Past the parse and the allowlist: the resolver ran, failed, and the
        // proxy answered the DNS failure the way it always has — a 502.
        expect(lookups).toEqual([HOST]);
        expect(response).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
        expect(audits).toHaveLength(1);
        expect(audits[0]!.status).toBe(502);
        expect(audits[0]!.url).toBe(target);
      });
    }

    // TASK-875: the 400 body is fixed text. A target is untrusted (the agent
    // wrote the CONNECT line), so it must not come back in the response — not
    // as markup, not as an encoded header-injection attempt, not at all. Each
    // of these reaches the `invalid_target` refusal (the audit proves it) and
    // none of its text appears anywhere in what the proxy writes. (Node's own
    // HTTP parser already refuses `<`, `>`, `"`, `{`, `\` and friends in the
    // request-target before this handler runs, so markup cannot get here; these
    // are the shapes that DO get here.)
    for (const [label, target, marker] of [
      ['a canary hostname with a bad port', 'reflect-canary-q9z.test:99999', 'reflect-canary-q9z'],
      ['an encoded CRLF header injection', 'x%0d%0aSet-Cookie:pwn=1:443', 'Set-Cookie'],
      ['a shell substitution', '$(id):443', '$(id)'],
      ['a quote and a userinfo', `q'@${HOST}:443`, "q'@"],
    ] as const) {
      it(`does not reflect ${label} into the 400`, async () => {
        const { audits, lookups, port } = await start(mode);

        const response = await connect(port, target);

        expectInvalidTargetResponse(response);
        expect(response).not.toContain(marker);
        expect(response).not.toContain(target);
        expect(lookups).toEqual([]);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ url: target, status: 400, blocked: 'invalid_target' });
      });
    }

    it('an unauthenticated CONNECT with a bad port still gets 407, not 400', async () => {
      // Auth runs before the target is parsed, so a bad port is no oracle for an
      // unauthenticated prober.
      const { audits, lookups, port } = await start(mode);

      const response = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(rawConnect(`${HOST}:99999`));
        });
        clients.push(sock);
        let acc = '';
        sock.on('data', (c: Buffer) => {
          acc += c.toString('latin1');
        });
        sock.on('end', () => {
          sock.end();
          resolve(acc);
        });
        sock.on('error', reject);
      });

      expect(response).toMatch(/^HTTP\/1\.1 407 /);
      expect(lookups).toEqual([]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ status: 407, blocked: 'proxy_auth_required' });
    });

    // TASK-874: bracketed IPv6 used to be mangled by `split(':')` into the host
    // `[` — refused as a 400 that told nobody why. Now the literal parses, is
    // matched against the allowlist unbracketed, and reaches the SSRF check,
    // which blocks loopback with a 403. Proof the parse let it through.
    for (const [label, target, host] of [
      ['a bracketed IPv6 literal', '[::1]:443', V6_LITERAL],
      ['an uncompressed bracketed IPv6 (canonicalized)', '[0:0:0:0:0:0:0:1]:443', V6_LITERAL],
      ['an IPv4-mapped IPv6 (canonical hex form still blocked)', '[::ffff:127.0.0.1]:443', V6_MAPPED],
      ['an IPv4 literal', '127.0.0.1:443', V4_LITERAL],
    ] as const) {
      it(`lets ${label} (${target}) past the parse to the SSRF check`, async () => {
        const { audits, lookups, port } = await start(mode);

        const response = await connect(port, target);

        // A literal skips DNS, so the resolver never runs — the 403 is the
        // private-IP block on the canonical, unbracketed host.
        expect(lookups).toEqual([]);
        expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
        expect(response).not.toContain('200 Connection Established');
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ url: target, status: 403 });
        expect(audits[0]!.blocked).toMatch(/^Blocked: /);
        expect(audits[0]!.blocked).toContain(host);
      });
    }
  });
}
