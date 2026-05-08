import { randomBytes } from 'node:crypto';

export interface BootstrapSessionStore {
  create(ttlMs: number): string;
  verify(sessionId: string): boolean;
  destroy(sessionId: string): void;
  /** Test seam — current count of in-memory sessions. */
  size(): number;
}

interface Entry {
  expiresAt: number;
}

/** `opts.now` is a test seam for the wall clock; defaults to `Date.now`. */
export function createBootstrapSessionStore(opts: { now?: () => number } = {}): BootstrapSessionStore {
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, Entry>();
  return {
    create(ttlMs) {
      const id = randomBytes(32).toString('base64url');
      map.set(id, { expiresAt: now() + ttlMs });
      return id;
    },
    verify(sessionId) {
      const e = map.get(sessionId);
      if (e === undefined) return false;
      if (e.expiresAt < now()) {
        map.delete(sessionId);
        return false;
      }
      return true;
    },
    destroy(sessionId) {
      map.delete(sessionId);
    },
    size() {
      return map.size;
    },
  };
}
