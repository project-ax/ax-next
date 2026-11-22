import type { HookBus, Logger } from '@ax/core';
import type { Bots } from './bots.js';
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
 * When an agent is deleted, delete what channel-slack keeps for it. First its
 * channel bindings and the capture veto's thread rows (TASK-1094), on every
 * install, in one transaction. Then its own Slack bot (TASK-1167), pending or
 * live, if it has one.
 *
 * `@ax/agents` fires `agents:deleted { agentId, ownerId, ownerType }` after
 * the agent's row is gone. A binding has no foreign key to it (no plugin
 * references another's rows), so without this a deleted agent's bindings
 * would outlive it. Its thread rows go here and nowhere else: a disconnect
 * and an install's removal keep them on purpose (channel-store.ts). Its bot
 * would stay live in Slack, for an agent that is gone, and keep its
 * approver's configuration token alive. The repo guard
 * scripts/__tests__/agent-keyed-tables-are-cleaned.test.js requires every
 * one of these tables cleaned: each has an `agent_id`.
 *
 * The bot goes as bots.ts's `removeForAgent` takes it: its Slack app deleted
 * with an access token minted from its approver's token, then its row, its
 * secrets and, once nothing else names the approver, their token. That waits
 * for the one app lock Admin › Slack shares, so it never runs alongside
 * another use of the approver's token. The bindings and threads never wait
 * for it, and the bot goes even when their delete failed: neither needs the
 * other.
 *
 * Only `agentId` is read, and only a non-empty string is acted on. A failure
 * is logged by code alone and never thrown: the agent is already deleted, and
 * a throw would only turn into the bus's own error line. Running it again (a
 * second delete event) is harmless. Returns the unsubscribe.
 */
export function subscribeAgentsDeleted(
  bus: HookBus,
  d: { channels: Pick<ChannelStore, 'removeForAgent'>; bots: Pick<Bots, 'removeForAgent'> },
  logger: Logger,
): () => void {
  bus.subscribe<unknown>(AGENTS_DELETED, AGENTS_DELETED_KEY, async (_ctx, payload) => {
    const agentId =
      typeof payload === 'object' && payload !== null ? (payload as { agentId?: unknown }).agentId : undefined;
    if (typeof agentId !== 'string' || agentId.length === 0) return undefined;
    await removeChannels(d.channels, agentId, logger);
    // Never throws: bots.ts logs its own faults.
    await d.bots.removeForAgent(agentId);
    return undefined;
  });
  return () => {
    bus.unsubscribe(AGENTS_DELETED, AGENTS_DELETED_KEY);
  };
}

/**
 * The agent's bindings and threads, in one transaction. Never throws: a
 * failure is logged by code alone.
 */
async function removeChannels(
  channels: Pick<ChannelStore, 'removeForAgent'>,
  agentId: string,
  logger: Logger,
): Promise<void> {
  let removed: { channels: number; threads: number };
  try {
    removed = await channels.removeForAgent(agentId);
  } catch (err) {
    quietly(() => logger.warn('slack_agent_cleanup_failed', { code: logCode(err) }));
    return;
  }
  if (removed.channels > 0 || removed.threads > 0) {
    quietly(() => logger.info('slack_agent_channels_removed', { channels: removed.channels, threads: removed.threads }));
  }
}
