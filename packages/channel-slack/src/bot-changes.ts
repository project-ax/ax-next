import type { Logger } from '@ax/core';
import { isBotNameTaken } from './bot-name.js';
import { handleFrom, type BotReply } from './bots.js';
import { liveOwnBot } from './channels.js';
import { botUrls, buildBotManifest } from './manifest.js';
import type { Mutex } from './mutex.js';
import type { SecretStore } from './secrets.js';
import type { SlackApi } from './slack-api.js';
import { createAppSteps, isHttps, namesInUse, type AppChangeRefusal } from './slack-apps.js';
import { InstallStoreError, type InstallRow, type InstallStore } from './store.js';

/**
 * A team agent's own Slack bot, changed once it is live (TASK-1171; design
 * docs/plans/2026-11-09-channel-slack-design.md §4 "Lifecycle"): a new name,
 * or a new picture. Neither needs a new approval or a reinstall, and the bot
 * stays in every channel it's in.
 *
 *   - `rename` refuses a name another bot already has (the shared bot's name,
 *     and every other bot's name and stored @handle, by the 21-character key
 *     bot-name.ts compares; the bot's own name and handle are free to vary).
 *     Then it sends Slack the bot's WHOLE manifest with the new name (Slack
 *     keeps nothing it isn't sent), stores the name only once Slack took it,
 *     and last reads the bot user's @handle again, best-effort: whether Slack
 *     changes it on a rename is unmeasured (design §7 Q3).
 *   - `setPicture` sends Slack the PNG agent-routes.ts already checked
 *     (`parseIconPng`), with `apps.icon.set`, and nothing else: no manifest,
 *     and no row write. AX keeps no copy of it.
 *
 * Both use the bot's APPROVER's configuration token (`connectedByUserId`),
 * whoever asked: only the token that made a Slack app can manage it (design
 * §8 Q5), and agent-routes.ts let only a team admin of the agent's team
 * through. The methods take no actor, so the asking admin's own token is
 * never read, rotated or written. The token goes through the step Admin ›
 * Slack's Rename uses too (`changeApp`, slack-apps.ts): read, rotated, and
 * its successor saved as the approver's BEFORE the access token minted with
 * it is used. A dead token changes nothing in AX.
 *
 * Each method takes the one app lock (`lock`, which plugin.ts shares with
 * Admin › Slack and bots.ts) exactly once, and nothing it calls takes it
 * again: mutex.ts isn't re-entrant. A bootstrap reset removes rows without
 * that lock. So a bot whose row went while Slack was changing its app
 * answers `not-live`, and its approver's just-saved token goes, unless an
 * install or a leftover app still names them.
 *
 * Log lines are code-only: `slack_bot_failed { installId, stage, code }` for
 * a step that failed, and `slack_bot_renamed { installId }` or
 * `slack_bot_picture_changed { installId }` for an outcome. Never a token, a
 * person's or an agent's id, a name, a handle, or a Slack id other than the
 * install's.
 */

export interface BotChangesDeps {
  /** The full store, not a Pick: namesInUse reads the shared install, every bot and (TASK-1169) every open request. */
  installs: InstallStore;
  /** The plugin's one cached secret store, the one bots.ts gets. */
  secrets: SecretStore;
  api: SlackApi;
  /** The one app lock. Not re-entrant: each method takes it once. */
  lock: Mutex;
  /** Where Slack reaches AX: a bot's manifest carries its events, interactions and OAuth redirect URLs. */
  publicOrigin: string;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
  randomBytes: (n: number) => Buffer;
}

export interface BotChanges {
  /**
   * Rename the agent's live bot. `botName` already passed `checkBotName`.
   * 200 `{ botName }`; 409 `not-live` | `public-origin-not-https` |
   * `bot-name-taken`; 502 what `appChangeError` says (`AppChangeRefusal`);
   * 500 `internal` when the rotated token couldn't be saved. A vault or store
   * fault throws: the route's 500.
   */
  rename(i: { agentId: string; botName: string }): Promise<BotReply>;
  /**
   * Give the agent's live bot a new picture: `png` already passed
   * `parseIconPng`. 200 `{}`; 409 `not-live`; 502 `slack-config-token` |
   * `slack-app-gone` | `slack-error`; 500 `internal` when the rotated token
   * couldn't be saved. A vault or store fault throws: the route's 500.
   */
  setPicture(i: { agentId: string; png: Buffer }): Promise<BotReply>;
}

const json = (status: number, body: unknown): BotReply => ({ status, body });
const INTERNAL = json(500, { error: 'internal' });
/** No live bot to change: none, one still pending, or one a reset removed meanwhile. */
const NOT_LIVE = json(409, { error: 'not-live' });

/** What a change Slack didn't take answers: a token we couldn't keep is ours (500), the rest Slack's (502). */
function refused(refusal: AppChangeRefusal | 'token-not-kept'): BotReply {
  return refusal === 'token-not-kept' ? INTERNAL : json(502, { error: refusal });
}

export function createBotChanges(d: BotChangesDeps): BotChanges {
  // The Slack-app steps Admin › Slack and bots.ts use too, logging as `slack_bot_failed`.
  const steps = createAppSteps({
    store: d.installs,
    secrets: d.secrets,
    api: d.api,
    logger: d.logger,
    now: d.now,
    randomBytes: d.randomBytes,
    logPrefix: 'slack_bot',
  });
  const canConnect = isHttps(d.publicOrigin);

  /** A log line never changes an outcome. */
  const log = (level: 'info' | 'warn', msg: string, fields: Record<string, string>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };

  /**
   * The renamed bot user's @handle, read again with the bot's own token and
   * kept only when `handleFrom` accepts it and it changed. Best-effort, and
   * never throws: Slack already took the name and the row has it. A missing
   * token or bot user, a failed read, an answer about anyone but the bot, a
   * name outside the rule, or a store fault keeps the stored handle, logged
   * code-only. Kept, not cleared: it stays in the names in use, and Slack may
   * well not have changed it. The caller holds the app lock.
   */
  async function refreshHandle(bot: InstallRow): Promise<void> {
    const installId = bot.installId;
    const botUserId = bot.botUserId;
    // A live bot always has its bot user, so this is never expected. Without
    // one there is nobody to ask about, and the bot token isn't even read.
    let token: string | null = null;
    if (botUserId !== null) {
      try {
        token = await d.secrets.get(bot, 'bot-token');
      } catch (err) {
        steps.failed('bot-handle', err, installId);
        return;
      }
    }
    if (botUserId === null || token === null) {
      log('warn', 'slack_bot_failed', { installId, stage: 'bot-handle', code: 'missing' });
      return;
    }
    let user: unknown;
    try {
      user = await d.api.usersInfo(token, botUserId);
    } catch (err) {
      steps.failed('bot-handle', err, installId);
      return;
    }
    const read = handleFrom(user, botUserId);
    if (!read.ok) {
      log('warn', 'slack_bot_failed', { installId, stage: 'bot-handle', code: read.code });
      return;
    }
    if (read.handle === bot.botHandle) return;
    try {
      await d.installs.setBotHandle(installId, read.handle);
    } catch (err) {
      steps.failed('bot-handle', err, installId);
    }
  }

  async function rename(i: { agentId: string; botName: string }): Promise<BotReply> {
    return d.lock.run(async () => {
      const bot = await liveOwnBot(d.installs, i.agentId);
      if (bot === null) return NOT_LIVE;
      // Every refusal that needs no Slack call, so a refused rename spends no token.
      // The manifest carries the URLs Slack calls back on: https only, as at a request.
      if (!canConnect) return json(409, { error: 'public-origin-not-https' });
      // One name per bot, the shared bot's included: Slack takes duplicates silently.
      if (isBotNameTaken(i.botName, await namesInUse(d.installs, { except: bot.installId }))) {
        return json(409, { error: 'bot-name-taken' });
      }

      // The whole manifest, built before any token is spent. Slack replaces
      // it on update, so a part of one would drop the rest (events, scopes).
      const manifest = buildBotManifest(i.botName, botUrls(d.publicOrigin, bot.installId));
      const refusal = await steps.changeApp(bot, 'update-app', (accessToken) =>
        d.api.updateApp(accessToken, bot.appId, manifest),
      );
      if (refusal !== null) return refused(refusal);

      // Only now, so the row only ever shows a name Slack took. If this write
      // fails, Slack has the name already, and a retry sends the same manifest.
      try {
        await d.installs.setBotName(bot.installId, i.botName);
      } catch (err) {
        if (err instanceof InstallStoreError) {
          // Gone meanwhile: a reset removes rows without the app lock, and
          // sweeps the secrets of what it removed. This takes back the token
          // saved after that sweep, unless something still names its person.
          await steps.release(bot);
          return NOT_LIVE;
        }
        throw err;
      }
      await refreshHandle(bot);
      log('info', 'slack_bot_renamed', { installId: bot.installId });
      return json(200, { botName: i.botName });
    });
  }

  async function setPicture(i: { agentId: string; png: Buffer }): Promise<BotReply> {
    return d.lock.run(async () => {
      const bot = await liveOwnBot(d.installs, i.agentId);
      if (bot === null) return NOT_LIVE;
      // A picture carries no URL, so an http origin doesn't stop it.
      const refusal = await steps.changeApp(bot, 'icon', (accessToken) =>
        d.api.setAppIcon(accessToken, bot.appId, i.png),
      );
      if (refusal !== null) return refused(refusal);
      // No row write here to find the row gone, so read it: a reset during
      // Slack's call would otherwise keep the token saved after its sweep.
      if ((await d.installs.get(bot.installId)) === null) {
        await steps.release(bot);
        return NOT_LIVE;
      }
      log('info', 'slack_bot_picture_changed', { installId: bot.installId });
      return json(200, {});
    });
  }

  return { rename, setPicture };
}
