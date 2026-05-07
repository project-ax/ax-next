import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// In-memory PKCE/state holder for the OAuth web-paste flow.
//
// Lifecycle:
//   - /admin/credentials/oauth/start (or /settings/...) calls `stash`,
//     receives a `pendingId`, and hands it back to the browser.
//   - The user signs in at the provider, copies the code shown on the
//     redirect page, and pastes it into /admin/credentials/oauth/finish
//     along with `pendingId`.
//   - The finish handler calls `claim` with the pendingId AND the
//     authenticated user id (the same one that started the flow), gets
//     back the codeVerifier + state + target metadata, and runs the
//     `credentials:exchange:<kind>` step.
//
// Security posture:
//   - Entries are bound to userId. A different user claiming the same
//     pendingId returns undefined AND consumes the entry — no oracle on
//     whether the id existed.
//   - Single-use: a successful claim removes the entry.
//   - TTL eviction (default 5min) bounds the window where a stolen
//     pendingId could be replayed. Capacity eviction (default 1000) caps
//     memory if a misbehaving client floods /start.
//   - The store has zero persistence; multi-replica deployments need
//     sticky sessions (or a DB-backed sibling plugin).
// ---------------------------------------------------------------------------

export interface PendingEntryInput {
  codeVerifier: string;
  state: string;
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  userId: string;
}

export interface PendingEntry extends PendingEntryInput {
  expiresAt: number;
}

export interface PendingStore {
  stash(entry: PendingEntryInput): string;
  claim(pendingId: string, expectedUserId: string): PendingEntry | undefined;
}

export interface PendingStoreOptions {
  ttlMs: number;
  capacity: number;
}

export function createPendingStore(opts: PendingStoreOptions): PendingStore {
  const map = new Map<string, PendingEntry>();

  function evictExpired(now: number): void {
    for (const [k, v] of map) {
      if (v.expiresAt <= now) map.delete(k);
    }
  }

  function evictOldestIfOverCapacity(): void {
    while (map.size >= opts.capacity) {
      let oldestKey: string | undefined;
      let oldestExp = Infinity;
      for (const [k, v] of map) {
        if (v.expiresAt < oldestExp) {
          oldestExp = v.expiresAt;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }

  return {
    stash(entry: PendingEntryInput): string {
      const now = Date.now();
      evictExpired(now);
      evictOldestIfOverCapacity();
      // 32 bytes → 43 base64url chars (no padding). Far above the 20-byte
      // floor the route-layer schema enforces.
      const pendingId = randomBytes(32).toString('base64url');
      map.set(pendingId, { ...entry, expiresAt: now + opts.ttlMs });
      return pendingId;
    },

    claim(pendingId: string, expectedUserId: string): PendingEntry | undefined {
      const now = Date.now();
      evictExpired(now);
      const entry = map.get(pendingId);
      if (entry === undefined) return undefined;
      // Always consume on lookup — even on userId mismatch, to avoid
      // timing/behavior oracles that distinguish "wrong user" from
      // "unknown id".
      map.delete(pendingId);
      if (entry.userId !== expectedUserId) return undefined;
      return entry;
    },
  };
}
