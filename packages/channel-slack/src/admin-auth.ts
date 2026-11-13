import { isUnauthenticated, type AgentContext, type HookBus } from '@ax/core';
import type { RouteRequest } from './http-types.js';
import { logCode } from './log-code.js';

/**
 * The gate on channel-slack's admin routes: a copy of @ax/branding's
 * `requireAuthenticated` / `requireAdmin` (copied, not imported: invariant 2),
 * refusing the same way. 401 when nobody is signed in, 403 for a signed-in
 * person who isn't an admin.
 *
 * It returns a verdict and writes nothing, because the routes answer a
 * refusal in two ways: the JSON routes with the status and `{ error }`, and
 * the OAuth callback, where a browser lands from Slack, by sending it home
 * with `failed` (admin-routes.ts).
 *
 * One deliberate difference: a fault in `auth:require-user` (anything but its
 * own `unauthenticated` refusal) is a 500 logged code-only, the way
 * @ax/mcp-oauth's gate does it, rather than through core's
 * `answerRequireUserFailure`, whose `{ hook, err }` line writes the error's
 * message. channel-slack's log lines carry codes only.
 */

/**
 * The signed-in admin: an id and nothing else the routes keep. Their name is
 * auth's, and is read from auth when a page shows it (invariant 4).
 */
export interface AdminActor {
  id: string;
  isAdmin: boolean;
}

/** What the gate decided. A refusal says how a JSON route answers it. */
export type AdminGate =
  | { ok: true; actor: AdminActor }
  | { ok: false; status: 401 | 403 | 500; error: 'unauthenticated' | 'forbidden' | 'internal' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The signed-in person as the gate needs them, or null for an answer it can't use. */
function actorOf(out: unknown): AdminActor | null {
  const user = isRecord(out) ? out['user'] : undefined;
  if (!isRecord(user)) return null;
  const id = user['id'];
  const isAdmin = user['isAdmin'];
  if (typeof id !== 'string' || id.length === 0 || typeof isAdmin !== 'boolean') return null;
  return { id, isAdmin };
}

/** A gate fault: a code-only log line, then a 500 refusal. */
function fault(ctx: AgentContext, code: string): AdminGate {
  try {
    ctx.logger.error('slack_admin_failed', { stage: 'auth', code });
  } catch {
    // Nothing left to report it with; the refusal still stands.
  }
  return { ok: false, status: 500, error: 'internal' };
}

/**
 * The /admin/slack gate: the signed-in admin, or why not. 401 signed out, 403
 * signed in but not an admin, 500 (logged) for any other failure.
 */
export async function checkAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
): Promise<AdminGate> {
  let out: unknown;
  try {
    out = await bus.call<{ req: RouteRequest }, unknown>('auth:require-user', ctx, { req });
  } catch (err) {
    if (isUnauthenticated(err)) return { ok: false, status: 401, error: 'unauthenticated' };
    return fault(ctx, logCode(err));
  }
  const actor = actorOf(out);
  if (actor === null) return fault(ctx, 'invalid-return');
  if (!actor.isAdmin) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, actor };
}
