import type { HookBus, Logger } from '@ax/core';
import type { ChannelStore } from './channel-store.js';
import { logCode } from './log-code.js';

/** The subscriber's name on the bus, so the plugin's shutdown can take it off. */
export const AGENTS_DELETED_KEY = '@ax/channel-slack/agents-deleted';

const AGENTS_DELETED = 'agents:deleted';

/** A log line never fails the cleanup it reports on. */
function quietly(log: () => void): void {
  try {
    log();
  } catch {
    // Nothing left to report it with.
  }
}

/**
 * When an agent is deleted, delete its channel bindings, on every install.
 *
 * `@ax/agents` fires `agents:deleted { agentId, ownerId, ownerType }` after
 * the agent's row is gone. A binding has no foreign key to it (no plugin
 * references another's rows), so without this a deleted agent would keep its
 * channels "taken": a connect refuses them until someone runs `/ax disconnect`
 * in each one. The repo guard
 * scripts/__tests__/agent-keyed-tables-are-cleaned.test.js requires it too.
 *
 * Only `agentId` is read, and only a non-empty string is acted on. A failure
 * is logged by code alone and never thrown: the agent is already deleted, and
 * a throw would only turn into the bus's own error line. Running it again (a
 * second delete event) is harmless. Returns the unsubscribe.
 */
export function subscribeAgentsDeleted(
  bus: HookBus,
  channels: Pick<ChannelStore, 'removeForAgent'>,
  logger: Logger,
): () => void {
  bus.subscribe<unknown>(AGENTS_DELETED, AGENTS_DELETED_KEY, async (_ctx, payload) => {
    const agentId =
      typeof payload === 'object' && payload !== null ? (payload as { agentId?: unknown }).agentId : undefined;
    if (typeof agentId !== 'string' || agentId.length === 0) return undefined;
    let count: number;
    try {
      count = await channels.removeForAgent(agentId);
    } catch (err) {
      quietly(() => logger.warn('slack_agent_cleanup_failed', { code: logCode(err) }));
      return undefined;
    }
    if (count > 0) quietly(() => logger.info('slack_agent_channels_removed', { count }));
    return undefined;
  });
  return () => {
    bus.unsubscribe(AGENTS_DELETED, AGENTS_DELETED_KEY);
  };
}
