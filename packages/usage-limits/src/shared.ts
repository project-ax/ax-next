import { isRejection, PluginError, type AgentContext, type HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// Route plumbing for the admin usage surface.
//
// Duck-typed RouteRequest / RouteResponse — no @ax/http-server import, same
// posture as @ax/branding and the other admin-route plugins (Invariant I2).
// CSRF for the mutating verbs is enforced by http-server before a handler
// runs; auth is enforced here, per handler.
// ---------------------------------------------------------------------------

/** Every body on this surface is a handful of numbers or a short note. */
export const USAGE_BODY_MAX_BYTES = 4 * 1024;

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  header(name: string, value: string): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

export interface AuthedUser {
  id: string;
  isAdmin: boolean;
}

/**
 * /admin/* gate. 401 when the caller cannot be authenticated (any auth
 * failure closes the door, not just the documented rejection), 403 when they
 * can but are not an admin. Returns null after writing the response.
 */
export async function requireAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  let actor: AuthedUser;
  try {
    const result = await bus.call<{ req: RouteRequest }, { user: { id: string; isAdmin: boolean } }>(
      'auth:require-user',
      ctx,
      { req },
    );
    actor = { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
  if (actor.isAdmin !== true) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return actor;
}

export type ParseBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

export function parseRequestBody(body: Buffer): ParseBodyResult {
  if (body.length > USAGE_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}
