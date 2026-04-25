import type { User } from './types.js';

/**
 * User + session persistence boundary. The plugin talks to this
 * abstraction; Task 4 lands the postgres-backed implementation.
 *
 * Why abstract it now: keeping the hook stubs and the storage shape in
 * separate files means Task 4's diff is the impl + its tests, not a
 * refactor of plugin.ts. Also lets a future @ax/auth-saml or test fake
 * stand in without touching the plugin's bus wiring.
 */
export interface AuthStore {
  /**
   * Return the user row for a session cookie's plaintext, or null if the
   * session is unknown or expired. Implementations MUST drop expired rows
   * (or treat them as missing) to avoid leaking stale identity.
   */
  resolveSessionUser(sessionId: string): Promise<User | null>;

  /** Lookup by our internal `user_id`. */
  getUserById(userId: string): Promise<User | null>;

  /**
   * Mint a bootstrap user + a one-time token redeemable for a session.
   * The token is emitted ONCE here; subsequent calls return a fresh row.
   * (Idempotency-on-second-bootstrap lives in @ax/cli, not here — see
   * Invariant I12.)
   */
  createBootstrapUser(input: {
    displayName: string;
    email?: string;
  }): Promise<{ user: User; oneTimeToken: string }>;
}
