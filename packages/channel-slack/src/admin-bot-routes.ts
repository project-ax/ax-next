import { makeAgentContext, type HookBus, type Logger } from '@ax/core';
import { checkAdmin, type AdminActor } from './admin-auth.js';
import type { Bots } from './bots.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { INSTALL_ID_RE } from './ingress.js';
import { ADMIN_BODY_MAX_BYTES } from './limits.js';
import { logCode } from './log-code.js';
import { bodyObject } from './slack-apps.js';

/**
 * Admin › Slack's list of the team agents' own bots, and its Disconnect for
 * one of them (TASK-1172; the domain is bots.ts):
 *
 *   GET  /admin/slack/bots             → { bots: AdminSlackBot[] }
 *   POST /admin/slack/bots/disconnect  { installId } → { appDeleted }
 *
 * Their own routes, beside admin-routes.ts's: the bots outlive the shared
 * install (its Disconnect leaves them alone), so they are their own resource.
 *
 * Both are admin-only, as every /admin/slack route is (admin-auth.ts): 401
 * signed out, 403 not an admin, 500 (logged code-only) when auth can't say,
 * before a body is read or anything is asked. That gate is the ONLY one
 * `listForAdmin` and `disconnectForAdmin` have: neither asks anyone's rights,
 * so these routes must stay their only callers.
 *
 * The list is read as the admin reading it. Its approvers may be emails
 * (only admins read it), and its install ids are the key the Disconnect
 * takes. The Disconnect's body is a JSON object whose only key is a
 * well-formed `installId` (INSTALL_ID_RE), else a 400 before the domain is
 * asked; the domain takes only a team agent's bot by that id, never the
 * shared app's, and answers 409 `no-bot` for anything else. The POST keeps
 * http-server's CSRF check and its body cap. Neither route takes the one app
 * lock: the domain does, and it isn't re-entrant (mutex.ts).
 *
 * A fault is a 500, logged `slack_admin_failed { stage, code }` with the
 * code alone, never the error's message.
 */

export const ADMIN_BOTS_PATH = '/admin/slack/bots';
export const ADMIN_BOT_DISCONNECT_PATH = '/admin/slack/bots/disconnect';

export interface AdminBotRoutesDeps {
  bus: HookBus;
  bots: Pick<Bots, 'listForAdmin' | 'disconnectForAdmin'>;
  logger: Logger;
}

type Reply = { status: number; body: unknown };

const PLUGIN = '@ax/channel-slack';
/** What a Disconnect's body may hold. */
const DISCONNECT_KEYS: readonly string[] = ['installId'];

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
    return json(200, { bots: await d.bots.listForAdmin({ ctx }) });
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
  ];
}
