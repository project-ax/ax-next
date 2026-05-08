import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/auth-better owns:
 *   auth_better_v1_users      — identity row (better-auth's user shape).
 *   auth_better_v1_sessions   — HTTP login session (better-auth's session shape).
 *   auth_providers            — runtime-configurable OAuth provider config.
 *
 * `auth_better_v1_*` is the schema-versioned prefix for this plugin's user/session
 * concept; future shape changes are forward-only via a `v2` side-table.
 *
 * `auth_providers` is OUR addition for dynamic OAuth provider config. Its
 * `client_secret_encrypted` column holds an envelope produced by
 * `credentials:envelope-encrypt` (Task 1.0) — never store plaintext.
 *
 * No FKs across the auth_better_v1_ ↔ session_postgres_v1_ boundary (I4).
 */
export interface AuthBetterDatabase {
  auth_better_v1_users: {
    id: string;
    email: string;
    email_verified: boolean;
    name: string | null;
    image: string | null;
    role: 'admin' | 'user';
    created_at: Date;
    updated_at: Date;
  };
  auth_better_v1_sessions: {
    id: string;
    user_id: string;
    token: string;
    expires_at: Date;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
    updated_at: Date;
  };
  auth_providers: {
    kind: string;
    client_id: string;
    client_secret_encrypted: Uint8Array;
    discovery_url: string | null;
    allowed_domains: string | null;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
  };
}

export async function runAuthBetterMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS auth_better_v1_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      name TEXT,
      image TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS auth_better_v1_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES auth_better_v1_users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS auth_providers (
      kind TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_secret_encrypted BYTEA NOT NULL,
      discovery_url TEXT,
      allowed_domains TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);
}
