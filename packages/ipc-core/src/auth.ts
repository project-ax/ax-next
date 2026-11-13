import type {
  AgentContext,
  AgentContextAudience,
  AgentContextSource,
  HookBus,
} from '@ax/core';
import type { IpcErrorEnvelope } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// Auth middleware
//
// Every inbound IPC request carries `Authorization: Bearer <token>`. We resolve
// the token via the `session:resolve-token` service hook — whichever session
// plugin is registered answers. The listener never stores tokens itself.
//
// I9: error bodies NEVER include the offending token value. We return a
// short, generic message ("missing authorization" / "invalid authorization
// scheme" / "unknown token") and let the client's reqId correlate if they
// need to debug.
//
// Cross-session safety: the caller (listener) also checks that the resolved
// sessionId matches the listener's owning session and returns 403 if not.
// That check lives in the listener rather than here so that the auth result
// stays honestly "this token resolved to session X" — the listener layers
// authorization on top of authentication.
// ---------------------------------------------------------------------------

export type AuthResult =
  | {
      ok: true;
      sessionId: string;
      workspaceRoot: string;
      // Week 9.5: legacy (pre-9.5) sessions resolve with userId/agentId
      // null. Newer sessions carry the IDs and downstream handlers can
      // act on them (e.g. tool-dispatcher's per-agent filter).
      userId: string | null;
      agentId: string | null;
      // Week 10–12 final review: carry the resolved session's
      // conversationId so the listener can stamp it onto the per-request
      // AgentContext. Without this, runner-fired chat:turn-end events lose
      // the conversation binding and three subscribers silently no-op
      // (auto-append, clearActiveReqId, SSE done-frame). Null for canary
      // / admin / pre-Task-15 sessions.
      conversationId: string | null;
      // TASK-181: carry the resolved session's HOST-DERIVED origin so the
      // listener can stamp `ctx.source` on the per-request AgentContext. The
      // value comes from the session store (set at session:create time from
      // the orchestrator's ctx.source) — NEVER from the inbound request. The
      // token is the only thing the runner controls, and it only selects WHICH
      // session record to read; it cannot influence the stored `source`. Null
      // for user / canary / pre-TASK-181 sessions.
      source: AgentContextSource | null;
      // TASK-1091: the resolved session's HOST-DERIVED audience, carried the
      // same way and for the same reason as `source` (memory reads it on the
      // runner's calls to decide what the session may recall). Same SECURITY
      // posture: from the session record only, never from the request. Null
      // for private / canary / pre-TASK-1091 sessions.
      audience: AgentContextAudience | null;
    }
  | { ok: false; status: number; body: IpcErrorEnvelope };

const BEARER_PREFIX = 'bearer ';

interface SessionResolveTokenInput {
  token: string;
}

type SessionResolveTokenOutput =
  | {
      sessionId: string;
      workspaceRoot: string;
      userId: string | null;
      agentId: string | null;
      conversationId?: string | null;
      // TASK-181 — host-derived session origin echoed by session:resolve-token.
      // Optional here for back-compat with any resolver that predates TASK-181;
      // the listener treats a missing value as null (user) — see authenticate().
      source?: AgentContextSource | null;
      // TASK-1091 — host-derived audience echoed by session:resolve-token.
      // Optional here for the same back-compat reason; missing ⇒ null (private).
      audience?: AgentContextAudience | null;
    }
  | null;

// TASK-1091 — the values this build knows. A `Record` over each union, so a
// new member is a compile error here until someone decides how it reads.
const KNOWN_SOURCES: Readonly<Record<AgentContextSource, true>> = {
  routine: true,
  user: true,
  external: true,
};
const KNOWN_AUDIENCES: Readonly<Record<AgentContextAudience, true>> = {
  private: true,
  shared: true,
};

/**
 * The resolved session's origin. Absent stays `null` (a user turn); a value
 * this build doesn't know reads as `'external'`, the least privileged.
 */
function sessionSource(raw: unknown): AgentContextSource | null {
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' && Object.hasOwn(KNOWN_SOURCES, raw)
    ? (raw as AgentContextSource)
    : 'external';
}

/**
 * The resolved session's audience. Absent stays `null` (private); a value
 * this build doesn't know reads as `'shared'`, the least recall.
 */
function sessionAudience(raw: unknown): AgentContextAudience | null {
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' && Object.hasOwn(KNOWN_AUDIENCES, raw)
    ? (raw as AgentContextAudience)
    : 'shared';
}

export async function authenticate(
  authHeader: string | undefined,
  bus: HookBus,
  ctx: AgentContext,
): Promise<AuthResult> {
  if (authHeader === undefined || authHeader.length === 0) {
    return {
      ok: false,
      status: 401,
      body: { error: { code: 'SESSION_INVALID', message: 'missing authorization' } },
    };
  }

  // Case-insensitive match on the scheme part only. The token itself
  // (everything after the space) is preserved verbatim — base64url tokens
  // are case-sensitive (I9: opaque base64url).
  if (authHeader.length <= BEARER_PREFIX.length ||
      authHeader.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return {
      ok: false,
      status: 401,
      body: { error: { code: 'SESSION_INVALID', message: 'invalid authorization scheme' } },
    };
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    return {
      ok: false,
      status: 401,
      body: { error: { code: 'SESSION_INVALID', message: 'invalid authorization scheme' } },
    };
  }

  const resolved = await bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
    'session:resolve-token',
    ctx,
    { token },
  );

  if (resolved === null) {
    // I9: DO NOT echo `token` into the message.
    return {
      ok: false,
      status: 401,
      body: { error: { code: 'SESSION_INVALID', message: 'unknown token' } },
    };
  }

  return {
    ok: true,
    sessionId: resolved.sessionId,
    workspaceRoot: resolved.workspaceRoot,
    userId: resolved.userId ?? null,
    agentId: resolved.agentId ?? null,
    conversationId: resolved.conversationId ?? null,
    // TASK-181 — host-derived; absent ⇒ null (treated as a user turn). Both
    // session stores' returns schemas reject a value outside the enum
    // (session-postgres maps it to 'external' first, TASK-1091), and this
    // hop fails closed on its own as well: it is the last one before the
    // value becomes `ctx.source` on every runner call.
    source: sessionSource(resolved.source),
    // TASK-1091 — host-derived; absent ⇒ null (treated as private). Same
    // posture: an unknown value reads as 'shared'.
    audience: sessionAudience(resolved.audience),
  };
}
