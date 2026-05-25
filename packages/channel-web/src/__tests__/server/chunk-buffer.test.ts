// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChunkBuffer } from '../../server/chunk-buffer';
import type { StreamChunk } from '../../server/types';

// Type-narrow accessor — these tests only push text/thinking variants.
const textOf = (c: StreamChunk): string =>
  c.kind === 'text' || c.kind === 'thinking' ? c.text : '';

describe('@ax/channel-web ChunkBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('append + tail returns chunks in insertion order', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
      buf.append({ reqId: 'r1', text: 'b', kind: 'text' });
      buf.append({ reqId: 'r1', text: 'c', kind: 'text' });
      const tail = buf.tail('r1');
      expect(tail.map(textOf)).toEqual(['a', 'b', 'c']);
    } finally {
      buf.dispose();
    }
  });

  it('tail returns an empty array for an unknown reqId', () => {
    const buf = createChunkBuffer();
    try {
      expect(buf.tail('r-unknown')).toEqual([]);
    } finally {
      buf.dispose();
    }
  });

  it('keyed by reqId — different reqIds do not bleed', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
      buf.append({ reqId: 'r2', text: 'B', kind: 'thinking' });
      buf.append({ reqId: 'r1', text: 'b', kind: 'text' });
      expect(buf.tail('r1').map(textOf)).toEqual(['a', 'b']);
      expect(buf.tail('r2').map(textOf)).toEqual(['B']);
    } finally {
      buf.dispose();
    }
  });

  it('hard-caps at MAX_CHUNKS_PER_REQ_ID per reqId; oldest evicted first', () => {
    // 256 cap; insert 260 → tail returns the LAST 256 in order.
    const buf = createChunkBuffer();
    try {
      for (let i = 0; i < 260; i += 1) {
        buf.append({ reqId: 'r1', text: String(i), kind: 'text' });
      }
      const tail = buf.tail('r1');
      expect(tail).toHaveLength(256);
      expect(textOf(tail[0]!)).toBe('4');
      expect(textOf(tail[255]!)).toBe('259');
    } finally {
      buf.dispose();
    }
  });

  it('evictReqId drops a single reqId; others survive', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
      buf.append({ reqId: 'r2', text: 'b', kind: 'text' });
      buf.evictReqId('r1');
      expect(buf.tail('r1')).toEqual([]);
      expect(buf.tail('r2').map(textOf)).toEqual(['b']);
    } finally {
      buf.dispose();
    }
  });

  it('evictReqId on an unknown reqId is a no-op', () => {
    const buf = createChunkBuffer();
    try {
      // Just shouldn't throw.
      buf.evictReqId('r-nope');
      expect(buf.tail('r-nope')).toEqual([]);
    } finally {
      buf.dispose();
    }
  });

  it('sweep timer evicts entries older than IDLE_TTL_MS since last write', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r-old', text: 'aged', kind: 'text' });
      // Advance past TTL (60s) and let one sweep tick (every 30s) run.
      vi.advanceTimersByTime(31_000);
      buf.append({ reqId: 'r-fresh', text: 'fresh', kind: 'text' });
      vi.advanceTimersByTime(31_000);
      // r-old was last written at t=0; now t≈62s → evicted.
      // r-fresh was written at t=31s; now t≈62s → still alive.
      expect(buf.tail('r-old')).toEqual([]);
      expect(buf.tail('r-fresh').map(textOf)).toEqual(['fresh']);
    } finally {
      buf.dispose();
    }
  });

  it('append refreshes lastWriteMs — a continuously-written reqId never evicts', () => {
    const buf = createChunkBuffer();
    try {
      // Write every 20s; sweep at 30s would otherwise drop a 60s-idle row.
      // Each append should refresh the timer so the row stays alive.
      buf.append({ reqId: 'r-live', text: 'a', kind: 'text' });
      vi.advanceTimersByTime(40_000);
      buf.append({ reqId: 'r-live', text: 'b', kind: 'text' });
      vi.advanceTimersByTime(40_000);
      buf.append({ reqId: 'r-live', text: 'c', kind: 'text' });
      vi.advanceTimersByTime(40_000);
      // After ~120s the row is still there because every gap < TTL.
      expect(buf.tail('r-live').map(textOf)).toEqual(['a', 'b', 'c']);
    } finally {
      buf.dispose();
    }
  });

  it('dispose stops the sweep timer (no leaked handle)', () => {
    const buf = createChunkBuffer();
    buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
    buf.dispose();
    // After dispose, advancing time must not do anything.
    vi.advanceTimersByTime(120_000);
    // tail still returns the seeded data because our retention map wasn't
    // touched after dispose — sweep was cancelled.
    expect(buf.tail('r1').map(textOf)).toEqual(['a']);
  });

  // -----------------------------------------------------------------------
  // Phase slot — single per-reqId, evicted as soon as any content lands.
  // Used by the SSE handler to replay "Starting sandbox…" for clients that
  // attach AFTER sandbox-k8s fired `chat:phase` but BEFORE the runner
  // started streaming content.
  // -----------------------------------------------------------------------

  it('appendPhase + tailPhase returns the latest phase for a reqId', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendPhase('r1', 'sandbox-starting');
      expect(buf.tailPhase('r1')).toBe('sandbox-starting');
    } finally {
      buf.dispose();
    }
  });

  it('tailPhase is null for unknown reqIds and reqIds with no phase yet', () => {
    const buf = createChunkBuffer();
    try {
      expect(buf.tailPhase('r-unknown')).toBeNull();
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
      expect(buf.tailPhase('r1')).toBeNull();
    } finally {
      buf.dispose();
    }
  });

  it('first content chunk evicts the phase (phase is pre-content only)', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendPhase('r1', 'sandbox-starting');
      expect(buf.tailPhase('r1')).toBe('sandbox-starting');
      buf.append({ reqId: 'r1', text: 'hi', kind: 'text' });
      expect(buf.tailPhase('r1')).toBeNull();
      // Content is intact; only the phase slot was cleared.
      expect(buf.tail('r1').map(textOf)).toEqual(['hi']);
    } finally {
      buf.dispose();
    }
  });

  it('appendPhase is ignored once content has arrived', () => {
    // Race protection: a stray phase event arriving after the model
    // already started streaming should not relabel the row.
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'hi', kind: 'text' });
      buf.appendPhase('r1', 'sandbox-starting');
      expect(buf.tailPhase('r1')).toBeNull();
    } finally {
      buf.dispose();
    }
  });

  it('phase is keyed by reqId — different reqIds do not bleed', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendPhase('r1', 'sandbox-starting');
      expect(buf.tailPhase('r2')).toBeNull();
      buf.append({ reqId: 'r2', text: 'a', kind: 'text' });
      // r1 phase still set; r2's content didn't touch it.
      expect(buf.tailPhase('r1')).toBe('sandbox-starting');
    } finally {
      buf.dispose();
    }
  });

  it('evictReqId clears the phase along with chunks', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendPhase('r1', 'sandbox-starting');
      buf.evictReqId('r1');
      expect(buf.tailPhase('r1')).toBeNull();
      expect(buf.tail('r1')).toEqual([]);
    } finally {
      buf.dispose();
    }
  });

  // TASK-22 — terminal turn-error replay slot. Stored so an SSE handler that
  // connects AFTER the orchestrator fired chat:turn-error (the pre-SSE-connect
  // race, acute for fast credential/session-open failures) still replays the
  // error frame instead of hanging.
  it('appendTurnError + tailTurnError returns the stored reason', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendTurnError('r1', 'proxy-open-failed');
      expect(buf.tailTurnError('r1')).toBe('proxy-open-failed');
    } finally {
      buf.dispose();
    }
  });

  it('tailTurnError is null for unknown reqIds and reqIds with no error yet', () => {
    const buf = createChunkBuffer();
    try {
      expect(buf.tailTurnError('r-unknown')).toBeNull();
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
      expect(buf.tailTurnError('r1')).toBeNull();
    } finally {
      buf.dispose();
    }
  });

  it('appendTurnError creates an entry when the error is the very first event', () => {
    // Fast pre-SSE-connect failures emit no chunks or phase at all — the
    // turn-error is the only event for the reqId, so the slot must self-create.
    const buf = createChunkBuffer();
    try {
      buf.appendTurnError('r-fast', 'proxy-open-failed');
      expect(buf.tailTurnError('r-fast')).toBe('proxy-open-failed');
      expect(buf.tail('r-fast')).toEqual([]);
    } finally {
      buf.dispose();
    }
  });

  it('turn-error is keyed by reqId — different reqIds do not bleed', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendTurnError('r1', 'proxy-open-failed');
      expect(buf.tailTurnError('r2')).toBeNull();
      expect(buf.tailTurnError('r1')).toBe('proxy-open-failed');
    } finally {
      buf.dispose();
    }
  });

  it('evictReqId clears a stored turn-error', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendTurnError('r1', 'proxy-open-failed');
      buf.evictReqId('r1');
      expect(buf.tailTurnError('r1')).toBeNull();
    } finally {
      buf.dispose();
    }
  });

  it('sweep timer reaps a stored turn-error after IDLE_TTL (connect window closed)', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendTurnError('r1', 'proxy-open-failed');
      expect(buf.tailTurnError('r1')).toBe('proxy-open-failed');
      // Past IDLE_TTL_MS (60s) + a sweep interval (30s) → entry reaped.
      vi.advanceTimersByTime(91_000);
      expect(buf.tailTurnError('r1')).toBeNull();
    } finally {
      buf.dispose();
    }
  });

  // -----------------------------------------------------------------------
  // TASK-23 — per-chunk monotonic sequence number for loss-free silent
  // turn-resume. `append` mints the next per-reqId seq (1-based), stamps it
  // on the buffered frame, and RETURNS the stamped frame so the buffer-fill
  // subscriber can propagate the same seq to live SSE listeners. The client
  // dedups replayed frames at/below its last-seen seq.
  // -----------------------------------------------------------------------

  it('append mints a 1-based monotonic seq per reqId and returns the stamped frame', () => {
    const buf = createChunkBuffer();
    try {
      const a = buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
      const b = buf.append({ reqId: 'r1', text: 'b', kind: 'text' });
      const c = buf.append({ reqId: 'r1', text: 'c', kind: 'text' });
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(c.seq).toBe(3);
    } finally {
      buf.dispose();
    }
  });

  it('seq is independent per reqId (each starts at 1)', () => {
    const buf = createChunkBuffer();
    try {
      expect(buf.append({ reqId: 'r1', text: 'a', kind: 'text' }).seq).toBe(1);
      expect(buf.append({ reqId: 'r2', text: 'A', kind: 'text' }).seq).toBe(1);
      expect(buf.append({ reqId: 'r1', text: 'b', kind: 'text' }).seq).toBe(2);
      expect(buf.append({ reqId: 'r2', text: 'B', kind: 'text' }).seq).toBe(2);
    } finally {
      buf.dispose();
    }
  });

  it('tail returns frames carrying their stored seq', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
      buf.append({ reqId: 'r1', text: 'b', kind: 'text' });
      const tail = buf.tail('r1');
      expect(tail.map((c) => c.seq)).toEqual([1, 2]);
    } finally {
      buf.dispose();
    }
  });

  it('seq survives the MAX_CHUNKS cap shift — it keeps counting past the dropped head', () => {
    // Insert 260 with a 256 cap: the buffer drops the oldest 4, but seq keeps
    // climbing monotonically. The retained tail's first frame is seq 5 and the
    // last is seq 260 — so a reconnecting client sees a HOLE (its last-seen seq
    // is below 5) and falls back to the banner (the loss-detection contract).
    const buf = createChunkBuffer();
    try {
      let last: number | undefined;
      for (let i = 0; i < 260; i += 1) {
        last = buf.append({ reqId: 'r1', text: String(i), kind: 'text' }).seq;
      }
      expect(last).toBe(260);
      const tail = buf.tail('r1');
      expect(tail).toHaveLength(256);
      expect(tail[0]!.seq).toBe(5);
      expect(tail[255]!.seq).toBe(260);
    } finally {
      buf.dispose();
    }
  });

  it('a recycled reqId after eviction re-seeds seq at 1 (a fresh turn starts over)', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' });
      expect(buf.append({ reqId: 'r1', text: 'b', kind: 'text' }).seq).toBe(2);
      buf.evictReqId('r1');
      // Entry gone → the next append re-creates it and the counter restarts.
      expect(buf.append({ reqId: 'r1', text: 'fresh', kind: 'text' }).seq).toBe(1);
    } finally {
      buf.dispose();
    }
  });
});
