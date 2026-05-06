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
});
