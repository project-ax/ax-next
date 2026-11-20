import { PluginError, type AgentContext, type HookBus, type Logger } from '@ax/core';
import { isBotNameTaken } from './bot-name.js';
import type { BotReply, Bots } from './bots.js';
import { checkRights, teamAdminAccess, type Rights } from './channels.js';
import type { ParsedIcon } from './icon.js';
import { cleanLabel } from './label.js';
import { BOT_REQUESTS_MAX, INSTALL_ID_BYTES } from './limits.js';
import { logCode } from './log-code.js';
import type { Mutex } from './mutex.js';
import { personName } from './person-name.js';
import type { SecretStore } from './secrets.js';
import { isHttps, isRecord, namesInUse } from './slack-apps.js';
import { InstallStoreError, type BotRequest, type InstallStore } from './store.js';

/**
 * Asking an AX admin for a team agent's own Slack bot (TASK-1169; design
 * docs/plans/2026-11-09-channel-slack-design.md §4 steps 2–3). A team admin
 * who can't install Slack apps asks from the agent's settings
 * (agent-routes.ts), and pastes no token. The request waits in its own table
 * (store.ts `BotRequest`) until an AX admin approves or declines it in Admin ›
 * Slack (bot-request-routes.ts), or the team cancels it.
 *
 * A request holds a bot name and its requester, nothing else: no secret, no
 * Slack app, no picture. An agent has an open request or a bot (pending or
 * live), never both, and a request's name counts as taken (slack-apps.ts
 * `namesInUse`) until it is approved or taken back.
 *
 * Who may do what. The routes check first; this checks again whatever can
 * change while a call waits for the lock:
 *   - `ask`, `cancel`: a team admin of the agent's team (the agent settings'
 *     gate, channels.ts). `ask` asks the rights again inside the lock, as the
 *     self path's request does: an agent deleted while it waited has had its
 *     request removed already (that removal takes the lock too), so a request
 *     let through would name an agent that's gone. `cancel` doesn't, as the
 *     pending bot's Cancel doesn't: it only takes something away.
 *   - `list`, `approve`, `decline`: an AX admin (Admin › Slack's gate). An
 *     approve makes the bot through the one create path (bots.ts `create`),
 *     with the AX admin as its approver (her own configuration token, stored
 *     or pasted, makes the app, and she manages it from then on) and the
 *     request's requester as its requester (whom its channels' outsiders run
 *     as). Only while that requester is still a team admin of the agent's
 *     team, asked inside the lock; the AX admin's own rights over the agent
 *     are never asked, since she needn't be on the team. The request goes
 *     only once the bot is made (`create` deletes it last), so an approve
 *     that makes nothing leaves it open.
 *
 * The lock: `ask`, `cancel`, `approve` and `decline` each take the one app
 * lock (plugin.ts) once, and each reads the request inside it. So names stay
 * unique, a cancel or a decline waits for an approve in flight and then
 * finds its request gone, and of two approves of one request (two AX admins,
 * or a double click) the second finds it gone: one Slack app, then 404. It
 * isn't re-entrant (mutex.ts): none of them calls anything that takes it
 * (`create` runs under the caller's). `list` takes none, never rotates a
 * token and never asks Slack anything: its one vault read is whether the
 * VIEWING admin's own token is stored.
 *
 * Admin › Slack's list names each request as its requester sees it: the agent
 * and its team as `agents:resolve` and `teams:list-for-user` (optional) answer
 * the requester, and the requester by display name, else email (only AX
 * admins read the list), each cleaned to one line (label.ts) and read when
 * shown, never stored (invariant 4). A requester who left the team, or an
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
  /** The agent's name as its requester sees it, else "A team agent". */
  agentName: string;
  /** Its team's name as its requester sees it; null without @ax/teams, or when they can't see the agent. */
  teamName: string | null;
  /** The requester's display name, else their email, else "A team admin". */
  requestedBy: string;
  /** When it was asked, as an ISO 8601 instant. */
  requestedAt: string;
}

export interface AdminBotRequestList {
  /** Oldest first, at most BOT_REQUESTS_MAX. */
  requests: AdminBotRequest[];
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
  /** The one app lock, shared with Admin › Slack and the bots domain. Not re-entrant. */
  lock: Mutex;
  /** Only an https origin can make a bot, so nothing is asked over plain http. */
  publicOrigin: string;
  logger: Logger;
  randomBytes: (n: number) => Buffer;
}

export interface BotRequests {
  /**
   * A team admin asks an AX admin for the agent's own bot, as `actorUserId`,
   * its requester. Takes the app lock, then refuses, in this order: 404 / 403
   * / 409 `personal-agent` as the rights re-check says; 409 `no-workspace`
   * (no live shared bot) and `public-origin-not-https` (nothing is asked
   * that couldn't be approved); 409 `bot-exists`, `bot-requested` (one per
   * agent, the unique index the last word) and `bot-name-taken` (every bot's,
   * the shared bot's and every open request's name). `botName` already passed
   * `checkBotName`. 200 `{}`, logged `slack_bot_request_opened { requestId }`.
   * A rights check that can't be answered, or a store fault, throws.
   */
  ask(i: { ctx: AgentContext; actorUserId: string; agentId: string; botName: string }): Promise<BotReply>;
  /**
   * The team takes its request back (the route let only a team admin of the
   * agent through). Takes the app lock, so it waits for an approve in
   * flight. 200 `{}`, logged `slack_bot_request_cancelled { requestId }`; 409
   * `not-requested` when the agent has no open request (an approve got
   * there first: the agent now shows its pending bot).
   */
  cancel(i: { agentId: string }): Promise<BotReply>;
  /**
   * The open requests Admin › Slack shows `viewerUserId`, an AX admin. Takes
   * no lock, never rotates or asks Slack. A lookup that fails reads as its
   * fallback, logged; a store fault reading the requests throws.
   */
  list(i: { ctx: AgentContext; viewerUserId: string }): Promise<AdminBotRequestList>;
  /**
   * An AX admin, `actorUserId`, approves one open request, by its id. Takes
   * the app lock, reads the request inside it (404 `not-found` when it is
   * gone: approved, declined or cancelled first), asks whether its requester
   * is still a team admin of the agent's team (409 `requester-not-admin`;
   * `agent-gone` for an agent deleted), then makes the bot through `create`,
   * with her as the approver and the requester as the requester, and answers
   * what it answers: 200 `{ installUrl, iconSet }`, or a refusal with the
   * request left open. `refreshToken` is a pasted one that passed the
   * route's shape check, or null for the one stored for her; `icon` is the
   * picture as icon.ts read it, or null. A check that can't be answered, or
   * a vault fault reading her token, throws.
   */
  approve(i: {
    ctx: AgentContext;
    actorUserId: string;
    requestId: string;
    refreshToken: string | null;
    icon: ParsedIcon | null;
  }): Promise<BotReply>;
  /**
   * An AX admin declines one open request, by its id. Takes the app lock, so
   * it waits for an approve in flight. 200 `{}`, logged
   * `slack_bot_request_declined { requestId }`; 404 `not-found` when it is
   * gone. No declined marker is kept: the team sees its form again.
   */
  decline(i: { requestId: string }): Promise<BotReply>;
}

/** The agent's name when its requester can't see it, or nobody says. */
const AGENT_FALLBACK = 'A team agent';
/** The requester's name when auth has no name, no email, no account or no answer. */
const REQUESTER_FALLBACK = 'A team admin';

const json = (status: number, body: unknown): BotReply => ({ status, body });
const NOT_FOUND = json(404, { error: 'not-found' });

/** A refused rights re-check, answered as the agent settings' routes answer their own. */
function rightsRefused(reason: Extract<Rights, { ok: false }>['reason']): BotReply {
  if (reason === 'forbidden') return json(403, { error: 'forbidden' });
  if (reason === 'personal-agent') return json(409, { error: 'personal-agent' });
  return NOT_FOUND;
}

/** The agent as one requester sees it. `teamId` is only ever used to find its team's name. */
interface SeenAgent {
  name: string;
  teamId: string | null;
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
    return d.lock.run(async () => {
      // The route checked before the lock. Asked again inside it: an agent
      // deleted while this waited has had its request removed already (that
      // removal takes this lock too), and a demoted admin is refused the same way.
      const rights = await checkRights(d.bus, i.ctx, i.agentId, i.actorUserId, 'manage');
      if (!rights.ok) return rightsRefused(rights.reason);
      // Nothing is asked that couldn't be approved: the self path's own conditions.
      const shared = await d.installs.current();
      if (shared === null || shared.status !== 'active') return json(409, { error: 'no-workspace' });
      if (!canConnect) return json(409, { error: 'public-origin-not-https' });
      // An open request or a bot, never both.
      if ((await d.installs.botForAgent(i.agentId)) !== null) return json(409, { error: 'bot-exists' });
      if ((await d.installs.botRequestForAgent(i.agentId)) !== null) return json(409, { error: 'bot-requested' });
      // One name per bot: a request holds its name until it is approved or taken back.
      if (isBotNameTaken(i.botName, await namesInUse(d.installs))) return json(409, { error: 'bot-name-taken' });
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
          return json(409, { error: 'bot-requested' });
        }
        throw err;
      }
      log('info', 'slack_bot_request_opened', { requestId });
      return json(200, {});
    });
  }

  async function cancel(i: { agentId: string }): Promise<BotReply> {
    return d.lock.run(async () => {
      const requestId = await d.installs.removeBotRequestForAgent(i.agentId);
      if (requestId === null) return json(409, { error: 'not-requested' });
      log('info', 'slack_bot_request_cancelled', { requestId });
      return json(200, {});
    });
  }

  async function approve(i: {
    ctx: AgentContext;
    actorUserId: string;
    requestId: string;
    refreshToken: string | null;
    icon: ParsedIcon | null;
  }): Promise<BotReply> {
    return d.lock.run(async () => {
      // Read under the lock: an approve, a decline or a cancel that got here first has taken it.
      const request = await d.installs.getBotRequest(i.requestId);
      if (request === null) return NOT_FOUND;
      // Whom its outsiders will run as must still be a team admin of the
      // agent's team. The AX admin's own rights over the agent are never
      // asked: she needn't be on the team.
      const requester = await teamAdminAccess(d.bus, i.ctx, request.agentId, request.requestedByUserId);
      if (requester === 'agent-gone') return json(409, { error: 'agent-gone' });
      if (requester !== 'yes') return json(409, { error: 'requester-not-admin' });
      return d.bots.create({
        agentId: request.agentId,
        approverUserId: i.actorUserId,
        requesterUserId: request.requestedByUserId,
        botName: request.botName,
        refreshToken: i.refreshToken,
        icon: i.icon,
        requestId: request.requestId,
      });
    });
  }

  async function decline(i: { requestId: string }): Promise<BotReply> {
    return d.lock.run(async () => {
      if (!(await d.installs.removeBotRequest(i.requestId))) return NOT_FOUND;
      log('info', 'slack_bot_request_declined', { requestId: i.requestId });
      return json(200, {});
    });
  }

  /**
   * The agent as its requester sees it: only an answer about this agent, as
   * a team agent, names it. One they can't see (they left the team) or one
   * that's gone reads as the fallback, quietly; any other fault too, logged.
   */
  async function agentSeenBy(ctx: AgentContext, r: BotRequest): Promise<SeenAgent> {
    const fallback: SeenAgent = { name: AGENT_FALLBACK, teamId: null };
    let out: unknown;
    try {
      out = await d.bus.call<{ agentId: string; userId: string }, unknown>('agents:resolve', ctx, {
        agentId: r.agentId,
        userId: r.requestedByUserId,
      });
    } catch (err) {
      const code = err instanceof PluginError ? err.code : undefined;
      if (code !== 'forbidden' && code !== 'not-found') failed('agent', err, r.requestId);
      return fallback;
    }
    const agent = isRecord(out) ? out['agent'] : undefined;
    if (!isRecord(agent) || agent['id'] !== r.agentId || agent['visibility'] !== 'team') return fallback;
    const name = agent['displayName'];
    const owner = agent['ownerId'];
    return {
      name: (typeof name === 'string' ? cleanLabel(name) : '') || AGENT_FALLBACK,
      // A team agent's owner is its team (@ax/agents): only ever matched against the requester's teams.
      teamId: typeof owner === 'string' && owner !== '' ? owner : null,
    };
  }

  /**
   * The names of the teams `userId` is on, by team id, cleaned; an empty map
   * when the answer can't be read. A fault reads as no names, logged.
   */
  async function teamNamesOf(ctx: AgentContext, userId: string, requestId: string): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    let out: unknown;
    try {
      out = await d.bus.call<{ userId: string }, unknown>('teams:list-for-user', ctx, { userId });
    } catch (err) {
      failed('team', err, requestId);
      return names;
    }
    const teams = isRecord(out) ? out['teams'] : undefined;
    if (!Array.isArray(teams)) return names;
    for (const team of teams) {
      if (!isRecord(team)) continue;
      const id = team['id'];
      const name = team['displayName'];
      if (typeof id !== 'string' || typeof name !== 'string' || names.has(id)) continue;
      const label = cleanLabel(name);
      if (label !== '') names.set(id, label);
    }
    return names;
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
    const rows = (await d.installs.listBotRequests()).slice(0, BOT_REQUESTS_MAX);
    // Nothing to approve: no token fact is needed.
    if (rows.length === 0) return { requests: [], configTokenStored: false };
    const hasTeams = d.bus.hasService('teams:list-for-user');
    // One question per requester per list, however many requests they made.
    const teamsOf = new Map<string, Promise<ReadonlyMap<string, string>>>();
    const namesOf = new Map<string, Promise<string>>();
    const requests: AdminBotRequest[] = [];
    for (const r of rows) {
      const requester = r.requestedByUserId;
      const agent = await agentSeenBy(i.ctx, r);
      let teamName: string | null = null;
      if (hasTeams && agent.teamId !== null) {
        let teams = teamsOf.get(requester);
        if (teams === undefined) {
          teams = teamNamesOf(i.ctx, requester, r.requestId);
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
        agentName: agent.name,
        teamName,
        requestedBy: await requestedBy,
        requestedAt: r.createdAt.toISOString(),
      });
    }
    return { requests, configTokenStored: await viewerTokenStored(i.viewerUserId) };
  }

  return { ask, cancel, list, approve, decline };
}
