import { randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';
import type { AgentConfig } from './types.js';

const PLUGIN_NAME = '@ax/session-inmemory';

// Plugin-specific error codes. Core's `PluginErrorCode` union is open
// (`| (string & {})`), so these flow through without casts.
export const DUPLICATE_SESSION = 'duplicate-session';
export const UNKNOWN_SESSION = 'unknown-session';

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
//
// Week 9.5 extension: session records also carry the {userId, agentId,
// agentConfig} that the orchestrator resolved before opening the sandbox.
// Frozen at create-time per Invariant I10 — switching agents = new session.
// Pre-9.5 callers that don't pass an owner object set userId/agentId to
// `null` and agentConfig to `null`; resolveToken / get echo those nulls
// so downstream consumers can branch on legacy vs. owned sessions.
// ---------------------------------------------------------------------------

export interface SessionOwner {
  userId: string;
  agentId: string;
  agentConfig: AgentConfig;
  /**
   * Conversation this session is bound to (Task 15 of Week 10–12).
   * Optional — canary / admin sessions have no conversation. Stored as
   * `null` in the record when absent so `session:get-config` can
   * always answer with a typed scalar.
   */
  conversationId?: string | null;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly token: string;
  readonly userId: string | null;
  readonly agentId: string | null;
  readonly agentConfig: AgentConfig | null;
  readonly conversationId: string | null;
  terminated: boolean;
}

export interface ResolveTokenResult {
  sessionId: string;
  workspaceRoot: string;
  userId: string | null;
  agentId: string | null;
}

export interface SessionStore {
  create(
    sessionId: string,
    workspaceRoot: string,
    owner?: SessionOwner,
  ): SessionRecord;
  resolveToken(token: string): ResolveTokenResult | null;
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
    create(sessionId, workspaceRoot, owner) {
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
        userId: owner?.userId ?? null,
        agentId: owner?.agentId ?? null,
        agentConfig: owner?.agentConfig ?? null,
        // Normalize `undefined` → null so the record always carries an
        // explicit nullable. Avoids `?? null` rituals at every read site.
        conversationId: owner?.conversationId ?? null,
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
        userId: record.userId,
        agentId: record.agentId,
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
