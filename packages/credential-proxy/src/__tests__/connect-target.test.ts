/**
 * TASK-874 — the CONNECT target grammar, as a pure function.
 *
 * RFC 9110 §9.3.6: a CONNECT request-target is authority-form, `host:port`,
 * and the client MUST send the port. `host` is a registered name, an IPv4
 * literal, or a bracketed IPv6 literal. Anything else is refused at the parse
 * (the listener answers it with its audited 400). The listener-level proof that
 * the refusal happens before DNS/dial on both CONNECT paths lives in
 * `listener-connect-port-validation.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { parseConnectTarget } from '../connect-target.js';

const VALID: Array<[string, string, { hostname: string; port: number }]> = [
  ['a hostname', 'api.anthropic.com:443', { hostname: 'api.anthropic.com', port: 443 }],
  ['a single-label host', 'localhost:8080', { hostname: 'localhost', port: 8080 }],
  ['a hyphenated label', 'my-host.example.com:1', { hostname: 'my-host.example.com', port: 1 }],
  ['an underscore label', '_srv.example.com:443', { hostname: '_srv.example.com', port: 443 }],
  ['a digit-leading label', '1password.com:443', { hostname: '1password.com', port: 443 }],
  ['an IPv4 literal', '93.184.216.34:443', { hostname: '93.184.216.34', port: 443 }],
  ['a private IPv4 literal (refused LATER, by the SSRF check)', '127.0.0.1:443', { hostname: '127.0.0.1', port: 443 }],
  ['the top port', 'example.com:65535', { hostname: 'example.com', port: 65535 }],
  ['a bracketed IPv6 loopback', '[::1]:443', { hostname: '::1', port: 443 }],
  ['a bracketed full IPv6', '[2001:db8::1]:8443', { hostname: '2001:db8::1', port: 8443 }],
  // Canonicalized (WHATWG URL host serialization) so the allowlist and the
  // private-IP check see the same spelling the HTTP forward path gives them.
  ['an uncompressed IPv6 (canonicalized)', '[0:0:0:0:0:0:0:1]:443', { hostname: '::1', port: 443 }],
  ['an upper-case IPv6 (canonicalized)', '[2001:DB8::A]:443', { hostname: '2001:db8::a', port: 443 }],
];

const INVALID: Array<[string, string]> = [
  // extra colons
  ['a trailing extra segment', 'api.anthropic.com:443:x'],
  ['two ports', 'api.anthropic.com:443:443'],
  ['an empty extra segment', 'api.anthropic.com:443:'],
  ['bracketed v6 with an extra segment', '[::1]:443:x'],
  // unbracketed v6
  ['an unbracketed IPv6 with a port', '::1:443'],
  ['an unbracketed full IPv6 with a port', '2001:db8::1:443'],
  ['an unbracketed IPv6 alone', '2001:db8::1'],
  // empty host
  ['an empty host', ':443'],
  ['empty brackets', '[]:443'],
  ['an empty target', ''],
  // missing port (RFC 9110 requires it)
  ['no port at all', 'api.anthropic.com'],
  ['an empty port', 'api.anthropic.com:'],
  ['a bracketed IPv6 with no port', '[::1]'],
  ['a bracketed IPv6 with an empty port', '[::1]:'],
  // the port rule is unchanged (TASK-862)
  ['port 0', 'api.anthropic.com:0'],
  ['port 65536', 'api.anthropic.com:65536'],
  ['a non-numeric port', 'api.anthropic.com:https'],
  ['a signed port', 'api.anthropic.com:+443'],
  // brackets that are not an IPv6 literal
  ['a bracketed hostname', '[example.com]:443'],
  ['a bracketed IPv4', '[127.0.0.1]:443'],
  ['an IPv6 zone id', '[fe80::1%eth0]:443'],
  ['an encoded zone id', '[fe80::1%25eth0]:443'],
  ['an IPvFuture literal', '[v1.fe80::1]:443'],
  ['an unclosed bracket', '[::1:443'],
  ['a stray closing bracket', '::1]:443'],
  ['junk between bracket and colon', '[::1]x:443'],
  // reg-name junk
  ['userinfo', 'user@api.anthropic.com:443'],
  ['a path', 'api.anthropic.com/x:443'],
  ['a space', 'api anthropic.com:443'],
  ['a leading space', ' api.anthropic.com:443'],
  ['a percent-encoding', 'api%2eanthropic.com:443'],
  ['an empty label', 'api..anthropic.com:443'],
  ['a leading dot', '.api.anthropic.com:443'],
  ['a trailing dot', 'api.anthropic.com.:443'],
  ['a 64-char label', `${'a'.repeat(64)}.com:443`],
  ['a 254-char name', `${'a.'.repeat(126)}ab:443`],
  ['a non-ASCII name', 'exämple.com:443'],
  ['a CR/LF', 'api.anthropic.com\r\n:443'],
  // numeric-looking names must be a real dotted-quad IPv4, never a shorthand
  // that the system resolver would expand (127.1 → 127.0.0.1).
  ['an IPv4 shorthand', '127.1:443'],
  ['an IPv4 with an octet over 255', '256.0.0.1:443'],
  ['a decimal-integer IPv4', '2130706433:443'],
  ['a five-part dotted number', '1.2.3.4.5:443'],
  ['a leading-zero octet', '127.000.0.1:443'],
  ['a hex-integer IPv4', '0x7f000001:443'],
  ['a hex last octet', '127.0.0.0x1:443'],
];

describe('parseConnectTarget', () => {
  for (const [label, target, expected] of VALID) {
    it(`accepts ${label}: ${JSON.stringify(target)}`, () => {
      expect(parseConnectTarget(target)).toEqual(expected);
    });
  }

  for (const [label, target] of INVALID) {
    it(`refuses ${label}: ${JSON.stringify(target)}`, () => {
      expect(parseConnectTarget(target)).toBeUndefined();
    });
  }

  it('accepts a 253-char name built from 63-char labels (the inclusive limits)', () => {
    const label63 = 'a'.repeat(63);
    // 63*3 + 61 + 3 dots = 253
    const name = `${label63}.${label63}.${label63}.${'b'.repeat(61)}`;
    expect(name).toHaveLength(253);
    expect(parseConnectTarget(`${name}:443`)).toEqual({ hostname: name, port: 443 });
  });
});
