// Per-agent debouncer for the Consolidator.
//
// WHY this exists (I10 — Consolidator is async + bounded): a user who sends
// several messages in quick succession fires one chat:end per message, which
// would launch overlapping consolidation passes for the same agent. Overlapping
// passes race to read and rewrite the same inbox files, corrupting the
// promotion accounting.
//
// The debouncer coalesces rapid schedule() calls within `windowMs` for the
// same agentId: only the LATEST scheduled runner fires; earlier ones are
// discarded. A fresh call after the window starts a new pass.
//
// Invariant I10: the Consolidator is async + bounded.

export interface Debouncer {
  schedule(agentId: string, run: () => Promise<void>): void;
  /** For tests + shutdown: drain any pending timers. */
  flush(): Promise<void>;
}

interface PendingSlot {
  timer: NodeJS.Timeout;
  /** The latest scheduled runner — replaces any earlier one within the window. */
  run: () => Promise<void>;
}

export function createDebouncer(windowMs: number): Debouncer {
  const slots = new Map<string, PendingSlot>();
  const inflight = new Map<string, Promise<void>>();

  const fire = (agentId: string): void => {
    const slot = slots.get(agentId);
    if (slot === undefined) return;
    slots.delete(agentId);
    const p = slot.run().catch(() => {
      // Subscriber posture: never throw out of a debounce timer.
    });
    inflight.set(agentId, p);
    void p.finally(() => inflight.delete(agentId));
  };

  return {
    schedule(agentId, run) {
      const existing = slots.get(agentId);
      if (existing !== undefined) clearTimeout(existing.timer);
      const timer = setTimeout(() => fire(agentId), windowMs);
      timer.unref?.();
      slots.set(agentId, { timer, run });
    },
    async flush() {
      // Force-fire any pending timers immediately (preserve coalesced semantics).
      const pendingIds = [...slots.keys()];
      for (const id of pendingIds) {
        const slot = slots.get(id);
        if (slot === undefined) continue;
        clearTimeout(slot.timer);
        fire(id);
      }
      await Promise.all(inflight.values());
    },
  };
}
