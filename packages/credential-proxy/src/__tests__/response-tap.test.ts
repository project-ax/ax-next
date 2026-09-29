import { describe, it, expect } from 'vitest';
import { ResponseTap, type TapResponse } from '../response-tap.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const CRLF = '\r\n';

function headText(status: number | string, headers: string[] = [], reason = 'OK'): string {
  return `HTTP/1.1 ${status} ${reason}${CRLF}${headers.map((h) => h + CRLF).join('')}${CRLF}`;
}

/** A Content-Length response. */
function clResponse(body: string, extra: string[] = [], status = 200): Buffer {
  const len = Buffer.byteLength(body, 'latin1');
  return Buffer.from(headText(status, [`Content-Length: ${len}`, ...extra]) + body, 'latin1');
}

function chunkedBody(pieces: string[], trailers: string[] = []): string {
  const data = pieces.map((p) => `${Buffer.byteLength(p, 'latin1').toString(16)}${CRLF}${p}${CRLF}`).join('');
  return data + `0${CRLF}` + trailers.map((t) => t + CRLF).join('') + CRLF;
}

function chunkedResponse(pieces: string[], extra: string[] = [], trailers: string[] = []): Buffer {
  return Buffer.from(headText(200, ['Transfer-Encoding: chunked', ...extra]) + chunkedBody(pieces, trailers), 'latin1');
}

function splitEvery(text: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPieces(buf: Buffer, rnd: () => number, maxPiece: number): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const n = 1 + Math.floor(rnd() * maxPiece);
    out.push(buf.subarray(i, i + n));
    i += n;
  }
  return out;
}

/**
 * A tap wired the way the listener wires it: the request method queue is
 * peeked at each final head, and popped in onResponse.
 */
function harness(methods: (string | undefined)[] = []) {
  const results: TapResponse[] = [];
  const queue = [...methods];
  let peeks = 0;
  const tap = new ResponseTap({
    peekMethod: () => {
      peeks++;
      return queue[0];
    },
    onResponse: (r) => {
      results.push(r);
      queue.shift();
    },
  });
  return { tap, results, peeks: () => peeks };
}

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":1234,"cache_creation_input_tokens":200,"cache_read_input_tokens":5000,"output_tokens":1}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":321}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const SSE_USAGE = { inputTokens: 1234, outputTokens: 321, cacheReadTokens: 5000, cacheWriteTokens: 200 };

const JSON_BODY =
  '{"id":"msg_9","type":"message","model":"claude-haiku-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":12,"cache_creation_input_tokens":3,"cache_read_input_tokens":4,"output_tokens":56}}';
const JSON_USAGE = { inputTokens: 12, outputTokens: 56, cacheReadTokens: 4, cacheWriteTokens: 3 };

// ---------------------------------------------------------------------------

describe('ResponseTap: Content-Length', () => {
  it('reads usage out of a JSON response', () => {
    const { tap, results } = harness(['POST']);
    tap.push(clResponse(JSON_BODY, ['Content-Type: application/json']));
    expect(results).toEqual([
      { status: 200, complete: true, encoded: false, model: 'claude-haiku-4-5', usage: JSON_USAGE },
    ]);
  });

  it('waits for the whole body: nothing is reported while it is short', () => {
    const { tap, results } = harness(['POST']);
    const buf = clResponse(JSON_BODY);
    tap.push(buf.subarray(0, buf.length - 1));
    expect(results).toHaveLength(0);
    tap.push(buf.subarray(buf.length - 1));
    expect(results).toHaveLength(1);
    expect(results[0]?.complete).toBe(true);
    expect(results[0]?.usage).toEqual(JSON_USAGE);
  });

  it('Content-Length: 0 completes at the end of the head, with no usage', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from(headText(200, ['Content-Length: 0']), 'latin1'));
    expect(results).toEqual([{ status: 200, complete: true, encoded: false, usage: null }]);
  });

  it('reports an error status with its body; the tap does not judge billability', () => {
    const { tap, results } = harness(['POST']);
    tap.push(clResponse('{"type":"error","error":{"type":"overloaded_error"}}', [], 529));
    expect(results).toEqual([{ status: 529, complete: true, encoded: false, usage: null }]);
  });

  it('header names are case-insensitive and values tolerate surrounding whitespace', () => {
    const { tap, results } = harness(['POST']);
    const len = Buffer.byteLength(JSON_BODY, 'latin1');
    tap.push(Buffer.from(headText(200, [`CONTENT-LENGTH:   ${len} \t`]) + JSON_BODY, 'latin1'));
    expect(results[0]?.usage).toEqual(JSON_USAGE);
    expect(results[0]?.complete).toBe(true);
  });

  it('accepts a status line without a reason phrase', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from('HTTP/1.1 200\r\nContent-Length: 2\r\n\r\n{}', 'latin1'));
    expect(results).toEqual([{ status: 200, complete: true, encoded: false, usage: null }]);
  });

  it('a repeated identical Content-Length is fine', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\ncontent-length: 2\r\n\r\n{}', 'latin1'));
    expect(results[0]?.complete).toBe(true);
  });

  it('a big head (60 KB of headers) still parses', () => {
    const { tap, results } = harness(['POST']);
    tap.push(clResponse(JSON_BODY, [`X-Pad: ${'a'.repeat(60_000)}`]));
    expect(results[0]?.usage).toEqual(JSON_USAGE);
  });
});

describe('ResponseTap: chunked', () => {
  it('reads an SSE stream whose counters are split across chunk boundaries', () => {
    const { tap, results } = harness(['POST']);
    tap.push(chunkedResponse(splitEvery(SSE, 13)));
    expect(results).toEqual([
      { status: 200, complete: true, encoded: false, model: 'claude-sonnet-4-5', usage: SSE_USAGE },
    ]);
  });

  it('scans chunk DATA only: size lines and CRLFs never interrupt a number', () => {
    const { tap, results } = harness(['POST']);
    // If the raw bytes were scanned, this would read `1` (then \r\n3\r\n...).
    tap.push(chunkedResponse(['{"usage":{"output_tokens":1', '23}}']));
    expect(results[0]?.usage?.outputTokens).toBe(123);
    expect(results[0]?.complete).toBe(true);
  });

  it('a forged counter in a chunk-size line or chunk extension is not read', () => {
    const { tap, results } = harness(['POST']);
    const body = `5;x="output_tokens":999${CRLF}hello${CRLF}` + `0${CRLF}${CRLF}`;
    tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked']) + body, 'latin1'));
    expect(results[0]?.complete).toBe(true);
    expect(results[0]?.usage).toBeNull();
  });

  it('gives the same answer fed byte by byte as fed whole', () => {
    const buf = chunkedResponse(splitEvery(SSE, 13));
    const whole = harness(['POST']);
    whole.tap.push(buf);

    const bytes = harness(['POST']);
    for (let i = 0; i < buf.length; i++) bytes.tap.push(buf.subarray(i, i + 1));

    expect(bytes.results).toEqual(whole.results);
    expect(bytes.results).toHaveLength(1);
    expect(bytes.results[0]?.usage).toEqual(SSE_USAGE);
  });

  it('gives the same answer for seeded random push sizes', () => {
    const buf = chunkedResponse(splitEvery(SSE, 29));
    const rnd = mulberry32(2024);
    for (let round = 0; round < 80; round++) {
      const h = harness(['POST']);
      for (const p of randomPieces(buf, rnd, round % 2 ? 5 : 200)) h.tap.push(p);
      expect(h.results).toEqual([
        { status: 200, complete: true, encoded: false, model: 'claude-sonnet-4-5', usage: SSE_USAGE },
      ]);
    }
  });

  it('understands hex sizes in any case, chunk extensions and trailers', () => {
    const { tap, results } = harness(['POST']);
    const payload = '{"usage":{"output_tokens":77}}' + ' '.repeat(11); // 41 bytes = 0x29
    const body =
      `29;name=value;other${CRLF}${payload}${CRLF}` +
      `0A${CRLF}${' '.repeat(10)}${CRLF}` +
      `0${CRLF}X-Trailer: yes${CRLF}X-Other: 1${CRLF}${CRLF}`;
    tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked']) + body, 'latin1'));
    expect(results).toHaveLength(1);
    expect(results[0]?.complete).toBe(true);
    expect(results[0]?.usage?.outputTokens).toBe(77);
  });

  it('Transfer-Encoding wins over Content-Length', () => {
    const { tap, results } = harness(['POST']);
    const body = chunkedBody(['{"usage":{"output_tokens":5}}']);
    tap.push(Buffer.from(headText(200, ['Content-Length: 3', 'transfer-encoding: Chunked']) + body, 'latin1'));
    expect(results).toHaveLength(1);
    expect(results[0]?.usage?.outputTokens).toBe(5);
    expect(results[0]?.complete).toBe(true);
  });

  it('is not complete until the blank line after the last chunk (and trailers)', () => {
    const { tap, results } = harness(['POST']);
    const full = chunkedResponse(['{"usage":{"output_tokens":5}}'], [], ['X-T: 1']);
    tap.push(full.subarray(0, full.length - 2));
    expect(results).toHaveLength(0);
    tap.push(full.subarray(full.length - 2));
    expect(results).toHaveLength(1);
    expect(results[0]?.complete).toBe(true);
  });
});

describe('ResponseTap: several responses', () => {
  it('two back-to-back responses in ONE push are both reported, in order', () => {
    const { tap, results } = harness(['POST', 'POST']);
    tap.push(Buffer.concat([clResponse(JSON_BODY), chunkedResponse(splitEvery(SSE, 40))]));
    expect(results).toHaveLength(2);
    expect(results[0]?.usage).toEqual(JSON_USAGE);
    expect(results[1]?.usage).toEqual(SSE_USAGE);
    expect(results.every((r) => r.complete)).toBe(true);
  });

  it('a push carrying the end of one response and the head of the next', () => {
    const { tap, results } = harness(['POST', 'POST']);
    const a = clResponse(JSON_BODY);
    const b = clResponse('{"usage":{"output_tokens":9}}');
    const all = Buffer.concat([a, b]);
    tap.push(all.subarray(0, a.length - 5));
    expect(results).toHaveLength(0);
    tap.push(all.subarray(a.length - 5, a.length + 10));
    expect(results).toHaveLength(1);
    tap.push(all.subarray(a.length + 10));
    expect(results).toHaveLength(2);
    expect(results[1]?.usage?.outputTokens).toBe(9);
  });

  it('a mixed pipeline gives identical results whole, byte by byte and in random pieces', () => {
    const wire = Buffer.concat([
      clResponse(JSON_BODY),
      Buffer.from(headText(100, [], 'Continue'), 'latin1'),
      chunkedResponse(splitEvery(SSE, 17), [], ['X-Done: 1']),
      Buffer.from(headText(204, [], 'No Content'), 'latin1'),
      clResponse('{"usage":{"output_tokens":9}}', ['Content-Encoding: identity']),
      Buffer.from(headText(304, ['Content-Length: 1000'], 'Not Modified'), 'latin1'),
      clResponse('{"error":"nope"}', [], 429),
    ]);
    const methods = ['POST', 'POST', 'GET', 'POST', 'GET', 'POST'];

    const whole = harness(methods);
    whole.tap.push(wire);
    expect(whole.results.map((r) => r.status)).toEqual([200, 200, 204, 200, 304, 429]);
    expect(whole.results.every((r) => r.complete)).toBe(true);

    const bytes = harness(methods);
    for (let i = 0; i < wire.length; i++) bytes.tap.push(wire.subarray(i, i + 1));
    expect(bytes.results).toEqual(whole.results);

    const rnd = mulberry32(31337);
    for (let round = 0; round < 60; round++) {
      const h = harness(methods);
      for (const p of randomPieces(wire, rnd, 1 + (round % 4) * 40)) h.tap.push(p);
      expect(h.results).toEqual(whole.results);
    }
  });
});

describe('ResponseTap: interim, no-body and upgrade responses', () => {
  it('100 Continue is skipped: one onResponse for the final head, one peek', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(headText(100, [], 'Continue'), 'latin1'));
    expect(h.results).toHaveLength(0);
    h.tap.push(clResponse(JSON_BODY));
    expect(h.results).toHaveLength(1);
    expect(h.results[0]?.status).toBe(200);
    expect(h.results[0]?.usage).toEqual(JSON_USAGE);
    expect(h.peeks()).toBe(1);
  });

  it('100 Continue and the final response in the same push, and several interims in a row', () => {
    const h = harness(['POST']);
    h.tap.push(
      Buffer.concat([
        Buffer.from(headText(100, [], 'Continue'), 'latin1'),
        Buffer.from(headText(103, ['Link: </a.css>; rel=preload'], 'Early Hints'), 'latin1'),
        clResponse(JSON_BODY),
      ]),
    );
    expect(h.results).toHaveLength(1);
    expect(h.results[0]?.status).toBe(200);
    expect(h.peeks()).toBe(1);
  });

  it('204 has no body, whatever the headers say', () => {
    const h = harness(['DELETE', 'POST']);
    h.tap.push(Buffer.concat([Buffer.from(headText(204, ['Content-Length: 50'], 'No Content'), 'latin1'), clResponse(JSON_BODY)]));
    expect(h.results).toHaveLength(2);
    expect(h.results[0]).toEqual({ status: 204, complete: true, encoded: false, usage: null });
    expect(h.results[1]?.usage).toEqual(JSON_USAGE);
  });

  it('304 has no body, whatever the headers say', () => {
    const h = harness(['GET', 'POST']);
    h.tap.push(
      Buffer.concat([Buffer.from(headText(304, ['Content-Length: 1234', 'ETag: "x"'], 'Not Modified'), 'latin1'), clResponse(JSON_BODY)]),
    );
    expect(h.results).toHaveLength(2);
    expect(h.results[0]).toEqual({ status: 304, complete: true, encoded: false, usage: null });
    expect(h.results[1]?.usage).toEqual(JSON_USAGE);
  });

  it('a HEAD response with a Content-Length header has no body; the next response parses normally', () => {
    const h = harness(['HEAD', 'POST']);
    h.tap.push(Buffer.from(headText(200, ['Content-Length: 4096', 'Content-Type: application/json']), 'latin1'));
    expect(h.results).toEqual([{ status: 200, complete: true, encoded: false, usage: null }]);
    h.tap.push(clResponse(JSON_BODY));
    expect(h.results).toHaveLength(2);
    expect(h.results[1]?.usage).toEqual(JSON_USAGE);
  });

  it('HEAD is matched case-insensitively', () => {
    const h = harness(['head', 'POST']);
    h.tap.push(Buffer.concat([Buffer.from(headText(200, ['Content-Length: 4096']), 'latin1'), clResponse(JSON_BODY)]));
    expect(h.results).toHaveLength(2);
    expect(h.results[1]?.usage).toEqual(JSON_USAGE);
  });

  it('a HEAD response with chunked framing has no body either', () => {
    const h = harness(['HEAD', 'POST']);
    h.tap.push(Buffer.concat([Buffer.from(headText(200, ['Transfer-Encoding: chunked']), 'latin1'), clResponse(JSON_BODY)]));
    expect(h.results).toHaveLength(2);
    expect(h.results[0]?.complete).toBe(true);
    expect(h.results[1]?.usage).toEqual(JSON_USAGE);
  });

  it('an unknown request method (peek returns undefined) is treated as having a body', () => {
    const h = harness([undefined]);
    h.tap.push(clResponse(JSON_BODY));
    expect(h.results[0]?.usage).toEqual(JSON_USAGE);
  });

  it('a throwing peekMethod is treated as unknown and does not break the tap', () => {
    const results: TapResponse[] = [];
    const tap = new ResponseTap({
      peekMethod: () => {
        throw new Error('nope');
      },
      onResponse: (r) => results.push(r),
    });
    tap.push(Buffer.concat([clResponse(JSON_BODY), clResponse(JSON_BODY)]));
    expect(results).toHaveLength(2);
    expect(results[1]?.usage).toEqual(JSON_USAGE);
  });

  it('101 Upgrade reports once (incomplete, no usage) and the tap goes quiet', () => {
    const h = harness(['GET']);
    h.tap.push(Buffer.from(headText(101, ['Upgrade: websocket', 'Connection: Upgrade'], 'Switching Protocols'), 'latin1'));
    expect(h.results).toEqual([{ status: 101, complete: false, encoded: false, usage: null }]);
    h.tap.push(clResponse(JSON_BODY));
    h.tap.end();
    expect(h.results).toHaveLength(1);
  });
});

describe('ResponseTap: encoded bodies', () => {
  const GZ = 'Content-Encoding: gzip';
  // Uncompressed on purpose: an implementation that scanned an encoded body anyway would read this.
  it('Content-Encoding: gzip is flagged and never scanned', () => {
    const { tap, results } = harness(['POST']);
    tap.push(clResponse(JSON_BODY, [GZ]));
    expect(results).toEqual([{ status: 200, complete: true, encoded: true, usage: null }]);
  });

  it('is flagged case-insensitively, also on a chunked body, and framing still works', () => {
    const h = harness(['POST', 'POST']);
    h.tap.push(Buffer.concat([chunkedResponse(splitEvery(SSE, 50), ['content-ENCODING: BR']), clResponse(JSON_BODY)]));
    expect(h.results).toHaveLength(2);
    expect(h.results[0]).toEqual({ status: 200, complete: true, encoded: true, usage: null });
    expect(h.results[1]?.usage).toEqual(JSON_USAGE);
  });

  it('Content-Encoding: identity is not encoded and is scanned', () => {
    const { tap, results } = harness(['POST']);
    tap.push(clResponse(JSON_BODY, ['Content-Encoding: identity']));
    expect(results[0]?.encoded).toBe(false);
    expect(results[0]?.usage).toEqual(JSON_USAGE);
  });

  it('a stacked coding that includes anything but identity is encoded', () => {
    const { tap, results } = harness(['POST']);
    tap.push(clResponse(JSON_BODY, ['Content-Encoding: identity, gzip']));
    expect(results[0]?.encoded).toBe(true);
    expect(results[0]?.usage).toBeNull();
  });

  it('Transfer-Encoding: gzip, chunked frames as chunked but is encoded', () => {
    const { tap, results } = harness(['POST', 'POST']);
    const first = Buffer.from(
      headText(200, ['Transfer-Encoding: gzip, chunked']) + chunkedBody([JSON_BODY]),
      'latin1',
    );
    tap.push(Buffer.concat([first, clResponse(JSON_BODY)]));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ status: 200, complete: true, encoded: true, usage: null });
    expect(results[1]?.usage).toEqual(JSON_USAGE);
  });
});

describe('ResponseTap: close-delimited bodies and end()', () => {
  it('a body with neither header runs until end(), which reports it complete', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from(headText(200, ['Content-Type: text/event-stream']) + SSE.slice(0, 200), 'latin1'));
    tap.push(Buffer.from(SSE.slice(200), 'latin1'));
    expect(results).toHaveLength(0);
    tap.end();
    expect(results).toEqual([
      { status: 200, complete: true, encoded: false, model: 'claude-sonnet-4-5', usage: SSE_USAGE },
    ]);
  });

  it('end() counts a final number that nothing followed', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from(headText(200) + '{"usage":{"output_tokens":42', 'latin1'));
    tap.end();
    expect(results[0]?.complete).toBe(true);
    expect(results[0]?.usage?.outputTokens).toBe(42);
  });

  it('HTTP/1.0 responses without a length are close-delimited too', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from('HTTP/1.0 200 OK\r\n\r\n' + JSON_BODY, 'latin1'));
    tap.end();
    expect(results[0]?.complete).toBe(true);
    expect(results[0]?.usage).toEqual(JSON_USAGE);
  });

  it('a truncated chunked body: end() reports incomplete, with the partial usage seen', () => {
    const { tap, results } = harness(['POST']);
    const started = SSE.slice(0, SSE.indexOf('event: message_delta'));
    tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked']) + chunkedBody(splitEvery(started, 60)).replace(/0\r\n\r\n$/, ''), 'latin1'));
    expect(results).toHaveLength(0);
    tap.end();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe(200);
    expect(results[0]?.complete).toBe(false);
    // message_start only: input and cache counts are known, the final output is not.
    expect(results[0]?.usage).toEqual({ inputTokens: 1234, outputTokens: 1, cacheReadTokens: 5000, cacheWriteTokens: 200 });
    expect(results[0]?.model).toBe('claude-sonnet-4-5');
  });

  it('a chunk cut off halfway through its data still contributes what arrived', () => {
    const { tap, results } = harness(['POST']);
    const body = '{"usage":{"output_tokens":31}} and then some more text to be cut';
    tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked']) + `100${CRLF}${body}`, 'latin1'));
    tap.end();
    expect(results[0]?.complete).toBe(false);
    expect(results[0]?.usage?.outputTokens).toBe(31);
  });

  it('a truncated Content-Length body: end() reports incomplete with what was seen', () => {
    const { tap, results } = harness(['POST']);
    const full = clResponse(JSON_BODY);
    tap.push(full.subarray(0, full.length - 30));
    tap.end();
    expect(results).toHaveLength(1);
    expect(results[0]?.complete).toBe(false);
    expect(results[0]?.status).toBe(200);
  });

  it('end() between the last chunk and the final blank line is incomplete', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked']) + `5${CRLF}hello${CRLF}0${CRLF}`, 'latin1'));
    tap.end();
    expect(results).toHaveLength(1);
    expect(results[0]?.complete).toBe(false);
  });

  it('end() mid-head reports one incomplete response with no status', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Le', 'latin1'));
    tap.end();
    expect(results).toEqual([{ status: 0, complete: false, encoded: false, usage: null }]);
  });

  it('end() with nothing in progress does nothing', () => {
    const fresh = harness();
    fresh.tap.end();
    expect(fresh.results).toHaveLength(0);

    const done = harness(['POST']);
    done.tap.push(clResponse(JSON_BODY));
    done.tap.end();
    expect(done.results).toHaveLength(1);

    const afterInterim = harness(['POST']);
    afterInterim.tap.push(Buffer.from(headText(100, [], 'Continue'), 'latin1'));
    afterInterim.tap.end();
    expect(afterInterim.results).toHaveLength(0);
  });

  it('end() is idempotent', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from(headText(200) + JSON_BODY, 'latin1'));
    tap.end();
    tap.end();
    expect(results).toHaveLength(1);
  });

  it('push after end() is ignored', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.from(headText(200) + JSON_BODY, 'latin1'));
    tap.end();
    tap.push(clResponse(JSON_BODY));
    expect(results).toHaveLength(1);
  });
});

describe('ResponseTap: framing lost', () => {
  const VALID = clResponse(JSON_BODY);

  function expectLostThenSilent(h: ReturnType<typeof harness>, status: number): void {
    expect(h.results).toHaveLength(1);
    expect(h.results[0]?.status).toBe(status);
    expect(h.results[0]?.complete).toBe(false);
    expect(h.results[0]?.encoded).toBe(false);
    // Silence: a perfectly valid response, more bytes and the close all do nothing.
    h.tap.push(VALID);
    h.tap.push(VALID);
    h.tap.end();
    h.tap.end();
    expect(h.results).toHaveLength(1);
  }

  it('a garbage status line', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from('this is not http\r\n\r\n', 'latin1'));
    expectLostThenSilent(h, 0);
    expect(h.results[0]?.usage).toBeNull();
  });

  it.each([
    ['not HTTP/1.x', 'HTTP/2 200 OK\r\n\r\n'],
    ['a two-digit status', 'HTTP/1.1 20 OK\r\n\r\n'],
    ['a non-numeric status', 'HTTP/1.1 abc OK\r\n\r\n'],
    ['a status below 100', 'HTTP/1.1 099 Odd\r\n\r\n'],
    ['a leading blank line', '\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'],
  ])('a bad status line: %s', (_name, text) => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(text, 'latin1'));
    expectLostThenSilent(h, 0);
  });

  it('an oversized head (no terminator within 64 KiB), fed whole', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(`HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(70_000)}\r\n\r\n`, 'latin1'));
    expectLostThenSilent(h, 0);
  });

  it('an oversized head, fed in small pushes, is reported once and stops buffering', () => {
    const h = harness(['POST']);
    const big = Buffer.from(`HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(100_000)}`, 'latin1');
    for (let i = 0; i < big.length; i += 997) h.tap.push(big.subarray(i, i + 997));
    expectLostThenSilent(h, 0);
  });

  it('an oversized head whose terminator does arrive after the cap', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Pad: ${'a'.repeat(66_000)}\r\n\r\n`, 'latin1'));
    expectLostThenSilent(h, 0);
  });

  it('a bad chunk size (with the usage seen so far kept)', () => {
    const h = harness(['POST']);
    h.tap.push(
      Buffer.from(
        headText(200, ['Transfer-Encoding: chunked']) + `1e${CRLF}{"usage":{"output_tokens":6}}${CRLF}zz${CRLF}`,
        'latin1',
      ),
    );
    expectLostThenSilent(h, 200);
    expect(h.results[0]?.usage?.outputTokens).toBe(6);
  });

  it.each([
    ['empty size line', `${CRLF}`],
    ['a sign', `-5${CRLF}hello${CRLF}`],
    ['a 0x prefix', `0x5${CRLF}hello${CRLF}`],
    ['an absurdly long size', `${'f'.repeat(30)}${CRLF}`],
    ['a bare LF line end', `5\nhello\r\n`],
    ['an endless size line', 'a'.repeat(20_000)],
  ])('a bad chunk size line: %s', (_name, body) => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked']) + body, 'latin1'));
    expectLostThenSilent(h, 200);
  });

  it('a missing CRLF after chunk data', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked']) + `5${CRLF}helloXX${CRLF}0${CRLF}${CRLF}`, 'latin1'));
    expectLostThenSilent(h, 200);
  });

  it('a bare LF in a trailer', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked']) + `0${CRLF}X-T: 1\n\n`, 'latin1'));
    expectLostThenSilent(h, 200);
  });

  it('conflicting Content-Length values', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!', 'latin1'));
    expectLostThenSilent(h, 200);
  });

  it.each([
    ['a non-digit value', 'Content-Length: 12abc'],
    ['a negative value', 'Content-Length: -1'],
    ['a list of values', 'Content-Length: 5, 5'],
    ['an empty value', 'Content-Length:'],
    ['an absurd value', `Content-Length: ${'9'.repeat(30)}`],
  ])('a bad Content-Length: %s', (_name, header) => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(`HTTP/1.1 200 OK\r\n${header}\r\n\r\nhello`, 'latin1'));
    expectLostThenSilent(h, 200);
  });

  it('an unknown transfer coding without chunked', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(headText(200, ['Transfer-Encoding: gzip']) + 'whatever', 'latin1'));
    expectLostThenSilent(h, 200);
  });

  it('chunked that is not the last transfer coding', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from(headText(200, ['Transfer-Encoding: chunked, gzip']) + 'whatever', 'latin1'));
    expectLostThenSilent(h, 200);
  });

  it('a header line that is not name: value (or has whitespace before the colon)', () => {
    const a = harness(['POST']);
    a.tap.push(Buffer.from('HTTP/1.1 200 OK\r\nno colon here\r\nContent-Length: 2\r\n\r\n{}', 'latin1'));
    expectLostThenSilent(a, 200);

    const b = harness(['POST']);
    b.tap.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length : 2\r\n\r\n{}', 'latin1'));
    expectLostThenSilent(b, 200);
  });

  it('a bare CR or LF inside the head (header smuggling shape)', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from('HTTP/1.1 200 OK\r\nX-A: 1\nContent-Length: 3\r\n\r\nabc', 'latin1'));
    expectLostThenSilent(h, 200);
  });

  it('loss on the SECOND response of a pipeline still reports the first normally', () => {
    const h = harness(['POST', 'POST']);
    h.tap.push(Buffer.concat([VALID, Buffer.from('garbage garbage\r\n\r\n', 'latin1')]));
    expect(h.results).toHaveLength(2);
    expect(h.results[0]?.complete).toBe(true);
    expect(h.results[0]?.usage).toEqual(JSON_USAGE);
    expect(h.results[1]).toEqual({ status: 0, complete: false, encoded: false, usage: null });
    h.tap.push(VALID);
    h.tap.end();
    expect(h.results).toHaveLength(2);
  });

  it('push after DEAD is ignored, byte by byte too', () => {
    const h = harness(['POST']);
    h.tap.push(Buffer.from('garbage\r\n\r\n', 'latin1'));
    for (let i = 0; i < VALID.length; i++) h.tap.push(VALID.subarray(i, i + 1));
    expect(h.results).toHaveLength(1);
  });
});

describe('ResponseTap: robustness', () => {
  it('onResponse throwing does not break later responses, in one push or across pushes', () => {
    let calls = 0;
    const seen: TapResponse[] = [];
    const tap = new ResponseTap({
      peekMethod: () => 'POST',
      onResponse: (r) => {
        calls++;
        seen.push(r);
        throw new Error('listener bug');
      },
    });
    tap.push(Buffer.concat([clResponse(JSON_BODY), clResponse('{"usage":{"output_tokens":9}}')]));
    tap.push(chunkedResponse(splitEvery(SSE, 25)));
    expect(calls).toBe(3);
    expect(seen[1]?.usage?.outputTokens).toBe(9);
    expect(seen[2]?.usage).toEqual(SSE_USAGE);
    expect(() => tap.end()).not.toThrow();
  });

  it('onResponse throwing on a framing-lost report does not throw out of push', () => {
    const tap = new ResponseTap({
      peekMethod: () => undefined,
      onResponse: () => {
        throw new Error('listener bug');
      },
    });
    expect(() => tap.push(Buffer.from('nonsense\r\n\r\n', 'latin1'))).not.toThrow();
    expect(() => tap.end()).not.toThrow();
  });

  it('empty pushes are harmless', () => {
    const { tap, results } = harness(['POST']);
    tap.push(Buffer.alloc(0));
    tap.push(clResponse(JSON_BODY));
    tap.push(Buffer.alloc(0));
    expect(results).toHaveLength(1);
  });

  it('random garbage never throws and yields at most one report', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed);
      const h = harness(['POST', 'POST', 'POST']);
      for (let i = 0; i < 20; i++) {
        const b = Buffer.alloc(1 + Math.floor(rnd() * 3000));
        for (let j = 0; j < b.length; j++) b[j] = Math.floor(rnd() * 256);
        expect(() => h.tap.push(b)).not.toThrow();
      }
      expect(() => h.tap.end()).not.toThrow();
      expect(h.results.length).toBeLessThanOrEqual(1);
    }
  });

  it('garbage after a valid head never throws (chunked and length-delimited)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed * 7919);
      const heads = [
        headText(200, ['Transfer-Encoding: chunked']),
        headText(200, ['Content-Length: 100000']),
        headText(200),
      ];
      for (const head of heads) {
        const h = harness(['POST']);
        h.tap.push(Buffer.from(head, 'latin1'));
        for (let i = 0; i < 10; i++) {
          const b = Buffer.alloc(1 + Math.floor(rnd() * 2000));
          for (let j = 0; j < b.length; j++) b[j] = Math.floor(rnd() * 256);
          expect(() => h.tap.push(b)).not.toThrow();
        }
        expect(() => h.tap.end()).not.toThrow();
        expect(h.results.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a non-Buffer push does not throw', () => {
    const { tap } = harness(['POST']);
    expect(() => tap.push(undefined as unknown as Buffer)).not.toThrow();
    expect(() => tap.end()).not.toThrow();
  });
});

describe('ResponseTap: scale', () => {
  it('a 20 MB Content-Length body pushed in 64 KiB pieces finishes fast with the right usage', () => {
    const { tap, results } = harness(['POST']);
    const filler = Buffer.from(`data: {"type":"content_block_delta","delta":{"text":"${'lorem ipsum '.repeat(40)}"}}\n\n`, 'latin1');
    const chunk = Buffer.alloc(64 * 1024);
    for (let off = 0; off < chunk.length; off += filler.length) filler.copy(chunk, off, 0, Math.min(filler.length, chunk.length - off));
    const first = Buffer.from('data: {"model":"claude-big","usage":{"input_tokens":11,"output_tokens":1}}\n', 'latin1');
    const last = Buffer.from('data: {"usage":{"output_tokens":777}}\n', 'latin1');
    const total = first.length + chunk.length * 320 + last.length;
    const started = Date.now();
    tap.push(Buffer.from(headText(200, [`Content-Length: ${total}`]), 'latin1'));
    tap.push(first);
    for (let i = 0; i < 320; i++) tap.push(chunk);
    expect(results).toHaveLength(0);
    tap.push(last);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(results).toHaveLength(1);
    expect(results[0]?.complete).toBe(true);
    expect(results[0]?.model).toBe('claude-big');
    expect(results[0]?.usage).toEqual({ inputTokens: 11, outputTokens: 777, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('a 20 MB close-delimited body in ONE push, then end()', () => {
    const { tap, results } = harness(['POST']);
    const head = Buffer.from(headText(200), 'latin1');
    const tail = Buffer.from(' {"usage":{"output_tokens":31337}}', 'latin1');
    const body = Buffer.alloc(20 * 1024 * 1024, 0x61);
    tail.copy(body, body.length - tail.length);
    tap.push(Buffer.concat([head, body]));
    tap.end();
    expect(results).toHaveLength(1);
    expect(results[0]?.complete).toBe(true);
    expect(results[0]?.usage?.outputTokens).toBe(31337);
  });

  it('many tiny chunks in one push', () => {
    const { tap, results } = harness(['POST']);
    const pieces = splitEvery('{"usage":{"output_tokens":4242}}' + ' '.repeat(20_000), 1);
    tap.push(chunkedResponse(pieces));
    expect(results).toHaveLength(1);
    expect(results[0]?.complete).toBe(true);
    expect(results[0]?.usage?.outputTokens).toBe(4242);
  });
});
