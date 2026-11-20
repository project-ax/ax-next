import type { AgentContext, HookBus } from '@ax/core';
import { isRecord } from './slack-apps.js';

/**
 * Whether auth says `userId` is an AX admin now: only an answer about that
 * person whose `isAdmin` is exactly true. No account (null) is no. A fault
 * throws, as a rights check that can't be answered does. The one place that
 * asks, for an approve and for the approver's Allow (bot-requests.ts, bots.ts).
 */
export async function isAxAdmin(bus: HookBus, ctx: AgentContext, userId: string): Promise<boolean> {
  const user = await bus.call<{ userId: string }, unknown>('auth:get-user', ctx, { userId });
  return isRecord(user) && user['id'] === userId && user['isAdmin'] === true;
}
