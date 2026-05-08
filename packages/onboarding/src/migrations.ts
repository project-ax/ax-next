import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/onboarding owns tables under the `bootstrap_` prefix —
 * never reach into them from another plugin (Invariant I4 — one source of
 * truth per concept).
 *
 * Single-row enforcement: PK (id) + CHECK (id = 1) makes it impossible to
 * insert a second row. This is intentional — bootstrap is a one-time event
 * per installation.
 *
 * Status transitions: pending → claimed → completed. Never backwards.
 * Enforced by the store's atomic CAS pattern (Invariant I6).
 */
export async function runOnboardingMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS bootstrap_state (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed')),
      token_hash TEXT NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
}

export interface BootstrapStateRow {
  id: number;
  status: 'pending' | 'claimed' | 'completed';
  token_hash: string;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OnboardingDatabase {
  bootstrap_state: BootstrapStateRow;
}
