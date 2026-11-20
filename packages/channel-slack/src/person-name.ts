import type { AgentContext, HookBus } from '@ax/core';
import { cleanLabel } from './label.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a page calls a person it only knows by id (an install's or a channel's
 * connector): who auth says they are NOW, since a row keeps the id and names
 * are auth's (invariant 4). Their display name, made fit to show on one line
 * (label.ts); else their email, but only where `allowEmail` says the readers
 * may see it; else `fallback`.
 *
 * `accountName` is for a page that must tell "gone" apart (TASK-1172: Admin ›
 * Slack marks a bot's approver who has left): it answers null when auth says
 * it has no such account, which only auth's own null answer means. An answer
 * that isn't an account reads as `fallback`: it is no proof that anyone left.
 * A fault in auth throws (the bus's wrap, with the fault as its cause): read
 * as a name, an outage would hide everyone who left, so such a page fails
 * and says so instead.
 */
export async function accountName(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  o: { allowEmail: boolean; fallback: string },
): Promise<string | null> {
  const user = await bus.call<{ userId: string }, unknown>('auth:get-user', ctx, { userId });
  if (user === null) return null;
  if (!isRecord(user)) return o.fallback;
  const label = (value: unknown): string => (typeof value === 'string' ? cleanLabel(value) : '');
  return label(user['displayName']) || (o.allowEmail ? label(user['email']) : '') || o.fallback;
}

/**
 * `accountName` for a page a name must never fail (the agent's Slack
 * settings, Admin › Slack's status): "gone" reads as `fallback`, and so does
 * a fault in auth, which is handed to `onFault` first (each page logs it its
 * own way).
 */
export async function personName(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  o: { allowEmail: boolean; fallback: string; onFault: (err: unknown) => void },
): Promise<string> {
  try {
    return (await accountName(bus, ctx, userId, o)) ?? o.fallback;
  } catch (err) {
    o.onFault(err);
    return o.fallback;
  }
}
