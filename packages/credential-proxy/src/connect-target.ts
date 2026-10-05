/**
 * The CONNECT request-target grammar (TASK-874).
 *
 * The agent writes the CONNECT line, so the target is untrusted input on the
 * egress boundary. RFC 9110 §9.3.6 says it is authority-form — `host:port`,
 * port REQUIRED — and that is all we accept:
 *
 *   target   = host ":" port
 *   host     = reg-name / IPv4 / "[" IPv6 "]"
 *   reg-name = label *("." label)          ; ≤ 253 chars, no trailing dot
 *   label    = 1*63( ALPHA / DIGIT / "-" / "_" )
 *   port     = 1*5DIGIT                     ; 1–65535 (TASK-862)
 *
 * A name whose last label is a number (`127.1`, `2130706433`, `0x7f000001`)
 * must be a dotted-quad IPv4 — never a shorthand the system resolver would
 * expand (the WHATWG URL "ends in a number" rule). Bracketed IPv6 rejects zone
 * ids and IPvFuture, and is returned unbracketed and canonicalized (WHATWG
 * host serialization: compressed, lower-case) — the same spelling the HTTP
 * forward path hands the allowlist and the private-IP check.
 *
 * Everything else (`host:443:x`, unbracketed v6, an empty host, a missing
 * port, userinfo, whitespace, `%`) is `undefined`, and the listener answers
 * it with its audited `400` before the allowlist, DNS, or any dial.
 */
import net from 'node:net';

export interface ConnectTarget {
  /** Unbracketed: `api.example.com`, `93.184.216.34`, or `::1`. */
  hostname: string;
  port: number;
}

const PORT_RE = /^[0-9]{1,5}$/;
const LABEL_RE = /^[A-Za-z0-9_-]{1,63}$/;
const NUMERIC_LABEL_RE = /^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/;
/** Only hex digits, `:` and `.` (embedded IPv4) — no zone id, no IPvFuture. */
const IPV6_CHARS_RE = /^[0-9A-Fa-f:.]+$/;
const MAX_NAME_LENGTH = 253;

function parsePort(portStr: string): number | undefined {
  if (!PORT_RE.test(portStr)) return undefined;
  const port = Number(portStr);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function parseRegNameOrIPv4(host: string): string | undefined {
  if (host.length === 0 || host.length > MAX_NAME_LENGTH) return undefined;
  const labels = host.split('.');
  if (!labels.every((l) => LABEL_RE.test(l))) return undefined;
  if (NUMERIC_LABEL_RE.test(labels[labels.length - 1]!) && !net.isIPv4(host)) {
    return undefined;
  }
  return host;
}

function parseIPv6(inner: string): string | undefined {
  if (!IPV6_CHARS_RE.test(inner) || !net.isIPv6(inner)) return undefined;
  // WHATWG host serialization: `0:0:0:0:0:0:0:1` → `::1`, `DB8` → `db8`.
  return new URL(`http://[${inner}]/`).hostname.slice(1, -1);
}

/** Parse a CONNECT target, or `undefined` if it is not strict `host:port`. */
export function parseConnectTarget(target: string): ConnectTarget | undefined {
  let hostname: string | undefined;
  let rest: string;
  if (target.startsWith('[')) {
    const close = target.indexOf(']');
    if (close === -1) return undefined;
    hostname = parseIPv6(target.slice(1, close));
    rest = target.slice(close + 1);
  } else {
    const colon = target.indexOf(':');
    if (colon === -1) return undefined;
    hostname = parseRegNameOrIPv4(target.slice(0, colon));
    rest = target.slice(colon);
  }
  if (hostname === undefined || !rest.startsWith(':')) return undefined;
  // `rest.slice(1)` must be ONLY digits, so a second `:` (`host:443:x`) fails here.
  const port = parsePort(rest.slice(1));
  return port === undefined ? undefined : { hostname, port };
}
