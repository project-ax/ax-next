import { makeAgentContext, type AgentContext, type HookBus, type Logger } from '@ax/core';
import type { BotChanges } from './bot-changes.js';
import { checkBotName } from './bot-name.js';
import type { BotRequests } from './bot-requests.js';
import type { AgentSlackBot, Bots } from './bots.js';
import type { ChannelStore } from './channel-store.js';
import { checkRights, liveOwnBot, type Rights } from './channels.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { parseIconPng, type ParsedIcon } from './icon.js';
import { INSTALL_ID_RE } from './ingress.js';
import { ADMIN_BODY_MAX_BYTES, ADMIN_CONNECT_BODY_MAX_BYTES, AGENT_ID_MAX } from './limits.js';
import { logCode } from './log-code.js';
import { personalAgentFor } from './router.js';
import { REFRESH_TOKEN_PREFIX, bodyObject, configToken } from './slack-apps.js';
import type { InstallStore } from './store.js';
import { agentTeamName } from './team-name.js';
import { checkUser } from './user-auth.js';

/**
 * The Slack section of a team agent's settings: the agent's own Slack bot
 * (TASK-1167, bots.ts). Asking for it, picking the request back up in Slack,
 * cancelling it, and disconnecting it (TASK-1172); once it's live, the
 * channels it has answered in (`botChannels`, a binding on its install),
 * renaming it or changing its picture (TASK-1171, bot-changes.ts), its
 * approver replacing their configuration token, and a team admin claiming it
 * once its requester is no longer one (TASK-1173). Or, for a team admin who
 * can't install Slack apps, asking an AX admin to approve it instead
 * (TASK-1169, bot-requests.ts), and taking that ask back. The shared app
 * connects no channel here (TASK-1186; design §4b.1): a team agent is reached
 * in a channel only through its own bot.
 *
 *   GET  /settings/slack/:agentId             → AgentSlackStatus          (anyone who can see the agent)
 *   POST /settings/slack/:agentId/bot         { botName, refreshToken?, iconPng? } → { installUrl, iconSet }
 *   POST /settings/slack/:agentId/bot/install-url  → { installUrl }, its approver only, while pending
 *   POST /settings/slack/:agentId/bot/cancel  { installId } → { appDeleted }, while pending (the domain
 *                                             asks the rights again, and answers 409 not-pending
 *                                             unless `installId` is the agent's pending bot, TASK-1173)
 *   POST /settings/slack/:agentId/bot/disconnect  { installId } → { appDeleted }, pending or live, with
 *                                               or without the shared app (the domain asks the rights
 *                                               again, and answers 409 no-bot unless `installId` is
 *                                               the agent's bot)
 *   POST /settings/slack/:agentId/bot/rename  { botName } → { botName }, a live bot only (the approver's token, TASK-1171)
 *   POST /settings/slack/:agentId/bot/icon    { iconPng } → {}, a live bot only (the approver's token, TASK-1171)
 *   POST /settings/slack/:agentId/bot/replace-token  { refreshToken } → {}, a live bot only, and only
 *                                             its approver (403 not-approver for anyone else, TASK-1173)
 *   POST /settings/slack/:agentId/bot/claim   { installId } → {}, a live bot whose requester is no
 *                                             longer a team admin (the domain asks the rights again,
 *                                             and answers 409 not-live without a live bot and 409
 *                                             no-bot when `installId` is another bot's, TASK-1173)
 *   POST /settings/slack/:agentId/bot-request         { botName } → {}, while it has no bot and no request
 *   POST /settings/slack/:agentId/bot-request/cancel  → {}, while it has an open request
 *
 * Every route answers, in this order: 401 signed out; the SAME 404 for an
 * agent the person can't see, one that doesn't exist, and an id no agent
 * could have (never tell someone the agent exists); then rights (channels.ts:
 * a team admin of the agent's team manages, workspace-admin status never
 * counts; anything but a team agent is `personal-agent`), all before a body
 * is read or the domain is asked anything. The routes hold no Slack client
 * and no vault: the domains do. The POSTs keep http-server's CSRF check and
 * cap their bodies; an unknown body key is a 400, so nothing in a body can
 * name another agent. The bot's request body can carry its picture, and a
 * new picture's body is one, so both have Admin › Slack's Connect cap.
 * The request's `refreshToken` is optional (the one stored for the person is
 * used without it), but one that is there must look like a configuration
 * refresh token, so an access token pasted into that box never reaches Slack.
 * Install-url reads no body; Cancel, Disconnect and Claim take only the
 * install id of the bot the page showed (INSTALL_ID_RE, as Admin › Slack's
 * Disconnect does), so a page drawn before the bot was cancelled or
 * disconnected, and asked for again, can't take the new one.
 * A rename's name must pass checkBotName (400 `invalid-bot-name` {reason}),
 * and a new picture parseIconPng (400 `invalid-icon` {reason}: here the
 * picture is the whole ask, so a bad one is refused, never skipped), both
 * before the domain takes the app lock. Neither hands the domain who asked:
 * it uses the bot's approver's token, whoever that is. A Replace's body is
 * the pasted refresh token alone, and it must look like one (400
 * `invalid-refresh-token`, a missing one included) before the domain takes
 * the app lock, so nothing else ever reaches Slack. It hands the domain who
 * asked only to be compared with the bot's approver: the minted token is
 * always stored as the approver's. A Claim hands the domain who asked, who
 * becomes the bot's requester once the domain has asked their rights again.
 * An ask for an AX admin's approval holds the name and nothing else: no
 * token (the approving AX admin brings their own) and no picture (their
 * browser draws it at Approve). Taking the ask back reads no body.
 *
 * Team members who aren't admins read the section, so a bot's approver is a
 * display name or "A teammate", never an email, and a live bot's install id
 * reaches only those who manage the agent (bots.ts). Failures log code-only.
 */

/**
 * A channel the agent's own bot has answered in (a binding on its install).
 * Nothing about its privacy: a private channel is remembered like any other
 * (TASK-1203, design §4c), so the settings have nothing to say about it.
 */
export interface AgentSlackBotChannel {
  channelId: string;
  name: string;
}

export type AgentSlackStatus =
  /**
   * `bot`: a live bot outlives the shared install (Admin › Slack's Disconnect
   * leaves it alone). `canManage`: the person reading manages the agent (as
   * `ready` says it), so they can still disconnect that bot (TASK-1172).
   * `botChannels`, `agentTeamName`: as `ready` says them.
   */
  | {
      state: 'no-workspace';
      canManage: boolean;
      bot: AgentSlackBot;
      botChannels?: AgentSlackBotChannel[];
      agentTeamName?: string;
    }
  /**
   * `answersDms`: a DM from the owner reaches THIS agent, their oldest
   * personal agent (router.ts `personalAgentFor`). Which one it does reach
   * otherwise is never said.
   */
  | { state: 'personal-agent'; botName: string; answersDms: boolean }
  | {
      state: 'ready';
      botName: string;
      workspaceName: string;
      canManage: boolean;
      bot: AgentSlackBot;
      /**
       * The agent's own bot's channels, oldest first. Present only when the
       * route's own read finds the bot live, so a row never needs a bot this
       * answer doesn't show.
       */
      botChannels?: AgentSlackBotChannel[];
      /**
       * The name of the agent's team, as the person reading sees it (TASK-1203:
       * the card says what the agent hears is shared with it). Cleaned to one
       * line, and present only when it can be read (a team agent, @ax/teams
       * there, the viewer on that team): the card says "its team" without one.
       * The AX team, so `agentTeamName`: in Slack's words a team is the
       * workspace, which `workspaceName` names.
       */
      agentTeamName?: string;
    };

export const AGENT_SLACK_PATH = '/settings/slack/:agentId';

/**
 * What the section's routes read for themselves (invariant 5): the shared
 * install (is Slack connected, its names), the agent's own bot, and that
 * bot's channels, which it only lists. No Slack client and no vault:
 * whatever reaches Slack goes through the bot domains.
 */
export interface AgentRoutesDeps {
  bus: HookBus;
  installs: Pick<InstallStore, 'current' | 'botForAgent'>;
  channels: Pick<ChannelStore, 'listForAgent'>;
  logger: Logger;
}

type Reply = { status: number; body: unknown };

/** A personal agent has no bot of its own, and nothing is read to say so. */
const NO_BOT: AgentSlackBot = { state: 'none', configTokenStored: false };
/** What a bot request's body may hold. */
const BOT_KEYS: readonly string[] = ['botName', 'refreshToken', 'iconPng'];
/** What a bot Disconnect's, Cancel's or Claim's body may hold: the install id of the bot the page showed. */
const BOT_DISCONNECT_KEYS: readonly string[] = ['installId'];
/** What an ask for an AX admin's approval may hold (TASK-1169): the name alone. */
const ASK_KEYS: readonly string[] = ['botName'];
/** What a live bot's rename body may hold: the name alone. */
const RENAME_KEYS: readonly string[] = ['botName'];
/** What a live bot's new picture body may hold: the picture alone. */
const PICTURE_KEYS: readonly string[] = ['iconPng'];
/** What the approver's Replace body may hold (TASK-1173): the pasted refresh token alone. */
const REPLACE_KEYS: readonly string[] = ['refreshToken'];

const PLUGIN = '@ax/channel-slack';
/** An agent id as a path may carry it: printable ASCII, bounded. Anything else is no agent at all. */
const AGENT_ID_RE = new RegExp(`^[\\x21-\\x7e]{1,${AGENT_ID_MAX}}$`);

const json = (status: number, body: unknown): Reply => ({ status, body });
const NOT_FOUND = json(404, { error: 'not-found' });
const INVALID_BODY = json(400, { error: 'invalid-body' });
const INTERNAL = json(500, { error: 'internal' });

/** A refused manage check, as the answer. */
function refused(reason: Extract<Rights, { ok: false }>['reason']): Reply {
  if (reason === 'forbidden') return json(403, { error: 'forbidden' });
  if (reason === 'personal-agent') return json(409, { error: 'personal-agent' });
  return NOT_FOUND;
}

type BotBody =
  | { ok: true; botName: string; refreshToken: string | null; icon: ParsedIcon | null }
  | { ok: false; reply: Reply };

/**
 * A body's `botName`, as checkBotName tidies it: a missing (or null) one is
 * `empty`, one that isn't text is `bad-characters`.
 */
function botNameOf(value: unknown): { ok: true; botName: string } | { ok: false; reply: Reply } {
  const raw = value ?? '';
  if (typeof raw !== 'string') {
    return { ok: false, reply: json(400, { error: 'invalid-bot-name', reason: 'bad-characters' }) };
  }
  const name = checkBotName(raw);
  if (!name.ok) return { ok: false, reply: json(400, { error: 'invalid-bot-name', reason: name.reason }) };
  return { ok: true, botName: name.name };
}

/**
 * A bot request's JSON body: an object with no key but BOT_KEYS. 413 past
 * Connect's cap (http-server's `maxBodyBytes` refused it first; this is the
 * backstop), else 400. The refresh token comes before the name, as at
 * Connect: one that is there (null included) must look like a configuration
 * refresh token, so a token pasted into the wrong box never reaches Slack.
 * The name must pass checkBotName (a missing one is `empty`). The picture is
 * never a 400: icon.ts's verdict goes to the domain, which skips an unusable
 * one, and logs why, once the app exists.
 */
function readBotBody(req: RouteRequest): BotBody {
  if (req.body.length > ADMIN_CONNECT_BODY_MAX_BYTES) {
    return { ok: false, reply: json(413, { error: 'body-too-large' }) };
  }
  const fields = bodyObject(req.body);
  if (fields === null || Object.keys(fields).some((k) => !BOT_KEYS.includes(k))) {
    return { ok: false, reply: INVALID_BODY };
  }
  const pasted = fields['refreshToken'];
  const refreshToken = pasted === undefined ? null : configToken(pasted, REFRESH_TOKEN_PREFIX);
  if (pasted !== undefined && refreshToken === null) {
    return { ok: false, reply: json(400, { error: 'invalid-refresh-token' }) };
  }
  const name = botNameOf(fields['botName']);
  if (!name.ok) return name;
  const icon = fields['iconPng'] === undefined ? null : parseIconPng(fields['iconPng']);
  return { ok: true, botName: name.botName, refreshToken, icon };
}

/**
 * An ask for an AX admin's approval (TASK-1169): an object with no key but
 * ASK_KEYS, so no token and no picture. 413 past the plain cap (http-server's
 * `maxBodyBytes` refused it first; this is the backstop), else 400. The name
 * must pass checkBotName, as the self path's does.
 */
function readAskBody(req: RouteRequest): { ok: true; botName: string } | { ok: false; reply: Reply } {
  if (req.body.length > ADMIN_BODY_MAX_BYTES) return { ok: false, reply: json(413, { error: 'body-too-large' }) };
  const fields = bodyObject(req.body);
  if (fields === null || Object.keys(fields).some((k) => !ASK_KEYS.includes(k))) {
    return { ok: false, reply: INVALID_BODY };
  }
  return botNameOf(fields['botName']);
}

type BotDisconnectBody = { ok: true; installId: string } | { ok: false; reply: Reply };

/**
 * A bot Disconnect's, Cancel's or Claim's JSON body (Cancel and Claim since
 * TASK-1173): an object whose only key is the install id of the bot the page
 * showed. 413 past the cap (http-server's `maxBodyBytes` refused it first;
 * this is the backstop), 400 `invalid-body` for anything but such an object,
 * 400 `invalid-install-id` for an id of the wrong shape (a missing one
 * included), as Admin › Slack's Disconnect answers (admin-bot-routes.ts).
 */
function readBotDisconnectBody(req: RouteRequest): BotDisconnectBody {
  if (req.body.length > ADMIN_BODY_MAX_BYTES) return { ok: false, reply: json(413, { error: 'body-too-large' }) };
  const fields = bodyObject(req.body);
  if (fields === null || Object.keys(fields).some((k) => !BOT_DISCONNECT_KEYS.includes(k))) {
    return { ok: false, reply: INVALID_BODY };
  }
  const installId = fields['installId'];
  if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId)) {
    return { ok: false, reply: json(400, { error: 'invalid-install-id' }) };
  }
  return { ok: true, installId };
}

type RenameBody = { ok: true; botName: string } | { ok: false; reply: Reply };

/**
 * A live bot's rename body (TASK-1171): an object holding `botName` alone.
 * 413 past ADMIN_BODY_MAX_BYTES (http-server's `maxBodyBytes` refused it
 * first; this is the backstop), else 400. The name is read as the request
 * reads it (botNameOf): a missing one is `empty`, one that isn't text
 * `bad-characters`, then checkBotName, whose tidy form is what the domain gets.
 */
function readRenameBody(req: RouteRequest): RenameBody {
  if (req.body.length > ADMIN_BODY_MAX_BYTES) return { ok: false, reply: json(413, { error: 'body-too-large' }) };
  const fields = bodyObject(req.body);
  if (fields === null || Object.keys(fields).some((k) => !RENAME_KEYS.includes(k))) {
    return { ok: false, reply: INVALID_BODY };
  }
  return botNameOf(fields['botName']);
}

type ReplaceBody = { ok: true; refreshToken: string } | { ok: false; reply: Reply };

/**
 * The approver's Replace body (TASK-1173): an object holding `refreshToken`
 * alone. 413 past ADMIN_BODY_MAX_BYTES (http-server's `maxBodyBytes` refused
 * it first; this is the backstop), 400 `invalid-body` for anything but such
 * an object, 400 `invalid-refresh-token` for anything that doesn't look like
 * a configuration refresh token (a missing one included), so an access token
 * pasted into that box, or anything else, never reaches Slack.
 */
function readReplaceBody(req: RouteRequest): ReplaceBody {
  if (req.body.length > ADMIN_BODY_MAX_BYTES) return { ok: false, reply: json(413, { error: 'body-too-large' }) };
  const fields = bodyObject(req.body);
  if (fields === null || Object.keys(fields).some((k) => !REPLACE_KEYS.includes(k))) {
    return { ok: false, reply: INVALID_BODY };
  }
  const refreshToken = configToken(fields['refreshToken'], REFRESH_TOKEN_PREFIX);
  if (refreshToken === null) return { ok: false, reply: json(400, { error: 'invalid-refresh-token' }) };
  return { ok: true, refreshToken };
}

type PictureBody = { ok: true; png: Buffer } | { ok: false; reply: Reply };

/**
 * A live bot's new picture body (TASK-1171): an object holding `iconPng`
 * alone. 413 past Connect's cap (http-server's `maxBodyBytes` refused it
 * first; this is the backstop), 400 `invalid-body` for anything but such an
 * object, and 400 `invalid-icon` with icon.ts's reason for a picture that
 * won't do (a missing one included). Unlike the request's, it is never
 * skipped: here the picture is the whole ask.
 */
function readPictureBody(req: RouteRequest): PictureBody {
  if (req.body.length > ADMIN_CONNECT_BODY_MAX_BYTES) {
    return { ok: false, reply: json(413, { error: 'body-too-large' }) };
  }
  const fields = bodyObject(req.body);
  if (fields === null || Object.keys(fields).some((k) => !PICTURE_KEYS.includes(k))) {
    return { ok: false, reply: INVALID_BODY };
  }
  const icon = parseIconPng(fields['iconPng']);
  if (!icon.ok) return { ok: false, reply: json(400, { error: 'invalid-icon', reason: icon.code }) };
  return { ok: true, png: icon.png };
}

/** Who is asking, about which agent, as one route sees it. */
interface Asked {
  req: RouteRequest;
  ctx: AgentContext;
  userId: string;
  agentId: string;
}

export function createAgentSlackRoutes(
  d: AgentRoutesDeps,
  bots: Pick<Bots, 'request' | 'installUrl' | 'cancel' | 'disconnect' | 'status'>,
  requests: Pick<BotRequests, 'ask' | 'cancel'>,
  // Never Admin › Slack's Replace by install id: admin-bot-routes.ts is its one caller.
  changes: Pick<BotChanges, 'rename' | 'setPicture' | 'replaceToken' | 'claim'>,
): RouteSpec[] {
  const authCtx = makeAgentContext({
    sessionId: 'channel-slack',
    agentId: PLUGIN,
    userId: 'system',
    logger: d.logger,
  });

  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // A log line never changes an answer.
    }
  };

  /** The manage check every route but the section itself starts with. */
  const manages = (a: Asked): Promise<Rights> => checkRights(d.bus, a.ctx, a.agentId, a.userId, 'manage');

  async function status(a: Asked): Promise<Reply> {
    const rights = await checkRights(d.bus, a.ctx, a.agentId, a.userId, 'view');
    if (!rights.ok && rights.reason !== 'personal-agent') return NOT_FOUND;
    const install = await d.installs.current();
    const sharedActive = install !== null && install.status === 'active';
    if (!rights.ok) {
      // A personal agent has no bot of its own: none is read, and nobody manages one.
      if (!sharedActive) {
        return json(200, { state: 'no-workspace', canManage: false, bot: NO_BOT } satisfies AgentSlackStatus);
      }
      // Only its owner sees a personal agent (agents:resolve), so the person
      // asking is the one whose DMs are routed: asked exactly as the DM router asks.
      const answersDms = (await personalAgentFor(d.bus, a.ctx, a.userId)) === a.agentId;
      return json(200, { state: 'personal-agent', botName: install.botName, answersDms } satisfies AgentSlackStatus);
    }

    const manage = await manages(a);
    // Deleted since the first question.
    if (!manage.ok && manage.reason === 'not-found') return NOT_FOUND;
    // The agent's own bot (bots.ts), as this viewer may see it. A live one
    // outlives the shared install, so it shows with no workspace too.
    const bot = await bots.status({
      ctx: a.ctx,
      viewerUserId: a.userId,
      agentId: a.agentId,
      manages: manage.ok,
      sharedActive,
    });
    // The channels the agent's own bot has answered in (a binding on its install), read only while
    // `bot` says live: bots.status read its own, and a row must never need a bot this answer doesn't show.
    // A live bot outlives the shared install, so they show with no workspace too (TASK-1180).
    const own = bot.state === 'live' ? await liveOwnBot(d.installs, a.agentId) : null;
    const ownBindings = own === null ? null : await d.channels.listForAgent(own.installId, a.agentId);
    const botChannels =
      ownBindings === null
        ? {}
        : {
            botChannels: ownBindings.map((b): AgentSlackBotChannel => ({ channelId: b.channelId, name: b.channelName })),
          };
    // The card says the agent's memory is shared with its team, by name when the viewer's own team list gives it.
    const team = await agentTeamName(d.bus, a.ctx, { agentId: a.agentId, userId: a.userId }, (err) =>
      log('warn', 'slack_team_name_failed', { code: logCode(err) }),
    );
    const agentTeamNameField = team === null ? {} : { agentTeamName: team };
    if (!sharedActive) {
      return json(200, {
        state: 'no-workspace',
        canManage: manage.ok,
        bot,
        ...botChannels,
        ...agentTeamNameField,
      } satisfies AgentSlackStatus);
    }
    const out: AgentSlackStatus = {
      state: 'ready',
      botName: install.botName,
      workspaceName: install.teamName ?? '',
      canManage: manage.ok,
      bot,
      ...botChannels,
      ...agentTeamNameField,
    };
    return json(200, out);
  }

  /** Ask for the agent's own bot, as the person asking, who becomes its requester and approver. */
  async function requestBot(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readBotBody(a.req);
    if (!body.ok) return body.reply;
    // The domain asks the rights again inside the app lock, before anything else.
    return bots.request({
      ctx: a.ctx,
      actorUserId: a.userId,
      agentId: a.agentId,
      botName: body.botName,
      refreshToken: body.refreshToken,
      icon: body.icon,
    });
  }

  /** Continue in Slack: a fresh install link for the pending bot, for its approver (the domain checks). */
  async function botInstallUrl(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    return bots.installUrl({ actorUserId: a.userId, agentId: a.agentId });
  }

  /**
   * Cancel the pending bot: any team admin who manages the agent may, naming
   * it by the install id their page showed (TASK-1173).
   */
  async function cancelBot(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readBotDisconnectBody(a.req);
    if (!body.ok) return body.reply;
    // The domain asks the rights again inside the app lock, before anything else.
    return bots.cancel({ ctx: a.ctx, actorUserId: a.userId, agentId: a.agentId, installId: body.installId });
  }

  /** Ask an AX admin to approve the agent's own bot (TASK-1169): the person asking becomes its requester. */
  async function askForBot(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readAskBody(a.req);
    if (!body.ok) return body.reply;
    // The domain asks the rights again inside the app lock, before anything else.
    return requests.ask({ ctx: a.ctx, actorUserId: a.userId, agentId: a.agentId, botName: body.botName });
  }

  /** Take the agent's open ask back: any team admin who manages the agent may. */
  async function cancelAsk(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    return requests.cancel({ agentId: a.agentId });
  }

  /**
   * Take the agent's own bot away, pending or live (TASK-1172): any team
   * admin who manages the agent may, with or without the shared app, naming
   * the bot by the install id their page showed.
   */
  async function disconnectBot(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readBotDisconnectBody(a.req);
    if (!body.ok) return body.reply;
    // The domain asks the rights again inside the app lock, before anything else.
    return bots.disconnect({ ctx: a.ctx, actorUserId: a.userId, agentId: a.agentId, installId: body.installId });
  }

  /**
   * Rename the live bot: any team admin who manages the agent may. Who asked
   * isn't handed on: the domain uses the bot's approver's token.
   */
  async function renameBot(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readRenameBody(a.req);
    if (!body.ok) return body.reply;
    return changes.rename({ agentId: a.agentId, botName: body.botName });
  }

  /** Give the live bot a new picture: as a rename, the approver's token, whoever asked. */
  async function setBotPicture(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readPictureBody(a.req);
    if (!body.ok) return body.reply;
    return changes.setPicture({ agentId: a.agentId, png: body.png });
  }

  /**
   * The live bot's approver replaces their own configuration token with one
   * they pasted (TASK-1173). Only a team admin who manages the agent gets
   * this far; the domain then refuses anyone but the bot's approver (403
   * `not-approver`) inside the app lock, before the vault or Slack.
   */
  async function replaceBotToken(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readReplaceBody(a.req);
    if (!body.ok) return body.reply;
    return changes.replaceToken({ actorUserId: a.userId, agentId: a.agentId, refreshToken: body.refreshToken });
  }

  /**
   * A team admin who manages the agent claims its live bot, named by the
   * install id their page showed, once its requester is no longer a team
   * admin (TASK-1173): from then on its outsiders run as the claimer.
   */
  async function claimBot(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readBotDisconnectBody(a.req);
    if (!body.ok) return body.reply;
    // The domain asks the rights again inside the app lock, before anything else.
    return changes.claim({ ctx: a.ctx, actorUserId: a.userId, agentId: a.agentId, installId: body.installId });
  }

  /**
   * One route: the person, then the agent id's shape, then `run`, then
   * exactly one answer. A throw `run` didn't handle is a 500, logged
   * code-only with the route's stage. A POST's body is capped at
   * `maxBodyBytes`, ADMIN_BODY_MAX_BYTES unless the route says otherwise.
   */
  function route(
    method: RouteSpec['method'],
    suffix: string,
    stage: string,
    run: (a: Asked) => Promise<Reply>,
    o: { maxBodyBytes?: number } = {},
  ): RouteSpec {
    return {
      method,
      path: `${AGENT_SLACK_PATH}${suffix}`,
      ...(method === 'POST' ? { maxBodyBytes: o.maxBodyBytes ?? ADMIN_BODY_MAX_BYTES } : {}),
      handler: async (req, res) => {
        let reply: Reply;
        try {
          const gate = await checkUser(d.bus, authCtx, req);
          const agentId = req.params['agentId'];
          if (!gate.ok) reply = json(gate.status, { error: gate.error });
          else if (agentId === undefined || !AGENT_ID_RE.test(agentId)) reply = NOT_FOUND;
          else {
            // No agent in the ctx: these lookups act for nobody's agent.
            const ctx = makeAgentContext({
              sessionId: 'channel-slack',
              agentId: '',
              userId: gate.userId,
              logger: d.logger,
            });
            reply = await run({ req, ctx, userId: gate.userId, agentId });
          }
        } catch (err) {
          log('error', 'slack_channel_route_failed', { stage, code: logCode(err) });
          reply = INTERNAL;
        }
        res.status(reply.status).json(reply.body);
      },
    };
  }

  return [
    route('GET', '', 'status', status),
    // Its body can carry the bot's picture (icon.ts), as Admin › Slack's Connect can.
    route('POST', '/bot', 'bot', requestBot, { maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES }),
    route('POST', '/bot/install-url', 'bot-install-url', botInstallUrl),
    route('POST', '/bot/cancel', 'bot-cancel', cancelBot),
    route('POST', '/bot/disconnect', 'bot-disconnect', disconnectBot),
    route('POST', '/bot/rename', 'bot-rename', renameBot),
    // Its body is the bot's new picture: Connect's cap.
    route('POST', '/bot/icon', 'bot-icon', setBotPicture, { maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES }),
    // Its approver's Replace, and a team admin's Claim (TASK-1173): a token or an id, so the plain cap.
    route('POST', '/bot/replace-token', 'bot-replace-token', replaceBotToken),
    route('POST', '/bot/claim', 'bot-claim', claimBot),
    // Asking an AX admin instead (TASK-1169): a name and nothing else, so the plain cap.
    route('POST', '/bot-request', 'bot-request', askForBot),
    route('POST', '/bot-request/cancel', 'bot-request-cancel', cancelAsk),
  ];
}
