// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChunkBuffer } from '../../server/chunk-buffer';
import type { PermissionRequest, StreamChunk } from '../../server/types';

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
      expect(buf.tailTurnError('r1')).toEqual({ reason: 'proxy-open-failed' });
    } finally {
      buf.dispose();
    }
  });

  // TASK-160 — the optional author-facing detail (dev-service-sidecar
  // self-diagnosis) is stored + replayed alongside the reason.
  it('appendTurnError carries an optional detail line for replay', () => {
    const buf = createChunkBuffer();
    try {
      buf.appendTurnError(
        'r1',
        'dev-service-failed',
        "Dev service 'kafka' couldn't write /opt/kafka (read-only filesystem) — add /opt/kafka to the service's writablePaths.",
      );
      expect(buf.tailTurnError('r1')).toEqual({
        reason: 'dev-service-failed',
        detail:
          "Dev service 'kafka' couldn't write /opt/kafka (read-only filesystem) — add /opt/kafka to the service's writablePaths.",
      });
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
      expect(buf.tailTurnError('r-fast')).toEqual({ reason: 'proxy-open-failed' });
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
      expect(buf.tailTurnError('r1')).toEqual({ reason: 'proxy-open-failed' });
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
      expect(buf.tailTurnError('r1')).toEqual({ reason: 'proxy-open-failed' });
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

  // Codex P1 (TASK-23): the IDLE_TTL sweep used to fully delete a still-live
  // reqId entry (e.g. a >60s-quiet tool call mid-turn), and the NEXT live chunk
  // recreated it at seq 1. A browser still connected with lastSeq > 0 would then
  // treat that reset seq as a duplicate and SILENTLY DROP the chunk (and every
  // chunk until the counter caught up) — exactly the silent loss this task
  // exists to prevent. The sweep must reclaim the heavy chunk array but KEEP the
  // monotonic seq cursor alive; only evictReqId (the real turn-end) resets it.
  it('TTL sweep reclaims chunks but KEEPS the seq cursor monotonic (no mid-turn reset)', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' }); // seq 1
      expect(buf.append({ reqId: 'r1', text: 'b', kind: 'text' }).seq).toBe(2);
      // A long-quiet tool call: no append for >IDLE_TTL while the SSE
      // connection is still open. The sweep runs and reclaims the chunks.
      vi.advanceTimersByTime(91_000);
      expect(buf.tail('r1')).toEqual([]); // chunk memory reclaimed
      // The next live chunk MUST continue the cursor (seq 3), NOT reset to 1 —
      // otherwise a connected client silently dedups it.
      expect(buf.append({ reqId: 'r1', text: 'c', kind: 'text' }).seq).toBe(3);
    } finally {
      buf.dispose();
    }
  });

  it('evictReqId (true turn-end) DOES reset the cursor even after a prior TTL sweep', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' }); // seq 1
      vi.advanceTimersByTime(91_000); // TTL sweep keeps the cursor
      buf.append({ reqId: 'r1', text: 'b', kind: 'text' }); // seq 2 (continued)
      buf.evictReqId('r1'); // real turn-end → full reset
      expect(buf.append({ reqId: 'r1', text: 'fresh', kind: 'text' }).seq).toBe(1);
    } finally {
      buf.dispose();
    }
  });

  // Codex P2 (TASK-23): a content turn that ends via chat:turn-error with NO
  // SSE listener attached stores the error (turn-error-fill subscriber) but no
  // per-connection evictor runs. On TTL the entry must be FULLY DELETED (the
  // seq cursor is dead — no chunks follow a turn-error), not preserved as a
  // cursor shell forever, which would leak one entry per abandoned failed turn.
  it('TTL sweep fully reaps a content entry that ended with a stored turn-error (no shell leak)', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'partial', kind: 'text' }); // seq 1, content
      buf.appendTurnError('r1', 'sandbox-terminated'); // terminal error, no listener
      expect(buf.tailTurnError('r1')).toEqual({ reason: 'sandbox-terminated' });
      // Past TTL + a sweep → the terminated entry is GONE, not a lingering shell.
      vi.advanceTimersByTime(91_000);
      expect(buf.tailTurnError('r1')).toBeNull();
      expect(buf.tail('r1')).toEqual([]);
      // Proof it was a FULL delete (not a kept cursor shell): a recycled reqId
      // re-seeds at seq 1.
      expect(buf.append({ reqId: 'r1', text: 'new-turn', kind: 'text' }).seq).toBe(1);
    } finally {
      buf.dispose();
    }
  });

  // Codex P2 (TASK-23): a cursor-only shell that is NEVER revived or evicted
  // (a runner crashed before firing any terminal hook) must not leak forever —
  // it's reaped once it ages past the shell ceiling (default 15 min).
  it('an orphaned cursor shell is reaped after the default shell ceiling (no permanent leak)', () => {
    const buf = createChunkBuffer();
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' }); // seq 1 → cursor exists
      // First sweep past IDLE_TTL converts it to a cursor-only shell (kept).
      vi.advanceTimersByTime(91_000);
      // Still a live cursor: a revival continues monotonically.
      // (We don't revive it here — we let it age out as an orphan instead.)
      // Advance well past the 15-min default shell ceiling with no revival/evict.
      vi.advanceTimersByTime(16 * 60_000);
      // The orphaned shell is gone → a recycled reqId re-seeds at seq 1.
      expect(buf.append({ reqId: 'r1', text: 'new', kind: 'text' }).seq).toBe(1);
    } finally {
      buf.dispose();
    }
  });

  // Codex P2 round 2 (TASK-23): the shell ceiling is configurable so it can be
  // sized ABOVE an operator-raised chat timeout. A still-live quiet turn whose
  // shell age is below the configured ceiling must KEEP its cursor (no reset →
  // no silent loss); only past the configured ceiling is it reaped.
  it('shellMaxAgeMs is honored — a shell below the configured ceiling keeps its cursor', () => {
    // 30-min ceiling (e.g. AX_CHAT_TIMEOUT_MS raised to 25 min + slack).
    const buf = createChunkBuffer({ shellMaxAgeMs: 30 * 60_000 });
    try {
      buf.append({ reqId: 'r1', text: 'a', kind: 'text' }); // seq 1
      vi.advanceTimersByTime(91_000); // → cursor-only shell
      // 20 min later (past the 15-min default, but UNDER the 30-min config):
      // the cursor MUST survive, so a revival continues at seq 2 — not reset to 1.
      vi.advanceTimersByTime(20 * 60_000);
      expect(buf.append({ reqId: 'r1', text: 'b', kind: 'text' }).seq).toBe(2);
    } finally {
      buf.dispose();
    }
  });

  // TASK-82 — durable pending JIT approval cards. These back the SSE replay
  // path that recovers a card lost to the cold-boot delivery race.
  describe('pending permission cards (TASK-82)', () => {
    const skill = (skillId: string) =>
      ({
        kind: 'skill' as const,
        skillId,
        description: 'd',
        hosts: ['api.example.com'],
        slots: [{ slot: 'KEY', kind: 'api-key' as const }],
      });

    it('appendPermissionCard + tailPermissionCards round-trips by conversationId', () => {
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('cnv1', skill('s1'));
        buf.appendPermissionCard('cnv1', skill('s2'));
        const cards = buf.tailPermissionCards('cnv1');
        expect(cards.map((c) => (c.kind === 'skill' ? c.skillId : ''))).toEqual([
          's1',
          's2',
        ]);
        expect(buf.tailPermissionCards('cnv-unknown')).toEqual([]);
      } finally {
        buf.dispose();
      }
    });

    it('de-dupes by skillId — a re-proposal replaces in place, never stacks', () => {
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('cnv1', skill('s1'));
        buf.appendPermissionCard('cnv1', {
          ...skill('s1'),
          hosts: ['api.example.com', 'extra.example.com'],
        });
        const cards = buf.tailPermissionCards('cnv1');
        expect(cards).toHaveLength(1);
        expect(cards[0]?.kind === 'skill' ? cards[0].hosts : []).toEqual([
          'api.example.com',
          'extra.example.com',
        ]);
      } finally {
        buf.dispose();
      }
    });

    it('evictPermissionCard removes one resolved skill card (grant applied)', () => {
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('cnv1', skill('s1'));
        buf.appendPermissionCard('cnv1', skill('s2'));
        buf.evictPermissionCard('cnv1', 's1');
        const cards = buf.tailPermissionCards('cnv1');
        expect(cards.map((c) => (c.kind === 'skill' ? c.skillId : ''))).toEqual([
          's2',
        ]);
        // Idempotent — evicting an absent skill is a no-op.
        buf.evictPermissionCard('cnv1', 's-absent');
        expect(buf.tailPermissionCards('cnv1')).toHaveLength(1);
      } finally {
        buf.dispose();
      }
    });

    it('evictConversationCards drops every card for a deleted conversation', () => {
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('cnv1', skill('s1'));
        buf.appendPermissionCard('cnv1', skill('s2'));
        buf.evictConversationCards('cnv1');
        expect(buf.tailPermissionCards('cnv1')).toEqual([]);
      } finally {
        buf.dispose();
      }
    });

    // TASK-112 — connector cards are conversationId-matched (like skill cards),
    // so they ride the SAME replay buffer + eviction. A connector card raised
    // during the cold-boot SSE race would otherwise be lost (un-approvable).
    const connector = (connectorId: string) =>
      ({
        kind: 'connector' as const,
        connectorId,
        name: connectorId,
        hosts: ['api.example.com'],
        slots: [{ slot: 'KEY', kind: 'api-key' as const }],
        authored: true as const,
        packages: { npm: [], pypi: [] },
      });

    it('connector cards round-trip by conversationId alongside skill cards', () => {
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('cnv1', skill('s1'));
        buf.appendPermissionCard('cnv1', connector('linear'));
        const cards = buf.tailPermissionCards('cnv1');
        expect(cards).toHaveLength(2);
        expect(cards[1]?.kind).toBe('connector');
        expect(cards[1]?.kind === 'connector' ? cards[1].connectorId : '').toBe(
          'linear',
        );
      } finally {
        buf.dispose();
      }
    });

    it('de-dupes connector cards by connectorId — a re-proposal replaces in place', () => {
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('cnv1', connector('linear'));
        buf.appendPermissionCard('cnv1', {
          ...connector('linear'),
          hosts: ['api.linear.app', 'extra.linear.app'],
        });
        const cards = buf.tailPermissionCards('cnv1');
        expect(cards).toHaveLength(1);
        expect(cards[0]?.kind === 'connector' ? cards[0].hosts : []).toEqual([
          'api.linear.app',
          'extra.linear.app',
        ]);
      } finally {
        buf.dispose();
      }
    });

    it('evictPermissionCard removes a resolved connector card by connectorId', () => {
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('cnv1', connector('linear'));
        buf.appendPermissionCard('cnv1', skill('s1'));
        buf.evictPermissionCard('cnv1', 'linear');
        const cards = buf.tailPermissionCards('cnv1');
        expect(cards).toHaveLength(1);
        expect(cards[0]?.kind).toBe('skill');
      } finally {
        buf.dispose();
      }
    });

    it('host cards key off reqId and are dropped at the turn boundary (evictReqId)', () => {
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('r1', {
          kind: 'host',
          host: 'h.example.com',
          sessionId: 's1',
        });
        expect(buf.tailHostCards('r1')).toHaveLength(1);
        buf.evictReqId('r1');
        expect(buf.tailHostCards('r1')).toEqual([]);
      } finally {
        buf.dispose();
      }
    });

    it('pending skill cards SURVIVE the IDLE_TTL sweep (a human may take minutes)', () => {
      vi.useFakeTimers();
      const buf = createChunkBuffer();
      try {
        buf.appendPermissionCard('cnv1', skill('s1'));
        // Well past the chunk IDLE_TTL (60s) and several sweep ticks (30s).
        vi.advanceTimersByTime(5 * 60_000);
        expect(buf.tailPermissionCards('cnv1')).toHaveLength(1);
      } finally {
        buf.dispose();
        vi.useRealTimers();
      }
    });

    it('caps the per-conversation card list, dropping the oldest on overflow', () => {
      const buf = createChunkBuffer();
      try {
        // Push 20 distinct skill cards — the cap is 16.
        for (let i = 0; i < 20; i++) buf.appendPermissionCard('cnv1', skill(`s${i}`));
        const cards = buf.tailPermissionCards('cnv1');
        expect(cards).toHaveLength(16);
        // Oldest (s0..s3) dropped; the tail retains s4..s19.
        expect(cards[0]?.kind === 'skill' ? cards[0].skillId : '').toBe('s4');
        expect(cards[15]?.kind === 'skill' ? cards[15].skillId : '').toBe('s19');
      } finally {
        buf.dispose();
      }
    });
  });
});

/*
  TASK-373 — reading back "grants waiting on ME".

  The buffer already kept pending conversation-keyed cards alive past the turn
  (they are exempt from the IDLE_TTL sweep). What it could not do was answer the
  question the Today queue asks, because `skillCards` is keyed by conversation
  and nothing recorded whose conversation it was.

  The owner is recorded by the PRODUCER, which holds an `AgentContext`. That is
  the whole security posture of the feature: the filter runs against identity
  the host wrote down, never against anything a reader supplies.
*/
describe('pendingGrantsForUser', () => {
  const skill = (skillId: string): PermissionRequest => ({
    kind: 'skill',
    skillId,
    description: '',
    hosts: [],
    slots: [],
  });

  it('returns a user their own pending grants, with the conversation and agent', () => {
    const buf = createChunkBuffer();
    buf.appendPermissionCard('cnv-1', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });

    expect(buf.pendingGrantsForUser('u-ann')).toEqual([
      {
        conversationId: 'cnv-1',
        agentId: 'a-quill',
        card: skill('linear'),
        raisedAt: expect.any(Number),
      },
    ]);
  });

  it('a conversation delete drops the owner with the cards', () => {
    // evictConversationCards fires on conversation delete (plugin.ts). If it
    // left the owner behind, the map grows one entry per deleted conversation
    // that ever held a card — and a later OWNERLESS append to the same key
    // would inherit the stale owner and become enumerable to a user who was
    // never asked. This pins the second half, which is the dangerous one.
    const buf = createChunkBuffer();
    buf.appendPermissionCard('cnv-1', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });
    buf.evictConversationCards('cnv-1');

    buf.appendPermissionCard('cnv-1', skill('github'));

    expect(buf.pendingGrantsForUser('u-ann')).toEqual([]);
  });

  it('never returns another user their grants', () => {
    // The leak this exists to prevent: skill ids, connector names and hostnames
    // are all readable from a card, and they belong to somebody.
    const buf = createChunkBuffer();
    buf.appendPermissionCard('cnv-ann', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });
    buf.appendPermissionCard('cnv-bob', skill('github'), {
      userId: 'u-bob',
      agentId: 'a-scout',
    });

    expect(buf.pendingGrantsForUser('u-ann')).toEqual([
      {
        conversationId: 'cnv-ann',
        agentId: 'a-quill',
        card: skill('linear'),
        raisedAt: expect.any(Number),
      },
    ]);
    expect(buf.pendingGrantsForUser('u-bob')).toEqual([
      {
        conversationId: 'cnv-bob',
        agentId: 'a-scout',
        card: skill('github'),
        raisedAt: expect.any(Number),
      },
    ]);
  });

  it('drops a card nobody owns rather than showing it to whoever asked', () => {
    // A card buffered without an owner (a canary probe, an ephemeral admin
    // path) is still replayable on its own stream — it is simply not
    // attributable, and guessing is the failure mode.
    const buf = createChunkBuffer();
    buf.appendPermissionCard('cnv-1', skill('linear'));

    expect(buf.pendingGrantsForUser('u-ann')).toEqual([]);
    // Still replayable the old way, on the conversation it belongs to.
    expect(buf.tailPermissionCards('cnv-1')).toHaveLength(1);
  });

  it('excludes host cards — a stale wall offers an answer that would do nothing', () => {
    // `proxy:add-host` widens the LIVE session's allowlist, so "just this once"
    // after the turn has ended reports success and changes nothing. TASK-375.
    const buf = createChunkBuffer();
    buf.appendPermissionCard(
      'req-1',
      { kind: 'host', host: 'example.org', sessionId: 's-1' },
      { userId: 'u-ann', agentId: 'a-quill' },
    );

    expect(buf.pendingGrantsForUser('u-ann')).toEqual([]);
    // But it is still replayable on its own turn's stream, as before.
    expect(buf.tailHostCards('req-1')).toHaveLength(1);
  });

  it('returns every pending grant across the user’s conversations', () => {
    const buf = createChunkBuffer();
    buf.appendPermissionCard('cnv-1', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });
    buf.appendPermissionCard('cnv-2', skill('github'), {
      userId: 'u-ann',
      agentId: 'a-scout',
    });

    const got = buf.pendingGrantsForUser('u-ann');
    expect(got).toHaveLength(2);
    expect(got.map((g) => g.agentId).sort()).toEqual(['a-quill', 'a-scout']);
  });

  it('stops returning a grant once it is answered', () => {
    // Eviction already existed and is wired to the decision route; this pins
    // that the new read path honours it rather than keeping a second copy.
    const buf = createChunkBuffer();
    buf.appendPermissionCard('cnv-1', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });
    buf.evictPermissionCard('cnv-1', 'linear');

    expect(buf.pendingGrantsForUser('u-ann')).toEqual([]);
  });

  it('a re-proposal stays one grant, and refreshes the owner', () => {
    const buf = createChunkBuffer();
    buf.appendPermissionCard('cnv-1', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });
    buf.appendPermissionCard('cnv-1', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });

    expect(buf.pendingGrantsForUser('u-ann')).toHaveLength(1);
  });

  it('an empty user id matches nothing — even a card stored with one', () => {
    /*
      The shape where a missing identity quietly becomes a wildcard.

      An earlier version of this test queried `''` against a card owned by
      `u-ann` and asserted an empty result — which the `userId` comparison gives
      you anyway, so it passed with the guard deleted and pinned nothing. The
      case the guard actually covers is an owner recorded with an EMPTY id
      (`ctx.userId` is typed non-optional but nothing enforces non-empty at
      runtime): without it, one unattributed card plus one unauthenticated read
      match each other.
    */
    const buf = createChunkBuffer();
    buf.appendPermissionCard('cnv-1', skill('linear'), {
      userId: '',
      agentId: 'a-quill',
    });

    expect(buf.pendingGrantsForUser('')).toEqual([]);
  });

  describe('raisedAt (TASK-444)', () => {
    /*
      `raisedAt` is the whole need-trigger. A durable "Not now" marker carries
      the instant the person refused; a pending card carries the instant it was
      raised; the grants read drops the card only while the refusal is the
      NEWER of the two. So the stamp has to be honest about one thing above all
      — a re-proposal is a fresh ask, not the old one still hanging around.
    */
    it('stamps raisedAt from the injected clock when a card is first buffered', () => {
      let clock = 5_000;
      const buf = createChunkBuffer({ now: () => clock });
      buf.appendPermissionCard('cnv-1', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });
      clock = 9_999;

      expect(buf.pendingGrantsForUser('u-ann')[0]?.raisedAt).toBe(5_000);
    });

    it('a re-proposal of the SAME subject bumps raisedAt — it is a fresh need', () => {
      /*
        The replace-in-place branch. If it kept the original instant, a grant
        the agent genuinely needs again would stay suppressed by an older
        decline forever — the deferral would silently become a permanent no,
        which is the one outcome "Not now" must never mean.
      */
      let clock = 5_000;
      const buf = createChunkBuffer({ now: () => clock });
      buf.appendPermissionCard('cnv-1', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });
      clock = 7_500;
      buf.appendPermissionCard('cnv-1', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      const rows = buf.pendingGrantsForUser('u-ann');
      // Still ONE grant (the dedupe is unchanged)...
      expect(rows).toHaveLength(1);
      // ...carrying the LATER instant.
      expect(rows[0]?.raisedAt).toBe(7_500);
    });

    it('tailPermissionCards still hands back plain cards, with no bookkeeping on them', () => {
      /*
        `raisedAt` is OURS. The same card object is what the SSE replay writes
        to the browser, so a bookkeeping field leaking onto it would ship a
        server-side instant to the client and make the fetched grant and the
        streamed grant of one subject disagree byte for byte.
      */
      const buf = createChunkBuffer({ now: () => 5_000 });
      buf.appendPermissionCard('cnv-1', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      const cards = buf.tailPermissionCards('cnv-1');
      expect(cards).toEqual([skill('linear')]);
      expect(Object.keys(cards[0] ?? {})).not.toContain('raisedAt');
    });
  });
});
