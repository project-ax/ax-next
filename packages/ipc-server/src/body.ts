import type * as http from 'node:http';
import { MAX_FRAME } from '@ax/core';

// ---------------------------------------------------------------------------
// Body reader
//
// Size-capped JSON body reader for the IPC listener. Enforces invariant I11
// (4 MiB cap) in two places:
//
//   1. Fails fast on Content-Length > cap BEFORE reading any body bytes.
//      This is the common case for malicious / confused clients — we never
//      allocate buffers for them.
//   2. Streams chunks into a capped Buffer; if the accumulated size crosses
//      the cap mid-flight (because the client lied in Content-Length or used
//      chunked transfer-encoding), we throw AND destroy the request.
//
// Parse errors are wrapped as BadJsonError so the listener can return a
// clean 400 without leaking the parser's internal stack. Stream errors
// propagate unchanged — they already say what they need to say.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_BODY_BYTES = MAX_FRAME;

/** The accumulated body exceeded the cap. Listener maps this to 413. */
export class TooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

/** JSON.parse failed after a successful read. Listener maps this to 400. */
export class BadJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadJsonError';
  }
}

export interface ReadBodyResult {
  value: unknown;
  bytesRead: number;
}

export async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<ReadBodyResult> {
  // ----- fail fast on declared Content-Length -----
  // Note: we only trust Content-Length to REJECT. An undersized or missing
  // header still requires mid-stream enforcement below.
  const contentLengthHeader = req.headers['content-length'];
  if (typeof contentLengthHeader === 'string' && contentLengthHeader.length > 0) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new TooLargeError(
        `content-length ${declared} exceeds cap ${maxBytes}`,
      );
    }
  }

  return new Promise<ReadBodyResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Stop receiving — don't let a malicious client fill memory by
        // ignoring our cap. destroy() severs the socket; the 'error' or
        // 'close' event handler will NOT fire a resolve because `settled`
        // is latched.
        req.destroy();
        settle(() =>
          reject(new TooLargeError(`body exceeded cap ${maxBytes} bytes`)),
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', (err) => {
      settle(() => reject(err));
    });

    req.on('end', () => {
      if (settled) return;
      const buf = Buffer.concat(chunks, total);
      let value: unknown;
      try {
        value = JSON.parse(buf.toString('utf8'));
      } catch (err) {
        settle(() =>
          reject(new BadJsonError((err as Error).message)),
        );
        return;
      }
      settle(() => resolve({ value, bytesRead: total }));
    });
  });
}
