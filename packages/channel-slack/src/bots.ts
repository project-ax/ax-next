import type { AgentContext, HookBus, Logger } from '@ax/core';
import { RESERVED_BOT_NAMES, isBotNameTaken } from './bot-name.js';
import { checkRights, teamAdminAccess, type Rights } from './channels.js';
import type { ParsedIcon } from './icon.js';
import { INSTALL_ID_BYTES } from './limits.js';
import { DEDICATED_BOT_SCOPES, botUrls, buildBotManifest } from './manifest.js';
import type { Mutex } from './mutex.js';
import { personName } from './person-name.js';
import { configTokenRef, type SecretOwner, type SecretStore } from './secrets.js';
import {
  SlackApiError,
  type CreatedApp,
  type OAuthInstall,
  type RotatedConfigToken,
  type SlackApi,
} from './slack-api.js';
import {
  REFRESH_TOKEN_REFUSED,
  createAppError,
  createAppSteps,
  isHttps,
  isRecord,
  namesInUse,
  refreshTokenError,
  type InstallLink,
} from './slack-apps.js';
import { InstallStoreError, type InstallRow, type InstallStore } from './store.js';

/**
 * A team agent's own Slack bot (TASK-1167; design
 * docs/plans/2026-11-09-channel-slack-design.md §4): a `kind 'bot'` install,
 * at most one per agent, pending until its approver clicks Allow in Slack.
 *
 * Its row names two people. `requestedByUserId` is the team admin who asked
 * for it, whom its channels' outsiders run as. `connectedByUserId` is its
 * approver, whose configuration token made the app (TASK-1175: one token per
 * person, shared by every Slack app they made through AX). On the self path
 * (`request`) they are one person: a team admin who can install Slack apps
 * asks and approves at once. Otherwise an AX admin approves a team admin's
 * open request in Admin › Slack (TASK-1169), and the two differ: the AX admin
 * is the approver, the team admin stays the requester. Every change to the
 * app, its deletion included, uses the approver's token through the steps
 * Admin › Slack uses too (slack-apps.ts): read, rotated, its successor saved
 * BEFORE the access token minted alongside is used, and released only once no
 * install and no leftover app names the person.
 *
 * Both ways make the bot through one create path, `create`. Its caller holds
 * the lock and has checked who may ask, for its own path (`request` re-checks
 * that the person manages the agent; an approve, that its request's requester
 * is still a team admin of the agent's team). Then:
 *   - every refusal that needs no Slack call: no live shared bot, a
 *     plain-http origin, a bot the agent already has (pending or live), an
 *     open request other than the one being approved (or that one gone), a
 *     name some bot or open request already has (an approve leaves its own
 *     request's name out);
 *   - the configuration access token. A refresh token the approver pasted
 *     wins over one stored for them: generating it revoked any older one. It
 *     goes to Slack once, to be rotated, and is never stored; the refresh
 *     token that rotate mints is stored at once as their own. Without a
 *     paste, their stored token is rotated the same way. One Slack refuses is
 *     `slack-config-token`, and stays where it is: their other apps still
 *     name them, and their next paste overwrites it;
 *   - then the app, made with the minted access token, which is then dropped;
 *     its two secrets, the pending row, its picture and the install link;
 *   - last, the request an AX admin approved goes, so an approve that fails
 *     anywhere leaves it open. Anything failing after Slack made the app
 *     takes all of it back (`undoConnect`): the app deleted, or left on the
 *     leftover list naming the approver, and their token released unless
 *     something names them.
 *
 * The approver's Allow comes back to the bot's own callback (bot-callback.ts),
 * which spends the OAuth state only for the person it was minted for and
 * hands the bot to `finish`. The bot goes live only for its approver, only
 * while the people its row names still stand, and only in the workspace the
 * shared bot is live in. On the self path that is its approver still
 * managing its agent. For an AX admin's approve it is its approver still an
 * AX admin and its requester still a team admin of the agent's team: the AX
 * admin needn't be on the team, so her own rights over the agent are never
 * asked. Its @handle is read once there, and kept only when a copy line can
 * show it.
 *
 * Every step that touches a Slack app or a configuration token runs under the
 * one app lock (`lock`), which plugin.ts creates once and shares with Admin ›
 * Slack: bot names are unique across every bot, the shared bot and every open
 * request, and one person's token serves all their apps, so nothing narrower
 * would do. It isn't re-entrant (mutex.ts): each method says whether it takes
 * it, and `create`, `finish` and `removeBot` run under their caller's.
 *
 * A bot has three secrets of its own, under its install (bot token, signing
 * secret, client secret), and never a configuration token. No answer carries
 * a token or a person's id: the one token fact any of them gives is
 * `configTokenStored`, about the viewer's own. Log lines are code-only:
 * `slack_bot_failed { installId?, stage, code }` for a step that failed, and
 * one line naming the install (and an approved request, by our own id) for
 * each outcome. Never a token, a person's or an agent's id, a name, or a
 * Slack id other than the install's.
 */

/**
 * What the agent's settings show of its own bot. `requested` and `pending`
 * reach only those who manage the agent; anyone else reads them as `none`.
 * `approver` is a display name or "A teammate", never an email: members read
 * this too.
 */
export type AgentSlackBot =
  /** `configTokenStored`: whether AX holds the viewer's OWN configuration token, so their form can skip the paste. */
  | { state: 'none'; configTokenStored: boolean }
  /**
   * An open request waiting for an AX admin (TASK-1169): no Slack app yet.
   * `requestedAt`: when it was asked, as an ISO 8601 instant.
   */
  | { state: 'requested'; botName: string; requestedAt: string }
  /** `canContinue`: the viewer is the approver, and the shared bot is live, so "Continue in Slack" can finish it. */
  | { state: 'pending'; botName: string; approver: string; canContinue: boolean }
  /**
   * `handle`: the bot user's @handle as Slack named it, or null when Slack
   * never said. `needsClaim`: its requester is no longer a team admin of the
   * agent's team, so its outsiders are turned away until one claims it.
   */
  | { state: 'live'; botName: string; handle: string | null; approver: string; needsClaim: boolean };

/** A route's answer, as agent-routes.ts writes it. */
export interface BotReply {
  status: number;
  body: unknown;
}

/**
 * Why `finish` didn't make a bot live. `oauth-access` and `store-grant` are a
 * step that failed and already logged its own code (`slack_bot_failed`); the
 * rest are refusals for the callback to name. A rights refusal keeps
 * channels.ts's word for it. `not-admin` and `requester-not-admin` are an AX
 * admin's approve (TASK-1169) whose approver is no longer an AX admin, or
 * whose requester is no longer a team admin of the agent's team.
 */
export type BotFinishRefusal =
  | 'not-pending'
  | 'not-approver'
  | Extract<Rights, { ok: false }>['reason']
  | 'not-admin'
  | 'requester-not-admin'
  | 'no-workspace'
  | 'no-client-secret'
  | 'oauth-access'
  | 'app-mismatch'
  | 'enterprise-install'
  | 'team-mismatch'
  | 'store-grant';

/** What `finish` did with an approver's Allow. */
export type BotFinish = { outcome: 'connected' } | { outcome: 'failed'; reason: BotFinishRefusal };

/**
 * What the one create path needs (TASK-1169). Its caller holds the app lock
 * and has checked who may ask, for its own path: the self path, that the
 * person manages the agent; an AX admin's approve, that its request's
 * requester is still a team admin of the agent's team.
 */
export interface BotCreate {
  agentId: string;
  /** `connected_by_user_id`: whose configuration token makes the app, and manages it from then on. */
  approverUserId: string;
  /** `requested_by_user_id`: whom its channels' outsiders run as. */
  requesterUserId: string;
  /** Already passed `checkBotName`. */
  botName: string;
  /** A refresh token the approver pasted, which passed the route's shape check, or null for their stored one. */
  refreshToken: string | null;
  /** The picture as icon.ts read it, or null. */
  icon: ParsedIcon | null;
  /** The open request an AX admin is approving, deleted once the bot is made; null on the self path. */
  requestId: string | null;
}

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
   * The agent was deleted (agents-deleted.ts). First its open request
   * (TASK-1169), if it has one, and `slack_agent_bot_request_removed
   * { requestId }` says so. Then its bot, pending or live, as `removeBot`
   * takes it, and `slack_agent_bot_removed { installId, appDeleted }` says
   * so. Takes the app lock, and looks both up only once it holds it, so a
   * bot another step was making under the lock (an approve of that very
   * request, say) is seen and goes too. An agent with neither costs two
   * reads, and no vault or Slack call. Never throws: a fault is logged
   * `slack_bot_failed { installId?, stage, code }`, with stage
   * `agent-deleted-request` for the request (the bot still goes) and
   * `agent-deleted` for the bot, with the install once it is known.
   */
  removeForAgent(agentId: string): Promise<void>;
  /**
   * Ask for the agent's own bot, as `actorUserId`, who becomes both its
   * requester and its approver (the self path). Takes the app lock, checks
   * the rights again inside it, then makes the bot through `create`.
   * `botName` already passed `checkBotName`; `refreshToken` is a pasted one
   * that passed the route's shape check, or null to use the one stored for
   * them; `icon` is the picture as icon.ts read it, or null. 200
   * `{ installUrl, iconSet }`. Refusals: 404/403/409 as the rights re-check
   * says; then `create`'s, `bot-requested` included while the agent waits
   * for an AX admin. A vault fault reading the stored token, or a rights
   * check that can't be answered, throws: the route's 500.
   */
  request(i: {
    ctx: AgentContext;
    actorUserId: string;
    agentId: string;
    botName: string;
    refreshToken: string | null;
    icon: ParsedIcon | null;
  }): Promise<BotReply>;
  /**
   * The one create path both ways share (TASK-1169): the self path's
   * `request`, and an AX admin approving a team admin's open request in
   * Admin › Slack. Runs under the caller's app lock and never takes it
   * (mutex.ts isn't re-entrant); the caller checked who may ask (BotCreate).
   * Refusals before any token is spent, in this order: 409 `no-workspace`,
   * `public-origin-not-https`, `bot-exists`; 409 `bot-requested` when the
   * agent has an open request other than `requestId`, and 404 `not-found`
   * when `requestId` is no longer the agent's open request; 409
   * `bot-name-taken` (an approve leaves its own request's name out); 500
   * `internal` for an approver id that can't name a vault ref. Then 409
   * `config-token-needed`; 502 `slack-refresh-token`, `slack-config-token`,
   * `slack-error` (a token) or what `createAppError` says (the app); 500
   * `internal`. The approved request is deleted LAST, once the install link
   * is minted: a failure anywhere, that delete included, takes the app back
   * and leaves the request open. 200 `{ installUrl, iconSet }`, logged
   * `slack_bot_requested { installId }` on the self path and
   * `slack_bot_approved { installId, requestId }` for an approve. A vault
   * fault reading the stored token throws.
   */
  create(i: BotCreate): Promise<BotReply>;
  /**
   * A fresh install link for the agent's pending bot, for its approver only:
   * the OAuth state binds one person, and only the approver's Allow can
   * finish what their token made. Any earlier link stops working. Takes the
   * app lock. 200 `{ installUrl }`; 409 `not-pending`; 403 `not-approver`.
   */
  installUrl(i: { actorUserId: string; agentId: string }): Promise<BotReply>;
  /**
   * Take back the agent's PENDING bot (one failed or cancelled Allow would
   * otherwise block the agent's bot for good), as `removeBot` does: with its
   * approver's token, whoever asks (the route let only a team admin of the
   * agent through). A live bot isn't cancelled here. Takes the app lock.
   * 200 `{ appDeleted }`, logged `slack_bot_cancelled { installId,
   * appDeleted }`; 409 `not-pending`.
   */
  cancel(i: { agentId: string }): Promise<BotReply>;
  /**
   * The approver's Allow, back from Slack: bot-callback.ts checked that the
   * OAuth state was minted for `actorUserId`, spent it, and read `install`
   * from the row it named. The bot goes live only if it is a pending bot,
   * `actorUserId` is its approver (their token made the app), the people its
   * row names still stand, and the shared bot is live. On the self path
   * (approver and requester one person) that is: they still manage its
   * agent (asked again here: a demoted admin can't finish what they
   * started). For an AX admin's approve (TASK-1169) it is: auth still says
   * the approver is an AX admin (`not-admin`), and the requester is still a
   * team admin of the agent's team (`requester-not-admin`; `not-found` for
   * an agent gone, `personal-agent` for one no longer a team agent). The AX
   * admin needn't be on the team: her own rights over the agent are never
   * asked. Then the code is traded with
   * the bot's own client secret and redirect_uri, and the workspace Slack
   * installed it in must be the shared bot's: a configuration token from
   * another workspace makes the app there, and its Allow must not put the
   * agent in that workspace. The bot token is kept BEFORE the row says
   * active. Last, best-effort, Slack's @handle for the bot user is read and
   * kept only when a copy line can show it. A refusal leaves the bot pending
   * with no bot token, so Continue in Slack and Cancel still work.
   *
   * Runs under the caller's app lock and never takes it (mutex.ts isn't
   * re-entrant). A rights or auth check that can't be answered, or a vault
   * fault reading the client secret, throws.
   */
  finish(i: { actorUserId: string; ctx: AgentContext; install: InstallRow; code: string }): Promise<BotFinish>;
  /**
   * What the agent's settings show of its bot to `viewerUserId`, given
   * whether they manage the agent and whether the shared bot is live. A bot
   * row wins over an open request (an approve has both for a moment); an
   * open request (TASK-1169) is read only for someone who manages the agent.
   * Takes no lock and never rotates or writes: the one vault read is whether
   * the viewer's own token is there. Faults in that read, the claim check or
   * the approver's name are logged and shown as the safe answer.
   */
  status(i: {
    ctx: AgentContext;
    viewerUserId: string;
    agentId: string;
    manages: boolean;
    sharedActive: boolean;
  }): Promise<AgentSlackBot>;
}

/** The approver's name when auth has none, no account or no answer. Never the email: members read this. */
const APPROVER_FALLBACK = 'A teammate';
/**
 * A bot user's @handle we keep: Slack's `name` field as its username rules
 * allow it. Copy lines show it as `@<handle>`, so it is also never a
 * RESERVED_BOT_NAMES word (`@channel`, `@here` and `@everyone` ping a whole
 * channel).
 */
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const json = (status: number, body: unknown): BotReply => ({ status, body });
const INTERNAL = json(500, { error: 'internal' });
const NOT_PENDING = json(409, { error: 'not-pending' });

/** A refused rights re-check, answered as the route answers its own. */
function rightsRefused(reason: Extract<Rights, { ok: false }>['reason']): BotReply {
  if (reason === 'forbidden') return json(403, { error: 'forbidden' });
  if (reason === 'personal-agent') return json(409, { error: 'personal-agent' });
  return json(404, { error: 'not-found' });
}

/** The configuration access token for one request, or the answer to give instead. */
type AccessToken = { ok: true; accessToken: string } | { ok: false; reply: BotReply };

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
  const canConnect = isHttps(d.publicOrigin);

  /** A log line never changes an outcome. */
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string | boolean>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };

  /** A bot's install link: its own callback, and the six scopes its manifest grants. */
  const botLink = (installId: string): InstallLink => ({
    redirectUrl: botUrls(d.publicOrigin, installId).redirectUrl,
    scopes: DEDICATED_BOT_SCOPES,
  });

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
      // Its open request first (TASK-1169), in a try of its own: it holds no
      // token and no Slack app, so a fault here is logged and never keeps the bot.
      try {
        const requestId = await d.installs.removeBotRequestForAgent(agentId);
        if (requestId !== null) log('info', 'slack_agent_bot_request_removed', { requestId });
      } catch (err) {
        steps.failed('agent-deleted-request', err, undefined, 'error');
      }
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

  /**
   * A pasted refresh token: tried once, then the refresh token that rotate
   * mints stored straight away as `owner`'s own. Generating the paste revoked
   * any older token of theirs, so the minted one is now their only live one.
   * The paste itself is never stored. The caller holds the app lock.
   */
  async function fromPaste(owner: SecretOwner, pasted: string): Promise<AccessToken> {
    let minted: RotatedConfigToken;
    try {
      minted = await d.api.rotateConfigToken(pasted);
    } catch (err) {
      steps.failed('try-refresh-token', err, owner.installId);
      return { ok: false, reply: json(502, { error: refreshTokenError(err) }) };
    }
    if (!(await steps.saveRotatedToken(owner, minted.refreshToken))) return { ok: false, reply: INTERNAL };
    return { ok: true, accessToken: minted.accessToken };
  }

  /**
   * `owner`'s stored token: read, rotated, and the successor saved BEFORE the
   * minted access token is used, because the rotate retired the stored one.
   * None stored is `config-token-needed` (the form then asks for a paste).
   * One Slack refuses is `slack-config-token`, and is left as it is: other
   * apps still name the person, and their next paste overwrites it. A rotate
   * that simply failed is `slack-error`. A successor that won't save is a
   * 500, and nothing is made with it. A vault fault reading it throws (the
   * route's 500). The caller holds the app lock.
   */
  async function fromStored(owner: SecretOwner): Promise<AccessToken> {
    const stored = await d.secrets.getConfigToken(owner);
    if (stored === null) return { ok: false, reply: json(409, { error: 'config-token-needed' }) };
    let minted: RotatedConfigToken;
    try {
      minted = await d.api.rotateConfigToken(stored);
    } catch (err) {
      steps.failed('rotate', err, owner.installId);
      const refused = err instanceof SlackApiError && REFRESH_TOKEN_REFUSED.has(err.code);
      return { ok: false, reply: json(502, { error: refused ? 'slack-config-token' : 'slack-error' }) };
    }
    if (!(await steps.saveRotatedToken(owner, minted.refreshToken))) return { ok: false, reply: INTERNAL };
    return { ok: true, accessToken: minted.accessToken };
  }

  async function create(i: BotCreate): Promise<BotReply> {
    // Every refusal that needs no Slack call, so a refused create spends no token.
    const shared = await d.installs.current();
    if (shared === null || shared.status !== 'active') return json(409, { error: 'no-workspace' });
    // The manifest carries the URLs Slack calls back on: https only.
    if (!canConnect) return json(409, { error: 'public-origin-not-https' });
    if ((await d.installs.botForAgent(i.agentId)) !== null) return json(409, { error: 'bot-exists' });
    // An agent has an open request or a bot, never both (TASK-1169): the self
    // path waits while an AX admin is asked, and an approve makes a bot only
    // for the agent's own open request, the one its admin saw.
    const open = await d.installs.botRequestForAgent(i.agentId);
    if (open !== null && open.requestId !== i.requestId) return json(409, { error: 'bot-requested' });
    if (open === null && i.requestId !== null) return json(404, { error: 'not-found' });
    // One name per bot, the shared bot's and every open request's included:
    // Slack takes duplicates silently. An approve leaves its own request's out.
    const taken = await namesInUse(d.installs, i.requestId !== null ? { except: i.requestId } : {});
    if (isBotNameTaken(i.botName, taken)) return json(409, { error: 'bot-name-taken' });
    // An id that can't name a vault ref can hold no token (secrets.ts):
    // refused before any token is spent. Logged code-only, never the id.
    try {
      configTokenRef(i.approverUserId);
    } catch (err) {
      steps.failed('request', err);
      return INTERNAL;
    }

    const installId = d.randomBytes(INSTALL_ID_BYTES).toString('base64url');
    // The approver's token makes the app (TASK-1175), whoever asked for it.
    const owner: SecretOwner = { installId, connectedByUserId: i.approverUserId };
    const token = i.refreshToken !== null ? await fromPaste(owner, i.refreshToken) : await fromStored(owner);
    if (!token.ok) return token.reply;

    let app: CreatedApp;
    try {
      app = await d.api.createApp(token.accessToken, buildBotManifest(i.botName, botUrls(d.publicOrigin, installId)));
    } catch (err) {
      steps.failed('create-app', err, installId);
      // A first-time approver's just-stored token goes again; one whose other apps name them stays.
      await steps.release(owner);
      return json(502, { error: createAppError(err) });
    }

    let rowStored = false;
    try {
      await d.secrets.put(owner, 'client-secret', app.clientSecret);
      await d.secrets.put(owner, 'signing-secret', app.signingSecret);
      await d.installs.insertPendingBot({
        installId,
        appId: app.appId,
        clientId: app.clientId,
        botName: i.botName,
        connectedByUserId: i.approverUserId,
        agentId: i.agentId,
        requestedByUserId: i.requesterUserId,
      });
      rowStored = true;
      const iconSet = await steps.setIcon(token.accessToken, app.appId, installId, i.icon);
      // The state binds the approver: only their Allow finishes what their token made.
      const installUrl = await steps.mintInstallUrl(installId, app.clientId, i.approverUserId, botLink(installId));
      // Last, once everything else worked: an approve that fails anywhere,
      // this delete included, leaves its request open for another try.
      if (i.requestId !== null) await d.installs.removeBotRequest(i.requestId);
      if (i.requestId === null) log('info', 'slack_bot_requested', { installId });
      else log('info', 'slack_bot_approved', { installId, requestId: i.requestId });
      return json(200, { installUrl, iconSet });
    } catch (err) {
      // Slack made the app: take all of it back, with the access token still in hand.
      steps.failed('request', err, installId);
      await steps.undoConnect(token.accessToken, app.appId, owner, i.botName, rowStored);
      // Another bot for the agent got in first (the unique index is the last word).
      if (err instanceof InstallStoreError && err.code === 'bot-exists') return json(409, { error: 'bot-exists' });
      return INTERNAL;
    }
  }

  async function request(i: {
    ctx: AgentContext;
    actorUserId: string;
    agentId: string;
    botName: string;
    refreshToken: string | null;
    icon: ParsedIcon | null;
  }): Promise<BotReply> {
    return d.lock.run(async () => {
      // The route checked before the lock. Asked again inside it: an agent
      // deleted while this waited has already had its bot removed (that
      // removal takes this lock too), so a request let through here would
      // make a bot nobody ever removes. A demoted admin is refused the same way.
      const rights = await checkRights(d.bus, i.ctx, i.agentId, i.actorUserId, 'manage');
      if (!rights.ok) return rightsRefused(rights.reason);
      // The self path: the person asking approves it too, so their token makes the app.
      return create({
        agentId: i.agentId,
        approverUserId: i.actorUserId,
        requesterUserId: i.actorUserId,
        botName: i.botName,
        refreshToken: i.refreshToken,
        icon: i.icon,
        requestId: null,
      });
    });
  }

  async function installUrl(i: { actorUserId: string; agentId: string }): Promise<BotReply> {
    return d.lock.run(async () => {
      const bot = await d.installs.botForAgent(i.agentId);
      if (bot === null || bot.status !== 'pending') return NOT_PENDING;
      if (i.actorUserId !== bot.connectedByUserId) return json(403, { error: 'not-approver' });
      try {
        return json(200, {
          installUrl: await steps.mintInstallUrl(bot.installId, bot.clientId, i.actorUserId, botLink(bot.installId)),
        });
      } catch (err) {
        // Allowed (or removed) since it was read.
        if (err instanceof InstallStoreError) return NOT_PENDING;
        throw err;
      }
    });
  }

  async function cancel(i: { agentId: string }): Promise<BotReply> {
    return d.lock.run(async () => {
      const bot = await d.installs.botForAgent(i.agentId);
      // A live bot isn't cancelled here: its channels would go with it.
      if (bot === null || bot.status !== 'pending') return NOT_PENDING;
      const appDeleted = await removeBot(bot);
      log('info', 'slack_bot_cancelled', { installId: bot.installId, appDeleted });
      return json(200, { appDeleted });
    });
  }

  /**
   * Slack's @handle for the new bot user, kept only when a copy line can show
   * it (HANDLE_RE, and no reserved word). It is Slack's text, so it is checked
   * here, before it is stored, and never cleaned into something else.
   * Best-effort: a failed read, an answer about anyone but the bot, or a name
   * outside the rule leaves it null, logged code-only, and never fails the
   * Allow. The caller holds the app lock.
   */
  async function keepHandle(installId: string, granted: OAuthInstall): Promise<void> {
    let user: unknown;
    try {
      user = await d.api.usersInfo(granted.botToken, granted.botUserId);
    } catch (err) {
      steps.failed('bot-handle', err, installId);
      return;
    }
    if (!isRecord(user) || user['id'] !== granted.botUserId) {
      log('warn', 'slack_bot_failed', { installId, stage: 'bot-handle', code: 'user-mismatch' });
      return;
    }
    const handle = user['name'];
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle) || RESERVED_BOT_NAMES.has(handle)) {
      log('warn', 'slack_bot_failed', { installId, stage: 'bot-handle', code: 'unusable-handle' });
      return;
    }
    try {
      await d.installs.setBotHandle(installId, handle);
    } catch (err) {
      steps.failed('bot-handle', err, installId);
    }
  }

  /**
   * Whether auth says `userId` is an AX admin now: only an answer about that
   * person whose `isAdmin` is exactly true. No account (null) is no. A fault
   * throws, as a rights check that can't be answered does.
   */
  async function isAxAdmin(ctx: AgentContext, userId: string): Promise<boolean> {
    const user = await d.bus.call<{ userId: string }, unknown>('auth:get-user', ctx, { userId });
    return isRecord(user) && user['id'] === userId && user['isAdmin'] === true;
  }

  async function finish(i: {
    actorUserId: string;
    ctx: AgentContext;
    install: InstallRow;
    code: string;
  }): Promise<BotFinish> {
    const bot = i.install;
    const refuse = (reason: BotFinishRefusal): BotFinish => ({ outcome: 'failed', reason });
    // A team agent's bot waiting for its Allow, and nothing else. A bot row
    // always names its requester (the database's CHECK): one that doesn't isn't a bot.
    if (bot.kind !== 'bot' || bot.status !== 'pending' || bot.agentId === null || bot.requestedByUserId === null) {
      return refuse('not-pending');
    }
    // Their token made the app, so only their Allow finishes it.
    if (bot.connectedByUserId !== i.actorUserId) return refuse('not-approver');
    // As things stand now, not as they stood when it was asked for.
    if (bot.requestedByUserId === bot.connectedByUserId) {
      // The self path: they asked for it, and must still manage its agent.
      const rights = await checkRights(d.bus, i.ctx, bot.agentId, i.actorUserId, 'manage');
      if (!rights.ok) return refuse(rights.reason);
    } else {
      // An AX admin approved a team admin's request (TASK-1169). She needn't
      // be on the agent's team, so her rights over it are never asked: she
      // must still be an AX admin, and the requester, whom its outsiders run
      // as, still a team admin of the agent's team.
      if (!(await isAxAdmin(i.ctx, i.actorUserId))) return refuse('not-admin');
      const requester = await teamAdminAccess(d.bus, i.ctx, bot.agentId, bot.requestedByUserId);
      if (requester === 'agent-gone') return refuse('not-found');
      if (requester === 'not-team') return refuse('personal-agent');
      if (requester === 'no') return refuse('requester-not-admin');
    }
    // The workspace the shared bot is live in, read before Slack is asked anything.
    const shared = await d.installs.current();
    if (shared === null || shared.status !== 'active') return refuse('no-workspace');
    const exchanged = await steps.exchangeCode(bot, i.code, botLink(bot.installId).redirectUrl);
    if (!exchanged.ok) return refuse(exchanged.reason);
    // Slack made and installed the app wherever the approver's configuration
    // token was from. Another workspace's bot token is never kept: the bot
    // stays pending, and Cancel deletes the app with the approver's token.
    if (exchanged.granted.teamId !== shared.teamId) return refuse('team-mismatch');
    if (!(await steps.storeGrant(bot, exchanged.granted))) return refuse('store-grant');
    await keepHandle(bot.installId, exchanged.granted);
    return { outcome: 'connected' };
  }

  /**
   * Whether AX holds the viewer's own configuration token: read only for
   * someone who could ask for a bot now (they manage the agent, and the
   * shared bot is live). Only whether it is there: a rotate is the one
   * honest test of a token, and a status never spends one. A fault (an id
   * that can't name a ref included) reads false, which only shows the form's
   * token field.
   */
  async function viewerTokenStored(i: { viewerUserId: string; manages: boolean; sharedActive: boolean }): Promise<boolean> {
    if (!i.manages || !i.sharedActive) return false;
    try {
      return (await d.secrets.getConfigToken({ installId: '', connectedByUserId: i.viewerUserId })) !== null;
    } catch (err) {
      steps.failed('status-config-token', err, undefined, 'warn');
      return false;
    }
  }

  /**
   * Whether the bot's requester is no longer a team admin of the agent's
   * team, so its outsiders are turned away until someone claims it. Shown
   * only: the router asks on every mention. A fault reads false.
   */
  async function needsClaim(i: { ctx: AgentContext; agentId: string }, bot: InstallRow): Promise<boolean> {
    // A bot row always has its requester (the database's CHECK); with none, nobody can vouch for its outsiders.
    if (bot.requestedByUserId === null) return true;
    try {
      return (await teamAdminAccess(d.bus, i.ctx, i.agentId, bot.requestedByUserId)) !== 'yes';
    } catch (err) {
      steps.failed('status-claim', err, bot.installId, 'warn');
      return false;
    }
  }

  async function status(i: {
    ctx: AgentContext;
    viewerUserId: string;
    agentId: string;
    manages: boolean;
    sharedActive: boolean;
  }): Promise<AgentSlackBot> {
    const bot = await d.installs.botForAgent(i.agentId);
    if (bot === null) {
      // An open request waiting for an AX admin (TASK-1169) is, as a pending
      // bot is, the business of those who manage the agent: read only for them.
      const asked = i.manages ? await d.installs.botRequestForAgent(i.agentId) : null;
      if (asked !== null) return { state: 'requested', botName: asked.botName, requestedAt: asked.createdAt.toISOString() };
      return { state: 'none', configTokenStored: await viewerTokenStored(i) };
    }
    // A bot row wins over a request (an approve has both for a moment). A
    // pending bot is the business of those who manage the agent; anyone else sees no bot yet.
    if (bot.status === 'pending' && !i.manages) {
      return { state: 'none', configTokenStored: await viewerTokenStored(i) };
    }
    // As auth knows them now: the row keeps only the id (invariant 4).
    const approver = await personName(d.bus, i.ctx, bot.connectedByUserId, {
      allowEmail: false,
      fallback: APPROVER_FALLBACK,
      onFault: (err) => steps.failed('approver', err, bot.installId, 'warn'),
    });
    if (bot.status === 'pending') {
      return {
        state: 'pending',
        botName: bot.botName,
        approver,
        canContinue: i.viewerUserId === bot.connectedByUserId && i.sharedActive,
      };
    }
    return {
      state: 'live',
      botName: bot.botName,
      handle: bot.botHandle,
      approver,
      needsClaim: await needsClaim(i, bot),
    };
  }

  return { removeForAgent, request, create, installUrl, cancel, finish, status };
}
