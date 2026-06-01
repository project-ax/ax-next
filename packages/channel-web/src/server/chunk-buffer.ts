import type { PermissionRequest, PhaseKind, StreamChunk } from './types.js';

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

// Ceiling on how many distinct pending approval cards we retain per
// conversation. A turn proposes at most a handful of cap-bearing skills; this
// bound just stops a pathological loop (an agent re-proposing endlessly) from
// growing the per-conversation card list without limit. Oldest is dropped on
// overflow. Cards are keyed by skillId, so a re-proposal of the SAME skill
// updates in place and never counts twice (see appendPermissionCard).
const MAX_PENDING_CARDS_PER_CONV = 16;

// DEFAULT ceiling on how long a cursor-only shell (a TTL-reclaimed entry whose
// monotonic seq we keep so a still-live quiet turn doesn't reset to 1 — Codex
// P1) may linger without being revived or explicitly evicted, used when the
// caller doesn't pass `shellMaxAgeMs`. A real turn fires its terminal
// chat:turn-end / chat:turn-error within the chat run timeout
// (DEFAULT_CHAT_TIMEOUT_MS = 10 min in @ax/chat-orchestrator), which evicts the
// reqId; this default sits comfortably above that so a legitimately-quiet live
// turn is never dropped early, while a genuinely orphaned shell — a runner that
// crashed before firing any terminal hook, or a malformed event — is still
// reaped instead of leaking one map entry per abandoned reqId (Codex P2). When
// operators raise AX_CHAT_TIMEOUT_MS above this, the channel-web plugin passes a
// larger `shellMaxAgeMs` derived from that timeout so the ceiling always stays
// above the max live turn duration (Codex P2 round 2).
const SHELL_MAX_AGE_MS = 15 * 60_000;

interface BufferEntry {
  chunks: StreamChunk[];
  /**
   * Next per-reqId monotonic sequence number to mint (1-based). Incremented on
   * every `append` and stamped onto the buffered frame (TASK-23). Keeps
   * climbing past the MAX_CHUNKS cap drop, so a client whose last-seen seq
   * falls below the retained tail's first seq detects the hole and falls back
   * to the visible banner rather than silently rendering a truncated reply.
   *
   * It also SURVIVES the IDLE_TTL sweep (the entry becomes a lightweight
   * cursor-only shell — see `reclaimed`) so a still-live turn that goes quiet
   * past the TTL (e.g. a long tool call) never has its counter reset to 1
   * underneath a connected client — a reset would make the client silently
   * dedup the post-quiet chunks as duplicates. Only `evictReqId` (the real
   * turn-end / turn-error boundary) resets the cursor.
   */
  nextSeq: number;
  /**
   * True once the IDLE_TTL sweep has reclaimed this entry's heavy fields
   * (chunk array, phase, turn-error) but KEPT the `nextSeq` cursor alive
   * (Codex P1, TASK-23). A reclaimed shell holds only the monotonic cursor; it
   * is NOT swept on the normal IDLE_TTL cadence (that would reset seq mid-turn)
   * — it is dropped by `evictReqId` (the real turn boundary), by a later stored
   * turn-error, or, as a backstop against a runner that crashed before firing
   * any terminal hook, once it ages past SHELL_MAX_AGE_MS (see `reclaimedAtMs`).
   * FAULTA-5 guarantees every turn fires a terminal chat:turn-end /
   * chat:turn-error, which evicts the reqId, so shells are reliably reclaimed at
   * turn end and don't accumulate in the common case.
   */
  reclaimed: boolean;
  /**
   * Wall-clock ms when this entry became a reclaimed cursor-only shell, or null
   * if it isn't a shell. The sweep drops a shell once it's older than
   * SHELL_MAX_AGE_MS so a genuinely orphaned shell (a runner that crashed before
   * firing any terminal hook) can't leak indefinitely (Codex P2). Reset to null
   * when a new chunk revives the shell.
   */
  reclaimedAtMs: number | null;
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
  /** Push a chunk into the per-reqId ring. Mints + stamps the next per-reqId
   *  monotonic `seq` (1-based; TASK-23) and RETURNS the seq-stamped frame so
   *  the buffer-fill subscriber can propagate the SAME seq to live SSE
   *  listeners (the dedup cursor must be identical on the replay and live
   *  paths). Refreshes the entry's TTL. Also evicts any pending phase slot —
   *  phase belongs to the pre-content window only, so the first content chunk
   *  supersedes it. */
  append(chunk: StreamChunk): StreamChunk;
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
  /** Drop the entry for `reqId`. Idempotent. Also drops any pending host
   *  approval card stored under this reqId (host cards are session/turn-scoped
   *  — once the turn ends the reactive-wall card is no longer live). */
  evictReqId(reqId: string): void;
  /**
   * Record a pending JIT approval card so an SSE handler that connects (or
   * reconnects) AFTER the card fired can replay it. This is the durable
   * delivery store for `chat:permission-request` — the live per-connection
   * subscriber in sse.ts only reaches an ALREADY-attached stream, so a card
   * raised during the cold-boot window (every gated turn cold-spawns a runner
   * pod, and the SSE GET races that boot) would otherwise be lost forever — and
   * the orchestrator's per-conversation dedup then suppresses re-emission, so
   * the pending cap-skill becomes permanently un-approvable (TASK-82).
   *
   * Skill cards are keyed by `conversationId` (the SSE skill match key — the
   * firing ctx carries the real conversationId; its reqId is fresh) + `skillId`
   * (a re-proposal of the same skill replaces in place — never duplicates).
   * Host cards are keyed by the routing `reqId` carried on the payload (the SSE
   * host match key) + host. Unlike the chunk/phase/turn-error slots, skill
   * cards are NOT reaped by the IDLE_TTL sweep — a pending approval legitimately
   * outlives the turn (the human may take minutes) and is only cleared by
   * `evictPermissionCard` on grant or by conversation eviction. Host cards ride
   * the turn and are dropped by `evictReqId` at the turn boundary.
   */
  appendPermissionCard(key: string, card: PermissionRequest): void;
  /**
   * Snapshot of pending skill cards for a conversation, in insertion order.
   * Empty when none. The SSE handler replays these on stream open keyed by
   * conversationId.
   */
  tailPermissionCards(conversationId: string): readonly PermissionRequest[];
  /**
   * Snapshot of pending host cards for a routing reqId, in insertion order.
   * Empty when none. The SSE handler replays these on stream open keyed by the
   * connection reqId.
   */
  tailHostCards(reqId: string): readonly PermissionRequest[];
  /**
   * Drop one pending conversation-keyed card by its SUBJECT id — a skill's
   * skillId OR a connector's connectorId (TASK-112). Called when the grant is
   * applied (the card is resolved — replaying it would re-prompt for an
   * already-approved subject). Idempotent.
   */
  evictPermissionCard(conversationId: string, subjectId: string): void;
  /** Drop all pending skill cards for a conversation. Called on conversation
   *  delete. Idempotent. */
  evictConversationCards(conversationId: string): void;
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
  /**
   * Max age (ms) of a reclaimed cursor-only shell before the sweep reaps it as
   * an orphan (TASK-23 / Codex P2). MUST exceed the maximum live turn duration
   * — i.e. the configured chat timeout — or a legitimately-quiet-but-still-live
   * turn could have its seq cursor reset to 1 mid-turn, silently dropping
   * output for a connected client. The channel-web plugin derives this from its
   * `chatTimeoutMs` config (+ slack); defaults to SHELL_MAX_AGE_MS when unset.
   * A value at/below 0 is treated as the default.
   */
  shellMaxAgeMs?: number;
}

export function createChunkBuffer(opts: ChunkBufferOptions = {}): ChunkBuffer {
  const now = opts.now ?? (() => Date.now());
  const setIntervalFn = opts.setInterval ?? setInterval;
  const clearIntervalFn = opts.clearInterval ?? clearInterval;
  const shellMaxAgeMs =
    opts.shellMaxAgeMs !== undefined && opts.shellMaxAgeMs > 0
      ? opts.shellMaxAgeMs
      : SHELL_MAX_AGE_MS;

  const map = new Map<string, BufferEntry>();
  // Durable pending-card stores, separate from the chunk ring so the IDLE_TTL
  // sweep (which reaps chunk/phase/turn-error entries) never drops a pending
  // approval card out from under a human who hasn't decided yet (TASK-82).
  //   - skillCards: conversationId → ordered list of pending skill cards
  //     (the SSE skill match key). Cleared only on grant / conversation delete.
  //   - hostCards: routing reqId → ordered list of pending host cards (the SSE
  //     host match key). Cleared by evictReqId at the turn boundary.
  const skillCards = new Map<string, PermissionRequest[]>();
  const hostCards = new Map<string, PermissionRequest[]>();
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
      if (entry.lastWriteMs > cutoff) continue;
      // A TERMINATED turn (a terminal turn-error is stored) is fully dropped
      // once its replay window passes — its seq cursor is dead (no more chunks
      // will follow a turn-error), so there's nothing to preserve and keeping a
      // shell would leak one entry per abandoned failed turn that no SSE
      // listener ever evicted (Codex P2). This precedes the reclaimed check so
      // a previously-reclaimed entry that later took a turn-error still reaps.
      if (entry.turnError !== null) {
        map.delete(reqId);
        continue;
      }
      if (entry.reclaimed) {
        // Already a cursor-only shell for a (presumed) still-live, long-quiet
        // turn — normally left alone, because resetting it would let the counter
        // restart at 1 underneath a connected client (Codex P1). BUT a shell
        // that has lingered past SHELL_MAX_AGE_MS without being revived or
        // evicted is almost certainly orphaned (a runner that crashed before any
        // terminal hook), so reap it to bound memory (Codex P2). A legitimate
        // turn fires its terminal hook (→ evictReqId) well within that ceiling.
        if (
          entry.reclaimedAtMs !== null &&
          now() - entry.reclaimedAtMs > shellMaxAgeMs
        ) {
          map.delete(reqId);
        }
        continue;
      }
      if (entry.nextSeq > 1) {
        // This reqId minted at least one chunk seq → a client may be tracking
        // a lastSeq for it. Reclaim the heavy fields to free memory but KEEP
        // the monotonic cursor so a revival (e.g. a tool-result after a long
        // quiet tool call) continues the sequence instead of resetting to 1.
        entry.chunks = [];
        entry.phase = null;
        entry.reclaimed = true;
        entry.reclaimedAtMs = now();
        continue;
      }
      // Never minted a content seq (only a phase, or an empty entry) → no
      // cursor worth preserving; drop it outright.
      map.delete(reqId);
    }
  }

  return {
    append(chunk) {
      const existing = map.get(chunk.reqId);
      if (existing === undefined) {
        // Fresh reqId — seq starts at 1; nextSeq advances to 2.
        const stamped: StreamChunk = { ...chunk, seq: 1 };
        map.set(chunk.reqId, {
          chunks: [stamped],
          nextSeq: 2,
          reclaimed: false,
          reclaimedAtMs: null,
          phase: null,
          turnError: null,
          lastWriteMs: now(),
        });
        return stamped;
      }
      const seq = existing.nextSeq;
      existing.nextSeq = seq + 1;
      // Revive a cursor-only shell (TTL-reclaimed mid-turn): the cursor
      // continued monotonically, so a connected client accepts this frame
      // contiguously (or sees a gap → banner) — never a silent dedup.
      existing.reclaimed = false;
      existing.reclaimedAtMs = null;
      const stamped: StreamChunk = { ...chunk, seq };
      existing.chunks.push(stamped);
      // Hard cap — drop the oldest. Array.shift() is O(n) but n ≤ 256
      // and we only shift on overflow; not worth a circular-buffer
      // structure for this slice. NOTE: nextSeq keeps climbing across the
      // drop, so the retained tail's first seq sits ABOVE a reconnecting
      // client's last-seen seq → the client detects the hole and surfaces
      // the banner instead of silently rendering a truncated reply (TASK-23).
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
      return stamped;
    },

    appendPhase(reqId, phase) {
      const existing = map.get(reqId);
      if (existing === undefined) {
        map.set(reqId, {
          chunks: [],
          nextSeq: 1,
          reclaimed: false,
          reclaimedAtMs: null,
          phase,
          turnError: null,
          lastWriteMs: now(),
        });
        return;
      }
      // Already past pre-content window — phase is no longer relevant. We gate
      // on `nextSeq > 1` (any content seq ever minted) rather than the current
      // chunk count, because a TTL-reclaimed shell has an empty `chunks` array
      // yet has already streamed content — a stray late phase must still be
      // ignored there.
      if (existing.chunks.length > 0 || existing.nextSeq > 1) return;
      existing.phase = phase;
      existing.lastWriteMs = now();
    },

    appendTurnError(reqId, reason) {
      const existing = map.get(reqId);
      if (existing === undefined) {
        map.set(reqId, {
          chunks: [],
          nextSeq: 1,
          reclaimed: false,
          reclaimedAtMs: null,
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
      // Host cards are turn-scoped (the reactive egress wall is per-session),
      // so the turn boundary drops them. Skill cards are NOT keyed by reqId and
      // intentionally survive (the pending approval outlives the turn).
      hostCards.delete(reqId);
    },

    appendPermissionCard(key, card) {
      if (typeof key !== 'string' || key.length === 0) return;
      // Skill AND connector cards are conversationId-matched (TASK-112) and share
      // the same per-conversation replay list. De-dupe by the card's SUBJECT id
      // (skillId / connectorId) so a re-proposal replaces in place rather than
      // stacking a second prompt for the same subject.
      if (card.kind === 'skill' || card.kind === 'connector') {
        const list = skillCards.get(key) ?? [];
        const idx = list.findIndex((c) =>
          card.kind === 'skill'
            ? c.kind === 'skill' && c.skillId === card.skillId
            : c.kind === 'connector' && c.connectorId === card.connectorId,
        );
        if (idx >= 0) {
          list[idx] = card;
        } else {
          list.push(card);
          // Bound the per-conversation list — drop the oldest on overflow.
          if (list.length > MAX_PENDING_CARDS_PER_CONV) {
            list.splice(0, list.length - MAX_PENDING_CARDS_PER_CONV);
          }
        }
        skillCards.set(key, list);
        return;
      }
      // Host card.
      const list = hostCards.get(key) ?? [];
      // De-dupe by host: the same blocked host re-tried within a turn shouldn't
      // stack duplicate cards.
      const idx = list.findIndex(
        (c) => c.kind === 'host' && c.host === card.host,
      );
      if (idx >= 0) {
        list[idx] = card;
      } else {
        list.push(card);
        if (list.length > MAX_PENDING_CARDS_PER_CONV) {
          list.splice(0, list.length - MAX_PENDING_CARDS_PER_CONV);
        }
      }
      hostCards.set(key, list);
    },

    tailPermissionCards(conversationId) {
      const list = skillCards.get(conversationId);
      if (list === undefined) return [];
      return list.slice();
    },

    tailHostCards(reqId) {
      const list = hostCards.get(reqId);
      if (list === undefined) return [];
      return list.slice();
    },

    evictPermissionCard(conversationId, subjectId) {
      const list = skillCards.get(conversationId);
      if (list === undefined) return;
      // TASK-112 — drop the card whose SUBJECT matches: a skill keyed by skillId
      // OR a connector keyed by connectorId. The two id namespaces don't collide
      // in practice, and the match is exact-string, so a single id arg suffices
      // (the route passes whichever subject it just granted).
      const next = list.filter(
        (c) =>
          !(
            (c.kind === 'skill' && c.skillId === subjectId) ||
            (c.kind === 'connector' && c.connectorId === subjectId)
          ),
      );
      if (next.length === 0) {
        skillCards.delete(conversationId);
      } else {
        skillCards.set(conversationId, next);
      }
    },

    evictConversationCards(conversationId) {
      skillCards.delete(conversationId);
    },

    dispose() {
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
    },
  };
}
