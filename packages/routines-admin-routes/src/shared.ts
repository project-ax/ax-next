import {
  isRejection,
  PluginError,
  SafeToolError,
  safeToolMessage,
  type AgentContext,
  type HookBus,
} from '@ax/core';

// ---------------------------------------------------------------------------
// Shared route plumbing for /settings/routines* — copied from
// credentials-admin-routes per Invariant L2 (no cross-plugin imports).
//
// This module owns:
//   - Duck-typed RouteRequest / RouteResponse (no @ax/http-server import,
//     same posture as packages/agents/src/admin-routes.ts — Invariant I2).
//   - 72 KiB body cap (ADMIN_BODY_MAX_BYTES) — room for a canonical 64 KiB
//     definition and its bounded request/revision envelope.
//   - The write-error → HTTP-status mapping (PluginError code → status).
//   - The auth helper. /settings/routines* needs an authed user; per-route
//     owner ACL goes through agents:resolve afterwards.
// ---------------------------------------------------------------------------

/** Locked at handler entry. Smaller than http-server's 1 MiB to keep the
 *  admin/settings surface from accepting blobs the storage layer can't
 *  reasonably hold. */
// Canonical definition JSON is capped at 64 KiB; allow its request/revision envelope.
export const ADMIN_BODY_MAX_BYTES = 72 * 1024;

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  /** Pattern-route capture for `/settings/routines/:agentId/...` etc. */
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

export interface AuthedUser {
  id: string;
  isAdmin: boolean;
}

/**
 * Ask @ax/auth-better to resolve the session cookie. Returns the user on
 * success, or null if we wrote 401 ourselves (caller must early-return).
 *
 * The shape mirrors packages/agents/src/admin-routes.ts:requireUser — call
 * `auth:require-user` with `{ req }` and unwrap `{ user: { id, isAdmin } }`.
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
    // PluginError 'unauthenticated' is the documented rejection from auth.
    // Any other failure (auth plugin not loaded, transient store error)
    // also closes the door — an admin endpoint that can't authenticate is
    // closed by default.
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

/** /settings/* gate. Any authed user passes; non-admin is fine. */
export async function requireUser(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  return requireAuthenticated(bus, ctx, req, res);
}

/** /admin/* gate. Authed AND isAdmin; 401 if no session, 403 if not admin. */
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

/** Closed routine failures are rendered again here; provider exception text is never public. */
export function writeServiceError(res: RouteResponse, err: unknown): boolean {
  if (err instanceof SafeToolError) {
    // Validate both closed fields again: plugin code can mutate Error objects.
    const checked = new SafeToolError(err.toolCode, err.field);
    const status =
      checked.toolCode === 'not-found' || checked.toolCode === 'forbidden'
        ? 404
        : [
              'revision-conflict',
              'webhook-path-conflict',
              'request-conflict',
              'cleanup-pending',
              'busy',
            ].includes(checked.toolCode)
          ? 409
          : checked.toolCode === 'unavailable'
            ? 503
            : 400;
    res
      .status(status)
      .json({
        code: checked.toolCode,
        field: checked.field,
        error: safeToolMessage(checked.toolCode, checked.field),
      });
    return true;
  }
  if (
    err instanceof PluginError &&
    (err.code === 'forbidden' || err.code === 'not-found')
  ) {
    res
      .status(404)
      .json({ code: 'not-found', error: 'The routine is unavailable.' });
    return true;
  }
  res
    .status(503)
    .json({
      code: 'unavailable',
      error: 'Routine management is temporarily unavailable.',
    });
  return true;
}

/**
 * Body-size cap + JSON.parse, with 413/400 mapped to a result the caller
 * writes verbatim. Mirrors agents/admin-routes.parseAndValidate but we
 * pass the parsed value through unvalidated — each route applies its own
 * zod schema afterwards.
 */
export type ParseBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

export function parseRequestBody(body: Buffer): ParseBodyResult {
  if (body.length > ADMIN_BODY_MAX_BYTES) {
    return { ok: false, status: 413, message: 'body-too-large' };
  }
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}
