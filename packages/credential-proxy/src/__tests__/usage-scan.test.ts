import { describe, it, expect } from 'vitest';
import { UsageScanner, type ScanResult } from '../usage-scan.js';

// ---------------------------------------------------------------------------
// Fixtures: realistic provider bodies. The numbers are distinct on purpose so a
// swapped field (input for output, read for write) cannot pass by coincidence.
// ---------------------------------------------------------------------------

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_01ABC","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1234,"cache_creation_input_tokens":200,"cache_read_input_tokens":5000,"cache_creation":{"ephemeral_5m_input_tokens":200,"ephemeral_1h_input_tokens":0},"output_tokens":1,"service_tier":"standard"}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world, this is a longer streamed answer."}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":null,"cache_creation_input_tokens":200,"cache_read_input_tokens":5000,"output_tokens":321}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const ANTHROPIC_SSE_RESULT: ScanResult = {
  model: 'claude-sonnet-4-5-20250929',
  usage: { inputTokens: 1234, outputTokens: 321, cacheReadTokens: 5000, cacheWriteTokens: 200 },
};

const OPENROUTER_SSE = [
  'data: {"id":"gen-1","provider":"Anthropic","model":"anthropic/claude-sonnet-4.5","object":"chat.completion.chunk","created":1759000000,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
  '',
  'data: {"id":"gen-1","provider":"Anthropic","model":"anthropic/claude-sonnet-4.5","object":"chat.completion.chunk","created":1759000000,"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}',
  '',
  'data: {"id":"gen-1","provider":"Anthropic","model":"anthropic/claude-sonnet-4.5","object":"chat.completion.chunk","created":1759000000,"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":6234,"completion_tokens":321,"total_tokens":6555,"prompt_tokens_details":{"cached_tokens":5000,"cache_write_tokens":200,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

// prompt_tokens INCLUDES the cache read and write tokens: 6234 - 5000 - 200.
const OPENROUTER_SSE_RESULT: ScanResult = {
  model: 'anthropic/claude-sonnet-4.5',
  usage: { inputTokens: 1034, outputTokens: 321, cacheReadTokens: 5000, cacheWriteTokens: 200 },
};

function feedAll(s: UsageScanner, parts: Buffer[]): void {
  for (const p of parts) s.feed(p);
}

function scanWhole(text: string): ScanResult {
  const s = new UsageScanner();
  s.feed(Buffer.from(text, 'latin1'));
  return s.result();
}

/** Deterministic PRNG so a failing split is reproducible. */
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

function randomSplit(buf: Buffer, rnd: () => number, maxPiece: number): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const n = 1 + Math.floor(rnd() * maxPiece);
    out.push(buf.subarray(i, i + n));
    i += n;
  }
  return out;
}

describe('UsageScanner: provider bodies', () => {
  it('reads an Anthropic SSE stream (cumulative counts, null input in message_delta)', () => {
    expect(scanWhole(ANTHROPIC_SSE)).toEqual(ANTHROPIC_SSE_RESULT);
  });

  it('reads an Anthropic non-streaming JSON response', () => {
    const body =
      '{"id":"msg_01","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":12,"cache_creation_input_tokens":3,"cache_read_input_tokens":4,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":0},"output_tokens":56,"service_tier":"standard"}}';
    expect(scanWhole(body)).toEqual({
      model: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 12, outputTokens: 56, cacheReadTokens: 4, cacheWriteTokens: 3 },
    });
  });

  it('reads an OpenRouter chat.completion.chunk stream with usage only in the last chunk', () => {
    expect(scanWhole(OPENROUTER_SSE)).toEqual(OPENROUTER_SSE_RESULT);
  });

  it('an OpenAI-style body with no cache details gets input = prompt_tokens', () => {
    const r = scanWhole('{"model":"openai/gpt-5","usage":{"prompt_tokens":100,"completion_tokens":40}}');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('never lets a cache-inclusive prompt_tokens go negative', () => {
    const r = scanWhole(
      '{"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":500,"cache_write_tokens":7}}}',
    );
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 1, cacheReadTokens: 500, cacheWriteTokens: 7 });
  });

  it('when both styles appear, takes the larger computed input (over-count is the safe side)', () => {
    const r = scanWhole('{"usage":{"input_tokens":50,"output_tokens":2}} {"usage":{"prompt_tokens":900,"completion_tokens":3}}');
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const r2 = scanWhole('{"usage":{"input_tokens":5000,"output_tokens":2}} {"usage":{"prompt_tokens":900,"completion_tokens":3}}');
    expect(r2.usage?.inputTokens).toBe(5000);
  });
});

describe('UsageScanner: combining', () => {
  it('takes the MAX of repeated cumulative counts, never the sum', () => {
    const text = [
      'data: {"usage":{"input_tokens":100,"output_tokens":1}}',
      'data: {"usage":{"input_tokens":100,"output_tokens":40}}',
      'data: {"usage":{"input_tokens":100,"output_tokens":90}}',
      'data: {"usage":{"input_tokens":100,"output_tokens":75}}',
    ].join('\n');
    const r = scanWhole(text);
    expect(r.usage?.outputTokens).toBe(90);
    expect(r.usage?.inputTokens).toBe(100);
  });

  it('a null counter simply does not match', () => {
    const r = scanWhole('{"usage":{"input_tokens": null,"output_tokens": 8}}');
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('a lone null counter leaves usage null', () => {
    expect(scanWhole('{"usage":{"input_tokens":null,"output_tokens":null}}').usage).toBeNull();
  });

  it('usage is null when no counter name matched at all', () => {
    const r = scanWhole('{"id":"x","type":"error","error":{"type":"overloaded_error","message":"try later"}}');
    expect(r.usage).toBeNull();
    expect(r.model).toBeUndefined();
  });

  it('a counter present with value 0 is a match (usage is not null)', () => {
    expect(scanWhole('{"usage":{"output_tokens":0}}').usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('tolerates whitespace between key, colon and number', () => {
    const r = scanWhole('{ "usage" : { "output_tokens" \t:\r\n  17 } }');
    expect(r.usage?.outputTokens).toBe(17);
  });

  it('does not treat a decimal or a longer number as a counter', () => {
    expect(scanWhole('{"output_tokens": 1.5}').usage).toBeNull();
    expect(scanWhole('{"output_tokens": 1234567890123}').usage).toBeNull();
  });

  it('does not match a prefixed or suffixed key name', () => {
    expect(scanWhole('{"x_output_tokens": 5, "output_tokens_extra": 6, "my\\"output_tokens": 7}').usage).toBeNull();
  });

  it('clamps every parsed number to 1e9', () => {
    const r = scanWhole('{"usage":{"input_tokens":999999999999,"output_tokens":4000000000,"cache_read_input_tokens":1000000001}}');
    expect(r.usage).toEqual({
      inputTokens: 1_000_000_000,
      outputTokens: 1_000_000_000,
      cacheReadTokens: 1_000_000_000,
      cacheWriteTokens: 0,
    });
  });

  it('every field is a whole non-negative number', () => {
    const r = scanWhole(ANTHROPIC_SSE);
    for (const v of Object.values(r.usage ?? {})) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('UsageScanner: model', () => {
  it('the first model wins; later ones are ignored', () => {
    const r = scanWhole('{"model":"first-one"} {"model":"second-one"} {"usage":{"output_tokens":1,"model":"third"}}');
    expect(r.model).toBe('first-one');
  });

  it('accepts the allowed characters (letters, digits, . _ : / @ + -)', () => {
    expect(scanWhole('{"model": "vendor/Model-4.5_x:free@2+beta"}').model).toBe('vendor/Model-4.5_x:free@2+beta');
  });

  it('rejects a model with characters outside the allowed set (no markup, spaces, quotes)', () => {
    expect(scanWhole('{"model":"bad model"}').model).toBeUndefined();
    expect(scanWhole('{"model":"<script>alert(1)</script>"}').model).toBeUndefined();
    expect(scanWhole('{"model":"caf\u00e9"}').model).toBeUndefined();
  });

  it('a rejected model does not stop a later valid one from being taken', () => {
    expect(scanWhole('{"model":"bad model"} {"model":"good-model"}').model).toBe('good-model');
  });

  it('rejects a model name longer than 200 characters', () => {
    expect(scanWhole(`{"model":"${'m'.repeat(201)}"}`).model).toBeUndefined();
    expect(scanWhole(`{"model":"${'m'.repeat(200)}"}`).model).toBe('m'.repeat(200));
  });

  it('ignores a model quoted inside model text (escaped quotes)', () => {
    const r = scanWhole('data: {"delta":{"text":"see \\"model\\": \\"evil\\" here"}} {"model":"real"}');
    expect(r.model).toBe('real');
    expect(scanWhole('\\"model": "evil"').model).toBeUndefined();
  });

  it('is found when it straddles a feed boundary', () => {
    const s = new UsageScanner();
    s.feed(Buffer.from('{"id":"x","mod'));
    s.feed(Buffer.from('el":"claude-x"}'));
    expect(s.result().model).toBe('claude-x');
  });
});

describe('UsageScanner: forgery via model text', () => {
  const REAL_TAIL = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":321}}';

  it('a usage object quoted inside a text_delta string (escaped) does not count', () => {
    const forged =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"output_tokens\\":999999,\\"input_tokens\\":888888}"}}';
    const r = scanWhole(`${forged}\n${REAL_TAIL}\n`);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 321, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('a backslash before ONLY the opening quote is still rejected (lookbehind, not just the closing quote)', () => {
    const r = scanWhole('\\"output_tokens": 999999 \\"prompt_tokens": 777777');
    expect(r.usage).toBeNull();
  });

  it('the same forgery fed one byte at a time is rejected too', () => {
    const s = new UsageScanner();
    const text = Buffer.from(`\\"output_tokens": 999999,${'p'.repeat(300)}\n${REAL_TAIL}\n`, 'latin1');
    for (let i = 0; i < text.length; i++) s.feed(text.subarray(i, i + 1));
    expect(s.result().usage?.outputTokens).toBe(321);
  });

  it('a forged key whose opening quote sits exactly at the start of the carried tail is still rejected', () => {
    // Feed 1 ends so that the carried tail starts on the quote of a backslash-quote
    // forgery. Without context the lookbehind would pass, so a naive scanner
    // would re-match the forgery on feed 2.
    const forged = '\\"output_tokens": 424242,';
    const pad = 'p'.repeat(256 - (forged.length - 1));
    const s = new UsageScanner();
    s.feed(Buffer.from(`aaaaaaaaaa${forged}${pad}`, 'latin1'));
    s.feed(Buffer.from('}', 'latin1'));
    s.feed(Buffer.from('}', 'latin1'));
    expect(s.result().usage).toBeNull();
  });

  it('keys preceded by a word character or a quote are rejected', () => {
    expect(scanWhole('x"output_tokens": 5').usage).toBeNull();
    expect(scanWhole('""output_tokens": 5').usage).toBeNull();
    expect(scanWhole(',"output_tokens": 5').usage?.outputTokens).toBe(5);
  });
});

describe('UsageScanner: chunk boundaries', () => {
  it('finds a counter split across two feeds, at every possible split point', () => {
    const text = 'data: {"usage":{"input_tokens":10,"cache_read_input_tokens":2048,"output_tokens":4096}}\n';
    const whole = scanWhole(text);
    const buf = Buffer.from(text, 'latin1');
    expect(whole.usage).toEqual({ inputTokens: 10, outputTokens: 4096, cacheReadTokens: 2048, cacheWriteTokens: 0 });
    for (let i = 0; i <= buf.length; i++) {
      const s = new UsageScanner();
      s.feed(buf.subarray(0, i));
      s.feed(buf.subarray(i));
      expect(s.result()).toEqual(whole);
    }
  });

  it('finds a counter split across the carried-tail boundary after a large first feed', () => {
    const s = new UsageScanner();
    s.feed(Buffer.from(`${'x'.repeat(100_000)} "cache_read_inp`, 'latin1'));
    s.feed(Buffer.from('ut_tokens": 9 ', 'latin1'));
    expect(s.result().usage?.cacheReadTokens).toBe(9);
  });

  it('does not lose a number that continues into the next feed (12 | 3 = 123)', () => {
    const s = new UsageScanner();
    s.feed(Buffer.from('{"output_tokens":12', 'latin1'));
    s.feed(Buffer.from('3}', 'latin1'));
    expect(s.result().usage?.outputTokens).toBe(123);
  });

  it('does not count a decimal whose integer part ended a feed (1 | .5)', () => {
    const s = new UsageScanner();
    s.feed(Buffer.from('{"output_tokens":1', 'latin1'));
    s.feed(Buffer.from('.5,"input_tokens":3}', 'latin1'));
    expect(s.result().usage).toEqual({ inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('counts a trailing number with nothing after it when result() is read (end of input is a terminator)', () => {
    const s = new UsageScanner();
    s.feed(Buffer.from('{"usage":{"output_tokens":42', 'latin1'));
    expect(s.result().usage?.outputTokens).toBe(42);
    // ...and result() did not consume it: more digits still extend the same number.
    s.feed(Buffer.from('7}', 'latin1'));
    expect(s.result().usage?.outputTokens).toBe(427);
  });

  it('one chunk, one byte at a time and seeded random splits all give the same result', () => {
    for (const [text, expected] of [
      [ANTHROPIC_SSE, ANTHROPIC_SSE_RESULT],
      [OPENROUTER_SSE, OPENROUTER_SSE_RESULT],
    ] as const) {
      const buf = Buffer.from(text, 'latin1');
      const one = new UsageScanner();
      one.feed(buf);
      expect(one.result()).toEqual(expected);

      const bytes = new UsageScanner();
      for (let i = 0; i < buf.length; i++) bytes.feed(buf.subarray(i, i + 1));
      expect(bytes.result()).toEqual(expected);

      const rnd = mulberry32(0xc0ffee);
      for (let round = 0; round < 60; round++) {
        const s = new UsageScanner();
        feedAll(s, randomSplit(buf, rnd, round % 2 === 0 ? 7 : 300));
        expect(s.result()).toEqual(expected);
      }
    }
  });

  it('random splits agree on a forgery-rich transcript (escaped keys, decimals, nulls, padding)', () => {
    const noisy = [
      'data: {"model":"claude-x","usage":{"input_tokens":17,"output_tokens":1}}',
      `data: {"delta":{"text":"${'\\"output_tokens\\": 555555, \\"prompt_tokens\\": 444444 '.repeat(20)}"}}`,
      `\\"output_tokens": 666666,${'.'.repeat(300)}`,
      `"output_tokens": 1.5 ${' '.repeat(40)}"input_tokens": 2.5`,
      'data: {"usage":{"input_tokens":null,"output_tokens":88}}',
      '',
    ].join('\n');
    const buf = Buffer.from(noisy, 'latin1');
    const whole = new UsageScanner();
    whole.feed(buf);
    expect(whole.result().usage).toEqual({ inputTokens: 17, outputTokens: 88, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(whole.result().model).toBe('claude-x');
    const rnd = mulberry32(12345);
    for (let round = 0; round < 200; round++) {
      const s = new UsageScanner();
      feedAll(s, randomSplit(buf, rnd, 1 + (round % 5) * 60));
      expect(s.result()).toEqual(whole.result());
    }
  });

  it('result() may be read between feeds without changing the final answer', () => {
    const buf = Buffer.from(ANTHROPIC_SSE, 'latin1');
    const rnd = mulberry32(99);
    const s = new UsageScanner();
    for (const p of randomSplit(buf, rnd, 40)) {
      s.feed(p);
      s.result();
    }
    expect(s.result()).toEqual(ANTHROPIC_SSE_RESULT);
  });

  it('result() before any feed is empty, and an empty feed changes nothing', () => {
    const s = new UsageScanner();
    expect(s.result()).toEqual({ usage: null });
    s.feed(Buffer.alloc(0));
    expect(s.result()).toEqual({ usage: null });
  });

  it('result() returns a snapshot: later feeds do not mutate an earlier result', () => {
    const s = new UsageScanner();
    s.feed(Buffer.from('{"usage":{"output_tokens":5}} ', 'latin1'));
    const early = s.result();
    s.feed(Buffer.from('{"usage":{"output_tokens":50}}', 'latin1'));
    expect(early.usage?.outputTokens).toBe(5);
    expect(s.result().usage?.outputTokens).toBe(50);
  });

  it('arbitrary binary garbage never throws', () => {
    const rnd = mulberry32(7);
    const s = new UsageScanner();
    for (let i = 0; i < 50; i++) {
      const b = Buffer.alloc(1 + Math.floor(rnd() * 4000));
      for (let j = 0; j < b.length; j++) b[j] = Math.floor(rnd() * 256);
      s.feed(b);
    }
    expect(() => s.result()).not.toThrow();
  });
});

describe('UsageScanner: scale', () => {
  it('a 20 MB body fed in 64 KiB chunks finishes fast with the right answer', () => {
    const s = new UsageScanner();
    const filler = Buffer.from(
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${'lorem ipsum '.repeat(40)}"}}\n\n`,
      'latin1',
    );
    const chunk = Buffer.alloc(64 * 1024);
    for (let off = 0; off < chunk.length; off += filler.length) filler.copy(chunk, off, 0, Math.min(filler.length, chunk.length - off));
    const started = Date.now();
    s.feed(Buffer.from('data: {"model":"claude-big","usage":{"input_tokens":11,"output_tokens":1}}\n', 'latin1'));
    for (let i = 0; i < 320; i++) s.feed(chunk); // 20 MiB
    s.feed(Buffer.from('data: {"usage":{"output_tokens":777}}\n', 'latin1'));
    const elapsed = Date.now() - started;
    expect(s.result()).toEqual({
      model: 'claude-big',
      usage: { inputTokens: 11, outputTokens: 777, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(elapsed).toBeLessThan(5000);
  });

  it('a single huge feed (20 MB in one Buffer) is handled and finds a counter at the very end', () => {
    const s = new UsageScanner();
    const big = Buffer.alloc(20 * 1024 * 1024, 0x61);
    const tail = Buffer.from(' {"usage":{"output_tokens":31337}}', 'latin1');
    tail.copy(big, big.length - tail.length);
    s.feed(big);
    expect(s.result().usage?.outputTokens).toBe(31337);
  });
});
