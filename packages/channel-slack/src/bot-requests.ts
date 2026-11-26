import type { AgentContext, HookBus, Logger } from '@ax/core';
import { isAxAdmin } from './ax-admin.js';
import { isBotNameTaken } from './bot-name.js';
import type { BotRequestDms, PostedDm } from './bot-request-dms.js';
import type { BotReply, Bots } from './bots.js';
import { checkRights, managerAccess, type Rights } from './channels.js';
import type { ParsedIcon } from './icon.js';
import { BOT_REQUESTS_MAX, INSTALL_ID_BYTES } from './limits.js';
import { logCode } from './log-code.js';
import type { Mutex } from './mutex.js';
import { personName } from './person-name.js';
import type { SecretStore } from './secrets.js';
import { isHttps, namesInUse } from './slack-apps.js';
import { InstallStoreError, type BotRequest, type InstallStore } from './store.js';
import { agentSeenBy, teamNamesOf } from './team-name.js';

/**
 * Asking an AX admin for a shared agent's own Slack bot (TASK-1169; design
 * docs/plans/2026-11-09-channel-slack-design.md §4 steps 2–3). Someone who
 * manages the agent (a team admin of a team agent's team, an owner of a
 * personal agent shared with other people, TASK-1248) but can't install
 * Slack apps asks from the agent's settings (agent-routes.ts), and pastes no
 * token. The request waits in its own table (store.ts `BotRequest`) until an
 * AX admin approves or declines it in Admin › Slack
 * (bot-request-routes.ts), or someone who manages the agent cancels it.
 *
 * A request holds a bot name and its requester, nothing else: no secret, no
 * Slack app, no picture. An agent has an open request or a bot (pending or
 * live), never both, and a request's name counts as taken (slack-apps.ts
 * `namesInUse`) until it is approved or taken back.
 *
 * Who may do what. The routes check first; this checks again whatever can
 * change while a call waits for the lock:
 *   - `ask`, `cancel`: someone who manages the agent (the agent settings'
 *     gate, channels.ts). `ask` asks the rights again inside the lock, as the
 *     self path's request does: an agent deleted while it waited has had its
 *     request removed already (that removal takes the lock too), so a request
 *     let through would name an agent that's gone. `cancel` doesn't, as the
 *     pending bot's Cancel doesn't: it only takes something away.
 *   - `list`, `approve`, `decline`: an AX admin (Admin › Slack's gate, or
 *     for a decline also the Slack DM's, bot-request-click.ts). An
 *     approve makes the bot through the one create path (bots.ts `create`),
 *     with the AX admin as its approver (her own configuration token, stored
 *     or pasted, makes the app, and she manages it from then on) and the
 *     request's requester as its requester (whom its channels' outsiders run
 *     as). Only while she is still an AX admin (403 `forbidden`, asked first
 *     inside the lock: one demoted while the call waited makes nothing) and
 *     that requester still manages the agent (channels.ts
 *     `managerAccess`), asked inside the lock; the AX admin's own rights over
 *     the agent are never asked, since she needn't be able to use it. The request goes
 *     only once the bot is made (`create` deletes it last), so an approve
 *     that makes nothing leaves it open. A decline is told who declined
 *     (the DMs' redraw names them), and isn't asked again inside the lock:
 *     it only takes something away.
 *
 * The lock: `ask`, `cancel`, `approve` and `decline` each take the one app
 * lock (plugin.ts) once, and each reads the request inside it. So names stay
 * unique, a cancel or a decline waits for an approve in flight and then
 * finds its request gone, and of two approves of one request (two AX admins,
 * or a double click) the second finds it gone: one Slack app, then 404. So
 * does the second of two declines (two admins in Slack, or a double click).
 * It isn't re-entrant (mutex.ts): none of them calls anything that takes it
 * (`create` runs under the caller's). `list` takes none, never rotates a
 * token and never asks Slack anything: its one vault read is whether the
 * VIEWING admin's own token is stored.
 *
 * The request's Slack DMs (TASK-1170, bot-request-dms.ts). An ask that
 * opened a request tells the AX admins (`opened`); an approve that made the
 * bot, and a decline that took the request, close their DMs (`closed`), with
 * whose request it was and its name, read under the lock (a decline reads
 * the row before it deletes it), and who answered. A step that changed
 * nothing tells nobody. Each notice goes only once the lock is free, and is
 * never awaited: Slack calls under the lock would hold up every approve,
 * connect and Allow, and a DM that fails or never answers must never change
 * an answer. The notices never reject (bot-request-dms.ts catches its own),
 * so there's nothing to catch here. Whom to DM, and whether the requester
 * hears, is decided there, not here. A cancel that took the request tells
 * nobody, but forgets its DMs (`forget`), so a fan-out still running sends
 * no more: an admin who clicks Decline on a DM about it is told it was
 * already handled.
 *
 * Admin › Slack's list names each request as its requester sees it: the agent
 * and its team as `agents:resolve` and `teams:list-for-user` (optional) answer
 * the requester (team-name.ts), and the requester by display name, else email
 * (only AX admins read the list), each cleaned to one line (label.ts) and read
 * when shown, never stored (invariant 4). A requester who left the team, or an
 * agent that's gone, reads as fallbacks (Approve then refuses). No answer
 * carries a token, or a person's, an agent's or a team's id: only names, and
 * the request's own id.
 *
 * Log lines are code-only: `slack_bot_request_opened`, `_cancelled` and
 * `_declined { requestId }`, and `slack_bot_request_failed { requestId?,
 * stage, code }` for a list lookup that failed and was shown as its
 * fallback. Never a name, a person's or an agent's id, or a token. An
 * approve's own lines are the create path's (`slack_bot_approved`,
 * `slack_bot_failed`).
 */

/** One open request as Admin › Slack lists it: display names only, and its own id. */
export interface AdminBotRequest {
  /** Our own random id: what Approve and Decline name. */
  requestId: string;
  /** Already passed `checkBotName` when it was asked. */
  botName: string;
  /** The agent's name as its requester sees it, else "An agent". */
  agentName: string;
  /** Its team's name as its requester sees it; null without @ax/teams, or when they can't see the agent. */
  teamName: string | null;
  /** The requester's display name, else their email, else "Someone". */
  requestedBy: string;
  /** When it was asked, as an ISO 8601 instant. */
  requestedAt: string;
}

export interface AdminBotRequestList {
  /** Oldest first, at most BOT_REQUESTS_MAX. */
  requests: AdminBotRequest[];
  /** More were waiting than are listed: the page says so, and the rest show once these are answered. */
  truncated: boolean;
  /**
   * Whether AX holds the VIEWING admin's own configuration token, so Approve
   * can skip the paste. Presence only (a rotate is the one honest test of a
   * token, and a list never spends one), false with no requests to approve.
   */
  configTokenStored: boolean;
}

export interface BotRequestsDeps {
  bus: HookBus;
  installs: InstallStore;
  /** Read only for whether the viewing admin's own token is there. */
  secrets: SecretStore;
  /** The one create path an approve makes the bot through. */
  bots: Pick<Bots, 'create'>;
  /** The request's Slack DMs: told once the lock is free, never awaited, never under the lock. */
  dms: Pick<BotRequestDms, 'opened' | 'closed' | 'forget'>;
  /** The one app lock, shared with Admin › Slack and the bots domain. Not re-entrant. */
  lock: Mutex;
  /** Only an https origin can make a bot, so nothing is asked over plain http. */
  publicOrigin: string;
  logger: Logger;
  randomBytes: (n: number) => Buffer;
}

export interface BotRequests {
  /**
   * Someone who manages the agent asks an AX admin for its own bot, as `actorUserId`,
   * its requester. Takes the app lock, then refuses, in this order: 404 / 403
   * / 409 `personal-agent` as the rights re-check says; 409 `no-workspace`
   * (no live shared bot) and `public-origin-not-https` (nothing is asked
   * that couldn't be approved); 409 `bot-exists`, `bot-requested` (one per
   * agent, the unique index the last word) and `bot-name-taken` (every bot's,
   * the shared bot's and every open request's name). `botName` already passed
   * `checkBotName`. 200 `{}`, logged `slack_bot_request_opened { requestId }`;
   * once the lock is free, the AX admins' DMs are told (`dms.opened`). A
   * rights check that can't be answered, or a store fault, throws.
   */
  ask(i: { ctx: AgentContext; actorUserId: string; agentId: string; botName: string }): Promise<BotReply>;
  /**
   * Someone who manages the agent takes its request back (the route let no
   * one else through). Takes the app lock, so it waits for an approve in
   * flight. 200 `{}`, logged `slack_bot_request_cancelled { requestId }`;
   * once the lock is free, its DMs are forgotten (`dms.forget`), so a
   * fan-out still running stops. 409 `not-requested` when the agent has no
   * open request (an approve got there first: the agent now shows its
   * pending bot), and nothing is forgotten.
   */
  cancel(i: { agentId: string }): Promise<BotReply>;
  /**
   * The open requests Admin › Slack shows `viewerUserId`, an AX admin: the
   * oldest BOT_REQUESTS_MAX, and `truncated` when more wait. Takes no lock,
   * never rotates or asks Slack. A lookup that fails reads as its
   * fallback, logged; a store fault reading the requests throws.
   */
  list(i: { ctx: AgentContext; viewerUserId: string }): Promise<AdminBotRequestList>;
  /**
   * An AX admin, `actorUserId`, approves one open request, by its id. Takes
   * the app lock, asks inside it whether she still is an AX admin (403
   * `forbidden`), reads the request (404 `not-found` when it is
   * gone: approved, declined or cancelled first), asks whether its requester
   * still manages the agent (409 `requester-not-admin`, a name from before sharing;
   * `agent-gone` for an agent deleted), then makes the bot through `create`,
   * with her as the approver and the requester as the requester, and answers
   * what it answers: 200 `{ installUrl, iconSet }`, or a refusal with the
   * request left open. `refreshToken` is a pasted one that passed the
   * route's shape check, or null for the one stored for her; `icon` is the
   * picture as icon.ts read it, or null. A 200 closes the request's DMs as
   * approved by her once the lock is free (`dms.closed`); anything else
   * closes nothing. A check that can't be answered, or a vault fault reading
   * her token, throws.
   */
  approve(i: {
    ctx: AgentContext;
    actorUserId: string;
    requestId: string;
    refreshToken: string | null;
    icon: ParsedIcon | null;
  }): Promise<BotReply>;
  /**
   * An AX admin, `actorUserId`, declines one open request, by its id, from
   * Admin › Slack or from the Slack DM about it (each gate checked she is
   * one). Takes the app lock, so it waits for an approve in flight, then
   * reads the request (404 `not-found` when it is gone) and deletes it (404
   * if nothing went). 200 `{}`, logged `slack_bot_request_declined
   * { requestId }`; once the lock is free, the request's DMs close as
   * declined by her (`dms.closed`), `clicked` with them: the DM a Slack
   * Decline was clicked in, which is redrawn even when nothing was kept for
   * it (Admin › Slack's decline has none). No declined marker is kept: the
   * team sees its form again. A store fault throws.
   */
  decline(i: { requestId: string; actorUserId: string; clicked?: PostedDm }): Promise<BotReply>;
}

/**
 * The agent's name when its requester can't see it, or nobody says. Names no
 * team: a personal agent shared with other people has a bot too (TASK-1248).
 */
const AGENT_FALLBACK = 'An agent';
/**
 * The requester's name when auth has no name, no email, no account or no
 * answer: a team agent's team admin, or a shared personal agent's owner.
 */
const REQUESTER_FALLBACK = 'Someone';

const json = (status: number, body: unknown): BotReply => ({ status, body });
const NOT_FOUND = json(404, { error: 'not-found' });

/** A refused rights re-check, answered as the agent settings' routes answer their own. */
function rightsRefused(reason: Extract<Rights, { ok: false }>['reason']): BotReply {
  if (reason === 'forbidden') return json(403, { error: 'forbidden' });
  if (reason === 'personal-agent') return json(409, { error: 'personal-agent' });
  return NOT_FOUND;
}

export function createBotRequests(d: BotRequestsDeps): BotRequests {
  const canConnect = isHttps(d.publicOrigin);

  /** A log line never changes an outcome. */
  const log = (level: 'info' | 'warn', msg: string, fields: Record<string, string>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };
  /** A list lookup that failed and was shown as its fallback: code-only. */
  const failed = (stage: string, err: unknown, requestId?: string): void => {
    log('warn', 'slack_bot_request_failed', {
      ...(requestId !== undefined ? { requestId } : {}),
      stage,
      code: logCode(err),
    });
  };

  async function ask(i: { ctx: AgentContext; actorUserId: string; agentId: string; botName: string }): Promise<BotReply> {
    const asked = await d.lock.run(async (): Promise<{ reply: BotReply; opened: string | null }> => {
      const refused = (reply: BotReply) => ({ reply, opened: null });
      // The route checked before the lock. Asked again inside it: an agent
      // deleted while this waited has had its request removed already (that
      // removal takes this lock too), and a demoted admin is refused the same way.
      const rights = await checkRights(d.bus, i.ctx, i.agentId, i.actorUserId, 'manage');
      if (!rights.ok) return refused(rightsRefused(rights.reason));
      // Nothing is asked that couldn't be approved: the self path's own conditions.
      const shared = await d.installs.current();
      if (shared === null || shared.status !== 'active') return refused(json(409, { error: 'no-workspace' }));
      if (!canConnect) return refused(json(409, { error: 'public-origin-not-https' }));
      // An open request or a bot, never both.
      if ((await d.installs.botForAgent(i.agentId)) !== null) return refused(json(409, { error: 'bot-exists' }));
      if ((await d.installs.botRequestForAgent(i.agentId)) !== null) return refused(json(409, { error: 'bot-requested' }));
      // One name per bot: a request holds its name until it is approved or taken back.
      if (isBotNameTaken(i.botName, await namesInUse(d.installs))) return refused(json(409, { error: 'bot-name-taken' }));
      const requestId = d.randomBytes(INSTALL_ID_BYTES).toString('base64url');
      try {
        await d.installs.insertBotRequest({
          requestId,
          agentId: i.agentId,
          requestedByUserId: i.actorUserId,
          botName: i.botName,
        });
      } catch (err) {
        // Another request for the agent got in first (the unique index is the last word).
        if (err instanceof InstallStoreError && err.code === 'request-exists') {
          return refused(json(409, { error: 'bot-requested' }));
        }
        throw err;
      }
      log('info', 'slack_bot_request_opened', { requestId });
      return { reply: json(200, {}), opened: requestId };
    });
    // Once the lock is free, never awaited: the AX admins hear of it.
    if (asked.opened !== null) {
      void d.dms.opened({
        requestId: asked.opened,
        agentId: i.agentId,
        requesterUserId: i.actorUserId,
        botName: i.botName,
      });
    }
    return asked.reply;
  }

  async function cancel(i: { agentId: string }): Promise<BotReply> {
    const cancelled = await d.lock.run(async (): Promise<string | null> => {
      const requestId = await d.installs.removeBotRequestForAgent(i.agentId);
      if (requestId !== null) log('info', 'slack_bot_request_cancelled', { requestId });
      return requestId;
    });
    if (cancelled === null) return json(409, { error: 'not-requested' });
    // Once the lock is free, never awaited: its DMs are forgotten, so a fan-out still running stops.
    void d.dms.forget({ requestId: cancelled });
    return json(200, {});
  }

  async function approve(i: {
    ctx: AgentContext;
    actorUserId: string;
    requestId: string;
    refreshToken: string | null;
    icon: ParsedIcon | null;
  }): Promise<BotReply> {
    const approved = await d.lock.run(async (): Promise<{ reply: BotReply; made: BotRequest | null }> => {
      const refused = (reply: BotReply) => ({ reply, made: null });
      // Still an AX admin, asked inside the lock: one demoted while this waited
      // makes nothing, as the approver's Allow asks (bots.ts `finish`). Before
      // the request is read, so a non-admin learns nothing about it.
      if (!(await isAxAdmin(d.bus, i.ctx, i.actorUserId))) return refused(json(403, { error: 'forbidden' }));
      // Read under the lock: an approve, a decline or a cancel that got here first has taken it.
      const request = await d.installs.getBotRequest(i.requestId);
      if (request === null) return refused(NOT_FOUND);
      // Whom its outsiders will run as must still manage the agent: a team
      // admin of a team agent's team, an owner of a shared personal agent
      // (TASK-1248). The AX admin's own rights over the agent are never
      // asked: she needn't be able to use it.
      const requester = await managerAccess(d.bus, i.ctx, request.agentId, request.requestedByUserId);
      if (requester === 'agent-gone') return refused(json(409, { error: 'agent-gone' }));
      if (requester !== 'yes') return refused(json(409, { error: 'requester-not-admin' }));
      const reply = await d.bots.create({
        agentId: request.agentId,
        approverUserId: i.actorUserId,
        requesterUserId: request.requestedByUserId,
        botName: request.botName,
        refreshToken: i.refreshToken,
        icon: i.icon,
        requestId: request.requestId,
      });
      // Only a bot made took the request: any other answer left it open, its DMs' buttons with it.
      return { reply, made: reply.status === 200 ? request : null };
    });
    // Once the lock is free, never awaited: the AX admins' DMs say she approved it.
    if (approved.made !== null) {
      void d.dms.closed({
        requestId: approved.made.requestId,
        requesterUserId: approved.made.requestedByUserId,
        botName: approved.made.botName,
        outcome: 'approved',
        byUserId: i.actorUserId,
      });
    }
    return approved.reply;
  }

  async function decline(i: { requestId: string; actorUserId: string; clicked?: PostedDm }): Promise<BotReply> {
    const declined = await d.lock.run(async (): Promise<BotRequest | null> => {
      // Read before the delete, under the lock: its DMs need whose request it was and its name.
      const request = await d.installs.getBotRequest(i.requestId);
      if (request === null || !(await d.installs.removeBotRequest(i.requestId))) return null;
      log('info', 'slack_bot_request_declined', { requestId: i.requestId });
      return request;
    });
    if (declined === null) return NOT_FOUND;
    // Once the lock is free, never awaited: the AX admins' DMs say she declined
    // it, the one she clicked in too (whether its requester hears is
    // bot-request-dms.ts's to decide).
    void d.dms.closed({
      requestId: declined.requestId,
      requesterUserId: declined.requestedByUserId,
      botName: declined.botName,
      outcome: 'declined',
      byUserId: i.actorUserId,
      ...(i.clicked !== undefined ? { clicked: i.clicked } : {}),
    });
    return json(200, {});
  }

  /** Whether AX holds the viewer's own token: presence only. A fault (a bad id included) reads false. */
  async function viewerTokenStored(viewerUserId: string): Promise<boolean> {
    try {
      return (await d.secrets.getConfigToken({ installId: '', connectedByUserId: viewerUserId })) !== null;
    } catch (err) {
      failed('status-config-token', err);
      return false;
    }
  }

  async function list(i: { ctx: AgentContext; viewerUserId: string }): Promise<AdminBotRequestList> {
    const all = await d.installs.listBotRequests();
    const truncated = all.length > BOT_REQUESTS_MAX;
    const rows = all.slice(0, BOT_REQUESTS_MAX);
    // Nothing to approve: no token fact is needed.
    if (rows.length === 0) return { requests: [], configTokenStored: false, truncated: false };
    const hasTeams = d.bus.hasService('teams:list-for-user');
    // One question per requester per list, however many requests they made.
    const teamsOf = new Map<string, Promise<ReadonlyMap<string, string>>>();
    const namesOf = new Map<string, Promise<string>>();
    const requests: AdminBotRequest[] = [];
    for (const r of rows) {
      const requester = r.requestedByUserId;
      // One they can't see, or one that's gone, reads as the fallback; a fault too, logged.
      const agent = await agentSeenBy(d.bus, i.ctx, r, (err) => failed('agent', err, r.requestId));
      let teamName: string | null = null;
      if (hasTeams && agent.teamId !== null) {
        let teams = teamsOf.get(requester);
        if (teams === undefined) {
          // A fault reads as no names, logged against the request that asked first.
          const requestId = r.requestId;
          teams = teamNamesOf(d.bus, i.ctx, requester, (err) => failed('team', err, requestId));
          teamsOf.set(requester, teams);
        }
        teamName = (await teams).get(agent.teamId) ?? null;
      }
      let requestedBy = namesOf.get(requester);
      if (requestedBy === undefined) {
        // As auth knows them now. The email is fine here: only AX admins read this list.
        requestedBy = personName(d.bus, i.ctx, requester, {
          allowEmail: true,
          fallback: REQUESTER_FALLBACK,
          onFault: (err) => failed('requested-by', err, r.requestId),
        });
        namesOf.set(requester, requestedBy);
      }
      requests.push({
        requestId: r.requestId,
        botName: r.botName,
        agentName: agent.name ?? AGENT_FALLBACK,
        teamName,
        requestedBy: await requestedBy,
        requestedAt: r.createdAt.toISOString(),
      });
    }
    return { requests, truncated, configTokenStored: await viewerTokenStored(i.viewerUserId) };
  }

  return { ask, cancel, list, approve, decline };
}
