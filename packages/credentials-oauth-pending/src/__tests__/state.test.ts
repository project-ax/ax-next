import { describe, it, expect, vi } from 'vitest';
import { createPendingStore } from '../state.js';

// ---------------------------------------------------------------------------
// PendingStore — in-memory, TTL+capacity, single-use, userId-bound.
//
// The store backs OAuth web-paste flow: between /oauth/start and
// /oauth/finish we hold the PKCE codeVerifier + state plus the target
// (scope, ownerId, ref, kind) and the userId who started the flow. The
// store has zero persistence — pendingId is a 32-byte random opaque
// handle and entries evaporate on TTL or process restart. Multi-replica
// deployments need either sticky sessions for the 5min window or a
// DB-backed sibling plugin (see plugin manifest comment).
// ---------------------------------------------------------------------------

describe('PendingStore', () => {
  it('stash returns a pendingId; claim returns the entry', () => {
    const store = createPendingStore({ ttlMs: 60_000, capacity: 10 });
    const id = store.stash({
      codeVerifier: 'v',
      state: 's',
      scope: 'user',
      ownerId: 'alice',
      ref: 'r',
      kind: 'k',
      userId: 'alice',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(20);
    const entry = store.claim(id, 'alice');
    expect(entry).toMatchObject({ codeVerifier: 'v', state: 's' });
  });

  it('claim is single-use', () => {
    const store = createPendingStore({ ttlMs: 60_000, capacity: 10 });
    const id = store.stash({
      codeVerifier: 'v',
      state: 's',
      scope: 'user',
      ownerId: 'alice',
      ref: 'r',
      kind: 'k',
      userId: 'alice',
    });
    expect(store.claim(id, 'alice')).toBeDefined();
    expect(store.claim(id, 'alice')).toBeUndefined();
  });

  it('claim with wrong userId returns undefined and consumes the entry', () => {
    const store = createPendingStore({ ttlMs: 60_000, capacity: 10 });
    const id = store.stash({
      codeVerifier: 'v',
      state: 's',
      scope: 'user',
      ownerId: 'alice',
      ref: 'r',
      kind: 'k',
      userId: 'alice',
    });
    expect(store.claim(id, 'bob')).toBeUndefined();
    // Original stash is consumed (defensive — no information leak about
    // whether the id existed).
    expect(store.claim(id, 'alice')).toBeUndefined();
  });

  it('expired entries are not claimable', () => {
    vi.useFakeTimers();
    try {
      const store = createPendingStore({ ttlMs: 1000, capacity: 10 });
      const id = store.stash({
        codeVerifier: 'v',
        state: 's',
        scope: 'user',
        ownerId: 'alice',
        ref: 'r',
        kind: 'k',
        userId: 'alice',
      });
      vi.advanceTimersByTime(1500);
      expect(store.claim(id, 'alice')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('capacity overflow evicts oldest by expiresAt', () => {
    // Fake timers force distinct expiresAt values across stashes — without
    // them, three back-to-back stashes can land on the same Date.now()
    // millisecond, which makes "oldest by expiresAt" implementation-defined
    // (Map insertion-order tiebreak). Advancing 1ms between each pins the
    // ordering deterministically.
    vi.useFakeTimers();
    try {
      const store = createPendingStore({ ttlMs: 60_000, capacity: 2 });
      const id1 = store.stash({
        codeVerifier: '1',
        state: 's',
        scope: 'user',
        ownerId: 'a',
        ref: 'r',
        kind: 'k',
        userId: 'a',
      });
      vi.advanceTimersByTime(1);
      const id2 = store.stash({
        codeVerifier: '2',
        state: 's',
        scope: 'user',
        ownerId: 'a',
        ref: 'r',
        kind: 'k',
        userId: 'a',
      });
      vi.advanceTimersByTime(1);
      const id3 = store.stash({
        codeVerifier: '3',
        state: 's',
        scope: 'user',
        ownerId: 'a',
        ref: 'r',
        kind: 'k',
        userId: 'a',
      });
      expect(store.claim(id1, 'a')).toBeUndefined(); // evicted
      expect(store.claim(id2, 'a')).toBeDefined();
      expect(store.claim(id3, 'a')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pendingId is a base64url string of >=20 chars', () => {
    const store = createPendingStore({ ttlMs: 60_000, capacity: 10 });
    const id = store.stash({
      codeVerifier: 'v',
      state: 's',
      scope: 'global',
      ownerId: null,
      ref: 'r',
      kind: 'k',
      userId: 'alice',
    });
    expect(id.length).toBeGreaterThanOrEqual(20);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
