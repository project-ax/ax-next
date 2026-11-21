import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import {
  admitSender,
  answerMention,
  findSenderUser,
  isApprovedSender,
  isTemporaryLookupFailure,
  screenEvent,
  type Admission,
  type DirectMessage,
  type Mention,
} from './admission.js';
import { CHANNEL_REFUSED_CODES, type ChannelCheck } from './channel-check.js';
import { decideTier, runsAsConnector, type SenderFacts } from './channel-route.js';
import type { ChannelBinding, ChannelStore } from './channel-store.js';
import { agentAccess, connectable, teamAdminAccess, type AgentAccess } from './channels.js';
import { COPY } from './copy.js';
import type { EventDispatcher, SlackEnvelope } from './events.js';
import { channelSenderLabel, dmSenderLabel, senderLabelNames } from './format.js';
import { cleanChannelName } from './label.js';
import { logCode } from './log-code.js';
import type { SecretStore } from './secrets.js';
import { SlackApiError, type SlackChannel } from './slack-api.js';
import type { InstallRow, InstallStore } from './store.js';
import type { KeyedQueue } from './turn-queue.js';
import { pickPersonalAgent, runTurn, type TurnDeps } from './turn.js';

/**
 * What a verified, new event for an active install becomes (the ingress's
 * EventDispatcher; it already acknowledged Slack and tracks this work).
 *
 *   1. screenEvent: Slack Connect, bots, anything but a 1:1 DM or a mention,
 *      and edits are ignored (admission.ts owns those rules).
 *   2. The install's bot token, from the vault.
 *
 * A DM (routeDm):
 *   3. The sender is admitted from users.info, never from the text. A
 *      refused sender gets silence; a users.info call that failed only
 *      because Slack was briefly unavailable gets "try again".
 *   4. A shared file gets "I can't read files yet"; an empty message nothing.
 *   5. auth:find-user-by-email with users.info's email → the sender's oldest
 *      personal agent → conversations:find-or-create for the thread
 *      (`slack:<installId>:<channel>:<thread_ts>`, origin `'slack'`).
 *   6. The turn is queued behind any other in its conversation; the fourth
 *      waiting gets "send it again after I reply".
 *   7. When the turn's time comes, the install is read again: one that was
 *      disconnected (or reset) while the turn waited is dropped, logged as
 *      `slack_turns_dropped`, and its agent never runs.
 *
 * A mention (routeMention), TASK-1094:
 *   3. The channel's binding. None: an admitted sender is told privately that
 *      no agent is connected here (answerMention); anyone else gets silence.
 *   4. The sender is admitted from users.info, as for a DM ("try again" goes
 *      to them alone, as an ephemeral). An empty mention is ignored.
 *   5. Who they are to the agent, from AX alone: their account
 *      (auth:find-user-by-email) and its access to the agent
 *      (agents:resolve), or, with no account, whether their email is on an
 *      approved domain (auth:is-approved-email); then, only for a turn that
 *      would run as the person who connected the channel, that person's own
 *      access. channel-route.ts decides the tier: attended as the sender,
 *      external as the connector, silence (off-domain), or a private "a team
 *      admin needs to connect me here again" when the binding is broken.
 *   6. conversations:find-or-create for the thread, one per identity: the
 *      sender's own (`slack:<installId>:<channel>:<thread_ts>`) or the
 *      connector's (`…:external`), so an outsider's words never enter a
 *      member's conversation, and a conversation is never run as anyone but
 *      its owner.
 *   7. Queued: a member's turn behind others in their conversation (the
 *      fourth is told to send it again), an outsider's in one lane for the
 *      whole channel (MAX_EXTERNAL_TURNS_PER_CHANNEL; one more is told the
 *      channel is busy).
 *   8. When the turn's time comes, the install AND the binding are read
 *      again: an install or binding that went away, or a channel now
 *      connected to another agent, drops the turn (`slack_turns_dropped`,
 *      `disconnected`), and so, on the shared app, does the agent's own bot
 *      having gone live meanwhile (`own-bot`, below); an outsider's turn
 *      whose channel was reconnected by someone else meanwhile is dropped
 *      too (`reconnected`), and its sender told to try again: it was
 *      planned as the old connector, in their conversation, and must not
 *      run as anyone else. On a team agent's own bot, an outsider's turn
 *      runs as its requester only while they are still a team admin of the
 *      agent's team, so it is asked again here: not any more drops the turn
 *      (`requester`) with the polite "I can't answer you here right now"
 *      line, and a failed read drops it too (`slack_event_failed`, stage
 *      `requester`), its sender told to try again. Last, Slack itself is
 *      asked about the channel, with the install's token (channel-check.ts,
 *      which keeps an answer that allows it for a minute), since a channel
 *      can change after it is bound (TASK-1184). A channel it now says is
 *      private, archived or Slack Connect, or can't find, loses its binding
 *      as a team admin's Disconnect would take it (the memory switch kept
 *      for the agent and channel stays). The one turn whose removal took it
 *      tells its sender, privately and once (`channelNoLongerAllowed`); every
 *      turn it stops is dropped (`slack_turns_dropped`,
 *      `channel-not-allowed`). Slack not answering is no turn either: "try
 *      again", and the binding stays.
 *   9. Before the agent runs, the conversation is recorded as one of the
 *      channel's threads, with the channel's memory switch as it is NOW
 *      (channel-store.ts `recordThread`): a turn that starts while the switch
 *      is off keeps that thread out of memory for good (capture-veto.ts). An
 *      outsider's turn records its conversation as outsiders', which memory
 *      never learns from, whatever the switch says, and only while the
 *      channel is still connected by the person it runs as: a reconnect
 *      since step 8 drops it as there. A member's turn also records the
 *      names its sender label shows (format.ts `senderLabelNames`), which
 *      the veto hands to memory so nothing said in the thread is stored
 *      under them (TASK-1146); an outsider's records none. If the record
 *      can't be written the turn doesn't run, and the sender is told
 *      privately to try again. A DM records nothing: the switch is a
 *      channel's.
 *   Lines before the turn are ephemeral, for the sender alone (in the
 *   mention's thread when it was in one); the reply goes in the thread.
 *
 * A team agent's own bot (TASK-1167) is any install whose kind isn't
 * exactly `shared` (store.ts reads anything else as a bot, the kind that
 * can do less):
 *   - a DM gets nothing, before any vault read or Slack call: its manifest
 *     asks for none, and one its approver turns on by hand reaches nobody;
 *   - a mention admits its sender first, and a missing binding is never "no
 *     agent here": a refused sender costs no Slack call and binds nothing.
 *     The binding is written at the first mention in a channel, once Slack's
 *     own conversations.info, read with the bot's token and about this
 *     channel, shows one the agent settings could connect (channels.ts
 *     `connectable`): to the bot's one agent, connected by its requester.
 *     Slack is asked again when each turn starts, as on the shared app (step
 *     8). A channel refused at its first mention is silence; a binding naming
 *     any other agent runs nothing;
 *   - an outsider's turn runs as that requester, and only while they are
 *     still a team admin of the agent's team (channels.ts `teamAdminAccess`);
 *     otherwise an outsider is told privately (`botUnavailable`) and gets
 *     no turn, while members still run as themselves.
 * And the shared app steps aside for an agent whose own bot is live, so two
 * bots never answer for one agent: a mention in one of that agent's channels
 * runs no turn, and an admitted sender is told which bot answers now
 * (`answersAsOwnBot`); a turn that was waiting when the bot went live is
 * dropped when its time comes. Not knowing whether it is live is no shared
 * turn either.
 *
 * The dispatch resolves once the turn is queued: a turn can outlast the
 * ingress's shutdown drain, and isn't awaited (decisions: running turns
 * aren't). It never rejects. Every failure is logged with the install, a
 * stage or reason and a code, never an email, a Slack id, a name or message
 * text; when someone admitted is waiting, they are told something went wrong.
 */

export interface RouterDeps extends TurnDeps {
  secrets: Pick<SecretStore, 'get'>;
  /**
   * Read again when a queued turn starts: Disconnect may have removed the
   * install meanwhile. On the shared app, also whether a channel's agent has
   * a live bot of its own (TASK-1167), when a mention arrives and again when
   * its turn starts. And the shared app's install when a team agent's own
   * bot binds a channel, for the memory switch the agent had there (TASK-1179).
   */
  installs: Pick<InstallStore, 'get' | 'botForAgent' | 'current'>;
  /** DM turns and members' channel turns: one lane per conversation. */
  queue: KeyedQueue;
  /**
   * Which agent each channel is connected to, read when a mention arrives and
   * again when its turn starts; the thread map the memory switch's veto
   * reads, written just before the turn's agent runs; and the binding a team
   * agent's own bot writes at its first mention in a channel (TASK-1167),
   * with the switch the team last set for the agent there, under the lock a
   * flip takes (`bindBot`, TASK-1182). And a binding removed when Slack says
   * its channel can't be served any more (`remove`, TASK-1184).
   */
  channels: Pick<ChannelStore, 'get' | 'recordThread' | 'bindBot' | 'remove'>;
  /** Outsiders' channel turns: one lane per channel. */
  externalQueue: KeyedQueue;
  /**
   * Slack's word that a connected channel is still public, live and not Slack
   * Connect, asked when each channel turn starts and kept for a minute
   * (channel-check.ts, TASK-1184).
   */
  channelCheck: ChannelCheck;
}

type Log = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, string | number>) => void;

/** An answer this router couldn't read. Carries a code, so it logs like any other failure. */
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

/** The agents in an `agents:list-for-user` answer that carry what picking one needs. */
function agentsOf(answer: unknown) {
  const raw = isRecord(answer) ? answer['agents'] : undefined;
  if (!Array.isArray(raw)) throw new UnreadableAnswer('agents:list-for-user');
  return raw.flatMap((a: unknown) => {
    if (!isRecord(a)) return [];
    const { id, ownerId, ownerType, visibility, createdAt } = a;
    if (typeof id !== 'string' || id.length === 0) return [];
    if (typeof ownerId !== 'string' || typeof ownerType !== 'string' || typeof visibility !== 'string') return [];
    return [{ id, ownerId, ownerType, visibility, createdAt: createdAt instanceof Date ? createdAt : new Date(Number.NaN) }];
  });
}

/**
 * The agent a DM from `userId` reaches: their oldest personal agent
 * (turn.ts `pickPersonalAgent`), or null when they have none. The agent
 * settings ask it too, so the two can't disagree.
 */
export async function personalAgentFor(bus: HookBus, ctx: AgentContext, userId: string): Promise<string | null> {
  const listed = await bus.call<{ userId: string; teamIds: string[] }, unknown>('agents:list-for-user', ctx, {
    userId,
    teamIds: [],
  });
  return pickPersonalAgent(agentsOf(listed), userId);
}

function conversationIdOf(answer: unknown): string {
  const conversation = isRecord(answer) ? answer['conversation'] : undefined;
  const id = isRecord(conversation) ? conversation['conversationId'] : undefined;
  if (typeof id !== 'string' || id.length === 0) throw new UnreadableAnswer('conversations:find-or-create');
  return id;
}

/** A ctx for the hook calls before a turn: no agent yet, and the mapped user once known. */
const lookupCtx = (userId: string): AgentContext =>
  makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId });

export function createEventRouter(d: RouterDeps): EventDispatcher {
  return async (install, envelope) => {
    try {
      await route(d, install, envelope);
    } catch (err) {
      try {
        d.logger.error('slack_event_failed', { installId: install.installId, stage: 'route', code: logCode(err) });
      } catch {
        // Nothing left to report it with.
      }
    }
  };
}

async function route(d: RouterDeps, install: InstallRow, envelope: SlackEnvelope): Promise<void> {
  const installId = install.installId;
  const log: Log = (level, msg, fields = {}) => {
    try {
      d.logger[level](msg, { installId, ...fields });
    } catch {
      // A log line never changes what the sender gets.
    }
  };

  const screened = screenEvent(install, envelope);
  if (screened.kind === 'ignore') {
    log('info', 'slack_event_ignored', { reason: screened.reason });
    return;
  }
  // A team agent's own bot answers mentions in channels, nothing else
  // (TASK-1167): its manifest asks for no DMs, and one its approver turns on
  // by hand on api.slack.com reaches nobody. Before any vault read or Slack call.
  if (screened.kind === 'dm' && install.kind !== 'shared') {
    log('info', 'slack_event_ignored', { reason: 'bot-dm' });
    return;
  }
  // The ingress only dispatches active installs, which always have a team.
  const teamId = install.teamId;
  if (teamId === null) {
    log('warn', 'slack_event_ignored', { reason: 'status' });
    return;
  }

  let botToken: string | null;
  try {
    botToken = await d.secrets.get(install, 'bot-token');
  } catch (err) {
    log('error', 'slack_event_failed', { stage: 'bot-token', code: logCode(err) });
    return;
  }
  if (botToken === null) {
    log('error', 'slack_bot_token_missing');
    return;
  }

  if (screened.kind === 'mention') {
    await routeMention(d, install, teamId, botToken, screened, log);
    return;
  }
  await routeDm(d, install, teamId, botToken, screened, log);
}

/** Log an admission refusal: a lookup that failed is a warning, a refusal is information. */
function logRefused(log: Log, a: Exclude<Admission, { ok: true }>): void {
  log(a.reason === 'lookup-failed' ? 'warn' : 'info', 'slack_sender_refused', {
    reason: a.reason,
    ...(a.code !== undefined ? { code: a.code } : {}),
  });
}

async function routeDm(
  d: RouterDeps,
  install: InstallRow,
  teamId: string,
  botToken: string,
  screened: DirectMessage,
  log: Log,
): Promise<void> {
  const installId = install.installId;
  const token = botToken;
  const say = async (text: string): Promise<void> => {
    try {
      await d.api.postMessage(token, { channel: screened.channel, threadTs: screened.threadTs, markdownText: text });
    } catch (err) {
      log('warn', 'slack_reply_failed', { stage: 'post', code: logCode(err) });
    }
  };
  const failed = async (stage: string, err: unknown): Promise<void> => {
    log('error', 'slack_event_failed', { stage, code: logCode(err) });
    await say(COPY.turnFailed);
  };

  const admission = await admitSender(d.api, botToken, screened.sender, teamId);
  if (!admission.ok) {
    logRefused(log, admission);
    // Slack was briefly unavailable, so this says nothing about the sender:
    // in a 1:1 DM only they see "try again". Refusals stay silent.
    if (isTemporaryLookupFailure(admission)) await say(COPY.turnFailed);
    return;
  }

  if (screened.fileShare) {
    await say(COPY.filesUnsupported);
    return;
  }
  if (screened.text.trim().length === 0) {
    log('info', 'slack_event_ignored', { reason: 'empty' });
    return;
  }

  let userId: string | null;
  try {
    // Logs `slack_sender_not_mapped` itself on every miss.
    userId = await findSenderUser(d.bus, lookupCtx(''), admission.email, { installId, logger: d.logger });
  } catch (err) {
    await failed('find-user', err);
    return;
  }
  if (userId === null) {
    await say(COPY.notMapped(d.publicOrigin));
    return;
  }

  const ctx = lookupCtx(userId);
  let agentId: string | null;
  try {
    agentId = await personalAgentFor(d.bus, ctx, userId);
  } catch (err) {
    await failed('agents', err);
    return;
  }
  if (agentId === null) {
    log('info', 'slack_no_personal_agent');
    await say(COPY.noAgent(d.publicOrigin));
    return;
  }

  let conversationId: string;
  try {
    const found = await d.bus.call<unknown, unknown>('conversations:find-or-create', ctx, {
      userId,
      agentId,
      externalKey: `slack:${installId}:${screened.channel}:${screened.threadTs}`,
      fallback: { origin: 'slack' },
    });
    conversationId = conversationIdOf(found);
  } catch (err) {
    await failed('conversation', err);
    return;
  }

  const mapped = userId;
  const chosen = agentId;
  const queued = d.queue.enqueue(conversationId, installId, async () => {
    // A turn can wait minutes behind another. If the admin disconnected the
    // install meanwhile (or a reset removed it), its agent must not run: the
    // workspace was let go, and the reply would have nowhere to go.
    let current: InstallRow | null;
    try {
      current = await d.installs.get(installId);
    } catch (err) {
      await failed('install', err);
      return;
    }
    if (current?.status !== 'active') {
      log('info', 'slack_turns_dropped', { reason: 'disconnected', count: 1 });
      return;
    }
    await runTurn(d, {
      mode: 'dm',
      label: dmSenderLabel(admission.name, screened.sender),
      install,
      botToken: token,
      channel: screened.channel,
      messageTs: screened.ts,
      threadTs: screened.threadTs,
      senderSlackId: screened.sender,
      userId: mapped,
      agentId: chosen,
      conversationId,
      text: screened.text,
    });
  });
  if (queued === 'full') {
    await say(COPY.queueFull);
  } else if (queued === 'closed') {
    log('warn', 'slack_event_failed', { stage: 'queue', code: 'shutting-down' });
    await say(COPY.turnFailed);
  }
}

/**
 * The text with every mention of this install's own bot user removed, in
 * either form Slack writes it (`<@U…>` or `<@U…|name>`). Other mentions stay.
 * The id comes from the install row, never from the text. An install with no
 * bot user id on record has nothing to strip.
 */
function withoutOwnMention(text: string, botUserId: string | null): string {
  if (botUserId === null || botUserId === '') return text;
  const id = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`<@${id}(?:\\|[^>]*)?>`, 'g'), '');
}

/** How the steps before a mention's turn speak to its sender. */
interface Say {
  /** A line only the sender sees, in the mention's thread when it was in one. */
  tell: (text: string) => Promise<void>;
  /** A step that failed: logged by stage and code, and the sender told to try again. */
  failed: (stage: string, err: unknown) => Promise<void>;
}

type Admitted = Extract<Admission, { ok: true }>;

/** What a mention's turn is planned from: the channel's binding, and its sender, admitted. */
interface Reached {
  binding: ChannelBinding;
  admission: Admitted;
}

async function routeMention(
  d: RouterDeps,
  install: InstallRow,
  teamId: string,
  botToken: string,
  m: Mention,
  log: Log,
): Promise<void> {
  const installId = install.installId;
  const say: Say = {
    tell: async (text) => {
      try {
        await d.api.postEphemeral(botToken, {
          channel: m.channel,
          user: m.sender,
          text,
          ...(m.threadTs !== undefined ? { threadTs: m.threadTs } : {}),
        });
      } catch (err) {
        log('warn', 'slack_reply_failed', { stage: 'ephemeral', code: logCode(err) });
      }
    },
    failed: async (stage, err) => {
      log('error', 'slack_event_failed', { stage, code: logCode(err) });
      await say.tell(COPY.turnFailed);
    },
  };
  const { tell, failed } = say;

  // 3–4. The channel's binding and the sender: the shared app's way, or a
  // team agent's own bot's (TASK-1167). Null: the mention ends there, with
  // whatever it needed said and logged.
  const reached =
    install.kind === 'shared'
      ? await reachShared(d, install, teamId, botToken, m, log, say)
      : await reachOwnBot(d, install, teamId, botToken, m, log, say);
  if (reached === null) return;
  const { binding, admission } = reached;
  const agentId = binding.agentId;
  const connectorId = binding.connectedByUserId;

  // 5. Who they are to the agent, from AX alone.
  let mapped: string | null;
  try {
    // Logs `slack_sender_not_mapped` itself on every miss.
    mapped = await findSenderUser(d.bus, lookupCtx(''), admission.email, { installId, logger: d.logger });
  } catch (err) {
    await failed('find-user', err);
    return;
  }
  let sender: SenderFacts;
  if (mapped !== null) {
    try {
      sender = { mappedUserId: mapped, access: await agentAccess(d.bus, lookupCtx(mapped), agentId, mapped), approved: null };
    } catch (err) {
      await failed('agent-access', err);
      return;
    }
  } else {
    try {
      // An AX account passed the domain rule at sign-in; without one, the email must.
      sender = { mappedUserId: null, access: null, approved: await isApprovedSender(d.bus, lookupCtx(''), admission.email) };
    } catch (err) {
      await failed('approved-email', err);
      return;
    }
  }
  let connectorAccess: AgentAccess | null = null;
  if (runsAsConnector(sender)) {
    // On the shared app the connector lends outsiders their identity while
    // they can use the agent. On a team agent's own bot the connector is its
    // requester, copied into the binding at the channel's first mention
    // (TASK-1167), and they lend it only while still a team admin of the
    // agent's team. Members never get here: they run as themselves.
    const access = install.kind === 'shared' ? agentAccess : teamAdminAccess;
    try {
      connectorAccess = await access(d.bus, lookupCtx(connectorId), agentId, connectorId);
    } catch (err) {
      await failed('connector-access', err);
      return;
    }
  }
  const tier = decideTier({ sender, connector: { userId: connectorId, access: connectorAccess } });
  if (tier.tier === 'refused') {
    log('info', 'slack_sender_refused', { reason: tier.reason });
    return;
  }
  if (tier.tier === 'unavailable') {
    log('warn', 'slack_channel_unavailable', { reason: tier.reason });
    // Nobody connected a bot's channel by hand: what needs a team admin is the bot itself.
    await tell(install.kind === 'shared' ? COPY.channelUnavailable : COPY.botUnavailable);
    return;
  }

  // 6. The thread's conversation for whoever the turn runs as.
  const external = tier.tier === 'external';
  const runAs = tier.userId;
  const threadTs = m.threadTs ?? m.ts;
  let conversationId: string;
  try {
    const found = await d.bus.call<unknown, unknown>('conversations:find-or-create', lookupCtx(runAs), {
      userId: runAs,
      agentId,
      externalKey: `slack:${installId}:${m.channel}:${threadTs}${external ? ':external' : ''}`,
      fallback: { origin: 'slack' },
    });
    conversationId = conversationIdOf(found);
  } catch (err) {
    await failed('conversation', err);
    return;
  }

  // 8. When its time comes, the turn is still wanted only if the channel is
  // still this agent's, on a live install, and (for an outsider) still
  // connected by the person it was planned to run as.
  const job = async (): Promise<void> => {
    /**
     * An outsider's turn whose channel someone else connected since it was
     * planned. Planned as the old connector, in their conversation: run as
     * anyone else, it would be a cross-user turn. Sent again, it runs as the
     * new one.
     */
    const droppedReconnected = async (): Promise<void> => {
      log('info', 'slack_turns_dropped', { reason: 'reconnected', count: 1 });
      await tell(COPY.turnFailed);
    };
    let current: InstallRow | null;
    try {
      current = await d.installs.get(installId);
    } catch (err) {
      await failed('install', err);
      return;
    }
    let now: ChannelBinding | null;
    try {
      now = await d.channels.get(installId, m.channel);
    } catch (err) {
      await failed('binding', err);
      return;
    }
    if (current?.status !== 'active' || now === null || now.agentId !== agentId) {
      log('info', 'slack_turns_dropped', { reason: 'disconnected', count: 1 });
      return;
    }
    // The agent's own bot went live while this shared turn waited
    // (TASK-1167): it answers for the agent now, so this turn never runs,
    // silently. Not knowing is no turn either, as at the mention.
    if (install.kind === 'shared') {
      let own: InstallRow | null;
      try {
        own = await d.installs.botForAgent(agentId);
      } catch (err) {
        await failed('own-bot', err);
        return;
      }
      if (own?.status === 'active') {
        log('info', 'slack_turns_dropped', { reason: 'own-bot', count: 1 });
        return;
      }
    }
    if (external && now.connectedByUserId !== runAs) {
      await droppedReconnected();
      return;
    }
    // On a team agent's own bot an outsider runs as its requester only while
    // they are a team admin of the agent's team (TASK-1167). Asked at the
    // mention, and again now: demoted while the turn waited, it never runs as
    // them. Not knowing is no turn either. Members run as themselves.
    if (external && install.kind !== 'shared') {
      let still: AgentAccess;
      try {
        still = await teamAdminAccess(d.bus, lookupCtx(runAs), agentId, runAs);
      } catch (err) {
        await failed('requester', err);
        return;
      }
      if (still !== 'yes') {
        log('info', 'slack_turns_dropped', { reason: 'requester', count: 1 });
        await tell(COPY.botUnavailable);
        return;
      }
    }
    // 8b. The channel itself, as Slack describes it now (TASK-1184). It was
    // checked when it was bound, and it may have been made private, archived
    // or shared with another company since: a mention doesn't say. Asked
    // last, so a turn the reads above drop costs no Slack call. A definitive
    // refusal disconnects the channel, as a team admin's Disconnect would (the
    // switch kept for the agent and channel stays), so the agent's settings
    // stop listing it and memory stops learning from its threads. Slack not
    // answering says nothing about the channel: no turn, and the binding stays.
    const channel = await d.channelCheck.check(installId, botToken, m.channel);
    if (channel.kind === 'unknown') {
      log('error', 'slack_event_failed', { stage: 'channel-check', code: channel.code });
      await tell(COPY.turnFailed);
      return;
    }
    if (channel.kind === 'refused') {
      let removed: boolean;
      try {
        removed = await d.channels.remove(installId, m.channel, agentId);
      } catch (err) {
        await failed('channel-remove', err);
        return;
      }
      if (removed) log('info', 'slack_channel_disconnected', { reason: 'channel-not-allowed', code: channel.code });
      log('info', 'slack_turns_dropped', { reason: 'channel-not-allowed', count: 1, code: channel.code });
      // Only the turn whose removal took the binding says so: once, however many were waiting.
      if (removed) await tell(COPY.channelNoLongerAllowed);
      return;
    }
    // 9. The memory switch, before anything is said in the conversation. The
    // store reads the switch in the same statement that records the thread,
    // so it is the switch as it is at that write: not as it was when the
    // mention arrived, nor when `now` was read above (an admin can turn it
    // off in between). Without this row the veto wouldn't know the
    // conversation is this channel's, and a pass could learn from a turn said
    // while the switch was off. No binding of this agent's at that write: the
    // channel was disconnected in the gap, so the turn is dropped like one
    // that found it disconnected above. For an outsider's turn the same
    // write checks the channel is still connected by the person it runs as:
    // a reconnect in the gap drops it like one found above.
    let recorded: 'recorded' | 'no-binding' | 'reconnected';
    try {
      recorded = await d.channels.recordThread({
        conversationId,
        installId,
        channelId: m.channel,
        agentId,
        // An outsiders' thread is never remembered, whatever the switch says
        // (capture-veto.ts), so it keeps no names. A member's keeps the names
        // their label shows, from the same `admission.name` and `m.sender` as
        // the label below: what memory must not file their words under.
        ...(external
          ? { mode: 'external' as const, runAs }
          : { mode: 'attended' as const, speakerNames: senderLabelNames(admission.name, m.sender) }),
      });
    } catch (err) {
      await failed('thread', err);
      return;
    }
    if (recorded === 'no-binding') {
      log('info', 'slack_turns_dropped', { reason: 'disconnected', count: 1 });
      return;
    }
    if (recorded === 'reconnected') {
      await droppedReconnected();
      return;
    }
    await runTurn(d, {
      mode: external ? 'external' : 'attended',
      label: channelSenderLabel(now.channelName || m.channel, admission.name, m.sender),
      install,
      botToken,
      channel: m.channel,
      messageTs: m.ts,
      threadTs,
      senderSlackId: m.sender,
      userId: runAs,
      agentId,
      conversationId,
      text: m.text,
    });
  };

  // 7. Queued: a member behind others in their conversation, an outsider in the channel's one lane.
  const queued = external
    ? d.externalQueue.enqueue(`${installId}:${m.channel}`, installId, job)
    : d.queue.enqueue(conversationId, installId, job);
  if (queued === 'full') {
    await tell(external ? COPY.channelBusy : COPY.queueFull);
  } else if (queued === 'closed') {
    log('warn', 'slack_event_failed', { stage: 'queue', code: 'shutting-down' });
    await tell(COPY.turnFailed);
  }
}

/**
 * Step 4, either way in: the sender, from users.info alone, per event and
 * never cached; then words, once the bot's own mention is gone. Null when the
 * mention ends here: a refusal is silence, a lookup that failed only because
 * Slack was briefly unavailable gets "try again" (the sender alone sees it),
 * and an empty mention is ignored.
 */
async function admitMention(
  d: RouterDeps,
  install: InstallRow,
  teamId: string,
  botToken: string,
  m: Mention,
  log: Log,
  say: Say,
): Promise<Admitted | null> {
  const admission = await admitSender(d.api, botToken, m.sender, teamId);
  if (!admission.ok) {
    logRefused(log, admission);
    // Says nothing about the sender: only they see "try again". Refusals stay silent.
    if (isTemporaryLookupFailure(admission)) await say.tell(COPY.turnFailed);
    return null;
  }
  // Slack's app_mention text always holds the bot's own `<@U…>`, so a bare
  // `@bot` is that token alone: words only once it is gone. The content sent
  // on is still the text as typed, the token included.
  if (withoutOwnMention(m.text, install.botUserId).trim().length === 0) {
    log('info', 'slack_event_ignored', { reason: 'empty' });
    return null;
  }
  return admission;
}

/**
 * The shared app's steps 3–4. The channel's binding, read before admission:
 * with no turn to come, answerMention admits the sender itself, so a line
 * goes to an admitted member only. Then nothing for an agent whose own bot is
 * live (TASK-1167). Then the sender.
 */
async function reachShared(
  d: RouterDeps,
  install: InstallRow,
  teamId: string,
  botToken: string,
  m: Mention,
  log: Log,
  say: Say,
): Promise<Reached | null> {
  // 3. The channel's binding.
  let binding: ChannelBinding | null;
  try {
    binding = await d.channels.get(install.installId, m.channel);
  } catch (err) {
    log('error', 'slack_event_failed', { stage: 'binding', code: logCode(err) });
    await answerAdmitted(d, botToken, teamId, m, COPY.turnFailed, log);
    return null;
  }
  if (binding === null) {
    await answerAdmitted(d, botToken, teamId, m, COPY.channelNotConnected, log);
    return null;
  }

  // The agent's own bot answers for it now: two bots never answer for one
  // agent, so the shared bot steps aside, and an admitted sender learns which
  // bot to mention instead. A pending bot changes nothing yet. Not knowing is
  // no turn: the shared bot can't tell whether it would be the second.
  let own: InstallRow | null;
  try {
    own = await d.installs.botForAgent(binding.agentId);
  } catch (err) {
    log('error', 'slack_event_failed', { stage: 'own-bot', code: logCode(err) });
    await answerAdmitted(d, botToken, teamId, m, COPY.turnFailed, log);
    return null;
  }
  if (own?.status === 'active') {
    log('info', 'slack_event_ignored', { reason: 'own-bot' });
    await answerAdmitted(d, botToken, teamId, m, COPY.answersAsOwnBot(own.botName, own.botHandle), log);
    return null;
  }

  // 4. The sender.
  const admission = await admitMention(d, install, teamId, botToken, m, log, say);
  return admission === null ? null : { binding, admission };
}

/**
 * A team agent's own bot's steps 3–4 (TASK-1167). The sender first: a
 * refused one costs no conversations.info and binds nothing, and a channel
 * with no binding is never "no agent here" (the bot serves its one agent
 * wherever it was invited). Then the channel's binding, or the one this
 * first mention there writes (bindBotChannel): a channel it refuses is
 * silence, Slack failing is "try again". A binding naming any agent but the
 * bot's runs nothing.
 */
async function reachOwnBot(
  d: RouterDeps,
  install: InstallRow,
  teamId: string,
  botToken: string,
  m: Mention,
  log: Log,
  say: Say,
): Promise<Reached | null> {
  // The database's CHECK gives every bot its agent and its requester. A row
  // without them answers nobody.
  const agentId = install.agentId;
  const requester = install.requestedByUserId;
  if (!isId(agentId) || !isId(requester)) {
    log('warn', 'slack_event_ignored', { reason: 'bot-row' });
    return null;
  }

  // 4. The sender.
  const admission = await admitMention(d, install, teamId, botToken, m, log, say);
  if (admission === null) return null;

  // 3. The channel's binding.
  let binding: ChannelBinding | null;
  try {
    binding = await d.channels.get(install.installId, m.channel);
  } catch (err) {
    await say.failed('binding', err);
    return null;
  }
  let bound = false;
  if (binding === null) {
    let outcome: BindOutcome;
    try {
      outcome = await bindBotChannel(d, { ...install, agentId, requestedByUserId: requester }, botToken, m.channel);
    } catch (err) {
      await say.failed('bind', err);
      return null;
    }
    if (!outcome.ok) {
      const code = outcome.code !== undefined ? { code: outcome.code } : {};
      if (outcome.reason === 'slack-error') {
        log('error', 'slack_event_failed', { stage: 'channel-info', ...code });
        await say.tell(COPY.turnFailed);
      } else {
        log('info', 'slack_event_ignored', { reason: 'channel-not-allowed', ...code });
      }
      return null;
    }
    binding = outcome.binding;
    bound = true;
  }
  if (binding.agentId !== agentId) {
    log('info', 'slack_event_ignored', { reason: 'binding-agent' });
    return null;
  }
  // A channel now runs the agent, its outsiders as the requester: worth a line.
  if (bound) log('info', 'slack_bot_channel_bound');
  return { binding, admission };
}

/** A non-empty id. */
function isId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `code` is Slack's own (or this file's `id-mismatch`), when there is one to
 * log. `slack-error` always has one.
 */
type BindOutcome =
  | { ok: true; binding: ChannelBinding }
  | { ok: false; reason: 'channel-not-allowed' | 'slack-error'; code?: string };

/**
 * A team agent's own bot binds a channel at its first mention there
 * (TASK-1167), with the checks the agent settings make before connecting
 * one for the shared app (channels.ts): Slack's own conversations.info, read
 * with the bot's token, must be about this channel and show one a connect
 * could take (`connectable`: public, live, not Slack Connect). The binding
 * is to the bot's one agent, connected by its requester, whom the channel's
 * outsiders run as (channel-store.ts); read back, so it is the one stored.
 * Its memory switch is the one the team last set for the agent in this
 * channel, so a channel the team chose not to have remembered stays that
 * way: the agent's live binding of it on the shared app (TASK-1179), else
 * the switch kept for the agent and channel, which outlives a Disconnect and
 * a rebuilt bot (TASK-1180), else on, as any new connection is. The store
 * reads it and writes the binding with it in one transaction, under the
 * lock a flip takes (channel-store.ts `bindBot`, TASK-1182), so no turn
 * ever reads it on, and a flip at the same moment lands either before the
 * read or on the binding written. The shared app's install is read first,
 * outside that transaction, so the transaction needs no second database
 * connection. A stale answer is harmless: with no shared binding the store
 * falls back to the kept switch, which every flip writes. The bot never
 * joins a channel: it is in this one because someone invited it. A store
 * failure throws; a failed read of the shared app's install, or of the
 * switch, throws before anything is written.
 */
async function bindBotChannel(
  d: RouterDeps,
  install: InstallRow & { agentId: string; requestedByUserId: string },
  botToken: string,
  channelId: string,
): Promise<BindOutcome> {
  let info: SlackChannel;
  try {
    info = await d.api.conversationsInfo(botToken, channelId);
  } catch (err) {
    if (err instanceof SlackApiError && CHANNEL_REFUSED_CODES.has(err.code)) {
      return { ok: false, reason: 'channel-not-allowed', code: err.code };
    }
    return { ok: false, reason: 'slack-error', code: logCode(err) };
  }
  // Every check reads this answer, so it must be about the channel the mention came from.
  if (info.id !== channelId) return { ok: false, reason: 'channel-not-allowed', code: 'id-mismatch' };
  if (!connectable(info)) return { ok: false, reason: 'channel-not-allowed' };

  // Read before bindBot's transaction, so that transaction never needs a second connection.
  const shared = await d.installs.current();
  const wrote = {
    installId: install.installId,
    channelId,
    agentId: install.agentId,
    connectedByUserId: install.requestedByUserId,
    channelName: info.name,
  };
  // `taken` can't happen here (only this writes a bot's bindings, always
  // for its agent); if it ever did, the read below finds the other agent's
  // binding, which the caller refuses.
  const remember = await d.channels.bindBot(wrote, shared?.installId ?? null);
  const stored = await d.channels.get(install.installId, channelId);
  // Gone again already (the bot removed meanwhile): what was written. The
  // turn's own re-read then finds the install gone and drops it.
  return {
    ok: true,
    binding: stored ?? { ...wrote, remember, channelName: cleanChannelName(info.name), createdAt: new Date() },
  };
}

/**
 * `text` for an admitted sender only (answerMention admits them first);
 * silence for anyone else. A refusal is logged, and so is a failed post.
 */
async function answerAdmitted(
  d: RouterDeps,
  botToken: string,
  teamId: string,
  m: Mention,
  text: string,
  log: Log,
): Promise<void> {
  let admission: Admission;
  try {
    admission = await answerMention(d.api, botToken, teamId, m, text);
  } catch (err) {
    log('warn', 'slack_reply_failed', { stage: 'ephemeral', code: logCode(err) });
    return;
  }
  if (!admission.ok) logRefused(log, admission);
}
