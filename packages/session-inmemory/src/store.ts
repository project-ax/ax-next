import { randomBytes } from 'node:crypto';
import { PluginError, type PluginErrorCode } from '@ax/core';

const PLUGIN_NAME = '@ax/session-inmemory';

// The plugin's public contract uses plugin-specific error codes
// (`duplicate-session`, `unknown-session`) that are narrower than the generic
// core PluginErrorCode union. Cast through `as PluginErrorCode` so callers can
// still pattern-match on `err.code`. A future slice may widen the core enum;
// until then we keep the plugin's error vocabulary here rather than forcing
// generic codes that would lose meaning.
export const DUPLICATE_SESSION: PluginErrorCode = 'duplicate-session' as PluginErrorCode;
export const UNKNOWN_SESSION: PluginErrorCode = 'unknown-session' as PluginErrorCode;

// ---------------------------------------------------------------------------
// Session store
//
// Two maps:
//   - `sessionId → SessionRecord` (primary)
//   - `token → sessionId`        (reverse lookup for O(1) resolve)
//
// `terminate()` sets a flag on the record but does NOT delete. The reverse
// map still contains the terminated token, but `resolveToken()` checks the
// flag and returns null — keeps the record around for forensic tooling and
// lets the future postgres impl match the same semantics with a tombstone.
//
// Token minting: 32 bytes of crypto.randomBytes, base64url-encoded, no
// padding — 43 chars exactly, matches /^[A-Za-z0-9_-]{43}$/. Never JWT (I9).
// ---------------------------------------------------------------------------

export interface SessionRecord {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly token: string;
  terminated: boolean;
}

export interface SessionStore {
  create(sessionId: string, workspaceRoot: string): SessionRecord;
  resolveToken(token: string): { sessionId: string; workspaceRoot: string } | null;
  get(sessionId: string): SessionRecord | null;
  terminate(sessionId: string): void;
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createSessionStore(): SessionStore {
  const bySessionId = new Map<string, SessionRecord>();
  const byToken = new Map<string, string>();

  return {
    create(sessionId, workspaceRoot) {
      if (bySessionId.has(sessionId)) {
        throw new PluginError({
          code: DUPLICATE_SESSION,
          plugin: PLUGIN_NAME,
          hookName: 'session:create',
          message: `session '${sessionId}' already exists`,
        });
      }
      const token = mintToken();
      const record: SessionRecord = {
        sessionId,
        workspaceRoot,
        token,
        terminated: false,
      };
      bySessionId.set(sessionId, record);
      byToken.set(token, sessionId);
      return record;
    },

    resolveToken(token) {
      const sessionId = byToken.get(token);
      if (sessionId === undefined) return null;
      const record = bySessionId.get(sessionId);
      if (record === undefined || record.terminated) return null;
      return {
        sessionId: record.sessionId,
        workspaceRoot: record.workspaceRoot,
      };
    },

    get(sessionId) {
      return bySessionId.get(sessionId) ?? null;
    },

    terminate(sessionId) {
      const record = bySessionId.get(sessionId);
      if (record === undefined) return; // idempotent no-op
      record.terminated = true;
    },
  };
}
