import { makeAgentContext, type AgentContext } from '@ax/core';
import { checkBotName } from './bot-name.js';
import type { AgentSlackBot, Bots } from './bots.js';
import {
  agentAccess,
  checkRights,
  connectChannel,
  listAvailableChannels,
  type AgentAccess,
  type ChannelDeps,
  type Rights,
} from './channels.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { parseIconPng, type ParsedIcon } from './icon.js';
import { ADMIN_BODY_MAX_BYTES, ADMIN_CONNECT_BODY_MAX_BYTES, AGENT_ID_MAX, SLACK_ID_RE } from './limits.js';
import { logCode } from './log-code.js';
import { personName } from './person-name.js';
import { personalAgentFor } from './router.js';
import { REFRESH_TOKEN_PREFIX, bodyObject, configToken } from './slack-apps.js';
import { checkUser } from './user-auth.js';

/**
 * The Slack section of a team agent's settings (TASK-1094): the channels it
 * answers in, and connecting, disconnecting and remembering them. And the
 * agent's own Slack bot (TASK-1167, bots.ts): asking for it, picking the
 * request back up in Slack, cancelling it, and disconnecting it (TASK-1172).
 *
 *   GET  /settings/slack/:agentId             → AgentSlackStatus          (anyone who can see the agent)
 *   GET  /settings/slack/:agentId/available   → { channels, truncated }   (a team admin of its team)
 *   POST /settings/slack/:agentId/connect     { channelId } → { channel, reconnected }
 *   POST /settings/slack/:agentId/disconnect  { channelId } → { removed }
 *   POST /settings/slack/:agentId/remember    { channelId, remember } → {}
 *   POST /settings/slack/:agentId/bot         { botName, refreshToken?, iconPng? } → { installUrl, iconSet }
 *   POST /settings/slack/:agentId/bot/install-url  → { installUrl }, its approver only, while pending
 *   POST /settings/slack/:agentId/bot/cancel  → { appDeleted }, while pending
 *   POST /settings/slack/:agentId/bot/disconnect  → { appDeleted }, pending or live, with or without
 *                                               the shared app (the domain asks the rights again)
 *
 * Every route answers, in this order: 401 signed out; the SAME 404 for an
 * agent the person can't see, one that doesn't exist, and an id no agent
 * could have (never tell someone the agent exists); then rights (channels.ts:
 * a team admin of the agent's team manages, workspace-admin status never
 * counts; anything but a team agent is `personal-agent`), all before a body
 * is read or Slack is asked anything. The POSTs keep http-server's CSRF
 * check and cap their bodies; an unknown body key is a 400, so nothing in a
 * body can name another agent. The bot's request body can carry its picture,
 * so it has Admin › Slack's Connect cap. Its `refreshToken` is optional (the
 * one stored for the person is used without it), but one that is there must
 * look like a configuration refresh token, so an access token pasted into
 * that box never reaches Slack. The other bot routes read no body.
 *
 * Team members who aren't admins read the section, so "connected by" and a
 * bot's approver are a display name or "A teammate", never an email.
 * Failures log code-only.
 */

export type AgentSlackStatus =
  /**
   * `bot`: a live bot outlives the shared install (Admin › Slack's Disconnect
   * leaves it alone). `canManage`: the person reading manages the agent (as
   * `ready` says it), so they can still disconnect that bot (TASK-1172).
   */
  | { state: 'no-workspace'; canManage: boolean; bot: AgentSlackBot }
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
      }>;
      bot: AgentSlackBot;
    };

export const AGENT_SLACK_PATH = '/settings/slack/:agentId';

type Reply = { status: number; body: unknown };

/** A personal agent has no bot of its own, and nothing is read to say so. */
const NO_BOT: AgentSlackBot = { state: 'none', configTokenStored: false };
/** What a bot request's body may hold. */
const BOT_KEYS: readonly string[] = ['botName', 'refreshToken', 'iconPng'];

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

type BotBody =
  | { ok: true; botName: string; refreshToken: string | null; icon: ParsedIcon | null }
  | { ok: false; reply: Reply };

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
  const rawName = fields['botName'] ?? '';
  if (typeof rawName !== 'string') {
    return { ok: false, reply: json(400, { error: 'invalid-bot-name', reason: 'bad-characters' }) };
  }
  const name = checkBotName(rawName);
  if (!name.ok) return { ok: false, reply: json(400, { error: 'invalid-bot-name', reason: name.reason }) };
  const icon = fields['iconPng'] === undefined ? null : parseIconPng(fields['iconPng']);
  return { ok: true, botName: name.name, refreshToken, icon };
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
    if (!sharedActive) {
      return json(200, { state: 'no-workspace', canManage: manage.ok, bot } satisfies AgentSlackStatus);
    }
    const nameOf = once((userId) => connectorName(a.ctx, userId));
    const accessOf = once((userId): Promise<AgentAccess> => agentAccess(d.bus, a.ctx, a.agentId, userId));
    const channels: Extract<AgentSlackStatus, { state: 'ready' }>['channels'] = [];
    for (const b of await d.channels.listForAgent(install.installId, a.agentId)) {
      channels.push({
        channelId: b.channelId,
        name: b.channelName,
        remember: b.remember,
        connectedBy: await nameOf(b.connectedByUserId),
        // Outsiders' turns run as the connector, so a connector who lost the
        // agent breaks the channel until a team admin connects it again.
        needsReconnect: (await accessOf(b.connectedByUserId)) !== 'yes',
      });
    }
    const out: AgentSlackStatus = {
      state: 'ready',
      botName: install.botName,
      workspaceName: install.teamName ?? '',
      canManage: manage.ok,
      channels,
      bot,
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

  async function remember(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    const body = readBody(a.req, ['channelId', 'remember']);
    if (!body.ok) return body.reply;
    const on = body.fields['remember'];
    if (typeof on !== 'boolean') return INVALID_BODY;
    const install = await d.installs.current();
    const changed =
      install !== null && (await d.channels.setRemember(install.installId, body.channelId, a.agentId, on));
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

  /** Cancel the pending bot: any team admin who manages the agent may. */
  async function cancelBot(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    return bots.cancel({ agentId: a.agentId });
  }

  /**
   * Take the agent's own bot away, pending or live (TASK-1172): any team
   * admin who manages the agent may, with or without the shared app.
   */
  async function disconnectBot(a: Asked): Promise<Reply> {
    const rights = await manages(a);
    if (!rights.ok) return refused(rights.reason);
    // The domain asks the rights again inside the app lock, before anything else.
    return bots.disconnect({ ctx: a.ctx, actorUserId: a.userId, agentId: a.agentId });
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
    // Its body can carry the bot's picture (icon.ts), as Admin › Slack's Connect can.
    route('POST', '/bot', 'bot', requestBot, { maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES }),
    route('POST', '/bot/install-url', 'bot-install-url', botInstallUrl),
    route('POST', '/bot/cancel', 'bot-cancel', cancelBot),
    route('POST', '/bot/disconnect', 'bot-disconnect', disconnectBot),
  ];
}
