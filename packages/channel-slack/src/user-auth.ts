import { isUnauthenticated, type AgentContext, type HookBus } from '@ax/core';
import type { RouteRequest } from './http-types.js';
import { logCode } from './log-code.js';

/**
 * The gate on the agent settings' Slack routes (agent-routes.ts): the
 * signed-in person, whatever their role. Copied in shape from admin-auth.ts:
 * 401 when nobody is signed in; a fault in `auth:require-user` (anything but
 * its own `unauthenticated` refusal) is a 500 logged code-only.
 *
 * It keeps the person's id and nothing else. Their workspace-admin flag is
 * deliberately never read: what they may do with an agent's channels is the
 * agent's team's to say (channels.ts), and workspace-admin status grants none
 * of it.
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
    ctx.logger.error('slack_channel_route_failed', { stage: 'auth', code });
  } catch {
    // Nothing left to report it with; the refusal still stands.
  }
  return { ok: false, status: 500, error: 'internal' };
}

export async function checkUser(bus: HookBus, ctx: AgentContext, req: RouteRequest): Promise<UserGate> {
  let out: unknown;
  try {
    out = await bus.call<{ req: RouteRequest }, unknown>('auth:require-user', ctx, { req });
  } catch (err) {
    if (isUnauthenticated(err)) return { ok: false, status: 401, error: 'unauthenticated' };
    return fault(ctx, logCode(err));
  }
  const user = isRecord(out) ? out['user'] : undefined;
  const id = isRecord(user) ? user['id'] : undefined;
  if (typeof id !== 'string' || id.length === 0) return fault(ctx, 'invalid-return');
  return { ok: true, userId: id };
}
