import type { SecretStore } from './secrets.js';

/**
 * A SecretStore that remembers each install's SIGNING SECRET for a short
 * while, so the events route doesn't read the vault for every request.
 *
 * Why: the events URL is public and its `installId` is no secret from anyone
 * who has seen it. Every POST to a known install needs the signing secret
 * before the signature can be checked, so without this, a stream of unsigned
 * requests would cost one vault read (a database read and a decrypt) each.
 * With it, they cost one per `ttlMs`.
 *
 * Only `get(install, 'signing-secret')` is remembered, and only a value: a
 * missing secret and a vault failure are asked again next time. Every
 * `put`, `remove` and `removeAll` for an install forgets its entry, both
 * before the vault call and after it, and a read that was in flight across
 * either is not kept. So a disconnect, or any write of the install's secrets,
 * is seen at once, not up to `ttlMs` later. `clear` forgets every install.
 *
 * In-process and bounded (`max` installs, the oldest forgotten first), like
 * the event-id dedupe: the chart pins one replica.
 */
export interface SigningSecretCache extends SecretStore {
  /** Forget every install's secret (a reset on this process's bus). */
  clear(): void;
}

export function cacheSigningSecrets(
  inner: SecretStore,
  o: { ttlMs: number; max: number; now: () => number },
): SigningSecretCache {
  if (!Number.isSafeInteger(o.ttlMs) || o.ttlMs <= 0 || !Number.isSafeInteger(o.max) || o.max <= 0) {
    throw new RangeError('cacheSigningSecrets: ttlMs and max must be positive integers');
  }
  const { ttlMs, max, now } = o;
  /** installId → the secret and when it stops being good. Insertion order is age. */
  const entries = new Map<string, { secret: string; expiresAt: number }>();
  /** Bumped by every change, so a read that straddles one keeps nothing. */
  let generation = 0;

  const forget = (installId: string): void => {
    generation += 1;
    entries.delete(installId);
  };

  /** Run a change to an install's secrets, forgetting its entry before and after. */
  async function changing<T>(installId: string, change: () => Promise<T>): Promise<T> {
    forget(installId);
    try {
      return await change();
    } finally {
      forget(installId);
    }
  }

  return {
    async get(install, name) {
      if (name !== 'signing-secret') return inner.get(install, name);
      const nowMs = now();
      const hit = entries.get(install.installId);
      if (hit !== undefined && nowMs < hit.expiresAt) return hit.secret;
      entries.delete(install.installId);

      const seen = generation;
      const secret = await inner.get(install, name);
      if (secret !== null && generation === seen) {
        while (entries.size >= max) {
          const oldest = entries.keys().next();
          if (oldest.done === true) break;
          entries.delete(oldest.value);
        }
        entries.set(install.installId, { secret, expiresAt: nowMs + ttlMs });
      }
      return secret;
    },

    put(install, name, value) {
      return changing(install.installId, () => inner.put(install, name, value));
    },

    remove(install, name) {
      return changing(install.installId, () => inner.remove(install, name));
    },

    removeAll(install) {
      return changing(install.installId, () => inner.removeAll(install));
    },

    clear() {
      generation += 1;
      entries.clear();
    },
  };
}
