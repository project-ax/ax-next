import type { Kysely } from 'kysely';
import type { BootstrapStateRow, OnboardingDatabase } from './migrations.js';

// Re-export for consumers that only import from store.
export type { BootstrapStateRow };

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'already-claimed-or-completed' };

export interface OnboardingStore {
  read(): Promise<BootstrapStateRow | null>;
  initializeWithHash(tokenHash: string): Promise<void>;
  claim(): Promise<ClaimResult>;
  complete(): Promise<void>;
}

/**
 * Onboarding store — single source of truth for `bootstrap_state`.
 *
 * All state transitions are one-directional: pending → claimed → completed.
 * The `claim()` method uses an atomic CAS UPDATE to enforce the "exactly one
 * winner" invariant (I6). A plain read-then-update (TOCTOU) would break under
 * concurrent callers.
 *
 * Only this file may query `bootstrap_state` directly (mirrors auth-oidc's
 * store-scoped access pattern, enforced by convention and future lint rule).
 */
export function createOnboardingStore(
  db: Kysely<OnboardingDatabase>,
): OnboardingStore {
  const table = 'bootstrap_state' as const;

  return {
    async read(): Promise<BootstrapStateRow | null> {
      const row = await db
        .selectFrom(table)
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirst();
      return row ?? null;
    },

    async initializeWithHash(tokenHash: string): Promise<void> {
      // INSERT ... ON CONFLICT (id) DO NOTHING — idempotent; never overwrites
      // an existing row regardless of its status. The token_hash must not be
      // replaced on re-init (a partial-state restart must not silently swap in
      // a stale token). Task 2.4's hook handles env-var-changed restarts by
      // checking the hash before calling this.
      await db
        .insertInto(table)
        .values({
          id: 1,
          status: 'pending',
          token_hash: tokenHash,
          completed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    },

    async claim(): Promise<ClaimResult> {
      // Atomic CAS: UPDATE ... WHERE status='pending' RETURNING *.
      // Only the first concurrent caller matches the WHERE predicate — the rest
      // see zero rows and return the not-pending result. No TOCTOU window.
      const result = await db
        .updateTable(table)
        .set({ status: 'claimed', updated_at: new Date() })
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      return result
        ? { ok: true }
        : { ok: false, reason: 'already-claimed-or-completed' };
    },

    // I6 backward-transition guard: only rows in 'pending' or 'claimed' state
    // can be completed. Already-completed rows are not re-stamped (idempotent),
    // and missing rows are a silent no-op. This enforces "never backwards" at
    // the SQL level rather than relying solely on route-layer ordering.
    async complete(): Promise<void> {
      await db
        .updateTable(table)
        .set({ status: 'completed', completed_at: new Date(), updated_at: new Date() })
        .where('id', '=', 1)
        .where('status', 'in', ['pending', 'claimed'])
        .execute();
    },
  };
}
