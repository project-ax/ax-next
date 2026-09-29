// ---------------------------------------------------------------------------
// A passive tap on the upstream -> client bytes of ONE metered MITM tunnel
// (TASK-715). It frames HTTP/1.1 responses and streams each body through a
// `UsageScanner`, so the meter can learn what a provider call cost.
//
// The tap only OBSERVES. The caller forwards every byte itself, before or
// after handing it here; nothing in this file can alter, delay or fail
// traffic. Three properties are load-bearing:
//
//   - It never throws. `push`/`end` swallow everything, a throwing
//     `onResponse` or `peekMethod` is contained, and an unexpected exception
//     just kills the tap (same as framing lost). A tap failure must never fail
//     a request.
//   - Memory is O(1) in the body. Body bytes are scanned and dropped; only the
//     head (capped at 64 KiB) and one short chunk-size/trailer line are ever
//     buffered.
//   - Doubt is loud, not silent. Anything that makes the framing ambiguous
//     (bad status line, oversized head, conflicting or non-numeric
//     Content-Length, an unknown transfer coding, a malformed chunk, a bare LF
//     where CRLF is required) ends the tap after ONE `complete: false` report.
//     The meter then charges an estimate. We never guess where a body ends: a
//     wrong guess would attribute the next response's usage to this one, or
//     stop counting altogether.
//
// State machine, per response:
//
//   head -> body-length ----------------------------------> head
//        -> chunk-size <-> chunk-data -> chunk-crlf -+
//             |  (size 0)                            |
//             +-> trailer ----------------------------> head
//        -> body-close (runs until end())
//        -> (no body: HEAD / 204 / 304 / Content-Length: 0) -> head
//   any state -> dead (framing lost, 101 Upgrade, end())
//
// Interim (1xx except 101) heads are skipped without reporting. A response
// whose head is `101` is reported once and the tap goes dead (the connection is
// no longer HTTP).
// ---------------------------------------------------------------------------

import type { MeasuredUsage } from './provider-usage.js';
import { UsageScanner } from './usage-scan.js';

export interface TapResponse {
  /** Status of the final (non-1xx) head. 0 if framing was lost before a head parsed. */
  status: number;
  /**
   * The body was fully framed (Content-Length satisfied, last chunk seen, or a
   * close-delimited body reached end()). False: the connection ended
   * mid-body, or framing was lost.
   */
  complete: boolean;
  /** A Content-Encoding other than identity was present: the body was NOT scanned (usage null). */
  encoded: boolean;
  model?: string;
  usage: MeasuredUsage | null;
}

/**
 * What arrived of a response's body, alongside the report. Kept out of
 * `TapResponse` on purpose: it only matters when a response ended early, where
 * the counters in the body may not have arrived yet but the bytes that did are
 * still evidence of how much was generated.
 */
export interface ResponseMeta {
  /** Body bytes seen (chunk data only for a chunked body, never the framing). */
  bodyBytes: number;
  /** `Content-Type: text/event-stream`: the body was delivered as server-sent events. */
  streamed: boolean;
}

export interface ResponseTapOptions {
  /**
   * Called once per response, when its final head has parsed, to learn the
   * method of the request it answers (a HEAD response has no body). Return
   * undefined if unknown. Do not pop anything; the caller pops in onResponse.
   */
  peekMethod(): string | undefined;
  onResponse(r: TapResponse, meta: ResponseMeta): void;
}

const MAX_HEAD_BYTES = 64 * 1024;
/** A chunk-size line (hex + extensions) or a single trailer line. */
const MAX_LINE_CHARS = 8 * 1024;
const MAX_TRAILER_BYTES = 64 * 1024;
/** 12 hex digits = 2^48 bytes, comfortably inside a safe integer. */
const MAX_CHUNK_HEX_DIGITS = 12;

const CR = 13;
const LF = 10;

const STATUS_LINE_RE = /^HTTP\/1\.\d (\d{3})(?: .*)?$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LONE_CR_OR_LF_RE = /[\r\n]/;

type State =
  | 'head'
  | 'body-length'
  | 'body-close'
  | 'chunk-size'
  | 'chunk-data'
  | 'chunk-crlf'
  | 'trailer'
  | 'dead';

interface Framing {
  /** Set when the body is length-delimited (and not chunked). */
  contentLength: number | undefined;
  chunked: boolean;
  encoded: boolean;
  streamed: boolean;
}

export class ResponseTap {
  private state: State = 'head';

  // Head accumulation. `crlfMatch` is how many bytes of `\r\n\r\n` the end of
  // what has been scanned so far matches, so a terminator split across pushes
  // is found without ever re-scanning or concatenating on every push.
  private headParts: Buffer[] = [];
  private headLen = 0;
  private crlfMatch = 0;

  // The response currently being framed.
  private status = 0;
  private encoded = false;
  private streamed = false;
  private bodyBytes = 0;
  private scanner: UsageScanner | null = null;
  private remaining = 0;

  // One short line (chunk-size, trailer) being accumulated.
  private line = '';
  private lineReady = false;
  private trailerBytes = 0;
  private crlfSeen = 0;

  constructor(private readonly opts: ResponseTapOptions) {}

  /** Upstream -> client bytes, in order. */
  push(chunk: Buffer): void {
    if (this.state === 'dead') return;
    try {
      this.run(chunk);
    } catch {
      this.lose();
    }
  }

  /** The upstream closed. Idempotent. */
  end(): void {
    if (this.state === 'dead') return;
    try {
      let report: TapResponse | null = null;
      if (this.state === 'head') {
        // Bytes of a head arrived but it never finished: a response was in
        // progress. No bytes at all (or only complete interim heads): nothing.
        if (this.headLen > 0) report = { status: 0, complete: false, encoded: false, usage: null };
      } else {
        report = this.snapshot(this.state === 'body-close');
      }
      const meta = this.meta();
      this.kill();
      if (report) this.emit(report, meta);
    } catch {
      this.kill();
    }
  }

  // ---- the state machine ---------------------------------------------------

  private run(buf: Buffer): void {
    const len = buf.length;
    let pos = 0;
    while (pos < len) {
      switch (this.state) {
        case 'head':
          pos = this.readHead(buf, pos);
          break;
        case 'body-length': {
          const take = Math.min(this.remaining, len - pos);
          this.scan(buf, pos, pos + take);
          this.remaining -= take;
          pos += take;
          if (this.remaining === 0) this.finish(true);
          break;
        }
        case 'body-close':
          this.scan(buf, pos, len);
          pos = len;
          break;
        case 'chunk-size':
          pos = this.readChunkSize(buf, pos);
          break;
        case 'chunk-data': {
          const take = Math.min(this.remaining, len - pos);
          this.scan(buf, pos, pos + take);
          this.remaining -= take;
          pos += take;
          if (this.remaining === 0) {
            this.state = 'chunk-crlf';
            this.crlfSeen = 0;
          }
          break;
        }
        case 'chunk-crlf':
          pos = this.readChunkCrlf(buf, pos);
          break;
        case 'trailer':
          pos = this.readTrailer(buf, pos);
          break;
        case 'dead':
          return;
      }
    }
  }

  /** Scans for the end of a head. Returns the index of the first byte not consumed. */
  private readHead(buf: Buffer, pos: number): number {
    const len = buf.length;
    let m = this.crlfMatch;
    let i = pos;
    let found = false;
    while (i < len) {
      if (this.headLen + (i - pos) + 1 > MAX_HEAD_BYTES) {
        this.lose();
        return len;
      }
      const b = buf[i]!;
      i++;
      if (b === CR) m = m === 2 ? 3 : 1;
      else if (b === LF) m = m === 1 ? 2 : m === 3 ? 4 : 0;
      else m = 0;
      if (m === 4) {
        found = true;
        break;
      }
    }
    if (i > pos) {
      // Copied: a head fragment must not pin (or alias) the caller's buffer.
      this.headParts.push(Buffer.from(buf.subarray(pos, i)));
      this.headLen += i - pos;
    }
    if (!found) {
      this.crlfMatch = m;
      return i;
    }
    const head = Buffer.concat(this.headParts, this.headLen);
    this.headParts = [];
    this.headLen = 0;
    this.crlfMatch = 0;
    this.onHead(head);
    return i;
  }

  private onHead(head: Buffer): void {
    const lines = head.toString('latin1', 0, head.length - 4).split('\r\n');

    const statusMatch = STATUS_LINE_RE.exec(lines[0] ?? '');
    const status = statusMatch?.[1] === undefined ? 0 : Number(statusMatch[1]);
    if (status < 100) return this.lose();

    // Interim heads are not a response: no report, no body, no peek.
    if (status >= 100 && status <= 199 && status !== 101) return;

    this.status = status;

    if (status === 101) {
      // The connection stops being HTTP here. Report once and stand down.
      this.kill();
      this.emit({ status, complete: false, encoded: false, usage: null }, { bodyBytes: 0, streamed: false });
      return;
    }

    // A bare CR or LF inside a head is how a header gets smuggled past a
    // parser that only splits on CRLF; a parser that also splits on LF would
    // frame this response differently than we do.
    for (const l of lines) {
      if (LONE_CR_OR_LF_RE.test(l)) return this.lose();
    }
    const framing = parseFraming(lines);
    if (framing === null) return this.lose();

    this.encoded = framing.encoded;
    this.streamed = framing.streamed;
    // Peeked for EVERY final head (once per response), not only when the
    // status alone would not settle it.
    const isHeadResponse = this.peekIsHead();
    if (isHeadResponse || status === 204 || status === 304) return this.finish(true);
    if (!framing.encoded) this.scanner = new UsageScanner();

    if (framing.chunked) {
      this.state = 'chunk-size';
      this.line = '';
      this.lineReady = false;
    } else if (framing.contentLength !== undefined) {
      if (framing.contentLength === 0) return this.finish(true);
      this.state = 'body-length';
      this.remaining = framing.contentLength;
    } else {
      this.state = 'body-close';
    }
  }

  private readChunkSize(buf: Buffer, pos: number): number {
    const next = this.takeLine(buf, pos);
    if (next < 0) {
      this.lose();
      return buf.length;
    }
    if (!this.lineReady) return next;
    const size = parseChunkSize(this.line);
    this.line = '';
    this.lineReady = false;
    if (size < 0) {
      this.lose();
      return buf.length;
    }
    if (size === 0) {
      this.state = 'trailer';
      this.trailerBytes = 0;
    } else {
      this.state = 'chunk-data';
      this.remaining = size;
    }
    return next;
  }

  private readChunkCrlf(buf: Buffer, pos: number): number {
    const b = buf[pos]!;
    if (this.crlfSeen === 0) {
      if (b !== CR) {
        this.lose();
        return buf.length;
      }
      this.crlfSeen = 1;
    } else {
      if (b !== LF) {
        this.lose();
        return buf.length;
      }
      this.state = 'chunk-size';
      this.line = '';
      this.lineReady = false;
    }
    return pos + 1;
  }

  private readTrailer(buf: Buffer, pos: number): number {
    const next = this.takeLine(buf, pos);
    if (next < 0) {
      this.lose();
      return buf.length;
    }
    if (!this.lineReady) return next;
    const blank = this.line.length === 0;
    this.trailerBytes += this.line.length + 2;
    this.line = '';
    this.lineReady = false;
    if (blank) {
      this.finish(true);
    } else if (this.trailerBytes > MAX_TRAILER_BYTES) {
      this.lose();
      return buf.length;
    }
    return next;
  }

  /**
   * Accumulates one CRLF-terminated line into `this.line` (without the CRLF).
   * Returns the index after the consumed bytes, or -1 when the line is
   * malformed (too long, or ended by a bare LF). `lineReady` says whether a
   * whole line is now in `this.line`.
   */
  private takeLine(buf: Buffer, pos: number): number {
    const nl = buf.indexOf(LF, pos);
    const end = nl < 0 ? buf.length : nl;
    if (this.line.length + (end - pos) > MAX_LINE_CHARS) return -1;
    this.line += buf.toString('latin1', pos, end);
    if (nl < 0) {
      this.lineReady = false;
      return buf.length;
    }
    if (!this.line.endsWith('\r')) return -1;
    this.line = this.line.slice(0, -1);
    this.lineReady = true;
    return nl + 1;
  }

  // ---- reporting -----------------------------------------------------------

  private scan(buf: Buffer, start: number, end: number): void {
    if (end <= start) return;
    this.bodyBytes += end - start;
    if (this.scanner !== null) this.scanner.feed(buf.subarray(start, end));
  }

  private meta(): ResponseMeta {
    return { bodyBytes: this.bodyBytes, streamed: this.streamed };
  }

  private snapshot(complete: boolean): TapResponse {
    const scanned = this.scanner?.result();
    const r: TapResponse = {
      status: this.status,
      complete,
      encoded: this.encoded,
      usage: scanned?.usage ?? null,
    };
    if (scanned?.model !== undefined) r.model = scanned.model;
    return r;
  }

  /** The response in progress is over. Report it and get ready for the next head. */
  private finish(complete: boolean): void {
    const report = this.snapshot(complete);
    const meta = this.meta();
    this.resetResponse();
    this.emit(report, meta);
  }

  /** Framing can no longer be trusted. Report once, then stay silent for good. */
  private lose(): void {
    if (this.state === 'dead') return;
    let report: TapResponse;
    let meta: ResponseMeta;
    try {
      report = this.snapshot(false);
      report.encoded = false;
      meta = this.meta();
    } catch {
      report = { status: 0, complete: false, encoded: false, usage: null };
      meta = { bodyBytes: 0, streamed: false };
    }
    this.kill();
    this.emit(report, meta);
  }

  private kill(): void {
    this.resetResponse();
    this.state = 'dead';
  }

  private resetResponse(): void {
    this.state = 'head';
    this.headParts = [];
    this.headLen = 0;
    this.crlfMatch = 0;
    this.status = 0;
    this.encoded = false;
    this.streamed = false;
    this.bodyBytes = 0;
    this.scanner = null;
    this.remaining = 0;
    this.line = '';
    this.lineReady = false;
    this.trailerBytes = 0;
    this.crlfSeen = 0;
  }

  private peekIsHead(): boolean {
    try {
      const method = this.opts.peekMethod();
      return typeof method === 'string' && method.toUpperCase() === 'HEAD';
    } catch {
      return false;
    }
  }

  private emit(report: TapResponse, meta: ResponseMeta): void {
    try {
      this.opts.onResponse(report, meta);
    } catch {
      // The listener's bug is not the tap's problem, and must not corrupt it.
    }
  }
}

// ---- pure helpers ----------------------------------------------------------

/**
 * Reads the framing headers off a parsed head (`lines[0]` is the status line).
 * Null = framing lost: an ambiguous or malformed head is never guessed at.
 */
function parseFraming(lines: readonly string[]): Framing | null {
  let contentLength: number | undefined;
  const transferCodings: string[] = [];
  const contentCodings: string[] = [];
  let streamed = false;

  for (let k = 1; k < lines.length; k++) {
    const line = lines[k] ?? '';
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const name = line.slice(0, colon);
    if (!HEADER_NAME_RE.test(name)) return null;
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '');
    const lower = name.toLowerCase();

    if (lower === 'content-length') {
      if (!/^\d{1,15}$/.test(value)) return null;
      const n = Number(value);
      if (contentLength !== undefined && contentLength !== n) return null;
      contentLength = n;
    } else if (lower === 'transfer-encoding') {
      pushTokens(transferCodings, value);
    } else if (lower === 'content-encoding') {
      pushTokens(contentCodings, value);
    } else if (lower === 'content-type') {
      streamed = value.toLowerCase().startsWith('text/event-stream');
    }
  }

  let chunked = false;
  let encoded = contentCodings.some((t) => t !== 'identity');
  if (transferCodings.length > 0) {
    if (transferCodings[transferCodings.length - 1] !== 'chunked') return null;
    const before = transferCodings.slice(0, -1);
    if (before.includes('chunked')) return null;
    // `gzip, chunked` frames as chunked, but what is inside the chunks is compressed.
    if (before.some((t) => t !== 'identity')) encoded = true;
    chunked = true;
    // Transfer-Encoding overrides Content-Length (RFC 9112 6.3).
    contentLength = undefined;
  }
  return { contentLength, chunked, encoded, streamed };
}

function pushTokens(into: string[], value: string): void {
  for (const raw of value.split(',')) {
    const token = raw.trim().toLowerCase();
    if (token) into.push(token);
  }
}

/** Hex size, extensions after `;` ignored. -1 when malformed. */
function parseChunkSize(line: string): number {
  const semi = line.indexOf(';');
  const hex = (semi < 0 ? line : line.slice(0, semi)).replace(/[ \t]+$/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) return -1;
  const significant = hex.replace(/^0+(?=.)/, '');
  if (significant.length > MAX_CHUNK_HEX_DIGITS) return -1;
  return parseInt(significant, 16);
}
