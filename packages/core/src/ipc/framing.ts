import { PluginError } from '../errors.js';

// Length-prefixed IPC framing.
//
// Wire format: 4-byte big-endian unsigned length prefix, followed by `length`
// bytes of UTF-8 JSON. The host must never crash on malformed or oversized
// child output — all such cases surface as PluginError with code 'invalid-payload'.

export const MAX_FRAME = 4 * 1024 * 1024; // 4 MiB, applies to the JSON body length

const PREFIX_BYTES = 4;

function framingError(message: string, cause?: unknown): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: 'core',
    hookName: 'ipc',
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function encodeFrame(obj: unknown): Buffer {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_FRAME) {
    throw framingError(`frame too large: ${body.length}`);
  }
  const prefix = Buffer.alloc(PREFIX_BYTES);
  prefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([prefix, body], PREFIX_BYTES + body.length);
}

/**
 * Streaming decoder for length-prefixed frames. Feed arbitrary byte chunks;
 * receive zero or more completed frames per call.
 *
 * On error, throws PluginError. After a throw the decoder's state is
 * implementation-defined — callers should discard the decoder.
 */
export class FrameDecoder {
  // Queue of unconsumed chunks. We slice rather than rebuilding the whole
  // buffer on every feed to keep append cost amortized.
  private queue: Buffer[] = [];
  private queued = 0; // total bytes across queue

  feed(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return [];
    this.queue.push(chunk);
    this.queued += chunk.length;

    const out: unknown[] = [];
    // Loop: read prefix, check size, then read body if available.
    // We only materialize the prefix/body via a targeted concat of just the
    // bytes we need, not the whole queue.
    while (this.queued >= PREFIX_BYTES) {
      const prefix = this.peek(PREFIX_BYTES);
      const bodyLen = prefix.readUInt32BE(0);
      if (bodyLen > MAX_FRAME) {
        // Reject BEFORE consuming or allocating body bytes.
        throw framingError(`frame too large: ${bodyLen}`);
      }
      const total = PREFIX_BYTES + bodyLen;
      if (this.queued < total) break;

      // Consume prefix + body.
      this.consume(PREFIX_BYTES);
      const body = this.take(bodyLen);

      let value: unknown;
      try {
        value = JSON.parse(body.toString('utf8'));
      } catch (cause) {
        throw framingError(`malformed JSON body (length ${bodyLen})`, cause);
      }
      out.push(value);
    }
    return out;
  }

  /** Return the first `n` bytes without consuming them. n must be <= this.queued. */
  private peek(n: number): Buffer {
    const first = this.queue[0]!;
    if (first.length >= n) return first.subarray(0, n);
    // Assemble just `n` bytes.
    const parts: Buffer[] = [];
    let remaining = n;
    for (const buf of this.queue) {
      if (buf.length >= remaining) {
        parts.push(buf.subarray(0, remaining));
        remaining = 0;
        break;
      }
      parts.push(buf);
      remaining -= buf.length;
    }
    return Buffer.concat(parts, n);
  }

  /** Consume and return the first `n` bytes. n must be <= this.queued. */
  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.queue[0]!;
    if (first.length === n) {
      this.queue.shift();
      this.queued -= n;
      return first;
    }
    if (first.length > n) {
      const out = first.subarray(0, n);
      this.queue[0] = first.subarray(n);
      this.queued -= n;
      return out;
    }
    // Spans multiple chunks.
    const parts: Buffer[] = [];
    let remaining = n;
    while (remaining > 0) {
      const buf = this.queue[0]!;
      if (buf.length <= remaining) {
        parts.push(buf);
        remaining -= buf.length;
        this.queue.shift();
      } else {
        parts.push(buf.subarray(0, remaining));
        this.queue[0] = buf.subarray(remaining);
        remaining = 0;
      }
    }
    this.queued -= n;
    return Buffer.concat(parts, n);
  }

  /** Drop the first `n` bytes. */
  private consume(n: number): void {
    this.take(n);
  }
}
