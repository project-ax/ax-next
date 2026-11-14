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
import { decideTier, runsAsConnector, type SenderFacts } from './channel-route.js';
import type { ChannelBinding, ChannelStore } from './channel-store.js';
import { agentAccess, type AgentAccess } from './channels.js';
import { COPY } from './copy.js';
import type { EventDispatcher, SlackEnvelope } from './events.js';
import { channelSenderLabel, dmSenderLabel } from './format.js';
import { logCode } from './log-code.js';
import type { SecretStore } from './secrets.js';
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
 *      `disconnected`); an outsider's turn whose channel was reconnected by
 *      someone else meanwhile is dropped too (`reconnected`), and its sender
 *      told to try again: it was planned as the old connector, in their
 *      conversation, and must not run as anyone else.
 *   9. Before the agent runs, the conversation is recorded as one of the
 *      channel's threads, with the channel's memory switch as it is NOW
 *      (channel-store.ts `recordThread`): a turn that starts while the switch
 *      is off keeps that thread out of memory for good (capture-veto.ts). If
 *      the record can't be written the turn doesn't run, and the sender is
 *      told privately to try again. A DM records nothing: the switch is a
 *      channel's.
 *   Lines before the turn are ephemeral, for the sender alone (in the
 *   mention's thread when it was in one); the reply goes in the thread.
 *
 * The dispatch resolves once the turn is queued: a turn can outlast the
 * ingress's shutdown drain, and isn't awaited (decisions: running turns
 * aren't). It never rejects. Every failure is logged with the install, a
 * stage or reason and a code, never an email, a Slack id, a name or message
 * text; when someone admitted is waiting, they are told something went wrong.
 */

export interface RouterDeps extends TurnDeps {
  secrets: Pick<SecretStore, 'get'>;
  /** Read again when a queued turn starts: Disconnect may have removed the install meanwhile. */
  installs: Pick<InstallStore, 'get'>;
  /** DM turns and members' channel turns: one lane per conversation. */
  queue: KeyedQueue;
  /**
   * Which agent each channel is connected to, read when a mention arrives and
   * again when its turn starts; and the thread map the memory switch's veto
   * reads, written just before the turn's agent runs.
   */
  channels: Pick<ChannelStore, 'get' | 'recordThread'>;
  /** Outsiders' channel turns: one lane per channel. */
  externalQueue: KeyedQueue;
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

async function routeMention(
  d: RouterDeps,
  install: InstallRow,
  teamId: string,
  botToken: string,
  m: Mention,
  log: Log,
): Promise<void> {
  const installId = install.installId;
  /** A line only the sender sees, in the mention's thread when it was in one. */
  const tell = async (text: string): Promise<void> => {
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
  };
  const failed = async (stage: string, err: unknown): Promise<void> => {
    log('error', 'slack_event_failed', { stage, code: logCode(err) });
    await tell(COPY.turnFailed);
  };

  // 3. The channel's binding. Read before admission: with no turn to come,
  // answerMention admits the sender itself, so a line goes to an admitted
  // member only.
  let binding: ChannelBinding | null;
  try {
    binding = await d.channels.get(installId, m.channel);
  } catch (err) {
    log('error', 'slack_event_failed', { stage: 'binding', code: logCode(err) });
    await answerAdmitted(d, botToken, teamId, m, COPY.turnFailed, log);
    return;
  }
  if (binding === null) {
    await answerAdmitted(d, botToken, teamId, m, COPY.channelNotConnected, log);
    return;
  }
  const agentId = binding.agentId;
  const connectorId = binding.connectedByUserId;

  // 4. The sender, from users.info alone, per event and never cached.
  const admission = await admitSender(d.api, botToken, m.sender, teamId);
  if (!admission.ok) {
    logRefused(log, admission);
    // Says nothing about the sender: only they see "try again". Refusals stay silent.
    if (isTemporaryLookupFailure(admission)) await tell(COPY.turnFailed);
    return;
  }
  // Slack's app_mention text always holds the bot's own `<@U…>`, so a bare
  // `@bot` is that token alone: words only once it is gone. The content sent
  // on is still the text as typed, the token included.
  if (withoutOwnMention(m.text, install.botUserId).trim().length === 0) {
    log('info', 'slack_event_ignored', { reason: 'empty' });
    return;
  }

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
    try {
      connectorAccess = await agentAccess(d.bus, lookupCtx(connectorId), agentId, connectorId);
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
    await tell(COPY.channelUnavailable);
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
    if (external && now.connectedByUserId !== runAs) {
      // Planned as the old connector, in their conversation: run as anyone
      // else, it would be a cross-user turn. Sent again, it runs as the new one.
      log('info', 'slack_turns_dropped', { reason: 'reconnected', count: 1 });
      await tell(COPY.turnFailed);
      return;
    }
    // 9. The memory switch, before anything is said in the conversation: the
    // switch as it is now, not as it was when the mention arrived. Without
    // this row the veto wouldn't know the conversation is this channel's, and
    // a pass could learn from a turn said while the switch was off.
    try {
      await d.channels.recordThread({
        conversationId,
        installId,
        channelId: m.channel,
        agentId,
        notRemembered: now.remember !== true,
      });
    } catch (err) {
      await failed('thread', err);
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
