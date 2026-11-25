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
import { channelInfoFailure, type ChannelCheck } from './channel-check.js';
import { decideTier, runsAsConnector, type SenderFacts } from './channel-route.js';
import type { ChannelBinding, ChannelStore } from './channel-store.js';
import { agentAccess, connectable, managerAccess, type AgentAccess } from './channels.js';
import { COPY } from './copy.js';
import type { DmAgentStore } from './dm-agents.js';
import type { EventDispatcher, SlackEnvelope } from './events.js';
import { channelSenderLabel, cleanSenderName, dmSenderLabel, mentionedUserIds, senderLabelNames } from './format.js';
import { cleanChannelName } from './label.js';
import { logCode } from './log-code.js';
import { postMemoryNotice } from './memory-notice.js';
import type { MentionNames } from './mention-names.js';
import type { SecretStore } from './secrets.js';
import type { SlackChannel } from './slack-api.js';
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
 * Who answers what (TASK-1186; design §4b.1): the shared app answers DMs,
 * and a team agent's own bot (TASK-1167) answers mentions in the channels
 * it was invited to. A team agent is reached in a channel only through its
 * own bot. A team agent's own bot is any install whose kind isn't exactly
 * `shared` (store.ts reads anything else as a bot, the kind that can do less).
 *   - A mention of the shared bot in a channel runs no turn. It reads no
 *     binding, so a row left from before is never used, and asks nothing
 *     about an agent or the channel: an admitted sender is told privately
 *     how to reach an agent instead (`sharedBotInChannel`, answerAdmitted),
 *     anyone else gets silence, and it is logged as `slack_event_ignored`
 *     (`shared-channel`).
 *   - A DM to a team agent's own bot gets nothing, before any vault read or
 *     Slack call: its manifest asks for none, and one its approver turns on
 *     by hand reaches nobody.
 *
 * A DM to the shared app (routeDm):
 *   3. The sender is admitted from users.info, never from the text. A
 *      refused sender gets silence; a users.info call that failed only
 *      because Slack was briefly unavailable gets "try again".
 *   4. A shared file gets "I can't read files yet"; an empty message nothing.
 *   5. auth:find-user-by-email with users.info's email → the sender's
 *      personal agent (`personalAgentFor`): the one they chose for their DMs
 *      (TASK-1238, dm-agents.ts) while agents:list-for-user still lists it as
 *      their own personal agent, else their oldest. A choice that can't be
 *      read is "try again", never the oldest instead →
 *      conversations:find-or-create for the thread
 *      (`slack:<installId>:<channel>:<thread_ts>`, origin `'slack'`). The
 *      agent is picked here, before the turn is queued, so a new choice
 *      applies from the next message on: a turn already running or waiting
 *      keeps the agent it was routed to.
 *   6. The turn is queued behind any other in its conversation; the fourth
 *      waiting gets "send it again after I reply".
 *   7. When the turn's time comes, the install is read again: one that was
 *      disconnected (or reset) while the turn waited is dropped, logged as
 *      `slack_turns_dropped`, and its agent never runs.
 *
 * A mention of a team agent's own bot (routeMention; TASK-1094, TASK-1167):
 *   3. The sender is admitted from users.info, as for a DM ("try again" goes
 *      to them alone, as an ephemeral). A refused sender costs no other Slack
 *      call and binds nothing. An empty mention is ignored.
 *   4. The channel's binding. A missing one is never "no agent here": the bot
 *      serves its one agent wherever it was invited. It is written at the
 *      first mention in a channel, once Slack's own conversations.info, read
 *      with the bot's token and about this channel, shows one a bot may bind
 *      (channels.ts `connectable`): to the bot's one agent, connected by its
 *      requester (a Claim moves it). A channel refused there is silence;
 *      Slack failing is "try again"; Slack saying the bot's token can't read
 *      any public channel (the turn-start check's reading, channel-check.ts
 *      `channelInfoFailure`) is `botUnavailable`; a binding naming any other
 *      agent runs nothing.
 *   5. Who they are to the agent, from AX alone: their account
 *      (auth:find-user-by-email) and its access to the agent
 *      (agents:resolve), or, with no account, whether their email is on an
 *      approved domain (auth:is-approved-email); then, only for a turn that
 *      would run as the bot's requester, whether the requester still manages
 *      the agent (channels.ts `managerAccess`: a team admin of a team agent's
 *      team, an owner of a shared personal agent, TASK-1248). channel-route.ts
 *      decides the tier: attended as the sender, external as the requester,
 *      silence (off-domain), or a private "a team admin needs to check my
 *      settings" (`botUnavailable`) when the agent is gone, or when the
 *      requester can't vouch for outsiders any more: members still run as
 *      themselves.
 *   6. conversations:find-or-create for the thread, one per identity: the
 *      sender's own (`slack:<installId>:<channel>:<thread_ts>`) or the
 *      requester's (`…:external`), so an outsider's words never enter a
 *      member's conversation, and a conversation is never run as anyone but
 *      its owner.
 *   7. Queued: a member's turn behind others in their conversation (the
 *      fourth is told to send it again), an outsider's in one lane for the
 *      whole channel (MAX_EXTERNAL_TURNS_PER_CHANNEL; one more is told the
 *      channel is busy).
 *   8. When the turn's time comes, the install AND the binding are read
 *      again: an install or binding that went away, or a channel now bound
 *      to another agent, drops the turn (`slack_turns_dropped`,
 *      `disconnected`); an outsider's turn whose bot someone else claimed
 *      meanwhile is dropped too (`reconnected`), and its sender told to try
 *      again: it was planned as the old requester, in their conversation, and
 *      must not run as anyone else. An outsider's turn runs as the requester
 *      only while they still manage the agent (`managerAccess`), so it is
 *      asked again here: not any more drops the turn (`requester`) with the
 *      polite `botUnavailable` line, and a failed read drops it too
 *      (`slack_event_failed`, stage `requester`), its sender told to try
 *      again. Last, Slack itself is asked about the channel, with the bot's
 *      token (channel-check.ts, which keeps an answer that allows it for a
 *      minute), since a channel can change after it is bound (TASK-1184). A
 *      channel it now says is archived or Slack Connect, or can't find, or
 *      (to a bot Allowed before `groups:read`) can't read, loses its binding.
 *      The one turn whose removal took it tells its sender, privately and
 *      once (`channelNoLongerAllowed`); every turn it stops is dropped
 *      (`slack_turns_dropped`, `channel-not-allowed`). A private channel
 *      runs its turn like any other, and is remembered like any other
 *      (TASK-1203, design §4c): nothing here reads its privacy. Slack not
 *      answering is no turn either: "try again", and the binding stays. Nor
 *      is Slack saying the bot's own token can't read any public channel
 *      (code `token-scope`): the binding stays, and since no retry fixes
 *      that, its sender is told a team admin must look (`botUnavailable`),
 *      never to try again. A Slack Connect channel seldom gets this far: step
 *      1 drops its events, so only a turn that was waiting when it was
 *      shared, or one while its share is still pending, finds it.
 *   9. Before the agent runs, the conversation is recorded as one of the
 *      channel's threads (channel-store.ts `recordThread`), which the capture
 *      veto reads (capture-veto.ts). A new thread is recorded remembered; one
 *      marked before TASK-1203 (a turn while its channel was private, or
 *      switched off) stays marked. An outsider's turn records its
 *      conversation as outsiders', which memory never learns from, and only
 *      while the binding still names the person it runs as: a Claim since
 *      step 8 drops it as there. A member's turn also records the names its
 *      sender label shows (format.ts `senderLabelNames`), which the veto
 *      hands to memory so it can tell the member in what it learns: what
 *      they say about themself is filed under their own AX key, never under
 *      their name (TASK-1146, TASK-1204); an outsider's records none. If the record can't be
 *      written the turn doesn't run, and the sender is told privately to try
 *      again. A DM records nothing: it is no channel's thread.
 *  9b. The channel's memory notice (memory-notice.ts, TASK-1203; design
 *      §4c): the first turn in a channel since it was bound (or since the
 *      notice existed, for a binding made before it) tells everyone there,
 *      in a top-level post, that what the bot hears is shared with anyone
 *      who talks to it.
 *      One turn claims it, on whichever replica (channel-store.ts
 *      `claimNotice`), and only that one posts; one Slack refuses is given
 *      back, so the next turn tries again, except in an announcement-only
 *      channel, where it goes in the mention's thread instead. Whatever becomes of it, the turn
 *      runs: it never throws, and logs no `slack_event_failed`.
 *  10. The thread is read back. One memory won't learn from (outsiders', or
 *      marked before TASK-1203) gets a fixed line before its label, so the
 *      agent doesn't promise to remember it (turn-note.ts
 *      `SLACK_NOT_REMEMBERED_LINE`, TASK-1191).
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
   * Which agent each of a bot's channels is bound to, read when a mention
   * arrives and again when its turn starts; the thread map the capture veto
   * reads, written just before the turn's agent runs; and the binding a team
   * agent's own bot writes at its first mention in a channel (`upsert`,
   * TASK-1167). And a binding removed when Slack says its channel can't be
   * served any more (`remove`, TASK-1184). The thread as recorded, read back
   * so a turn's agent is told when memory won't learn from it (`getThread`,
   * TASK-1191). The binding's memory notice, claimed before it is posted and
   * given back when Slack refuses it (`claimNotice`, `releaseNotice`,
   * TASK-1203). The shared app reads and writes none (TASK-1186).
   */
  channels: Pick<ChannelStore, 'get' | 'recordThread' | 'getThread' | 'upsert' | 'remove' | 'claimNotice' | 'releaseNotice'>;
  /**
   * Which personal agent each person chose for their DMs (TASK-1238,
   * dm-agents.ts): read once per DM, and never trusted as stored
   * (`personalAgentFor`). The router never writes it.
   */
  dmAgents: Pick<DmAgentStore, 'get'>;
  /** Outsiders' channel turns: one lane per channel. */
  externalQueue: KeyedQueue;
  /**
   * Slack's word that a bound channel is still live and not Slack Connect,
   * asked when each channel turn starts and kept for a minute
   * (channel-check.ts, TASK-1184). A private channel is answered in like any
   * other (TASK-1188), and remembered like any other (TASK-1203).
   */
  channelCheck: ChannelCheck;
  /**
   * Names for the people a message mentions, so the agent reads `@moss`, not
   * `<@U…>` (mention-names.ts, TASK-1190): asked when each turn starts, with
   * the install's bot token, a few calls a message, kept for minutes.
   */
  mentionNames: MentionNames;
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

/**
 * The agents in an `agents:list-for-user` answer that carry what picking one
 * needs, each with its display name ('' when it has none) for the settings
 * to name it by.
 */
function agentsOf(answer: unknown) {
  const raw = isRecord(answer) ? answer['agents'] : undefined;
  if (!Array.isArray(raw)) throw new UnreadableAnswer('agents:list-for-user');
  return raw.flatMap((a: unknown) => {
    if (!isRecord(a)) return [];
    const { id, ownerId, ownerType, visibility, createdAt, displayName } = a;
    if (typeof id !== 'string' || id.length === 0) return [];
    if (typeof ownerId !== 'string' || typeof ownerType !== 'string' || typeof visibility !== 'string') return [];
    return [
      {
        id,
        ownerId,
        ownerType,
        visibility,
        createdAt: createdAt instanceof Date ? createdAt : new Date(Number.NaN),
        displayName: typeof displayName === 'string' ? displayName : '',
      },
    ];
  });
}

/**
 * The personal agents `agents:list-for-user` returns for `userId`, and no
 * team's (`teamIds` empty). Since TASK-1246 that list also holds personal
 * agents only SHARED with them (another person's, as owner or audience); every
 * caller narrows it with turn.ts `pickPersonalAgent`, which keeps only
 * `ownerId === userId`, so a DM never reaches an agent that is merely shared.
 */
async function ownAgents(bus: HookBus, ctx: AgentContext, userId: string) {
  const listed = await bus.call<{ userId: string; teamIds: string[] }, unknown>('agents:list-for-user', ctx, {
    userId,
    teamIds: [],
  });
  return agentsOf(listed);
}

/** The personal agent a DM reaches. */
export interface DmAgent {
  id: string;
  /** displayName as agents lists it; '' when it had none. Owner-authored. */
  name: string;
}

/**
 * The agent a DM from `userId` reaches (turn.ts `pickPersonalAgent`): the
 * personal agent they chose for their DMs (TASK-1238, dm-agents.ts) while
 * AX still lists it as their own personal agent; else their oldest; null
 * when they have none. A stored choice is never trusted as stored: one
 * naming an agent that was deleted, or isn't theirs, or isn't personal, is
 * passed over for the oldest. The choice is read before the list, so a
 * delete between the two is still caught by the list.
 *
 * Either read failing throws, and nothing falls back: a DM sent to the
 * oldest because the choice couldn't be read would put the person's words
 * into the agent they moved away from. The agent settings ask this too
 * (agent-routes.ts), so the two can't disagree.
 */
export async function personalAgentFor(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  choices: Pick<DmAgentStore, 'get'>,
): Promise<DmAgent | null> {
  const chosen = await choices.get(userId);
  const listed = await ownAgents(bus, ctx, userId);
  const id = pickPersonalAgent(listed, userId, chosen);
  if (id === null) return null;
  return { id, name: listed.find((a) => a.id === id)?.displayName ?? '' };
}

/**
 * Whether `agentId` is `userId`'s own personal agent, by the list and the
 * rule `personalAgentFor` reads a choice with: so a choice the settings
 * write (agent-routes.ts) is one the next DM honors.
 */
export async function isOwnPersonalAgent(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  agentId: string,
): Promise<boolean> {
  return pickPersonalAgent(await ownAgents(bus, ctx, userId), userId, agentId) === agentId;
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
    // The one they chose, while it is still their own personal agent, else their oldest (TASK-1238).
    agentId = (await personalAgentFor(d.bus, ctx, userId, d.dmAgents))?.id ?? null;
  } catch (err) {
    // Their agents or their choice couldn't be read: "try again", and never the oldest instead.
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
    // The shared app is the agent's voice here, so its own user is "(you)" too.
    const known = new Map([[screened.sender, admission.name]]);
    if (install.botUserId !== null && install.botUserId !== '') known.set(install.botUserId, ownMentionName(install));
    const names = await mentionNamesFor(d, installId, botToken, teamId, screened.text, known, log);
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
      // A DM is no channel's thread: memory learns from it (capture-veto.ts has no opinion).
      remembered: true,
      text: screened.text,
      names,
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

/**
 * What the bot's own user reads as in its agent's text (TASK-1190): the
 * @handle people type, else its name, cleaned like any Slack name, then
 * "(you)". Just "you" when neither has anything printable.
 */
function ownMentionName(install: InstallRow): string {
  const name = cleanSenderName(install.botHandle ?? install.botName);
  return name === '' ? 'you' : `${name} (you)`;
}

/**
 * The names for the `<@U…>`s in `text` (mention-names.ts): `known` costs no
 * call. Lookups that failed, and ids left unasked (past the per-message
 * limit, or while Slack rate-limits us), are logged by count and code, never
 * by id or name, and their mentions read `@someone`.
 */
async function mentionNamesFor(
  d: RouterDeps,
  installId: string,
  botToken: string,
  teamId: string,
  text: string,
  known: ReadonlyMap<string, string>,
  log: Log,
): Promise<ReadonlyMap<string, string>> {
  const ids = mentionedUserIds(text);
  if (ids.length === 0) return new Map();
  const found = await d.mentionNames.lookup({ installId, botToken, teamId, ids, known });
  if (found.failed > 0 || found.capped > 0 || found.paused > 0) {
    log(found.failed > 0 ? 'warn' : 'info', 'slack_mention_names_missed', {
      failed: found.failed,
      capped: found.capped,
      paused: found.paused,
      ...(found.code !== undefined ? { code: found.code } : {}),
    });
  }
  return found.names;
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
  // The shared app answers in no channel (TASK-1186; design §4b.1): a team
  // agent is reached there only through its own bot. Before any binding read,
  // so a binding the shared app still has (one the boot hasn't deleted yet,
  // or an older replica wrote after it did) never runs a turn, and nothing is
  // asked about an agent or the channel. An admitted sender learns where to
  // go instead; anyone else gets silence.
  if (install.kind === 'shared') {
    log('info', 'slack_event_ignored', { reason: 'shared-channel' });
    await answerAdmitted(d, botToken, teamId, m, COPY.sharedBotInChannel, log);
    return;
  }
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

  // 3–4. The sender, then the channel's binding (TASK-1167). Null: the
  // mention ends there, with whatever it needed said and logged.
  const reached = await reachOwnBot(d, install, teamId, botToken, m, log, say);
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
    // The connector is the bot's requester, copied into the binding at the
    // channel's first mention (TASK-1167; a Claim moves it), and they lend
    // outsiders their identity only while they still manage the agent: a
    // team admin of a team agent's team, an owner of a shared personal agent
    // (TASK-1248). Members never get here: they run as themselves.
    try {
      connectorAccess = await managerAccess(d.bus, lookupCtx(connectorId), agentId, connectorId);
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
    await tell(COPY.botUnavailable);
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
  // still this agent's, on a live install, and (for an outsider) its binding
  // still names the person it was planned to run as for the bot's requester.
  const job = async (): Promise<void> => {
    /**
     * An outsider's turn whose bot someone else claimed since it was planned
     * (a Claim moves the requester in every binding). Planned as the old
     * requester, in their conversation: run as anyone else, it would be a
     * cross-user turn. Sent again, it runs as the new one.
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
    if (external && now.connectedByUserId !== runAs) {
      await droppedReconnected();
      return;
    }
    // An outsider runs as the bot's requester only while they still manage
    // the agent (TASK-1167, TASK-1248). Asked at the mention, and again now:
    // demoted while the turn waited, it never runs as them. Not knowing is
    // no turn either. Members run as themselves.
    if (external) {
      let still: AgentAccess;
      try {
        still = await managerAccess(d.bus, lookupCtx(runAs), agentId, runAs);
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
    // checked when it was bound, and it may have been archived or shared
    // with another company since: a mention doesn't say, though step 1 drops
    // one Slack flags as Slack Connect. Asked last, so a turn the reads above
    // drop costs no Slack call. A definitive refusal removes the channel's
    // binding, so the agent's settings stop listing it and memory stops
    // learning from its threads. Slack not answering says nothing about the
    // channel: no turn, and the binding stays. A channel made private (or
    // public again) is answered in (TASK-1188) and remembered (TASK-1203,
    // design §4c) like any other: nothing below reads its privacy.
    const channelNow = await d.channelCheck.check(installId, botToken, m.channel);
    // Only `allowed` goes on to the turn; every other kind returns, and a kind
    // added later fails to compile (the `never` below) rather than run a turn.
    if (channelNow.kind !== 'allowed') {
      switch (channelNow.kind) {
        case 'token-scope': {
          // The bot's own token can't read any public channel (its app lost
          // channels:read): nothing about this channel, so the binding stays. No
          // retry fixes it, so no "try again": a team admin must look, as for a
          // requester who can't vouch for outsiders (tier `unavailable`, step 5).
          log('error', 'slack_event_failed', { stage: 'channel-check', code: 'token-scope' });
          await tell(COPY.botUnavailable);
          return;
        }
        case 'unknown': {
          log('error', 'slack_event_failed', { stage: 'channel-check', code: channelNow.code });
          await tell(COPY.turnFailed);
          return;
        }
        case 'refused': {
          let removed: boolean;
          try {
            removed = await d.channels.remove(installId, m.channel, agentId);
          } catch (err) {
            await failed('channel-remove', err);
            return;
          }
          if (removed) log('info', 'slack_channel_disconnected', { reason: 'channel-not-allowed', code: channelNow.code });
          log('info', 'slack_turns_dropped', { reason: 'channel-not-allowed', count: 1, code: channelNow.code });
          // Only the turn whose removal took the binding says so: once, however many were waiting.
          if (removed) await tell(COPY.channelNoLongerAllowed);
          return;
        }
        default: {
          const unhandled: never = channelNow;
          void unhandled;
          return;
        }
      }
    }
    // 9. The thread's record, before anything is said in the conversation.
    // The store reads the binding in the same statement that records the
    // thread. Without this row the veto wouldn't know the conversation is
    // this channel's: a pass could learn from an outsider's turn, or file a
    // member's words under her own name (TASK-1146). A new thread is
    // recorded remembered, public channel or private (TASK-1203); one
    // marked before keeps its mark. No binding of this agent's at that
    // write: the channel was disconnected in the gap, so the turn is dropped
    // like one that found it disconnected above. For an outsider's turn the
    // same write checks the binding still names the person it runs as: a
    // Claim in the gap drops it like one found above.
    let recorded: 'recorded' | 'no-binding' | 'reconnected';
    try {
      recorded = await d.channels.recordThread({
        conversationId,
        installId,
        channelId: m.channel,
        agentId,
        // An outsiders' thread is never remembered (capture-veto.ts), so it
        // keeps no names. A member's keeps the names their label shows, from
        // the same `admission.name` and `m.sender` as the label below: how
        // memory tells them in what it learns, to file their words about
        // themself under their own AX key rather than their name.
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
    // 9b. The channel's memory notice (TASK-1203, design §4c), at its first
    // turn: after the record, so a turn dropped above tells nobody; before
    // the agent runs, so the channel reads it before the reply. It never
    // throws: the turn goes on whatever becomes of the notice.
    // An announcement-only channel's goes in this turn's thread, where the reply goes.
    await postMemoryNotice(d, { installId, channelId: m.channel, threadTs, agentId, botToken }, log);
    // 10. Whether memory will learn from this thread, read back from the row
    // just written, with the flags capture-veto.ts reads first: so the agent
    // is told when it won't (TASK-1191), rather than promise to remember: an
    // outsiders' thread, or one marked before TASK-1203. A thread that can't
    // be read is told it isn't remembered: the harmless side, and no reason
    // to drop the turn. As the record says at this write: memory reads the
    // binding again when it runs, so a channel disconnected after this still
    // keeps it out, untold. A woken turn after an Allow has no message of
    // ours to carry the line (answers.ts).
    let remembered = false;
    try {
      const thread = await d.channels.getThread(conversationId);
      remembered = thread !== null && thread.notRemembered === false && thread.external === false;
    } catch (err) {
      // Its own name: every `slack_event_failed` means the event's work stopped, and this turn still runs.
      log('warn', 'slack_thread_read_failed', { code: logCode(err) });
    }
    // Who the message names, the bot itself included: its own user reads as
    // `@[<handle> (you)]`, so an agent knows when it was the one named. A
    // looked-up name is cleaned (cleanSenderName: no Unicode brackets or
    // parentheses), so it can't leave its `@[…]` or spell "(you)" with them.
    const known = new Map([[m.sender, admission.name]]);
    if (install.botUserId !== null && install.botUserId !== '') {
      known.set(install.botUserId, ownMentionName(install));
    }
    const names = await mentionNamesFor(d, installId, botToken, teamId, m.text, known, log);
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
      remembered,
      text: m.text,
      names,
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
 * Step 3: the sender, from users.info alone, per event and never cached;
 * then words, once the bot's own mention is gone. Null when the mention ends
 * here: a refusal is silence, a lookup that failed only because Slack was
 * briefly unavailable gets "try again" (the sender alone sees it), and an
 * empty mention is ignored.
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
  // on keeps it, read as the bot's own name and "(you)" (TASK-1190).
  if (withoutOwnMention(m.text, install.botUserId).trim().length === 0) {
    log('info', 'slack_event_ignored', { reason: 'empty' });
    return null;
  }
  return admission;
}

/**
 * A team agent's own bot's steps 3–4 (TASK-1167). The sender first: a
 * refused one costs no conversations.info and binds nothing, and a channel
 * with no binding is never "no agent here" (the bot serves its one agent
 * wherever it was invited). Then the channel's binding, or the one this
 * first mention there writes (bindBotChannel): a channel it refuses is
 * silence, Slack failing is "try again", and a token that can't read any
 * public channel is `botUnavailable`, since no retry fixes it. A binding
 * naming any agent but the bot's runs nothing.
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

  // 3. The sender.
  const admission = await admitMention(d, install, teamId, botToken, m, log, say);
  if (admission === null) return null;

  // 4. The channel's binding.
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
      if (outcome.reason === 'token-scope') {
        // As at the turn-start check (step 8): no retry fixes the bot's token, a team admin must.
        log('error', 'slack_event_failed', { stage: 'channel-info', code: 'token-scope' });
        await say.tell(COPY.botUnavailable);
      } else if (outcome.reason === 'slack-error') {
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
 * log. `slack-error` always has one. `token-scope` (never a code): the bot's
 * own token can't read any public channel (channel-check.ts
 * `channelInfoFailure`).
 */
type BindOutcome =
  | { ok: true; binding: ChannelBinding }
  | { ok: false; reason: 'channel-not-allowed' | 'slack-error' | 'token-scope'; code?: string };

/**
 * A team agent's own bot binds a channel at its first mention there
 * (TASK-1167): Slack's own conversations.info, read with the bot's token,
 * must be about this channel and show one a bot may bind (channels.ts
 * `connectable`: live, not Slack Connect; public or private, TASK-1188, and
 * remembered either way, TASK-1203). The binding is to the bot's one agent,
 * connected by its requester, whom the channel's outsiders run as
 * (channel-store.ts), written in one statement (`upsert`); read back, so it
 * is the one stored. The bot never joins a channel: it is in this one
 * because someone invited it. A store failure throws.
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
    // The turn-start check's own reading (channel-check.ts), so this bind and
    // every later turn agree: a token that can't read public channels at all
    // is no refusal of this channel.
    const failure = channelInfoFailure(err);
    if (failure.kind === 'refused') return { ok: false, reason: 'channel-not-allowed', code: failure.code };
    if (failure.kind === 'token-scope') return { ok: false, reason: 'token-scope' };
    return { ok: false, reason: 'slack-error', code: failure.code };
  }
  // Every check reads this answer, so it must be about the channel the mention came from.
  if (info.id !== channelId) return { ok: false, reason: 'channel-not-allowed', code: 'id-mismatch' };
  if (!connectable(info)) return { ok: false, reason: 'channel-not-allowed' };

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
  await d.channels.upsert(wrote);
  const stored = await d.channels.get(install.installId, channelId);
  // Gone again already (the bot removed meanwhile): what was written. The
  // turn's own re-read then finds the install gone and drops it.
  return {
    ok: true,
    binding: stored ?? { ...wrote, channelName: cleanChannelName(info.name), createdAt: new Date() },
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
