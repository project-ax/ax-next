import type { ChatContext, HookBus } from '@ax/core';
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
  | { ok: true; sessionId: string; workspaceRoot: string }
  | { ok: false; status: number; body: IpcErrorEnvelope };

const BEARER_PREFIX = 'bearer ';

interface SessionResolveTokenInput {
  token: string;
}

type SessionResolveTokenOutput =
  | { sessionId: string; workspaceRoot: string }
  | null;

export async function authenticate(
  authHeader: string | undefined,
  bus: HookBus,
  ctx: ChatContext,
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
  };
}
