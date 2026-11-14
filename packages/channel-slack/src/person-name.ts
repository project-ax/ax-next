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
 * may see it; else `fallback`, which also stands in for an account that's
 * gone. A fault in auth is handed to `onFault` (each page logs it its own
 * way) and answered with `fallback`: a name never fails the page it's on.
 */
export async function personName(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  o: { allowEmail: boolean; fallback: string; onFault: (err: unknown) => void },
): Promise<string> {
  let user: unknown;
  try {
    user = await bus.call<{ userId: string }, unknown>('auth:get-user', ctx, { userId });
  } catch (err) {
    o.onFault(err);
    return o.fallback;
  }
  if (!isRecord(user)) return o.fallback;
  const label = (value: unknown): string => (typeof value === 'string' ? cleanLabel(value) : '');
  return label(user['displayName']) || (o.allowEmail ? label(user['email']) : '') || o.fallback;
}
