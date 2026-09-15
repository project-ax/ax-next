/**
 * The SSE wire, and nothing else (TASK-349).
 *
 * Bytes in, typed `SseFrame`s out. This module knows how a frame is framed on
 * the wire and how the TASK-23 sequence cursor works. It does not know what a
 * frame MEANS — no `UIMessageChunk`, no store, no label table, no React. Both
 * readers render their own way on top of it:
 *
 *   - `lib/transport.ts`    — chat, into AI-SDK chunks for assistant-ui.
 *   - `lib/workspace-api.ts` — the agent workspace, into plain callbacks.
 *
 * WHY IT LIVES HERE. Until now the parser was welded into `transport.ts`'s
 * chunk emission and module-private, so the workspace grew a second, dumber
 * reader over the same wire — one with no seq dedup and no gap detection, which
 * is the difference between a replayed buffer rendering twice and rendering
 * once, and between a truncated answer and a visible banner. Two parsers on one
 * wire is two things to keep in step (invariant 4).
 *
 * WHY IT LIVES *HERE* SPECIFICALLY, and not in `transport.ts` or beside a chat
 * component: TASK-360 deletes `lib/transport.ts` and the chat-only component
 * tree wholesale when the workspace becomes the only surface. A parser inside
 * either is a parser that gets deleted out from under the surface that is left.
 *
 * Wire shapes are imported from `src/server/types.ts` rather than restated.
 * That file is types-only, so the import erases at build time and costs the
 * browser bundle nothing.
 */
import type { SseFrame } from '../server/types';

/** What the caller wants to happen after it has looked at a frame. */
export type FrameVerdict =
  /** Keep reading. */
  | 'continue'
  /** The caller recognised a terminal frame (`done` / `error`) and is finished. */
  | 'stop';

/**
 * How one body's read ended. Only `stopped` means the turn reached a terminator
 * the caller understood; every other reason is a stream that ended without
 * saying so, which both callers surface rather than treating as a clean finish
 * (the FAULTA-5 rule: a silent finish is worse than a banner).
 */
export type SseReadEnd =
  /** The caller returned `'stop'`. It has already handled the terminal frame. */
  | { reason: 'stopped' }
  /** The body closed gracefully with no terminal frame (Faults B/D). */
  | { reason: 'closed' }
  /**
   * A TASK-23 sequence discontinuity: frames the client never saw are missing,
   * so the rest of this body cannot be rendered as a complete answer. The body
   * has been cancelled by the time this is returned.
   *
   *  - `truncated-head` — the FIRST seq-bearing content frame was above 1. The
   *    host always mints from 1, so the bounded per-reqId buffer dropped the
   *    head before this client ever connected.
   *  - `mid-stream` — a hole opened after content had already streamed.
   */
  | { reason: 'gap'; kind: 'truncated-head' | 'mid-stream' }
  /**
   * The read threw — a network drop mid-body, or the caller's own `onFrame`
   * throwing. The error is passed back so the caller can log it; both callers
   * treat it the same as `closed` for what the user sees.
   */
  | { reason: 'body-error'; error: unknown };

/** The `data: ` field prefix, and its length — the only wire field we read. */
const DATA_PREFIX = 'data: ';

/**
 * Read one SSE body to its end, handing every frame to `onFrame`.
 *
 * Framing: lines are split on `\n` across decoder reads (a line straddling two
 * reads is stitched through an internal carry buffer). Blank lines, `:`
 * keepalive comments and any non-`data:` field line are skipped, as is a line
 * whose payload is not JSON — the server is the source of truth, and half a
 * frame is not a frame. A trailing line with no newline is never delivered: it
 * may still be growing, and a server terminates every frame it means to send.
 *
 * Sequence handling (TASK-23) applies ONLY to content frames — the ones with a
 * top-level `kind`. Out-of-band frames (`phase`, `permissionRequest`,
 * `decisionRaised`) and the terminators (`done`, `error`) carry none, so they
 * always pass; that is what lets an approval card arrive during a replayed
 * tail. A content frame at or below the cursor is a replayed duplicate and is
 * dropped without reaching the caller. A frame that jumps the cursor is a gap:
 * the body is cancelled and the read ends (see `SseReadEnd`). Frames with no
 * numeric `seq` at all — an older server build — bypass the cursor entirely and
 * stream as before.
 *
 * Both the carry buffer and the sequence cursor are per-BODY, because a body is
 * read exactly once: `openSseStream` retries the *open*, and each successful
 * open feeds one body to one call of this function. When the automatic
 * same-reqId reconnect lands (TASK-27 / TASK-30) the cursor will need to
 * outlive a single body; it can be lifted into a caller-owned argument then,
 * rather than added now as a parameter no caller varies.
 */
export async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => FrameVerdict,
): Promise<SseReadEnd> {
  const reader = body
    .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
    .getReader();

  /** Partial trailing line carried into the next read. */
  let carry = '';
  /**
   * Highest content `seq` accepted so far. 0 = nothing seq-bearing yet, which
   * is a distinct state: the first frame is allowed to be any value only in the
   * sense that 1 is a clean start and anything above it is a truncated head.
   */
  let lastSeq = 0;

  /**
   * True once we have actively cancelled the reader for a locally-detected gap.
   * `reader.cancel()` already releases the lock, so the `finally` must NOT also
   * `releaseLock()` — that throws. Cancelling propagates up through the pipe to
   * the HTTP body, so the request actually closes; otherwise the browser leaves
   * it open and the server keeps writing into a connection nobody reads.
   */
  let cancelledForGap = false;
  const cancelForGap = async (kind: 'truncated-head' | 'mid-stream'): Promise<SseReadEnd> => {
    cancelledForGap = true;
    try {
      await reader.cancel();
    } catch {
      // Body already closed or errored — nothing to cancel.
    }
    return { reason: 'gap', kind };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // Graceful close with no terminal frame (Faults B/D). Anything left in
        // `carry` is a truncated line and is deliberately discarded.
        return { reason: 'closed' };
      }

      const lines = (carry + value).split('\n');
      carry = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith(DATA_PREFIX)) continue;

        let frame: SseFrame;
        try {
          frame = JSON.parse(trimmed.slice(DATA_PREFIX.length)) as SseFrame;
        } catch {
          // Malformed JSON — skip. The server is the source of truth.
          continue;
        }

        // TASK-23 — dedup + gap, content frames only.
        if ('kind' in frame && typeof (frame as { seq?: unknown }).seq === 'number') {
          const seq = (frame as { seq: number }).seq;
          if (seq <= lastSeq) {
            continue; // Replayed duplicate — the caller has already seen it.
          }
          if (lastSeq === 0) {
            if (seq > 1) return await cancelForGap('truncated-head');
          } else if (seq > lastSeq + 1) {
            return await cancelForGap('mid-stream');
          }
          lastSeq = seq;
        }

        if (onFrame(frame) === 'stop') return { reason: 'stopped' };
      }
    }
  } catch (error) {
    // A hard body error (network drop mid-read) with no terminal frame — or a
    // consumer that threw. Both end the read the same way; the caller decides
    // what to show, and gets the error for its log.
    return { reason: 'body-error', error };
  } finally {
    // The gap path already released the lock via `reader.cancel()`; calling
    // `releaseLock()` again would throw out of this finally block.
    if (!cancelledForGap) {
      reader.releaseLock();
    }
  }
}
