import { PluginError, type AgentContext } from '@ax/core';
import { mapPluginError } from '../errors.js';
import type { HandlerErr } from './types.js';

/**
 * A runner may act only on the conversation its session is bound to. The
 * binding is `ctx.conversationId`, which the IPC listener stamps from the
 * bearer token's session record — never from the request body. An honest
 * runner only ever names the conversation it was handed at boot, so a request
 * for any other one (or from a session bound to none) comes from a misbehaving
 * runner: refuse it with a 403 and log it.
 *
 * Returns the refusal to send, or `null` when the request names the bound
 * conversation.
 */
export function refuseUnboundConversation(
  ctx: AgentContext,
  requestedConversationId: string,
  action: string,
  logEvent: string,
): HandlerErr | null {
  const bound = ctx.conversationId;
  if (bound !== undefined && bound.length > 0 && bound === requestedConversationId) {
    return null;
  }
  ctx.logger.warn(logEvent, {
    action,
    sessionBoundToConversation: bound !== undefined && bound.length > 0,
  });
  return mapPluginError(
    new PluginError({
      code: 'forbidden',
      plugin: '@ax/ipc-core',
      hookName: action,
      message: 'a runner may act only on its own conversation',
    }),
  );
}
