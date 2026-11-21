import { makeAgentContext, type AgentContext } from '@ax/core';
import type { BotChanges } from './bot-changes.js';
import { checkBotName } from './bot-name.js';
import type { BotRequests } from './bot-requests.js';
import type { AgentSlackBot, Bots } from './bots.js';
import {
  agentAccess,
  checkRights,
  connectChannel,
  listAvailableChannels,
  liveOwnBot,
  type AgentAccess,
  type ChannelDeps,
  type Rights,
} from './channels.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { parseIconPng, type ParsedIcon } from './icon.js';
import { INSTALL_ID_RE } from './ingress.js';
import { ADMIN_BODY_MAX_BYTES, ADMIN_CONNECT_BODY_MAX_BYTES, AGENT_ID_MAX, SLACK_ID_RE } from './limits.js';
import { logCode } from './log-code.js';
import { personName } from './person-name.js';
import { personalAgentFor } from './router.js';
import { REFRESH_TOKEN_PREFIX, bodyObject, configToken } from './slack-apps.js';
import { checkUser } from './user-auth.js';

/**
 * The Slack section of a team agent's settings (TASK-1094): the channels
 * connected to it through the shared app, and connecting, disconnecting and
 * remembering them. With its own bot live (TASK-1168) those are the ones still
 * waiting for the bot: each is `needsInvite` until the bot has answered there
 * (a binding on the bot's install), then it leaves the list for the bot's own
 * (`botChannels`, TASK-1180), where it has its own memory switch, flipped by
 * `POST …/bot/remember`. From then the shared switch answers `409 own-bot`
 * for that channel; before, it sets what the bot will start from there. And
 * `POST …/connect` refuses that agent with `409 own-bot` (channels.ts). And
 * the agent's own Slack bot (TASK-1167, bots.ts): asking for it, picking the
 * request back up in Slack, cancelling it, and disconnecting it (TASK-1172);
 * once it's live, renaming it or changing its picture (TASK-1171,
 * bot-changes.ts), its approver replacing their configuration token, and a
 * team admin claiming it once its requester is no longer one (TASK-1173). Or,
 * for a team admin who can't install Slack apps, asking an AX admin to
 * approve it instead (TASK-1169, bot-requests.ts), and taking that ask back.
 *
 *   GET  /settings/slack/:agentId             → AgentSlackStatus          (anyone who can see the agent)
 *   GET  /settings/slack/:agentId/available   → { channels, truncated }   (a team admin of its team)
 *   POST /settings/slack/:agentId/connect     { channelId } → { channel, reconnected }
 *                                             · 409 own-bot while its own bot is live
 *   POST /settings/slack/:agentId/disconnect  { channelId } → { removed }
 *   POST /settings/slack/:agentId/remember    { channelId, remember } → {}
 *                                             · 409 own-bot once its own bot has answered in the channel
 *   POST /settings/slack/:agentId/bot/remember  { channelId, remember } → {}, a channel its live bot has
 *                                               answered in, with or without the shared app (TASK-1180)
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
 *                                             and answers 409 no-bot unless `installId` is the
 *                                             agent's live bot, TASK-1173)
 *   POST /settings/slack/:agentId/bot-request         { botName } → {}, while it has no bot and no request
 *   POST /settings/slack/:agentId/bot-request/cancel  → {}, while it has an open request
 *
 * Every route answers, in this order: 401 signed out; the SAME 404 for an
 * agent the person can't see, one that doesn't exist, and an id no agent
 * could have (never tell someone the agent exists); then rights (channels.ts:
 * a team admin of the agent's team manages, workspace-admin status never
 * counts; anything but a team agent is `personal-agent`), all before a body
 * is read or Slack is asked anything. The POSTs keep http-server's CSRF
 * check and cap their bodies; an unknown body key is a 400, so nothing in a
 * body can name another agent. The bot's request body can carry its picture,
 * and a new picture's body is one, so both have Admin › Slack's Connect cap.
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
 * Team members who aren't admins read the section, so "connected by" and a
 * bot's approver are a display name or "A teammate", never an email, and a
 * live bot's install id reaches only those who manage the agent (bots.ts).
 * Failures log code-only.
 */

/**
 * A channel the agent's own bot has answered in (a binding on its install),
 * with that binding's memory switch (TASK-1180).
 */
export interface AgentSlackBotChannel {
  channelId: string;
  name: string;
  remember: boolean;
}

export type AgentSlackStatus =
  /**
   * `bot`: a live bot outlives the shared install (Admin › Slack's Disconnect
   * leaves it alone). `canManage`: the person reading manages the agent (as
   * `ready` says it), so they can still disconnect that bot (TASK-1172).
   * `botChannels`: as `ready` says it.
   */
  | { state: 'no-workspace'; canManage: boolean; bot: AgentSlackBot; botChannels?: AgentSlackBotChannel[] }
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
      channels: Array<{
        channelId: string;
        name: string;
        remember: boolean;
        connectedBy: string;
        needsReconnect: boolean;
        /**
         * The agent's own bot is live and hasn't answered in this channel yet,
         * so the shared bot steps aside here and nobody reaches the agent in it
         * until someone runs `/invite` for the bot. Only ever true when `bot`
         * is live in the same answer.
         */
        needsInvite: boolean;
      }>;
      bot: AgentSlackBot;
      /**
       * The agent's own bot's channels, oldest first. Present only when the
       * route's own read finds the bot live (as `needsInvite` is).
       */
      botChannels?: AgentSlackBotChannel[];
    };

export const AGENT_SLACK_PATH = '/settings/slack/:agentId';

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
/** "Connected by" when auth has no name, no account or no answer. Never the email: members read this page. */
const CONNECTOR_FALLBACK = 'A teammate';
/** An agent id as a path may carry it: printable ASCII, bounded. Anything else is no agent at all. */
const AGENT_ID_RE = new RegExp(`^[\\x21-\\x7e]{1,${AGENT_ID_MAX}}$`);

const json = (status: number, body: unknown): Reply => ({ status, body });
const NOT_FOUND = json(404, { error: 'not-found' });
const INVALID_BODY = json(400, { error: 'invalid-body' });
const INTERNAL = json(500, { error: 'internal' });
const utf8 = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A refused manage check, as the answer. */
function refused(reason: Extract<Rights, { ok: false }>['reason']): Reply {
  if (reason === 'forbidden') return json(403, { error: 'forbidden' });
  if (reason === 'personal-agent') return json(409, { error: 'personal-agent' });
  return NOT_FOUND;
}

type WriteBody = { ok: true; channelId: string; fields: Record<string, unknown> } | { ok: false; reply: Reply };

/**
 * A write's JSON body: an object with a Slack-shaped `channelId` and no key
 * but `keys`. 413 past the cap (http-server's `maxBodyBytes` refused it
 * first; this is the backstop), 400 for anything else.
 */
function readBody(req: RouteRequest, keys: readonly string[]): WriteBody {
  if (req.body.length > ADMIN_BODY_MAX_BYTES) return { ok: false, reply: json(413, { error: 'body-too-large' }) };
  let fields: unknown;
  try {
    fields = JSON.parse(utf8.decode(req.body));
  } catch {
    return { ok: false, reply: INVALID_BODY };
  }
  if (!isRecord(fields) || Object.keys(fields).some((k) => !keys.includes(k))) {
    return { ok: false, reply: INVALID_BODY };
  }
  const channelId = fields['channelId'];
  if (typeof channelId !== 'string' || !SLACK_ID_RE.test(channelId)) return { ok: false, reply: INVALID_BODY };
  return { ok: true, channelId, fields };
}

/** A memory switch flip's body: readBody's, with a boolean `remember` beside the `channelId`, and no other key. */
function readSwitchBody(req: RouteRequest): { ok: true; channelId: string; remember: boolean } | { ok: false; reply: Reply } {
  const body = readBody(req, ['channelId', 'remember']);
  if (!body.ok) return body;
  const remember = body.fields['remember'];
  if (typeof remember !== 'boolean') return { ok: false, reply: INVALID_BODY };
  return { ok: true, channelId: body.channelId, remember };
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

/** One lookup per key per request, however many channels share it. */
function once<T>(look: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const seen = new Map<string, Promise<T>>();
  return (key) => {
    let found = seen.get(key);
    if (found === undefined) {
      found = look(key);
      seen.set(key, found);
    }
    return found;
  };
}

/** Who is asking, about which agent, as one route sees it. */
interface Asked {
  req: RouteRequest;
  ctx: AgentContext;
  userId: string;
  agentId: string;
}

export function createAgentSlackRoutes(
  d: ChannelDeps,
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

  const connectorName = (ctx: AgentContext, userId: string): Promise<string> =>
    personName(d.bus, ctx, userId, {
      allowEmail: false,
      fallback: CONNECTOR_FALLBACK,
      onFault: (err) => log('warn', 'slack_channel_route_failed', { stage: 'connected-by', code: logCode(err) }),
    });

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
            botChannels: ownBindings.map(
              (b): AgentSlackBotChannel => ({ channelId: b.channelId, name: b.channelName, remember: b.remember }),
            ),
          };
    if (!sharedActive) {
      return json(200, { state: 'no-workspace', canManage: manage.ok, bot, ...botChannels } satisfies AgentSlackStatus);
    }
    const nameOf = once((userId) => connectorName(a.ctx, userId));
    const accessOf = once((userId): Promise<AgentAccess> => agentAccess(d.bus, a.ctx, a.agentId, userId));
    const channels: Extract<AgentSlackStatus, { state: 'ready' }>['channels'] = [];
    const answered = ownBindings === null ? null : new Set(ownBindings.map((c) => c.channelId));
    for (const b of await d.channels.listForAgent(install.installId, a.agentId)) {
      // Its own bot answers here now: off the list. The shared binding stays, unused.
      if (answered?.has(b.channelId) === true) continue;
      const needsInvite = answered !== null;
      channels.push({
        channelId: b.channelId,
        name: b.channelName,
        remember: b.remember,
        connectedBy: await nameOf(b.connectedByUserId),
        // Outsiders' turns run as the connector, so a connector who lost the
        // agent breaks the channel until a team admin connects it again. While
        // the agent's own bot is live the shared bot steps aside for it, so
        // no outsider runs as the connector here.
        needsReconnect: !needsInvite && (await accessOf(b.connectedByUserId)) !== 'yes',
        needsInvite,
      });
    }
    const out: AgentSlackStatus = {
      state: 'ready',
      botName: install.botName,
      workspaceName: install.teamName ?? '',
      canManage: manage.ok,
      channels,
      bot,
      ...botChannels,
    };
    return json(200, out);
  }

  async function available(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const listed = await listAvailableChannels(d, a.agentId);
    if (listed.ok) return json(200, { channels: listed.channels, truncated: listed.truncated });
    return listed.reason === 'slack-error' ? json(502, { error: 'slack-error' }) : json(409, { error: listed.reason });
  }

  async function connect(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readBody(a.req, ['channelId']);
    if (!body.ok) return body.reply;
    const out = await connectChannel(d, {
      // The settings have no signed request: they work in the one install.
      install: await d.installs.current(),
      agentId: a.agentId,
      channelId: body.channelId,
      actorUserId: a.userId,
      ctx: a.ctx,
    });
    if (out.ok) {
      const b = out.binding;
      return json(200, {
        channel: {
          channelId: b.channelId,
          name: b.channelName,
          remember: b.remember,
          connectedBy: await connectorName(a.ctx, b.connectedByUserId),
          needsReconnect: false,
          needsInvite: false,
        },
        reconnected: out.reconnected,
      });
    }
    switch (out.reason) {
      case 'not-public':
      case 'archived':
      case 'shared':
        return json(422, { error: 'channel-not-allowed', reason: out.reason });
      case 'not-allowed':
        return json(422, { error: 'channel-not-allowed', reason: 'workspace-policy' });
      case 'agent-gone':
        // Deleted while this connect ran: the binding was taken back.
        return NOT_FOUND;
      case 'own-bot':
        // The agent's own bot went live since the page that offered this was
        // drawn (it hides the picker and Reconnect while one is live). The code
        // alone: reading the section again shows the bot and how to invite it.
        return json(409, { error: 'own-bot' });
      case 'slack-error':
        return json(502, { error: 'slack-error' });
      default:
        return json(409, { error: out.reason });
    }
  }

  async function disconnect(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readBody(a.req, ['channelId']);
    if (!body.ok) return body.reply;
    const install = await d.installs.current();
    if (install === null) return json(200, { removed: false });
    const removed = await d.channels.remove(install.installId, body.channelId, a.agentId);
    if (removed) log('info', 'slack_channel_disconnected', { installId: install.installId });
    return json(200, { removed });
  }

  /**
   * Whether the agent's own bot is live and has answered in the channel: a
   * binding of it, this agent's, on the bot's install. A store fault throws,
   * so a caller that can't tell writes nothing.
   */
  async function ownBotAnswers(agentId: string, channelId: string): Promise<boolean> {
    const own = await liveOwnBot(d.installs, agentId);
    if (own === null) return false;
    const binding = await d.channels.get(own.installId, channelId);
    return binding !== null && binding.agentId === agentId;
  }

  /**
   * The shared connection's switch. Once the agent's own bot has answered in
   * the channel, the switch there is the bot channel's (`…/bot/remember`), so
   * this one answers `409 own-bot` and writes nothing. Before that it is what
   * the bot will start from there (router.ts), so it flips as before: the
   * agent's bindings of the channel and the switch kept for it
   * (channel-store.ts `setRemember`).
   */
  async function remember(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readSwitchBody(a.req);
    if (!body.ok) return body.reply;
    const install = await d.installs.current();
    if (install === null) return json(404, { error: 'not-connected' });
    if (await ownBotAnswers(a.agentId, body.channelId)) return json(409, { error: 'own-bot' });
    const changed = await d.channels.setRemember(install.installId, body.channelId, a.agentId, body.remember);
    return changed ? json(200, {}) : json(404, { error: 'not-connected' });
  }

  /**
   * The switch of a channel the agent's own bot has answered in (TASK-1180):
   * any team admin who manages the agent may flip it, with or without the
   * shared app. It flips the bot's binding, the agent's shared binding of
   * the channel with it, and the switch kept for the agent and channel
   * (channel-store.ts `setRemember`), so the shared bot carries on with it
   * if the bot is disconnected. The bot is the agent's, never the body's to
   * name. `404 not-connected` while the agent has no live bot, or its bot
   * hasn't answered there.
   */
  async function rememberBotChannel(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readSwitchBody(a.req);
    if (!body.ok) return body.reply;
    const own = await liveOwnBot(d.installs, a.agentId);
    const changed =
      own !== null && (await d.channels.setRemember(own.installId, body.channelId, a.agentId, body.remember));
    return changed ? json(200, {}) : json(404, { error: 'not-connected' });
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
    route('GET', '/available', 'available', available),
    route('POST', '/connect', 'connect', connect),
    route('POST', '/disconnect', 'disconnect', disconnect),
    route('POST', '/remember', 'remember', remember),
    // A channel the agent's own bot has answered in has its own switch (TASK-1180).
    route('POST', '/bot/remember', 'bot-remember', rememberBotChannel),
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
