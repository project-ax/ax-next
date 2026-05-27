/** Minimal substitution surface, satisfied by SharedCredentialRegistry. */
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

export interface FramerOptions {
  /** Cap on a single buffered request head; exceeding it falls back to verbatim passthrough. */
  maxHeadBytes?: number;
  /** Called once when a head exceeds `maxHeadBytes` (for logging). */
  onOversizedHead?: () => void;
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
}

type Phase = 'head' | 'body-counted' | 'passthrough';

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
 *      there would write the real secret into outbound message content — to the
 *      intended host AND any other allowlisted host. Leaving bodies verbatim
 *      keeps a leaked placeholder an inert fake token wherever it travels.
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
    const subHead = (b: Buffer): Buffer => {
      const r = this.replacer.replaceAllBuffer(b);
      if (r !== b) injected = true;
      return r;
    };
    let working = chunk;
    for (;;) {
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
      const t = transformBasicAuthHead(head, this.replacer, this.canaryTokens);
      if (t.canaryToken) return { out: Buffer.concat(parts), canaryToken: t.canaryToken, injected };
      if (t.head !== head) injected = true; // a Basic placeholder was substituted
      // Verbatim substitution over the Basic-transformed head too, so a
      // placeholder carried verbatim in a non-Basic header (e.g. `Authorization:
      // Bearer ax-cred:…`) is still replaced. Scoped to the HEAD (headers only):
      // the Basic line already holds the re-encoded real value, so this can't
      // double-substitute it, and body bytes never reach the replacer.
      parts.push(subHead(t.head));
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
