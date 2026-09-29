// ---------------------------------------------------------------------------
// Reads token usage out of a model provider's response body (TASK-715).
//
// This is the MEASURING half of the provider meter: a passive scanner the
// response tap streams body bytes through. It never sees the request, never
// alters a byte, and never throws on input; the bytes are forwarded by someone
// else. What it must get right is small:
//
//   - O(1) memory. A response can be many MB of SSE. Only a 256-char tail of
//     the previous feed is kept, so a counter split across two feeds is still
//     found. Big feeds are processed in 64 KiB slices, so the transient string
//     is bounded too.
//   - Split-invariance. Feeding a body in one piece, byte by byte, or in random
//     pieces yields the same answer. That falls out of combining every field
//     with MAX (re-matching the overlap is harmless), plus two edge rules
//     below.
//   - Forgery resistance. Model text is quoted inside SSE `data:` payloads with
//     escaped quotes (`\"output_tokens\":9`). A key preceded by a backslash, a
//     word character or a quote does not count, so text the model writes
//     cannot forge a usage object. (Inflating your own count only hurts you.)
//
// Two edge rules that keep split-invariance honest:
//   1. A number that touches the END of the text scanned so far is not
//      counted yet (`12` may be the start of `123`, or of `1.5`). It stays in
//      the carried tail and is decided when more bytes arrive. `result()`
//      reads the tail as if the input ended there, without consuming it.
//   2. Once the tail has been cut, a match beginning at its very first char
//      has lost the look-behind context of the char before it, so it is
//      skipped: it was already judged, with context, when it was fully inside
//      the previous text.
// ---------------------------------------------------------------------------

import type { MeasuredUsage } from './provider-usage.js';

export interface ScanResult {
  /** The first `"model"` string seen, when it is made of ordinary model-name characters. */
  model?: string;
  /** Null when no counter name matched at all. */
  usage: MeasuredUsage | null;
}

/** Carried between feeds so a counter (key, colon, digits) split across two feeds is still found. */
const TAIL_CHARS = 256;
/** Bytes turned into a string at a time; bounds the transient allocation of a huge feed. */
const SLICE_BYTES = 64 * 1024;
/** No single reported count is believed beyond this. */
const CLAMP = 1_000_000_000;

// A JSON number after a quoted key. The key must not be preceded by a
// backslash (escaped string inside model output), a word char or a quote.
// `null` and decimals do not match. Up to 12 digits; longer runs do not match.
const COUNTER_RE =
  /(?<![\\\w"])"(input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens|prompt_tokens|completion_tokens|cached_tokens|cache_write_tokens)"[ \t\r\n]*:[ \t\r\n]*(\d{1,12})(?![\d.])/g;

const MODEL_RE = /(?<![\\\w"])"model"[ \t\r\n]*:[ \t\r\n]*"([A-Za-z0-9._:/@+-]{1,200})"/g;

export class UsageScanner {
  /** Per counter name, the MAX seen. Absent = never matched. */
  private readonly counters = new Map<string, number>();
  private model: string | undefined;
  private tail = '';
  /** True once `tail` no longer starts at the start of the stream. */
  private cut = false;

  /** Feed response body bytes: any number of times, at any split points. */
  feed(chunk: Buffer): void {
    for (let off = 0; off < chunk.length; off += SLICE_BYTES) {
      const end = Math.min(off + SLICE_BYTES, chunk.length);
      const text = this.tail + chunk.toString('latin1', off, end);
      this.absorb(text, false, this.counters);
      if (this.model === undefined) this.findModel(text);
      if (text.length > TAIL_CHARS) {
        this.tail = text.slice(-TAIL_CHARS);
        this.cut = true;
      } else {
        this.tail = text;
      }
    }
  }

  /** The answer so far. May be called at any time; does not consume or reset anything. */
  result(): ScanResult {
    // A number touching the end of the input is still growing, so `feed` leaves
    // it undecided. Read it here as if the input ended at the tail.
    const counters = new Map(this.counters);
    this.absorb(this.tail, true, counters);

    const usage = combine(counters);
    return this.model === undefined ? { usage } : { model: this.model, usage };
  }

  private absorb(text: string, atEnd: boolean, into: Map<string, number>): void {
    for (const m of text.matchAll(COUNTER_RE)) {
      const at = m.index ?? 0;
      if (this.cut && at === 0) continue; // lost its look-behind context; already judged
      if (!atEnd && at + m[0].length === text.length) continue; // the number may continue
      const name = m[1];
      const digits = m[2];
      if (name === undefined || digits === undefined) continue;
      const value = Math.min(Number(digits), CLAMP);
      const prev = into.get(name);
      if (prev === undefined || value > prev) into.set(name, value);
    }
  }

  private findModel(text: string): void {
    for (const m of text.matchAll(MODEL_RE)) {
      if (this.cut && (m.index ?? 0) === 0) continue;
      this.model = m[1];
      return;
    }
  }
}

function combine(counters: ReadonlyMap<string, number>): MeasuredUsage | null {
  if (counters.size === 0) return null;
  const get = (name: string): number => counters.get(name) ?? 0;

  const outputTokens = Math.max(get('output_tokens'), get('completion_tokens'));
  const cacheReadTokens = Math.max(get('cache_read_input_tokens'), get('cached_tokens'));
  const cacheWriteTokens = Math.max(get('cache_creation_input_tokens'), get('cache_write_tokens'));

  // Anthropic's `input_tokens` already EXCLUDES cache reads and writes. The
  // OpenAI-compatible `prompt_tokens` INCLUDES them, so take them back out. If
  // both styles showed up, the larger wins: over-counting is the safe side.
  let inputTokens = 0;
  const anthropicInput = counters.get('input_tokens');
  if (anthropicInput !== undefined) inputTokens = anthropicInput;
  const promptTokens = counters.get('prompt_tokens');
  if (promptTokens !== undefined) {
    inputTokens = Math.max(inputTokens, Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens));
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}
