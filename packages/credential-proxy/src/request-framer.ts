/**
 * Minimal substitution surface. The listener hands the framer a replacer that is
 * already scoped to ONE tunnel (TASK-687): the authenticated session's own
 * placeholders that are bound to that tunnel's destination host
 * (`SharedCredentialRegistry.replacerFor`). The framer never sees a host or a
 * session, so it cannot substitute anything the tunnel is not entitled to.
 */
export interface Replacer {
  replaceAll(input: string): string;
  replaceAllBuffer(input: Buffer): Buffer;
}

/** First canary token present in `data`, or null. Mirrors the listener's existing `includes` scan. */
export function findCanaryHit(data: string | Buffer, tokens: readonly string[]): string | null {
  if (tokens.length === 0) return null;
  const hay = typeof data === 'string' ? data : data.toString('latin1');
  for (const token of tokens) {
    if (token && hay.includes(token)) return token;
  }
  return null;
}

export interface HeadTransform {
  head: Buffer;
  canaryToken: string | null;
}

// Matches `Authorization: Basic <b64>` / `Proxy-Authorization: Basic <b64>` (scheme case-insensitive).
const BASIC_AUTH_LINE_RE = /^((?:proxy-)?authorization):[ \t]*(basic)[ \t]+([A-Za-z0-9+/=]+)[ \t]*$/i;

/**
 * Decode → canary-scan → substitute → re-encode each Basic auth header in an HTTP
 * request head. All other bytes (including Bearer/Digest auth) are preserved 1:1
 * (latin1 round-trip). Re-encoding to base64 cannot emit CR/LF, so a malicious
 * decoded value cannot inject headers. If a canary token appears in any decoded
 * value, returns `{ canaryToken }` and leaves the head unmodified (caller blocks).
 */
export function transformBasicAuthHead(
  head: Buffer,
  replacer: Replacer,
  canaryTokens: readonly string[],
): HeadTransform {
  const lines = head.toString('latin1').split('\r\n');
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(BASIC_AUTH_LINE_RE);
    if (!m) continue;
    const name = m[1]!;
    const scheme = m[2]!;
    const b64 = m[3]!;
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const hit = findCanaryHit(decoded, canaryTokens);
    if (hit) return { head, canaryToken: hit };
    const replaced = replacer.replaceAll(decoded);
    if (replaced !== decoded) {
      lines[i] = `${name}: ${scheme} ${Buffer.from(replaced, 'utf8').toString('base64')}`;
      mutated = true;
    }
  }
  if (!mutated) return { head, canaryToken: null };
  return { head: Buffer.from(lines.join('\r\n'), 'latin1'), canaryToken: null };
}

const DEFAULT_MAX_HEAD = 64 * 1024;

/**
 * What the framer knows about one request head, handed to a metered tunnel's
 * policy BEFORE anything is forwarded or substituted.
 */
export interface RequestHeadInfo {
  /** Request method as written (upper-case letters only). */
  method: string;
  /** Request target as written, e.g. `/v1/messages?beta=true`. */
  target: string;
  /** `HTTP/1.1` is the only version a metered request may use. */
  version: string;
  /** Body length from `Content-Length`, or null when the body is chunked. */
  contentLength: number | null;
}

/** What a metered tunnel decides for one request head (TASK-715). */
export type RequestVerdict =
  /** Splice the credential (it matches an allowed request and the gate admitted it). */
  | { kind: 'splice' }
  /** Not an allowed request: forward it with NO substitution (the placeholder stays inert). */
  | { kind: 'plain' }
  /** Refuse it: nothing is forwarded, the caller answers `status` and closes the tunnel. */
  | { kind: 'deny'; status: number; reason: string; message: string };

/**
 * Per-tunnel policy for a tunnel to a metered host. The framer asks it once per
 * request head; `splice` is the ONLY verdict under which a credential is
 * substituted, so the gate, the endpoint allowlist and the meter cannot be
 * walked around by any request the framer sees.
 */
export interface MeteredRequestPolicy {
  onRequestHead(info: RequestHeadInfo): RequestVerdict;
}

export interface FramerOptions {
  /** Cap on a single buffered request head; exceeding it falls back to verbatim passthrough. */
  maxHeadBytes?: number;
  /** Called once when a head exceeds `maxHeadBytes` (for logging). */
  onOversizedHead?: () => void;
  /**
   * Set only for a tunnel to a metered host. Without it the framer behaves
   * exactly as it always has (substitute every head with the tunnel's replacer).
   */
  metered?: MeteredRequestPolicy;
}

export interface FramerOutput {
  /** Bytes to forward upstream (may be empty while a head is still buffering). */
  out: Buffer;
  /** Non-null if a canary token appeared in a decoded Basic value — caller must block. */
  canaryToken: string | null;
  /**
   * True only if a credential placeholder was actually substituted in this call
   * (Basic-decoded or verbatim). Distinct from "output differs from input" —
   * reframing a buffered multi-chunk head also changes the bytes but injects nothing.
   */
  injected: boolean;
  /**
   * Set when a metered policy refused a request head. `out` then holds only the
   * bytes of requests admitted BEFORE it; the refused request and everything
   * after it are dropped and the framer accepts no more input. The caller must
   * answer the client and close the tunnel.
   */
  denied?: { status: number; reason: string; message: string };
}

type Phase = 'head' | 'body-counted' | 'passthrough' | 'dead';

const NOOP_REPLACER: Replacer = Object.freeze({
  replaceAll: (input: string): string => input,
  replaceAllBuffer: (input: Buffer): Buffer => input,
});

const REQUEST_LINE_RE = /^([A-Z]{1,16}) (\S{1,8192}) (HTTP\/1\.[01])$/;

/**
 * Parse the request line and body framing of a complete request head. Null when
 * the request line is not `METHOD SP target SP HTTP/1.x`: a metered tunnel
 * refuses such a head outright (a real client never sends one, and a head the
 * framer and the upstream might read differently is how request/response
 * pairing gets skewed).
 */
export function parseRequestHead(head: Buffer): RequestHeadInfo | null {
  const text = head.toString('latin1');
  const eol = text.indexOf('\r\n');
  const m = REQUEST_LINE_RE.exec(eol < 0 ? '' : text.slice(0, eol));
  if (m === null) return null;
  const f = parseBodyFraming(head);
  return {
    method: m[1]!,
    target: m[2]!,
    version: m[3]!,
    contentLength: f.chunked ? null : f.contentLength,
  };
}

/**
 * Replace whatever `Accept-Encoding` the client sent with `identity`, so the
 * response comes back readable by the usage meter. A head with an obsolete
 * folded header line is returned untouched: editing around a fold could attach
 * its continuation to the wrong header, and an encoded response is merely
 * charged as unmeasured (never free).
 */
export function forceIdentityEncoding(head: Buffer): Buffer {
  const lines = head.toString('latin1').split('\r\n');
  // A complete head ends `...\r\n\r\n`, so the last two entries are empty.
  if (lines.length < 3 || lines[lines.length - 1] !== '' || lines[lines.length - 2] !== '') return head;
  for (let i = 1; i < lines.length - 2; i++) {
    if (/^[ \t]/.test(lines[i]!)) return head;
  }
  const kept = lines.filter((l, i) => i === 0 || !/^accept-encoding[ \t]*:/i.test(l));
  kept.splice(kept.length - 2, 0, 'Accept-Encoding: identity');
  return Buffer.from(kept.join('\r\n'), 'latin1');
}

function indexOfCrlfCrlf(buf: Buffer): number {
  return buf.indexOf('\r\n\r\n', 0, 'latin1');
}

interface BodyFraming {
  contentLength: number;
  chunked: boolean;
}

function parseBodyFraming(head: Buffer): BodyFraming {
  let contentLength = 0;
  let chunked = false;
  for (const line of head.toString('latin1').split('\r\n')) {
    const c = line.match(/^content-length:[ \t]*(\d+)[ \t]*$/i);
    if (c) contentLength = Number(c[1]!);
    const te = line.match(/^transfer-encoding:[ \t]*(.+?)[ \t]*$/i);
    if (te && /\bchunked\b/i.test(te[1]!)) chunked = true;
  }
  return { contentLength, chunked };
}

/**
 * Frames the decrypted client→upstream byte stream of one MITM connection into
 * HTTP/1.1 requests so each request head can be Basic-auth-transformed.
 *
 * - HEAD phase: buffer until `\r\n\r\n`, transform Basic auth + verbatim
 *   placeholder substitution over the head (headers only), then route by framing.
 * - Content-Length body: forward verbatim, count down, re-arm to HEAD (catches the
 *   next pipelined/keep-alive request — e.g. git's POST after the info/refs GET).
 * - Transfer-Encoding: chunked, or an oversized head: forward verbatim and stay in
 *   passthrough for the rest of the connection (git's chunked POST is terminal).
 *
 * CREDENTIAL SUBSTITUTION IS HEADER-ONLY. Bodies are forwarded byte-for-byte and
 * never run through the replacer. Two reasons, both load-bearing:
 *   1. Framing integrity — substituting a placeholder (`ax-cred:<32hex>`, 40 B)
 *      for a real secret changes the body's byte length, but `Content-Length`
 *      was already forwarded in the head. The upstream then reads the wrong
 *      number of body bytes and rejects the request ("unexpected end of data").
 *   2. Leak containment — every real credential path positions its secret in a
 *      HEADER (Anthropic `x-api-key`, git `Authorization: Basic`, Bash `curl -H`).
 *      A placeholder appearing in a BODY only happens when it leaked into the
 *      conversation transcript (e.g. the model dumped its env). Resolving it
 *      there would write the real secret into outbound message content, where
 *      the destination can store, echo or log it. Leaving bodies verbatim
 *      keeps a leaked placeholder an inert fake token wherever it travels.
 *      (Host binding, TASK-687, is the complementary guard for the HEADER case:
 *      even a deliberately placed header is only resolved for the credential's
 *      own hosts.)
 */
export class RequestFramer {
  private phase: Phase = 'head';
  private headBuf: Buffer = Buffer.alloc(0);
  private bodyRemaining = 0;
  private readonly maxHead: number;

  constructor(
    private readonly replacer: Replacer,
    private readonly canaryTokens: readonly string[],
    private readonly opts: FramerOptions = {},
  ) {
    this.maxHead = opts.maxHeadBytes ?? DEFAULT_MAX_HEAD;
  }

  process(chunk: Buffer): FramerOutput {
    const parts: Buffer[] = [];
    let injected = false;
    // HEAD-ONLY substitution that also tracks whether anything was actually
    // replaced. `replaceAllBuffer` returns the input buffer by identity when no
    // placeholder is present, so `!==` is a precise "a credential was injected"
    // signal — unlike comparing final output to the input chunk (reframing alone
    // changes the bytes without injecting anything). Bodies are NEVER passed
    // through this — see the class docstring (framing integrity + leak
    // containment).
    const subHead = (b: Buffer, replacer: Replacer = this.replacer): Buffer => {
      const r = replacer.replaceAllBuffer(b);
      if (r !== b) injected = true;
      return r;
    };
    const policy = this.opts.metered;
    const refuse = (status: number, reason: string, message: string): FramerOutput => {
      // Nothing from the refused request is forwarded, and nothing after it is
      // read: the caller answers the client and closes the tunnel.
      this.phase = 'dead';
      this.headBuf = Buffer.alloc(0);
      return {
        out: Buffer.concat(parts),
        canaryToken: null,
        injected,
        denied: { status, reason, message },
      };
    };
    let working = chunk;
    for (;;) {
      if (this.phase === 'dead') break;
      if (this.phase === 'passthrough') {
        // Body bytes (chunked / oversized-head tail) forwarded verbatim — no
        // substitution, so chunk-size framing and content stay byte-exact.
        if (working.length) parts.push(working);
        break;
      }
      if (this.phase === 'body-counted') {
        const take = Math.min(working.length, this.bodyRemaining);
        // Verbatim: forward the exact body bytes the client sent so the
        // already-forwarded Content-Length still describes them precisely.
        if (take > 0) parts.push(working.subarray(0, take));
        this.bodyRemaining -= take;
        working = working.subarray(take);
        if (this.bodyRemaining > 0) break; // need more body bytes
        this.phase = 'head';
        if (working.length === 0) break;
        continue;
      }
      // phase === 'head'
      this.headBuf = this.headBuf.length ? Buffer.concat([this.headBuf, working]) : working;
      working = Buffer.alloc(0);
      const idx = indexOfCrlfCrlf(this.headBuf);
      if (idx < 0) {
        if (this.headBuf.length > this.maxHead) {
          // A metered tunnel never lets an oversized head anywhere near the key.
          if (policy !== undefined) {
            this.opts.onOversizedHead?.();
            return refuse(400, 'malformed-request', 'This request head is too large to forward.');
          }
          // Oversized head = pre-terminator header bytes → header substitution.
          parts.push(subHead(this.headBuf));
          this.headBuf = Buffer.alloc(0);
          this.phase = 'passthrough';
          this.opts.onOversizedHead?.();
        }
        break; // wait for more head bytes
      }
      const headEnd = idx + 4;
      const head = this.headBuf.subarray(0, headEnd);
      const rest = this.headBuf.subarray(headEnd);
      this.headBuf = Buffer.alloc(0);
      // Metered tunnel (TASK-715): the canary scan runs FIRST, so a request that
      // is about to be blocked for a canary never takes a slot from the gate; then
      // the policy decides whether THIS head may carry the credential at all.
      let replacer: Replacer = this.replacer;
      let identity = false;
      if (policy !== undefined) {
        const pre = transformBasicAuthHead(head, NOOP_REPLACER, this.canaryTokens);
        if (pre.canaryToken) return { out: Buffer.concat(parts), canaryToken: pre.canaryToken, injected };
        const info = parseRequestHead(head);
        if (info === null) {
          return refuse(400, 'malformed-request', 'This request could not be read as an HTTP/1.1 request.');
        }
        const verdict = policy.onRequestHead(info);
        if (verdict.kind === 'deny') return refuse(verdict.status, verdict.reason, verdict.message);
        if (verdict.kind === 'plain') replacer = NOOP_REPLACER;
        else identity = true;
      }
      const t = transformBasicAuthHead(head, replacer, this.canaryTokens);
      if (t.canaryToken) return { out: Buffer.concat(parts), canaryToken: t.canaryToken, injected };
      if (t.head !== head) injected = true; // a Basic placeholder was substituted
      // Verbatim substitution over the Basic-transformed head too, so a
      // placeholder carried verbatim in a non-Basic header (e.g. `Authorization:
      // Bearer ax-cred:…`) is still replaced. Scoped to the HEAD (headers only):
      // the Basic line already holds the re-encoded real value, so this can't
      // double-substitute it, and body bytes never reach the replacer.
      const sent = subHead(t.head, replacer);
      // A spliced request asks for an unencoded response so the meter can read it.
      parts.push(identity ? forceIdentityEncoding(sent) : sent);
      const framing = parseBodyFraming(head);
      if (framing.chunked) {
        this.phase = 'passthrough';
        // `rest` is the start of the chunked BODY — forward verbatim (no
        // substitution) so chunk-size framing stays byte-exact.
        if (rest.length) parts.push(rest);
        break;
      }
      if (framing.contentLength > 0) {
        this.phase = 'body-counted';
        this.bodyRemaining = framing.contentLength;
        working = rest;
        continue;
      }
      // no body — re-arm for the next request head
      this.phase = 'head';
      if (rest.length === 0) break;
      working = rest;
    }
    return { out: Buffer.concat(parts), canaryToken: null, injected };
  }
}
