import { isUnauthenticated, type AgentContext } from '@ax/core';
import type { BridgeBus } from './access.js';
import type { RouteRequest } from './http-types.js';
import { loggableCode } from './log-code.js';

/**
 * The gate on the Apps settings and approve routes (settings-routes.ts): the
 * signed-in person, whatever their role. Copied in shape from channel-slack's
 * user-auth.ts: 401 when nobody is signed in; a fault in `auth:require-user`
 * (anything but its own `unauthenticated` refusal) is a 500 logged code-only.
 *
 * It keeps the person's id and nothing else. Their workspace-admin flag is
 * deliberately never read: who may lend an agent's sign-in is the agent's
 * owners' call (`agents:can-manage-connectors`, asked as a non-admin), and
 * workspace-admin status grants none of it.
 */
export type UserGate =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 500; error: 'unauthenticated' | 'internal' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A gate fault: a code-only log line, then a 500 refusal. */
function fault(ctx: AgentContext, code: string): UserGate {
  try {
    ctx.logger.error('apps_settings_route_failed', { stage: 'auth', code });
  } catch {
    // Nothing left to report it with; the refusal still stands.
  }
  return { ok: false, status: 500, error: 'internal' };
}

export async function checkUser(bus: BridgeBus, ctx: AgentContext, req: RouteRequest): Promise<UserGate> {
  let out: unknown;
  try {
    out = await bus.call<{ req: RouteRequest }, unknown>('auth:require-user', ctx, { req });
  } catch (err) {
    if (isUnauthenticated(err)) return { ok: false, status: 401, error: 'unauthenticated' };
    return fault(ctx, loggableCode(err) ?? 'unknown');
  }
  const user = isRecord(out) ? out['user'] : undefined;
  const id = isRecord(user) ? user['id'] : undefined;
  if (typeof id !== 'string' || id.length === 0) return fault(ctx, 'invalid-return');
  return { ok: true, userId: id };
}
