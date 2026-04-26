import { randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { AuthDatabase } from './migrations.js';
import type { User } from './types.js';

const PLUGIN_NAME = '@ax/auth-oidc';

// ---------------------------------------------------------------------------
// User + session persistence.
//
// All `auth_v1_*` queries are scoped to this file. Other plugins MUST
// route through service hooks (`auth:require-user` etc.); the
// `local/no-bare-tenant-tables` ESLint rule (eslint-rules/) flags any
// `db.selectFrom('auth_v1_*')` outside `store.ts` / `scope.ts` /
// `__tests__/`. That rule is the lock-in that keeps the alternate-impl
// boundary clean — a future `@ax/auth-better-auth` owns its own tables
// and the swap doesn't touch consumers.
//
// `auth_v1_users` rows map IdP-issued (provider, subject) pairs to our
// internal user_id. `auth_v1_sessions` rows hold the http login session;
// the row's primary key is the same value the client carries in the
// signed `ax_auth_session` cookie.
//
// session_id minting: 32 bytes via crypto.randomBytes, base64url-encoded
// (43 chars, regex-clean). NEVER a JWT — Invariant I9, mirrored from
// session-postgres's Week 4-6 audit.
//
// user_id minting: 16 random bytes base64url, prefixed `usr_`. Plan calls
// for a ULID; we don't pull a ulid dep in (zero new deps), and a 16-byte
// random id is collision-free in practice for our scale. The 'usr_' prefix
// keeps it easy to distinguish from session ids in logs.
//
// Why a typed Kysely<AuthDatabase> not a generic `Kysely<unknown>`: the
// plugin owns the auth_v1_ prefix (Invariant I4); typing the schema here
// catches column drift at compile time and documents the surface.
// ---------------------------------------------------------------------------

export interface AuthStore {
  /**
   * Look up the user behind an active session. Returns null when:
   *   - The session id has no row (forged / rotated).
   *   - The session row's `expires_at <= NOW()` (idle timeout).
   *   - The user row is missing (race: user deleted while session live).
   * Implementations MUST treat expired rows as missing — leaking stale
   * identity is the bug class auth_v1_sessions_expires_at_idx exists for.
   */
  resolveSessionUser(sessionId: string): Promise<User | null>;

  /** Lookup by our internal `user_id`. Used by `auth:get-user`. */
  getUserById(userId: string): Promise<User | null>;

  /**
   * Look up an existing IdP user, or null if first-time. Returns the row
   * already mapped to the public `User` shape so callers don't re-shape.
   */
  findUserByProviderSubject(
    provider: string,
    subjectId: string,
  ): Promise<User | null>;

  /**
   * Insert a fresh user row. Caller is expected to have first checked
   * `findUserByProviderSubject` to avoid the UNIQUE-violation path; if the
   * race fires anyway (concurrent first-time sign-in for the same sub),
   * the impl re-reads the row and returns it.
   */
  createUser(input: {
    provider: string;
    subjectId: string;
    email: string | null;
    displayName: string | null;
    isAdmin: boolean;
  }): Promise<User>;

  /**
   * Mint a session row pointing at userId, expiring at `expiresAt`.
   * Returns the session_id (the cookie value's plaintext).
   */
  createSession(userId: string, expiresAt: Date): Promise<string>;

  /**
   * Idempotent — a missing row is a no-op (mirrors session-postgres
   * `terminate`). DELETE rather than mark-terminated because login
   * sessions don't carry forensic value beyond their lifetime; the audit
   * record is the `auth:user-signed-out` subscriber payload.
   */
  deleteSession(sessionId: string): Promise<void>;

  /**
   * Bootstrap path. Idempotent on re-call: if a user with provider
   * 'dev-bootstrap' + subject 'admin' exists, returns it; else creates
   * a fresh row with `is_admin = true`.
   */
  upsertBootstrapAdmin(input: {
    displayName: string | null;
    email: string | null;
  }): Promise<{ user: User; created: boolean }>;
}

export function mintSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function mintUserId(): string {
  return `usr_${randomBytes(16).toString('base64url')}`;
}

function rowToUser(row: {
  user_id: string;
  email: string | null;
  display_name: string | null;
  is_admin: boolean;
}): User {
  return {
    id: row.user_id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin,
  };
}

export function createAuthStore(db: Kysely<AuthDatabase>): AuthStore {
  return {
    async resolveSessionUser(sessionId) {
      // Single round-trip via JOIN: faster than two queries and means
      // we never read the session row without knowing the user is
      // still resolvable (avoids the post-DELETE/CASCADE race).
      const row = await db
        .selectFrom('auth_v1_sessions as s')
        .innerJoin('auth_v1_users as u', 'u.user_id', 's.user_id')
        .select(['u.user_id', 'u.email', 'u.display_name', 'u.is_admin'])
        .where('s.session_id', '=', sessionId)
        .where('s.expires_at', '>', new Date())
        .executeTakeFirst();
      return row === undefined ? null : rowToUser(row);
    },

    async getUserById(userId) {
      const row = await db
        .selectFrom('auth_v1_users')
        .select(['user_id', 'email', 'display_name', 'is_admin'])
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row === undefined ? null : rowToUser(row);
    },

    async findUserByProviderSubject(provider, subjectId) {
      const row = await db
        .selectFrom('auth_v1_users')
        .select(['user_id', 'email', 'display_name', 'is_admin'])
        .where('auth_provider', '=', provider)
        .where('auth_subject_id', '=', subjectId)
        .executeTakeFirst();
      return row === undefined ? null : rowToUser(row);
    },

    async createUser(input) {
      const userId = mintUserId();
      try {
        const row = await db
          .insertInto('auth_v1_users')
          .values({
            user_id: userId,
            auth_provider: input.provider,
            auth_subject_id: input.subjectId,
            email: input.email,
            display_name: input.displayName,
            is_admin: input.isAdmin,
            created_at: new Date(),
          })
          .returning(['user_id', 'email', 'display_name', 'is_admin'])
          .executeTakeFirstOrThrow();
        return rowToUser(row);
      } catch (err) {
        // Concurrent first-time sign-in for same (provider, subject) loses
        // the UNIQUE race; re-read so the caller still gets a User.
        if (isUniqueViolation(err)) {
          const existing = await this.findUserByProviderSubject(
            input.provider,
            input.subjectId,
          );
          if (existing !== null) return existing;
        }
        throw new PluginError({
          code: 'create-user-failed',
          plugin: PLUGIN_NAME,
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        });
      }
    },

    async createSession(userId, expiresAt) {
      const sessionId = mintSessionId();
      await db
        .insertInto('auth_v1_sessions')
        .values({
          session_id: sessionId,
          user_id: userId,
          expires_at: expiresAt,
          created_at: new Date(),
        })
        .execute();
      return sessionId;
    },

    async deleteSession(sessionId) {
      await db
        .deleteFrom('auth_v1_sessions')
        .where('session_id', '=', sessionId)
        .execute();
    },

    async upsertBootstrapAdmin(input) {
      const existing = await this.findUserByProviderSubject(
        'dev-bootstrap',
        'admin',
      );
      if (existing !== null) {
        return { user: existing, created: false };
      }
      const user = await this.createUser({
        provider: 'dev-bootstrap',
        subjectId: 'admin',
        email: input.email,
        displayName: input.displayName,
        isAdmin: true,
      });
      return { user, created: true };
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
