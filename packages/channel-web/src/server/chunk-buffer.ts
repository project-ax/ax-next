import type { StreamChunk } from './types.js';

// ---------------------------------------------------------------------------
// Per-reqId chunk ring buffer for SSE reconnect tail.
//
// Single-replica only (Invariant J8). Tasks 13+ may swap this for a
// distributed buffer (redis stream, postgres logical replication, etc.);
// the chunk-buffer interface is the boundary the SSE handler talks to and
// stays the same shape.
//
// Capacity / TTL constants are deliberately conservative:
//
//   MAX_CHUNKS_PER_REQ_ID — 256
//     A single turn streaming at 64 byte chunks fits 16 KiB of model
//     output before the oldest is dropped. Above that, the SSE consumer
//     will lose the very start of the turn on reconnect — acceptable
//     because the client is reading live anyway and only "tail since
//     reconnect" is a soft guarantee.
//
//   IDLE_TTL_MS — 60 s
//     Time since last write before the entry is evictable. Long enough
//     to span a quick browser reconnect (refresh, tab-focus); short
//     enough that finished turns release memory promptly. The chat:
//     turn-end subscriber explicitly evicts on success so this TTL is
//     mostly the "browser closed mid-stream" path.
//
//   SWEEP_INTERVAL_MS — 30 s
//     One timer per buffer instance. Walks all entries and drops any
//     past TTL. setInterval is .unref()'d so a buffer hanging around in
//     a process that's otherwise idle doesn't keep the event loop alive.
// ---------------------------------------------------------------------------

const MAX_CHUNKS_PER_REQ_ID = 256;
const IDLE_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

interface BufferEntry {
  chunks: StreamChunk[];
  /** Wall-clock ms at the most recent append. */
  lastWriteMs: number;
}

export interface ChunkBuffer {
  /** Push a chunk into the per-reqId ring. Refreshes the entry's TTL. */
  append(chunk: StreamChunk): void;
  /** Snapshot of the current chunks for a reqId, in insertion order. */
  tail(reqId: string): readonly StreamChunk[];
  /** Drop the entry for `reqId`. Idempotent. */
  evictReqId(reqId: string): void;
  /** Stop the sweep timer. Safe to call multiple times. */
  dispose(): void;
}

export interface ChunkBufferOptions {
  /** Test seam: returns "now" in ms. Default `Date.now`. */
  now?: () => number;
  /**
   * Test seam: alternate setInterval/clearInterval. Defaults to globals.
   * setInterval is .unref()'d on the production path; tests using fake
   * timers (vitest's `vi.useFakeTimers`) work without overriding this.
   */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export function createChunkBuffer(opts: ChunkBufferOptions = {}): ChunkBuffer {
  const now = opts.now ?? (() => Date.now());
  const setIntervalFn = opts.setInterval ?? setInterval;
  const clearIntervalFn = opts.clearInterval ?? clearInterval;

  const map = new Map<string, BufferEntry>();
  let timer: ReturnType<typeof setInterval> | null = setIntervalFn(() => {
    sweep();
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive on the sweep timer alone — a host
  // that's otherwise quiescent should be allowed to exit.
  if (timer !== null && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  function sweep(): void {
    const cutoff = now() - IDLE_TTL_MS;
    for (const [reqId, entry] of map) {
      if (entry.lastWriteMs <= cutoff) {
        map.delete(reqId);
      }
    }
  }

  return {
    append(chunk) {
      const existing = map.get(chunk.reqId);
      if (existing === undefined) {
        map.set(chunk.reqId, {
          chunks: [chunk],
          lastWriteMs: now(),
        });
        return;
      }
      existing.chunks.push(chunk);
      // Hard cap — drop the oldest. Array.shift() is O(n) but n ≤ 256
      // and we only shift on overflow; not worth a circular-buffer
      // structure for this slice.
      if (existing.chunks.length > MAX_CHUNKS_PER_REQ_ID) {
        existing.chunks.splice(
          0,
          existing.chunks.length - MAX_CHUNKS_PER_REQ_ID,
        );
      }
      existing.lastWriteMs = now();
    },

    tail(reqId) {
      const entry = map.get(reqId);
      if (entry === undefined) return [];
      // Defensive copy — the caller iterates it AND we may push more
      // chunks before they finish, which would otherwise mutate their
      // snapshot mid-iteration.
      return entry.chunks.slice();
    },

    evictReqId(reqId) {
      map.delete(reqId);
    },

    dispose() {
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
    },
  };
}
