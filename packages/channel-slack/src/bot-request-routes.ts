import { makeAgentContext, type HookBus, type Logger } from '@ax/core';
import { checkAdmin, type AdminActor } from './admin-auth.js';
import type { BotRequests } from './bot-requests.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { parseIconPng, type ParsedIcon } from './icon.js';
import { INSTALL_ID_RE } from './ingress.js';
import { ADMIN_BODY_MAX_BYTES, ADMIN_CONNECT_BODY_MAX_BYTES } from './limits.js';
import { logCode } from './log-code.js';
import { REFRESH_TOKEN_PREFIX, bodyObject, configToken } from './slack-apps.js';

/**
 * Admin › Slack's bot requests (TASK-1169): the open requests team admins
 * made for their agents' own Slack bots, and an AX admin's Approve and
 * Decline. The domain is bot-requests.ts; the rest of Admin › Slack is
 * admin-routes.ts.
 *
 *   GET  /admin/slack/bot-requests                     → { requests, configTokenStored }
 *   POST /admin/slack/bot-requests/:requestId/approve  { refreshToken?, iconPng? } → { installUrl, iconSet }
 *   POST /admin/slack/bot-requests/:requestId/decline  → {}
 *
 * Every route answers, in this order: the admin gate (admin-auth.ts: 401
 * signed out, 403 for anyone who isn't an AX admin, 500 for an auth fault),
 * before anything else is read; then a request id of any shape but ours (22
 * base64url characters) is the same 404 a request that's gone gets, before
 * the domain is asked. The POSTs keep http-server's CSRF check and cap their
 * bodies. Approve's body can carry the bot's picture, so it has Connect's
 * cap; an unknown key in it is a 400, so it can't rename the bot or name
 * another request. Its `refreshToken` is optional (the approving admin's
 * stored one is used without it), but one that is there must look like a
 * configuration refresh token, so an access token pasted into that box never
 * reaches Slack. The domain sends it to Slack once, to be rotated, and keeps
 * only the refresh token that rotate mints, as the admin's own: the paste is
 * never stored. The picture is never a 400: icon.ts's verdict goes to the
 * domain, which skips an unusable one, and logs why, once the app exists.
 * Decline reads no body.
 *
 * No answer carries a token or a person's id. A fault is a 500, logged
 * `slack_admin_failed { stage, code }`, as the rest of Admin › Slack logs
 * one: never a message, a token, a name or an id.
 */

export const ADMIN_BOT_REQUESTS_PATH = '/admin/slack/bot-requests';
export const ADMIN_BOT_REQUEST_APPROVE_PATH = '/admin/slack/bot-requests/:requestId/approve';
export const ADMIN_BOT_REQUEST_DECLINE_PATH = '/admin/slack/bot-requests/:requestId/decline';

export interface BotRequestAdminRoutesDeps {
  bus: HookBus;
  requests: Pick<BotRequests, 'list' | 'approve' | 'decline'>;
  logger: Logger;
}

type Reply = { status: number; body: unknown };

const PLUGIN = '@ax/channel-slack';
/** What Approve's body may hold. */
const APPROVE_KEYS: readonly string[] = ['refreshToken', 'iconPng'];

const json = (status: number, body: unknown): Reply => ({ status, body });
const NOT_FOUND = json(404, { error: 'not-found' });
const INTERNAL = json(500, { error: 'internal' });

type ApproveBody = { ok: true; refreshToken: string | null; icon: ParsedIcon | null } | { ok: false; reply: Reply };

/**
 * Approve's JSON body: an object with no key but APPROVE_KEYS. 413 past
 * Connect's cap (http-server's `maxBodyBytes` refused it first; this is the
 * backstop), else 400. A refresh token that is there (null included) must
 * look like a configuration refresh token; the picture is icon.ts's to read.
 */
function readApproveBody(req: RouteRequest): ApproveBody {
  if (req.body.length > ADMIN_CONNECT_BODY_MAX_BYTES) {
    return { ok: false, reply: json(413, { error: 'body-too-large' }) };
  }
  const fields = bodyObject(req.body);
  if (fields === null || Object.keys(fields).some((k) => !APPROVE_KEYS.includes(k))) {
    return { ok: false, reply: json(400, { error: 'invalid-body' }) };
  }
  const pasted = fields['refreshToken'];
  const refreshToken = pasted === undefined ? null : configToken(pasted, REFRESH_TOKEN_PREFIX);
  if (pasted !== undefined && refreshToken === null) {
    return { ok: false, reply: json(400, { error: 'invalid-refresh-token' }) };
  }
  const icon = fields['iconPng'] === undefined ? null : parseIconPng(fields['iconPng']);
  return { ok: true, refreshToken, icon };
}

export function createBotRequestAdminRoutes(d: BotRequestAdminRoutesDeps): RouteSpec[] {
  const authCtx = makeAgentContext({
    sessionId: 'channel-slack',
    agentId: PLUGIN,
    userId: 'system',
    logger: d.logger,
  });

  /** A fault: code-only, as the rest of Admin › Slack logs one. A log line never changes an answer. */
  const failed = (stage: string, err: unknown): void => {
    try {
      d.logger.error('slack_admin_failed', { stage, code: logCode(err) });
    } catch {
      // Nothing left to report it with.
    }
  };

  /** The ctx the domain acts in: no agent, the AX admin asking. */
  const ctxFor = (actor: AdminActor) =>
    makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: actor.id, logger: d.logger });

  async function list(_req: RouteRequest, actor: AdminActor): Promise<Reply> {
    return json(200, await d.requests.list({ ctx: ctxFor(actor), viewerUserId: actor.id }));
  }

  async function approve(req: RouteRequest, actor: AdminActor, requestId: string): Promise<Reply> {
    const body = readApproveBody(req);
    if (!body.ok) return body.reply;
    return d.requests.approve({
      ctx: ctxFor(actor),
      actorUserId: actor.id,
      requestId,
      refreshToken: body.refreshToken,
      icon: body.icon,
    });
  }

  async function decline(_req: RouteRequest, _actor: AdminActor, requestId: string): Promise<Reply> {
    return d.requests.decline({ requestId });
  }

  /**
   * One route: the admin gate, then (for a route about one request) the
   * request id's shape, then `run`, then exactly one answer. A throw `run`
   * didn't handle is a 500, logged code-only with the route's stage. A
   * POST's body is capped at `maxBodyBytes`, ADMIN_BODY_MAX_BYTES unless the
   * route says otherwise.
   */
  function route(
    method: RouteSpec['method'],
    path: string,
    stage: string,
    run: (req: RouteRequest, actor: AdminActor, requestId: string) => Promise<Reply>,
    o: { maxBodyBytes?: number } = {},
  ): RouteSpec {
    const aboutOne = path.includes(':requestId');
    return {
      method,
      path,
      ...(method === 'POST' ? { maxBodyBytes: o.maxBodyBytes ?? ADMIN_BODY_MAX_BYTES } : {}),
      handler: async (req, res) => {
        let reply: Reply;
        const gate = await checkAdmin(d.bus, authCtx, req);
        const requestId = aboutOne ? req.params['requestId'] : '';
        if (!gate.ok) reply = json(gate.status, { error: gate.error });
        // Never ours, so it can't be open: the same answer as one that's gone.
        else if (requestId === undefined || (aboutOne && !INSTALL_ID_RE.test(requestId))) reply = NOT_FOUND;
        else {
          try {
            reply = await run(req, gate.actor, requestId);
          } catch (err) {
            failed(stage, err);
            reply = INTERNAL;
          }
        }
        res.status(reply.status).json(reply.body);
      },
    };
  }

  return [
    route('GET', ADMIN_BOT_REQUESTS_PATH, 'bot-requests', list),
    // Its body can carry the bot's picture (icon.ts), as Connect's can.
    route('POST', ADMIN_BOT_REQUEST_APPROVE_PATH, 'bot-request-approve', approve, {
      maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES,
    }),
    route('POST', ADMIN_BOT_REQUEST_DECLINE_PATH, 'bot-request-decline', decline),
  ];
}
