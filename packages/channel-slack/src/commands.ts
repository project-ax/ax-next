import { makeAgentContext, type AgentContext } from '@ax/core';
import { admitSender, findSenderUser, isTemporaryLookupFailure } from './admission.js';
import type { ChannelBinding } from './channel-store.js';
import { agentAccess, checkRights, connectChannel, type ChannelDeps, type ConnectOutcome } from './channels.js';
import { COPY } from './copy.js';
import { decodeSlackEntities } from './format.js';
import type { RouteHandler, RouteRequest, RouteResponse } from './http-types.js';
import { admittedHandler, verifySignedRequest } from './ingress.js';
import type { Lifetime } from './lifetime.js';
import {
  AGENT_NAME_ARG_MAX,
  COMMANDS_MAX_BODY_BYTES,
  SLACK_ID_RE,
  SLASH_REPLY_DEADLINE_MS,
  SLASH_TEXT_MAX,
} from './limits.js';
import { logCode } from './log-code.js';
import { SLASH_COMMAND } from './manifest.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * `POST /slack/commands/:installId`: the `/ax` slash command (TASK-1094).
 *
 *   /ax connect <agent name>   connect this channel to a team agent
 *   /ax disconnect             disconnect whichever agent is connected here
 *   anything else              how to use it
 *
 * The route is public and its caller is Slack, so it checks what the events
 * route checks first (ingress.ts: body cap, install id, install, signing
 * secret, signature), then:
 *
 *   1. The body is a form (`application/x-www-form-urlencoded`, UTF-8) with
 *      `command`, `team_id`, `api_app_id`, `user_id` and `channel_id` once
 *      each, the ids Slack-shaped, and `text` at most SLASH_TEXT_MAX, else
 *      400. Slack's `ssl_check` is an empty 200.
 *   2. Another app, a pending install, another workspace or another command
 *      → an empty 200, ignored.
 *   3. Who is asking is the signed `user_id`, admitted through users.info
 *      with the install's bot token (admission.ts), and mapped to an AX
 *      account through its verified email. Never `user_name`, never anything
 *      in the text: the text is only ever a subcommand and an agent's name.
 *      Someone users.info refuses (a guest, a bot, another workspace, …)
 *      gets an empty 200 and AX is asked nothing about them; only a lookup
 *      that failed because Slack was briefly unavailable says "try again".
 *   4. `connect` reaches only a team agent the invoker sees whose name
 *      matches (normalizeName), then only one they manage: a team admin of
 *      its team (channels.ts; workspace-admin status never counts). The
 *      channel is the one the command was typed in, and connectChannel does
 *      the rest, the same core as the agent settings.
 *   5. `disconnect` needs the same rights over the connected agent, except
 *      when that agent is gone: a binding nobody can manage any more is
 *      cleared for anyone who asks.
 *
 * Replies are ephemeral (only the invoker sees them). Slack wants the HTTP
 * answer within 3 s, so the work runs tracked by the lifetime, and the
 * answer carries the reply when it is ready inside SLASH_REPLY_DEADLINE_MS.
 * Otherwise the answer is "working on it" (or, if the invoker isn't admitted
 * yet, nothing at all), and the reply follows once, through
 * `chat.postEphemeral`, when the work settles. Slack's `response_url` is
 * never used: `slack.com/api` stays the only egress.
 *
 * Logs carry the install and a reason, stage or code: never a Slack id, an
 * email, a name or the text.
 */

export const COMMANDS_ROUTE_PATH = '/slack/commands/:installId';
const COMMANDS_PATH_PREFIX = '/slack/commands/';

export interface CommandsHandlerDeps extends ChannelDeps {
  store: Pick<InstallStore, 'get'>;
  lifetime: Lifetime;
  /** The web app's origin, linked from the "sign in first" reply. */
  publicOrigin: string;
  /** Epoch milliseconds. */
  now: () => number;
  /** Test seam for the reply deadline. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

// ── The form ────────────────────────────────────────────────────────────────

/** A verified `/ax` invocation: what this route reads of it, and nothing else. */
interface SlashCommand {
  teamId: string;
  apiAppId: string;
  /** Slack's id for whoever typed the command: the only identity read. */
  userId: string;
  channelId: string;
  command: string;
  text: string;
}

type CommandForm = { kind: 'ssl-check' } | { kind: 'command'; command: SlashCommand };

const FORM_TYPE = 'application/x-www-form-urlencoded';
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Step 1 above. Null when the body isn't a form we accept. */
function parseCommandForm(contentType: string | undefined, body: Buffer): CommandForm | null {
  if ((contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() !== FORM_TYPE) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(utf8.decode(body));
  } catch {
    return null;
  }
  /** A field's value; null when it's absent, undefined when it came more than once. */
  const one = (name: string): string | null | undefined => {
    const all = params.getAll(name);
    if (all.length > 1) return undefined;
    return all[0] ?? null;
  };
  // Slack checking our certificate: it carries none of the fields below.
  if (one('ssl_check') === '1') return { kind: 'ssl-check' };

  const id = (name: string): string | null => {
    const value = one(name);
    return typeof value === 'string' && SLACK_ID_RE.test(value) ? value : null;
  };
  const teamId = id('team_id');
  const apiAppId = id('api_app_id');
  const userId = id('user_id');
  const channelId = id('channel_id');
  const command = one('command');
  const text = one('text');
  if (teamId === null || apiAppId === null || userId === null || channelId === null) return null;
  if (typeof command !== 'string' || command.length === 0) return null;
  if (text === undefined || (text !== null && text.length > SLASH_TEXT_MAX)) return null;
  return { kind: 'command', command: { teamId, apiAppId, userId, channelId, command, text: text ?? '' } };
}

type Subcommand = { kind: 'connect'; name: string } | { kind: 'disconnect' } | { kind: 'usage' };

/**
 * What the text asks for: its first word, in any case, after Slack's
 * escaping is undone. `connect` needs a name after it; `disconnect` takes
 * nothing, so a stray word can't make it act on this channel by mistake.
 */
function subcommandOf(text: string): Subcommand {
  const words = decodeSlackEntities(text).trim();
  const gap = words.search(/\s/);
  const verb = (gap === -1 ? words : words.slice(0, gap)).toLowerCase();
  const rest = gap === -1 ? '' : words.slice(gap).trim();
  if (verb === 'connect' && rest.length > 0) return { kind: 'connect', name: rest };
  if (verb === 'disconnect' && rest.length === 0) return { kind: 'disconnect' };
  return { kind: 'usage' };
}

/**
 * An agent's name as `/ax connect` compares it, for both what was typed and
 * each agent's display name: NFC, trimmed, runs of whitespace as one space,
 * one pair of surrounding straight quotes dropped, lowercase.
 */
export function normalizeName(raw: string): string {
  let name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  const quote = name[0];
  if (name.length >= 2 && (quote === '"' || quote === "'") && name.endsWith(quote)) {
    name = name.slice(1, -1).trim();
  }
  return name.toLowerCase();
}

// ── Answers from AX ─────────────────────────────────────────────────────────

/** An answer this route couldn't read. Carries a code, so it logs like any other failure. */
class UnreadableAnswer extends Error {
  readonly code = 'bad-response';
  constructor(hook: string) {
    super(`channel-slack: unreadable answer from ${hook}`);
    this.name = 'UnreadableAnswer';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The team ids in a `teams:list-for-user` answer. */
function teamIdsOf(answer: unknown): string[] {
  const raw = isRecord(answer) ? answer['teams'] : undefined;
  if (!Array.isArray(raw)) throw new UnreadableAnswer('teams:list-for-user');
  return raw.flatMap((t: unknown) => {
    const id = isRecord(t) ? t['id'] : undefined;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
}

/** The team agents in an `agents:list-for-user` answer, each once. A personal agent is never one. */
function teamAgentsOf(answer: unknown): Array<{ id: string; displayName: string }> {
  const raw = isRecord(answer) ? answer['agents'] : undefined;
  if (!Array.isArray(raw)) throw new UnreadableAnswer('agents:list-for-user');
  const agents = new Map<string, { id: string; displayName: string }>();
  for (const a of raw) {
    if (!isRecord(a) || a['visibility'] !== 'team') continue;
    const { id, displayName } = a;
    if (typeof id !== 'string' || id.length === 0 || typeof displayName !== 'string') continue;
    if (!agents.has(id)) agents.set(id, { id, displayName });
  }
  return [...agents.values()];
}

/** A refused connect, as `/ax` says it. */
function connectRefusal(outcome: Extract<ConnectOutcome, { ok: false }>): string {
  switch (outcome.reason) {
    case 'channel-taken':
      return COPY.slashChannelTaken;
    case 'archived':
    case 'shared':
      return COPY.slashChannelNotAllowed(outcome.reason);
    case 'not-public':
    // An install that has `/ax` has channels:read (one manifest), so Slack
    // answering missing_scope here means a DM, a group DM or a private
    // channel. Never "connect Slack again": that makes a new install and
    // drops every channel's binding.
    case 'needs-reconnect':
      return COPY.slashChannelNotAllowed('not-public');
    case 'no-workspace':
      return COPY.slashNeedsReconnect;
    case 'slack-error':
      return COPY.slashFailed;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ── The handler ─────────────────────────────────────────────────────────────

type IgnoreReason = 'app' | 'status' | 'team' | 'command';
type Declined = 'no-such-agent' | 'not-manager' | 'ambiguous' | 'nothing-connected';

/** What one invocation has learned so far, for the answer at the deadline and the reply after it. */
interface Progress {
  /** users.info admitted the invoker: from here they may hear "working on it". */
  admitted: boolean;
  botToken: string | null;
}

export function createCommandsHandler(d: CommandsHandlerDeps): RouteHandler {
  const sleep = d.sleep ?? defaultSleep;

  // A log line never changes the answer.
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };

  /** A ctx for the lookups: no agent, and the invoker once they are known. */
  const lookupCtx = (userId: string): AgentContext =>
    makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId, logger: d.logger });

  async function handle(req: RouteRequest, res: RouteResponse): Promise<void> {
    const install = await verifySignedRequest(d, req, res, {
      pathPrefix: COMMANDS_PATH_PREFIX,
      maxBodyBytes: COMMANDS_MAX_BODY_BYTES,
      logPrefix: 'slack_command',
    });
    if (install === null) return;
    const installId = install.installId;

    const contentType = Object.hasOwn(req.headers, 'content-type') ? req.headers['content-type'] : undefined;
    const form = parseCommandForm(contentType, req.body);
    if (form === null) {
      log('warn', 'slack_command_refused', { installId, reason: 'malformed' });
      res.status(400).end();
      return;
    }
    if (form.kind === 'ssl-check') {
      res.status(200).end();
      return;
    }
    const c = form.command;
    const ignored: IgnoreReason | null =
      c.apiAppId !== install.appId
        ? 'app'
        : install.status !== 'active'
          ? 'status'
          : c.teamId !== install.teamId
            ? 'team'
            : c.command !== SLASH_COMMAND
              ? 'command'
              : null;
    if (ignored !== null) {
      log('info', 'slack_command_ignored', { installId, reason: ignored });
      res.status(200).end();
      return;
    }

    // The reply: in the HTTP answer if it's ready by the deadline, else privately once it is.
    const progress: Progress = { admitted: false, botToken: null };
    let answered = false;
    const answer = (text: string | null): void => {
      answered = true;
      if (text === null) res.status(200).end();
      else res.status(200).json({ response_type: 'ephemeral', text });
    };
    const work = d.lifetime
      .track(async () => {
        const text = await respond(install, c, progress);
        if (!answered) {
          answer(text);
          return;
        }
        if (text !== null && progress.botToken !== null) await postLate(installId, progress.botToken, c, text);
      })
      .catch((err: unknown) => log('error', 'slack_command_failed', { installId, stage: 'reply', code: logCode(err) }));
    await Promise.race([work, sleep(SLASH_REPLY_DEADLINE_MS)]);
    // Someone not yet admitted hears nothing until we know who they are.
    if (!answered) answer(progress.admitted ? COPY.slashWorking : null);
  }

  /** The reply that missed the deadline, said once, only to the invoker. */
  async function postLate(installId: string, botToken: string, c: SlashCommand, text: string): Promise<void> {
    try {
      await d.api.postEphemeral(botToken, { channel: c.channelId, user: c.userId, text });
    } catch (err) {
      log('warn', 'slack_reply_failed', { installId, stage: 'ephemeral', code: logCode(err) });
    }
  }

  /**
   * Run the command: the reply to give, or null for silence. Never rejects:
   * a fault is logged by code and answered with "try again".
   */
  async function respond(install: InstallRow, c: SlashCommand, progress: Progress): Promise<string | null> {
    const installId = install.installId;
    const failed = (stage: string, err: unknown): string => {
      log('error', 'slack_command_failed', { installId, stage, code: logCode(err) });
      return COPY.slashFailed;
    };

    let botToken: string | null;
    try {
      botToken = await d.secrets.get(install, 'bot-token');
    } catch (err) {
      return failed('bot-token', err);
    }
    if (botToken === null) {
      // Nobody can be admitted without it: silence, and a line for the operator.
      log('error', 'slack_bot_token_missing', { installId });
      return null;
    }
    progress.botToken = botToken;

    // Who is asking: the signed user_id, through users.info. Never user_name, never the text.
    const admission = await admitSender(d.api, botToken, c.userId, c.teamId);
    if (!admission.ok) {
      log(admission.reason === 'lookup-failed' ? 'warn' : 'info', 'slack_sender_refused', {
        installId,
        reason: admission.reason,
        ...(admission.code !== undefined ? { code: admission.code } : {}),
      });
      // Slack was briefly unavailable, which says nothing about the invoker:
      // "try again". A refusal is silence: they learn nothing from the bot.
      return isTemporaryLookupFailure(admission) ? COPY.slashFailed : null;
    }
    progress.admitted = true;

    const asked = subcommandOf(c.text);
    if (asked.kind === 'usage') return COPY.slashUsage;

    let userId: string | null;
    try {
      // Logs `slack_sender_not_mapped` itself on every miss.
      userId = await findSenderUser(d.bus, lookupCtx(''), admission.email, { installId, logger: d.logger });
    } catch (err) {
      return failed('find-user', err);
    }
    if (userId === null) return COPY.slashNotMapped(d.publicOrigin);

    const ctx = lookupCtx(userId);
    try {
      return asked.kind === 'connect'
        ? await connect(installId, c, ctx, userId, asked.name)
        : await disconnect(installId, c, ctx, userId);
    } catch (err) {
      return failed(asked.kind, err);
    }
  }

  const declined = (installId: string, reason: Declined, text: string): string => {
    log('info', 'slack_command_declined', { installId, reason });
    return text;
  };

  /** The invoker's teams. @ax/teams is optional: without it, nobody is on one. */
  async function teamIdsFor(ctx: AgentContext, userId: string): Promise<string[]> {
    if (!d.bus.hasService('teams:list-for-user')) return [];
    return teamIdsOf(await d.bus.call<{ userId: string }, unknown>('teams:list-for-user', ctx, { userId }));
  }

  async function connect(
    installId: string,
    c: SlashCommand,
    ctx: AgentContext,
    userId: string,
    name: string,
  ): Promise<string> {
    const wanted = normalizeName(name);
    // Longer than any agent's name can be.
    if (wanted.length > AGENT_NAME_ARG_MAX) return declined(installId, 'no-such-agent', COPY.slashNoSuchAgent);

    const listed = await d.bus.call<{ userId: string; teamIds: string[] }, unknown>('agents:list-for-user', ctx, {
      userId,
      teamIds: await teamIdsFor(ctx, userId),
    });
    let seen = 0;
    const managed: Array<{ agentId: string; agentName: string }> = [];
    for (const agent of teamAgentsOf(listed)) {
      if (normalizeName(agent.displayName) !== wanted) continue;
      const rights = await checkRights(d.bus, ctx, agent.id, userId, 'manage');
      if (rights.ok) {
        seen += 1;
        managed.push({ agentId: agent.id, agentName: rights.agentName || agent.displayName });
      } else if (rights.reason === 'forbidden') {
        // Theirs to see, not to connect. (Gone since the list, or not a team
        // agent after all: no candidate.)
        seen += 1;
      }
    }
    const chosen = managed[0];
    if (seen === 0) return declined(installId, 'no-such-agent', COPY.slashNoSuchAgent);
    if (chosen === undefined) return declined(installId, 'not-manager', COPY.slashNotManager);
    if (managed.length > 1) return declined(installId, 'ambiguous', COPY.slashAmbiguous);

    // Logs `slack_channel_connected` / `slack_channel_refused` itself.
    const outcome = await connectChannel(d, { agentId: chosen.agentId, channelId: c.channelId, actorUserId: userId });
    if (!outcome.ok) return connectRefusal(outcome);
    return outcome.reconnected
      ? COPY.slashReconnected(chosen.agentName)
      : COPY.slashConnected(chosen.agentName, outcome.binding.channelName);
  }

  async function disconnect(installId: string, c: SlashCommand, ctx: AgentContext, userId: string): Promise<string> {
    const binding = await d.channels.get(installId, c.channelId);
    if (binding === null) return declined(installId, 'nothing-connected', COPY.slashNothingConnected);

    const remove = async (b: ChannelBinding, stale: boolean): Promise<string> => {
      if (!(await d.channels.remove(b.installId, b.channelId, b.agentId))) return COPY.slashNothingConnected;
      log('info', 'slack_channel_disconnected', { installId, ...(stale ? { reason: 'agent-gone' } : {}) });
      return COPY.slashDisconnected;
    };

    // agentAccess, not checkRights: checkRights answers "not found" alike for
    // an agent that is gone and one the invoker can't see, and only a binding
    // to a gone agent may be cleared without rights (nobody can manage it).
    const access = await agentAccess(d.bus, ctx, binding.agentId, userId);
    if (access === 'agent-gone') return remove(binding, true);
    if (access !== 'yes') return declined(installId, 'not-manager', COPY.slashNotManager);
    const rights = await checkRights(d.bus, ctx, binding.agentId, userId, 'manage');
    if (!rights.ok) return declined(installId, 'not-manager', COPY.slashNotManager);
    return remove(binding, false);
  }

  return admittedHandler(d.lifetime, handle);
}
