import type { HookBus, Logger } from '@ax/core';
import type { Mutex } from './mutex.js';
import type { SecretStore } from './secrets.js';
import type { SlackApi } from './slack-api.js';
import { createAppSteps } from './slack-apps.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * A team agent's own Slack bot (TASK-1167; design
 * docs/plans/2026-11-09-channel-slack-design.md §4): a `kind 'bot'` install,
 * at most one per agent, pending until its approver clicks Allow in Slack.
 *
 * Its row names two people. `requestedByUserId` is the team admin who asked
 * for it, whom its channels' outsiders run as. `connectedByUserId` is its
 * approver, whose configuration token made the app (TASK-1175: one token per
 * person, shared by every Slack app they made through AX); in TASK-1167 the
 * two are the same person. Every change to the app, its deletion included,
 * uses the approver's token through the steps Admin › Slack uses too
 * (slack-apps.ts): read, rotated, its successor saved BEFORE the access token
 * minted alongside is used, and released only once no install and no
 * leftover app names the person.
 *
 * Every step that touches a Slack app or a configuration token runs under the
 * one app lock (`lock`), which plugin.ts creates once and shares with Admin ›
 * Slack: bot names are unique across every bot and the shared bot, and one
 * person's token serves all their apps, so nothing narrower would do. It
 * isn't re-entrant (mutex.ts): each method says whether it takes it, and
 * `removeBot` runs under its caller's.
 *
 * A bot has three secrets of its own, under its install (bot token, signing
 * secret, client secret), and never a configuration token. Log lines are
 * code-only: `slack_bot_failed { installId?, stage, code }` for a step that
 * failed, and one line naming the install for each outcome. Never a token, a
 * person's or an agent's id, a name, or a Slack id other than the install's.
 */

export interface BotDeps {
  bus: HookBus;
  installs: InstallStore;
  /**
   * The plugin's one cached store (secret-cache.ts), so a bot's removal also
   * drops the signing secret the events route keeps for it.
   */
  secrets: SecretStore;
  api: SlackApi;
  /** The one app lock, shared with Admin › Slack. Not re-entrant. */
  lock: Mutex;
  /** Where Slack reaches AX: a bot's events and interactions URLs and its OAuth redirect. */
  publicOrigin: string;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
  randomBytes: (n: number) => Buffer;
}

export interface Bots {
  /**
   * The agent was deleted (agents-deleted.ts): its bot, pending or live, goes
   * as `removeBot` takes it, and `slack_agent_bot_removed { installId,
   * appDeleted }` says so. Takes the app lock, and looks the bot up only once
   * it holds it, so a bot another step was making under the lock is seen and
   * goes too. An agent with no bot costs one read, and no vault or Slack
   * call. Never throws: a fault is logged `slack_bot_failed { installId?,
   * stage: 'agent-deleted', code }`, with the install once it is known.
   */
  removeForAgent(agentId: string): Promise<void>;
}

export function createBots(d: BotDeps): Bots {
  // The Slack-app steps Admin › Slack uses too, logging as `slack_bot_failed`.
  const steps = createAppSteps({
    store: d.installs,
    secrets: d.secrets,
    api: d.api,
    logger: d.logger,
    now: d.now,
    randomBytes: d.randomBytes,
    logPrefix: 'slack_bot',
  });

  /** A log line never changes an outcome. */
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string | boolean>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };

  /**
   * Take a bot away, pending or live, as Admin › Slack's Disconnect takes the
   * shared app. First its Slack app, deleted with an access token minted from
   * its approver's token (the successor saved first). Then, in one
   * statement, its row and its channel bindings, with the app moved to the
   * leftover list, still naming the approver, when Slack didn't delete it.
   * Then its three secrets, and last the approver's token, unless an install
   * or a leftover app still names them. A row that won't go throws, and
   * nothing after it runs: its secrets and the approver's token stay, as
   * Disconnect leaves them, so a later try can still finish. The caller holds
   * the app lock. True when the app is gone from Slack.
   */
  async function removeBot(bot: InstallRow): Promise<boolean> {
    const appDeleted = await steps.deleteSlackApp(bot);
    await d.installs.remove(bot.installId, { appLeft: !appDeleted });
    await d.secrets.removeAll(bot);
    await steps.release(bot);
    return appDeleted;
  }

  async function removeForAgent(agentId: string): Promise<void> {
    await d.lock.run(async () => {
      let bot: InstallRow | null = null;
      try {
        bot = await d.installs.botForAgent(agentId);
        if (bot === null) return;
        const appDeleted = await removeBot(bot);
        log('info', 'slack_agent_bot_removed', { installId: bot.installId, appDeleted });
      } catch (err) {
        // Our own store failing: the agent is gone and its bot may not be.
        steps.failed('agent-deleted', err, bot?.installId, 'error');
      }
    });
  }

  return { removeForAgent };
}
