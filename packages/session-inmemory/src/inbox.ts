import type { ClaimResult, InboxEntry } from './types.js';

// ---------------------------------------------------------------------------
// Per-session long-poll inbox
//
// Each session owns:
//   - `entries`: ordered list of queued inbox entries (index === 0-based cursor)
//   - `waiters`: set of wake callbacks registered by currently-blocked `claim`s
//   - `terminated`: flag — set by `terminate()`; wakes all waiters and causes
//     subsequent claims on this session to resolve as `timeout`.
//
// Per-session state is lazy-initialized on first `queue` or `claim`. The store
// is the authoritative existence check — the plugin layer calls `store.get()`
// before touching the inbox, so we don't second-guess whether a sessionId
// "should" exist here.
//
// Invariants (per-promise):
//   - Every `claim` promise resolves exactly once.
//   - On wake: the timer is cleared AND the waiter is removed from the set.
//   - On timeout: the waiter is removed from the set.
//   - On terminate: all waiters fire; each waiter's re-check either delivers
//     a just-queued entry or falls through to the `timeout` path.
// ---------------------------------------------------------------------------

interface PerSession {
  entries: InboxEntry[];
  waiters: Set<() => void>;
  terminated: boolean;
}

export interface Inbox {
  queue(sessionId: string, entry: InboxEntry): { cursor: number };
  claim(sessionId: string, cursor: number, timeoutMs: number): Promise<ClaimResult>;
  terminate(sessionId: string): void;
}

export function createInbox(): Inbox {
  const sessions = new Map<string, PerSession>();

  const getOrCreate = (sessionId: string): PerSession => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { entries: [], waiters: new Set(), terminated: false };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const deliver = (entry: InboxEntry, cursor: number): ClaimResult => {
    // Cursor advancement on delivery: next cursor = delivered-index + 1.
    // This matches the IPC protocol's SessionNextMessageResponseSchema — the
    // server echoes the cursor the client should use on the NEXT request.
    if (entry.type === 'user-message') {
      return {
        type: 'user-message',
        payload: entry.payload,
        reqId: entry.reqId,
        cursor: cursor + 1,
      };
    }
    return { type: 'cancel', cursor: cursor + 1 };
  };

  return {
    queue(sessionId, entry) {
      const state = getOrCreate(sessionId);
      const cursor = state.entries.length;
      state.entries.push(entry);
      // Wake all current waiters. Each re-checks its own cursor — a waiter
      // whose cursor doesn't match this push yet simply re-registers (no —
      // actually, it falls through to timeout; see claim() below). The common
      // case is a single waiter at `cursor === entries.length - 1`, so this
      // loop is short.
      for (const wake of state.waiters) wake();
      return { cursor };
    },

    claim(sessionId, cursor, timeoutMs) {
      const state = getOrCreate(sessionId);
      // Fast path: entry already present.
      const present = state.entries[cursor];
      if (present !== undefined) {
        return Promise.resolve(deliver(present, cursor));
      }
      // If the session is already terminated, don't bother waiting.
      if (state.terminated) {
        return Promise.resolve({ type: 'timeout', cursor });
      }

      return new Promise<ClaimResult>((resolve) => {
        let settled = false;
        const finish = (result: ClaimResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.waiters.delete(wake);
          resolve(result);
        };

        const wake = (): void => {
          if (settled) return;
          const entry = state.entries[cursor];
          if (entry !== undefined) {
            finish(deliver(entry, cursor));
            return;
          }
          // Woken without an entry — session must have been terminated
          // (or a spurious wake). Resolve as timeout with echo cursor.
          finish({ type: 'timeout', cursor });
        };

        const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
          // On timer: always resolve timeout with echo cursor, no advancement.
          finish({ type: 'timeout', cursor });
        }, timeoutMs);
        // Don't keep the event loop alive solely for a blocked claim — if the
        // process is otherwise idle, a 30 s long-poll shouldn't block shutdown.
        timer.unref();

        state.waiters.add(wake);
      });
    },

    terminate(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) {
        // No per-session state has been materialized — nothing to tear down.
        // The plugin layer already gates queue/claim behind store.get(), so we
        // never need a lazy "terminated marker" here. Writing one would poison
        // a same-sessionId re-create sequence (terminate unknown → create →
        // claim would short-circuit on the stale flag).
        return;
      }
      state.terminated = true;
      // Copy the waiter set before firing — each wake callback removes itself,
      // and mutating a Set during iteration is asking for trouble.
      const waiters = [...state.waiters];
      for (const wake of waiters) wake();
    },
  };
}
