import type { PhaseKind, StreamChunk } from './types.js';

// ---------------------------------------------------------------------------
// Per-reqId chunk ring buffer for SSE reconnect tail.
//
// Single-replica only (Invariant J7 — the per-reqId chunk ring buffer
// itself; J8 is the Origin/CSRF allow-list, distinct concern). This buffer
// is replica-local, so the k8s chart REFUSES to render replicas > 1
// (ax-next.validateHostReplicas in deploy/charts/ax-next/templates/
// _helpers.tpl). A distributed stream broker (redis stream, postgres
// logical replication, etc.) is the tracked follow-up that would lift that
// guard; the chunk-buffer interface is the boundary the SSE handler talks
// to and stays the same shape when it lands.
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
  /**
   * Latest phase event for this reqId, or null. Phase is single-slot
   * (only one in-flight phase at a time today) and is automatically
   * evicted as soon as any content chunk lands — once the model is
   * streaming text, "Starting sandbox…" is no longer the truth.
   */
  phase: PhaseKind | null;
  /**
   * Terminal turn-error reason for this reqId, or null. Single-slot. Stored
   * so an SSE handler that attaches AFTER the orchestrator fired
   * `chat:turn-error` (the pre-SSE-connect race — acute for fast session-open
   * failures like a credential-resolution error, which reject before the
   * browser opens `/api/chat/stream/:reqId`) still replays the terminal error
   * frame on connect instead of hanging on keepalives forever. The IDLE_TTL
   * sweep reaps it like any other entry once the connect window passes.
   */
  turnError: string | null;
  /** Wall-clock ms at the most recent append. */
  lastWriteMs: number;
}

export interface ChunkBuffer {
  /** Push a chunk into the per-reqId ring. Refreshes the entry's TTL.
   *  Also evicts any pending phase slot — phase belongs to the pre-content
   *  window only, so the first content chunk supersedes it. */
  append(chunk: StreamChunk): void;
  /** Set the latest phase for a reqId. Replaces any prior phase slot.
   *  Refreshes the entry's TTL. Ignored if a content chunk has already
   *  arrived for this reqId (phase is pre-content only). */
  appendPhase(reqId: string, phase: PhaseKind): void;
  /**
   * Record the terminal turn-error reason for a reqId so an SSE handler that
   * connects after the error fired can replay it. Replaces any prior slot and
   * refreshes the entry's TTL; creates the entry if absent (the error may be
   * the very first event for this reqId — fast pre-SSE-connect failures emit
   * no chunks or phase at all).
   */
  appendTurnError(reqId: string, reason: string): void;
  /** Snapshot of the current chunks for a reqId, in insertion order. */
  tail(reqId: string): readonly StreamChunk[];
  /** Latest phase for a reqId, or null. Cleared by the first content chunk. */
  tailPhase(reqId: string): PhaseKind | null;
  /** Terminal turn-error reason for a reqId, or null. */
  tailTurnError(reqId: string): string | null;
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
          phase: null,
          turnError: null,
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
      // Once content starts streaming, the phase ("Starting sandbox…")
      // is no longer the truth. Evict so reconnects don't briefly
      // flicker back to a stale label.
      existing.phase = null;
      existing.lastWriteMs = now();
    },

    appendPhase(reqId, phase) {
      const existing = map.get(reqId);
      if (existing === undefined) {
        map.set(reqId, {
          chunks: [],
          phase,
          turnError: null,
          lastWriteMs: now(),
        });
        return;
      }
      // Already past pre-content window — phase is no longer relevant.
      if (existing.chunks.length > 0) return;
      existing.phase = phase;
      existing.lastWriteMs = now();
    },

    appendTurnError(reqId, reason) {
      const existing = map.get(reqId);
      if (existing === undefined) {
        map.set(reqId, {
          chunks: [],
          phase: null,
          turnError: reason,
          lastWriteMs: now(),
        });
        return;
      }
      existing.turnError = reason;
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

    tailPhase(reqId) {
      return map.get(reqId)?.phase ?? null;
    },

    tailTurnError(reqId) {
      return map.get(reqId)?.turnError ?? null;
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
