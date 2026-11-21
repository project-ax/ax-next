import type { AgentContext, HookBus, Logger } from '@ax/core';
import { isBotNameTaken } from './bot-name.js';
import { handleFrom, type BotReply } from './bots.js';
import { checkRights, liveOwnBot, teamAdminAccess, type Rights } from './channels.js';
import { botUrls, buildBotManifest } from './manifest.js';
import type { Mutex } from './mutex.js';
import type { SecretStore } from './secrets.js';
import type { SlackApi } from './slack-api.js';
import { createAppSteps, isHttps, namesInUse, type AppChangeRefusal, type ReplaceRefusal } from './slack-apps.js';
import { InstallStoreError, type InstallRow, type InstallStore } from './store.js';

/**
 * A team agent's own Slack bot, changed once it is live (TASK-1171,
 * TASK-1173; design docs/plans/2026-11-09-channel-slack-design.md §4
 * "Lifecycle"): a new name, a new picture, its approver's token replaced, or
 * a new requester. None needs a new approval or a reinstall, and the bot
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
 *   - `replaceToken`, and `replaceTokenForAdmin` from Admin › Slack by install
 *     id (TASK-1173): the bot's APPROVER replaces their own configuration
 *     token, which stopped working, with a refresh token they pasted. Through
 *     the step Admin › Slack's Replace uses (`replaceConfigToken`,
 *     slack-apps.ts): the PASTED token rotated once, the access token that
 *     minted checked by sending Slack the bot's whole manifest under its
 *     stored name, and only once Slack took that is the minted refresh token
 *     stored, as the approver's. One token per person (TASK-1175), so that
 *     fixes every app of theirs. The stored token is never read or rotated:
 *     it is the dead one. No date moves and no leftover pass runs.
 *   - `claim` (TASK-1173): a team admin of the agent's team takes over a live
 *     bot whose requester is no longer one, so the bot's outsiders run as the
 *     claimer from then on. The row's requester and every binding's copy of
 *     it move in ONE statement (`InstallStore.claimBot`). No vault, no Slack:
 *     the approver, whose token made the app, doesn't change.
 *
 * Rename and picture use the bot's APPROVER's configuration token
 * (`connectedByUserId`), whoever asked: only the token that made a Slack app
 * can manage it (design §8 Q5), and agent-routes.ts let only a team admin of
 * the agent's team through. They take no actor, so the asking admin's own
 * token is never read, rotated or written. The token goes through the step
 * Admin › Slack's Rename uses too (`changeApp`, slack-apps.ts): read,
 * rotated, and its successor saved as the approver's BEFORE the access token
 * minted with it is used. A dead token changes nothing in AX. A Replace takes
 * an actor only to compare it with the approver: anyone else is refused (403
 * `not-approver`) before the vault or Slack, so nobody's paste lands in the
 * approver's slot, and the approver's paste in nobody else's. A Claim's actor
 * becomes the requester, once their manage rights are asked again inside the
 * lock, before anything is read.
 *
 * Each method takes the one app lock (`lock`, which plugin.ts shares with
 * Admin › Slack and bots.ts) exactly once, and nothing it calls takes it
 * again: mutex.ts isn't re-entrant. A bootstrap reset removes rows without
 * that lock, and sweeps the secrets of what it removed. So once `changeApp`
 * is done, whatever Slack said, the bot's row is checked: a rename's write
 * finds it gone, and any other outcome (a picture Slack took, or a change
 * Slack refused, perhaps after the rotated token was already saved) reads it
 * again; a Replace reads it again once it stored a token (a refused one
 * stored nothing). A row gone answers `not-live`, not Slack's refusal (there
 * is no bot left to fix), and the approver's token goes, unless an install or
 * a leftover app still names them: the successor saved after the reset's
 * sweep would otherwise outlive it. When nothing is stored any more (nothing
 * was saved after the sweep, or the reset's wipe came after the save), there
 * is nothing left to delete, and nothing is: every release reads the token
 * first, as the reset's own does, because the vault deletes by writing an
 * empty row and a reset leaves no credential rows behind. `release` takes no
 * lock. A claim racing a reset moves nothing (`claimBot` updates a live bot
 * only) and answers `not-live`.
 *
 * Log lines are code-only: `slack_bot_failed { installId, stage, code }` for
 * a step that failed, and `slack_bot_renamed`, `slack_bot_picture_changed`,
 * `slack_bot_token_replaced` or `slack_bot_claimed`, each `{ installId }`, for
 * an outcome. Never a token, a person's or an agent's id, a name, a handle,
 * or a Slack id other than the install's.
 */

export interface BotChangesDeps {
  /** A Claim's rights, asked again inside the lock, and whether the bot's requester is still a team admin. */
  bus: HookBus;
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
   * fault throws: the route's 500. A row a reset removed meanwhile is
   * `not-live`, whatever Slack said.
   */
  rename(i: { agentId: string; botName: string }): Promise<BotReply>;
  /**
   * Give the agent's live bot a new picture: `png` already passed
   * `parseIconPng`. 200 `{}`; 409 `not-live`; 502 `slack-config-token` |
   * `slack-app-gone` | `slack-error`; 500 `internal` when the rotated token
   * couldn't be saved. A vault or store fault throws: the route's 500. A row
   * a reset removed meanwhile is `not-live`, whatever Slack said.
   */
  setPicture(i: { agentId: string; png: Buffer }): Promise<BotReply>;
  /**
   * The approver replaces their own configuration token through the agent's
   * live bot (TASK-1173): `refreshToken` already passed the route's shape
   * check. 200 `{}`; 409 `not-live`; 403 `not-approver` for anyone but the
   * bot's approver, before the vault or Slack; 409 `public-origin-not-https`;
   * 502 `slack-refresh-token` | `slack-not-app-manager` | `slack-error`
   * (`ReplaceRefusal`), the stored token kept; 500 `internal` when the minted
   * token couldn't be stored. A vault or store fault throws: the route's
   * 500. A row a reset removed meanwhile is `not-live`.
   */
  replaceToken(i: { actorUserId: string; agentId: string; refreshToken: string }): Promise<BotReply>;
  /**
   * The same, from Admin › Slack, naming the bot by its install id: 409
   * `no-bot` for an id no team bot has (the shared app's included); 409
   * `not-live` for a bot still pending.
   */
  replaceTokenForAdmin(i: { actorUserId: string; installId: string; refreshToken: string }): Promise<BotReply>;
  /**
   * A team admin of the agent's team claims its live bot, named by the
   * install id their page showed, whose requester is no longer a team admin
   * of that team (TASK-1173): from then on its outsiders run as them. 200
   * `{}`; 403 `forbidden`, 409 `personal-agent` or 404 `not-found` when the
   * manage rights asked again say so; 409 `not-live` (no live bot, or one a
   * reset removed meanwhile); 409 `no-bot` (the agent's live bot has another
   * id); 409 `claim-not-needed` (the requester is still a team admin); 404
   * `not-found` for an agent deleted meanwhile. An agents or store fault
   * throws: the route's 500.
   */
  claim(i: { ctx: AgentContext; actorUserId: string; agentId: string; installId: string }): Promise<BotReply>;
}

const json = (status: number, body: unknown): BotReply => ({ status, body });
const INTERNAL = json(500, { error: 'internal' });
/** No live bot to change: none, one still pending, or one a reset removed meanwhile. */
const NOT_LIVE = json(409, { error: 'not-live' });
/** An install id no team bot has, or not the agent's live bot's: a stale page's, say. */
const NO_BOT = json(409, { error: 'no-bot' });
/** Only the person whose token made the bot's app can replace that token. */
const NOT_APPROVER = json(403, { error: 'not-approver' });
/** The bot's requester is still a team admin: there is nothing to claim. */
const CLAIM_NOT_NEEDED = json(409, { error: 'claim-not-needed' });

/** What a change or a Replace Slack didn't take answers: a token we couldn't keep is ours (500), the rest Slack's (502). */
function refused(refusal: AppChangeRefusal | ReplaceRefusal | 'token-not-kept'): BotReply {
  return refusal === 'token-not-kept' ? INTERNAL : json(502, { error: refusal });
}

/** A refused rights re-check, answered as the route answers its own (bots.ts does the same). */
function rightsRefused(reason: Extract<Rights, { ok: false }>['reason']): BotReply {
  if (reason === 'forbidden') return json(403, { error: 'forbidden' });
  if (reason === 'personal-agent') return json(409, { error: 'personal-agent' });
  return json(404, { error: 'not-found' });
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

  /**
   * After `changeApp`, whatever Slack said: true when the bot's row went
   * meanwhile (a reset takes no lock), after taking back its approver's token
   * unless something still names them. Only a token still stored is deleted
   * (rename's write path does the same): when the reset's wipe came after
   * anything was saved, or Slack refused the rotate so nothing was, the
   * vault's delete would leave an empty row of its own. A
   * store fault reading the row throws: the route's 500. The caller holds
   * the app lock.
   */
  async function goneMeanwhile(bot: InstallRow): Promise<boolean> {
    if ((await d.installs.get(bot.installId)) !== null) return false;
    await steps.release(bot, { onlyIfStored: true });
    return true;
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
      // A refusal may come after the successor was saved: a reset meanwhile mustn't keep it.
      if (refusal !== null) return (await goneMeanwhile(bot)) ? NOT_LIVE : refused(refusal);

      // Only now, so the row only ever shows a name Slack took. If this write
      // fails, Slack has the name already, and a retry sends the same manifest.
      try {
        await d.installs.setBotName(bot.installId, i.botName);
      } catch (err) {
        if (err instanceof InstallStoreError) {
          // Gone meanwhile: a reset removes rows without the app lock, and
          // sweeps the secrets of what it removed. This takes back the token
          // saved after that sweep, unless something still names its person;
          // only one still stored, as in goneMeanwhile: the reset's wipe may
          // have come after the save.
          await steps.release(bot, { onlyIfStored: true });
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
      // No row write here to find the row gone, so read it, taken or refused:
      // a reset during Slack's call would otherwise keep the token saved after its sweep.
      if (await goneMeanwhile(bot)) return NOT_LIVE;
      if (refusal !== null) return refused(refusal);
      log('info', 'slack_bot_picture_changed', { installId: bot.installId });
      return json(200, {});
    });
  }

  /**
   * The approver's Replace of their own token, through `bot`, a live bot the
   * caller found under the app lock (TASK-1173). Whoever asks is compared
   * with the approver and never otherwise used: the minted token goes to
   * `bot.connectedByUserId`'s slot, through the step, whoever pasted it.
   */
  async function replaceFor(bot: InstallRow, actorUserId: string, refreshToken: string): Promise<BotReply> {
    // Their token made the app, and only theirs can manage it. Asked before
    // the vault or Slack: anyone else's paste goes nowhere, and theirs never
    // reaches the approver's slot.
    if (actorUserId !== bot.connectedByUserId) return NOT_APPROVER;
    // The check sends the manifest, which carries the URLs Slack calls back on: https only, as at a rename.
    if (!canConnect) return json(409, { error: 'public-origin-not-https' });

    // The bot's whole manifest under its stored name, built before the paste
    // is spent: a manifest update is the one change that proves the minted
    // token manages THIS app, and resending what Slack has changes nothing.
    const manifest = buildBotManifest(bot.botName, botUrls(d.publicOrigin, bot.installId));
    const replaced = await steps.replaceConfigToken(bot, refreshToken, (accessToken) =>
      d.api.updateApp(accessToken, bot.appId, manifest),
    );
    // A refusal stored nothing (the step stores only after Slack took the
    // check), so there is nothing a reset meanwhile would leave behind.
    if (!replaced.ok) return refused(replaced.refusal);
    // Stored: a reset meanwhile mustn't keep it.
    if (await goneMeanwhile(bot)) return NOT_LIVE;
    log('info', 'slack_bot_token_replaced', { installId: bot.installId });
    return json(200, {});
  }

  async function replaceToken(i: { actorUserId: string; agentId: string; refreshToken: string }): Promise<BotReply> {
    return d.lock.run(async () => {
      const bot = await liveOwnBot(d.installs, i.agentId);
      // A pending bot has no channels yet: Cancel and ask again costs nothing.
      if (bot === null) return NOT_LIVE;
      return replaceFor(bot, i.actorUserId, i.refreshToken);
    });
  }

  async function replaceTokenForAdmin(i: {
    actorUserId: string;
    installId: string;
    refreshToken: string;
  }): Promise<BotReply> {
    return d.lock.run(async () => {
      const row = await d.installs.get(i.installId);
      // A team agent's bot, and nothing else: the shared app has its own Replace.
      if (row === null || row.kind !== 'bot' || row.agentId === null) return NO_BOT;
      // Its agent's live bot, and this one.
      const bot = await liveOwnBot(d.installs, row.agentId);
      if (bot === null || bot.installId !== i.installId) return NOT_LIVE;
      return replaceFor(bot, i.actorUserId, i.refreshToken);
    });
  }

  async function claim(i: {
    ctx: AgentContext;
    actorUserId: string;
    agentId: string;
    installId: string;
  }): Promise<BotReply> {
    return d.lock.run(async () => {
      // The route checked before the lock. Asked again inside it, before
      // anything is read: a claim changes whose identity the bot's outsiders
      // borrow, so a team admin demoted, or an agent deleted, while this
      // waited is refused, and nothing is touched.
      const rights = await checkRights(d.bus, i.ctx, i.agentId, i.actorUserId, 'manage');
      if (!rights.ok) return rightsRefused(rights.reason);
      // Live bots only: a pending bot whose requester left is refused at its
      // Allow, and Cancel is its way out.
      const bot = await liveOwnBot(d.installs, i.agentId);
      if (bot === null) return NOT_LIVE;
      // The bot the page showed, and no other: a stale page names an old one.
      if (bot.installId !== i.installId) return NO_BOT;
      // As things stand now. A bot row always names its requester (the
      // database's CHECK); with none, nobody vouches for its outsiders.
      const requester =
        bot.requestedByUserId === null ? 'no' : await teamAdminAccess(d.bus, i.ctx, i.agentId, bot.requestedByUserId);
      if (requester === 'yes') return CLAIM_NOT_NEEDED;
      if (requester === 'agent-gone') return json(404, { error: 'not-found' });
      if (requester === 'not-team') return json(409, { error: 'personal-agent' });
      try {
        // The row and every binding of its install, in one statement.
        await d.installs.claimBot(bot.installId, i.actorUserId);
      } catch (err) {
        // Not a live bot any more: a reset removed it meanwhile (it takes no lock).
        if (err instanceof InstallStoreError) return NOT_LIVE;
        throw err;
      }
      log('info', 'slack_bot_claimed', { installId: bot.installId });
      return json(200, {});
    });
  }

  return { rename, setPicture, replaceToken, replaceTokenForAdmin, claim };
}
