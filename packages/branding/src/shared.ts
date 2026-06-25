import {
  isRejection,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';

// ---------------------------------------------------------------------------
// Shared route plumbing for the branding surface.
//
// Duck-typed RouteRequest / RouteResponse — no @ax/http-server import, same
// posture as the sibling admin-route plugins (Invariant I2). The response
// adds `header()` + `body()` (vs the json-only admin-settings shape) because
// the logo-serve route streams raw bytes with hardened headers.
//
// The auth helpers mirror credentials-admin-routes/shared.ts: call
// `auth:require-user` with `{ req }` and unwrap `{ user: { id, isAdmin } }`.
// ---------------------------------------------------------------------------

/**
 * Whole-body cap for `PUT /admin/branding`. Covers two logos + name, base64-
 * inflated. The PUT route also passes this as `maxBodyBytes` so http-server
 * rejects oversized bodies (413) before the handler runs; this in-handler
 * check is the defense-in-depth backstop.
 */
export const BRANDING_BODY_MAX_BYTES = 3 * 1024 * 1024;

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  /** Pattern-route capture for `/api/branding/logo/:variant`. */
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  header(name: string, value: string): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  /** Send raw bytes. Content-Type set via an earlier `header()` call wins. */
  body(buf: Buffer, contentType?: string): void;
  end(): void;
}

export interface AuthedUser {
  id: string;
  isAdmin: boolean;
}

/**
 * Resolve the session cookie via @ax/auth-better. Returns the user, or null
 * after writing 401 (caller must early-return). Any auth failure — not just
 * the documented `unauthenticated` rejection — closes the door: an admin
 * endpoint that can't authenticate is closed by default.
 */
export async function requireAuthenticated(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  try {
    const result = await bus.call<
      { req: RouteRequest },
      { user: { id: string; isAdmin: boolean } }
    >('auth:require-user', ctx, { req });
    return { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

/** /admin/* gate. 401 → unauthenticated; 403 → authenticated but not admin. */
export async function requireAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  const actor = await requireAuthenticated(bus, ctx, req, res);
  if (actor === null) return null;
  if (!actor.isAdmin) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return actor;
}

export type ParseBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

export function parseRequestBody(body: Buffer): ParseBodyResult {
  if (body.length > BRANDING_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}
