import { makeAgentContext, type HookBus, type Logger } from '@ax/core';
import { checkAdmin, type AdminActor } from './admin-auth.js';
import type { BotChanges } from './bot-changes.js';
import type { Bots } from './bots.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { INSTALL_ID_RE } from './ingress.js';
import { ADMIN_BODY_MAX_BYTES } from './limits.js';
import { logCode } from './log-code.js';
import { REFRESH_TOKEN_PREFIX, bodyObject, configToken } from './slack-apps.js';

/**
 * Admin › Slack's list of the team agents' own bots, its Disconnect for one
 * of them (TASK-1172; the domain is bots.ts), and the Replace of a bot's
 * configuration token by the bot's own approver (TASK-1173; the domain is
 * bot-changes.ts):
 *
 *   GET  /admin/slack/bots                → { bots: AdminSlackBot[] }
 *   POST /admin/slack/bots/disconnect     { installId } → { appDeleted }
 *   POST /admin/slack/bots/replace-token  { installId, refreshToken } → {}
 *
 * Their own routes, beside admin-routes.ts's: the bots outlive the shared
 * install (its Disconnect leaves them alone), so they are their own resource.
 *
 * All three are admin-only, as every /admin/slack route is (admin-auth.ts):
 * 401 signed out, 403 not an admin, 500 (logged code-only) when auth can't
 * say, before a body is read or anything is asked. That gate is the ONLY one
 * `listForAdmin` and `disconnectForAdmin` have: neither asks anyone's
 * rights, so these routes must stay their only callers. `replaceTokenForAdmin`
 * asks no one's manage rights either, so the same holds for it; past this
 * gate, it refuses anyone but the bot's approver (403 `not-approver`) inside
 * the one app lock, before the vault or Slack. An admin-approved bot's
 * approver is an AX admin who may not be on its agent's team (TASK-1169), so
 * Admin › Slack is where they replace their token.
 *
 * The list is read as the admin reading it. Its approvers may be emails
 * (only admins read it), and its install ids are the key the Disconnect and
 * the Replace take. The Disconnect's body is a JSON object whose only key is
 * a well-formed `installId` (INSTALL_ID_RE), else a 400 before the domain is
 * asked; the domain takes only a team agent's bot by that id, never the
 * shared app's, and answers 409 `no-bot` for anything else. The Replace's
 * body holds a well-formed `installId` and a `refreshToken` that looks like
 * a configuration refresh token, and no other key (400 `invalid-body`,
 * `invalid-install-id`, `invalid-refresh-token`, in that order), so nothing
 * else ever reaches Slack; the domain answers 409 `no-bot` for an id no team
 * bot has. The POSTs keep http-server's CSRF check and their body cap. No
 * route takes the one app lock: the domain does, and it isn't re-entrant
 * (mutex.ts).
 *
 * A fault is a 500, logged `slack_admin_failed { stage, code }` with the
 * code alone, never the error's message.
 */

export const ADMIN_BOTS_PATH = '/admin/slack/bots';
export const ADMIN_BOT_DISCONNECT_PATH = '/admin/slack/bots/disconnect';
export const ADMIN_BOT_REPLACE_TOKEN_PATH = '/admin/slack/bots/replace-token';

export interface AdminBotRoutesDeps {
  bus: HookBus;
  bots: Pick<Bots, 'listForAdmin' | 'disconnectForAdmin'>;
  /** The approver's Replace by install id (TASK-1173), and nothing else of bot-changes.ts. */
  changes: Pick<BotChanges, 'replaceTokenForAdmin'>;
  logger: Logger;
}

type Reply = { status: number; body: unknown };

const PLUGIN = '@ax/channel-slack';
/** What a Disconnect's body may hold. */
const DISCONNECT_KEYS: readonly string[] = ['installId'];
/** What a Replace's body may hold (TASK-1173): the bot's install id and the pasted refresh token. */
const REPLACE_KEYS: readonly string[] = ['installId', 'refreshToken'];

const json = (status: number, body: unknown): Reply => ({ status, body });
const INTERNAL = json(500, { error: 'internal' });
const INVALID_BODY = json(400, { error: 'invalid-body' });

export function createAdminBotRoutes(d: AdminBotRoutesDeps): RouteSpec[] {
  // The gate asks auth for the request's person: it acts for no one.
  const gateCtx = makeAgentContext({
    sessionId: 'channel-slack',
    agentId: PLUGIN,
    userId: 'system',
    logger: d.logger,
  });

  /** A log line never changes an answer. */
  const log = (msg: string, fields: Record<string, string>): void => {
    try {
      d.logger.error(msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };

  /** Every team agent's bot, pending or live, as the admin reading may see it. */
  async function list(_req: RouteRequest, actor: AdminActor): Promise<Reply> {
    // No agent in the ctx: the approvers' names are looked up for nobody's agent.
    const ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: actor.id, logger: d.logger });
    // The admin reading is the viewer each row's `viewerIsApprover` is about (TASK-1173).
    return json(200, { bots: await d.bots.listForAdmin({ ctx, viewerUserId: actor.id }) });
  }

  /** Take one team agent's bot away, by its install id. */
  async function disconnect(req: RouteRequest): Promise<Reply> {
    // http-server's maxBodyBytes refused anything larger already; this is the backstop.
    if (req.body.length > ADMIN_BODY_MAX_BYTES) return json(413, { error: 'body-too-large' });
    const body = bodyObject(req.body);
    if (body === null || Object.keys(body).some((k) => !DISCONNECT_KEYS.includes(k))) return INVALID_BODY;
    const installId = body['installId'];
    if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId)) {
      return json(400, { error: 'invalid-install-id' });
    }
    return d.bots.disconnectForAdmin({ installId });
  }

  /**
   * A team bot's approver replaces their own configuration token, naming the
   * bot by its install id (TASK-1173). The admin is handed on only for the
   * domain to compare with the bot's approver.
   */
  async function replaceToken(req: RouteRequest, actor: AdminActor): Promise<Reply> {
    // http-server's maxBodyBytes refused anything larger already; this is the backstop.
    if (req.body.length > ADMIN_BODY_MAX_BYTES) return json(413, { error: 'body-too-large' });
    const body = bodyObject(req.body);
    if (body === null || Object.keys(body).some((k) => !REPLACE_KEYS.includes(k))) return INVALID_BODY;
    const installId = body['installId'];
    if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId)) {
      return json(400, { error: 'invalid-install-id' });
    }
    // Checked before the domain, so an access token pasted into the refresh box never reaches Slack.
    const refreshToken = configToken(body['refreshToken'], REFRESH_TOKEN_PREFIX);
    if (refreshToken === null) return json(400, { error: 'invalid-refresh-token' });
    return d.changes.replaceTokenForAdmin({ actorUserId: actor.id, installId, refreshToken });
  }

  /**
   * One route: the admin gate, then `run`, then exactly one answer. A throw
   * `run` didn't handle is a 500, logged code-only with the route's stage.
   */
  function route(
    method: RouteSpec['method'],
    path: string,
    stage: string,
    run: (req: RouteRequest, actor: AdminActor) => Promise<Reply>,
  ): RouteSpec {
    return {
      method,
      path,
      ...(method === 'POST' ? { maxBodyBytes: ADMIN_BODY_MAX_BYTES } : {}),
      handler: async (req, res) => {
        const gate = await checkAdmin(d.bus, gateCtx, req);
        let reply: Reply;
        if (!gate.ok) reply = json(gate.status, { error: gate.error });
        else {
          try {
            reply = await run(req, gate.actor);
          } catch (err) {
            log('slack_admin_failed', { stage, code: logCode(err) });
            reply = INTERNAL;
          }
        }
        res.status(reply.status).json(reply.body);
      },
    };
  }

  return [
    route('GET', ADMIN_BOTS_PATH, 'bots', list),
    route('POST', ADMIN_BOT_DISCONNECT_PATH, 'bot-disconnect', disconnect),
    route('POST', ADMIN_BOT_REPLACE_TOKEN_PATH, 'bot-replace-token', replaceToken),
  ];
}
