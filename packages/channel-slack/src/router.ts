import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import {
  admitSender,
  answerMention,
  findSenderUser,
  isTemporaryLookupFailure,
  screenEvent,
  type Admission,
} from './admission.js';
import { COPY } from './copy.js';
import { pickPersonalAgent, runDmTurn, type DmTurnDeps } from './dm-turn.js';
import type { EventDispatcher, SlackEnvelope } from './events.js';
import { logCode } from './log-code.js';
import type { SecretStore } from './secrets.js';
import type { InstallRow, InstallStore } from './store.js';
import type { KeyedQueue } from './turn-queue.js';

/**
 * What a verified, new event for an active install becomes (the ingress's
 * EventDispatcher; it already acknowledged Slack and tracks this work).
 *
 *   1. screenEvent: Slack Connect, bots, anything but a 1:1 DM or a mention,
 *      and edits are ignored (admission.ts owns those rules).
 *   2. The install's bot token, from the vault.
 *   3. A mention gets the private refusal, if the sender is admitted.
 *   4. A DM's sender is admitted from users.info, never from the text. A
 *      refused sender gets silence; a users.info call that failed only
 *      because Slack was briefly unavailable gets "try again".
 *   5. A shared file gets "I can't read files yet"; an empty message nothing.
 *   6. auth:find-user-by-email with users.info's email → the sender's oldest
 *      personal agent → conversations:find-or-create for the thread
 *      (`slack:<installId>:<channel>:<thread_ts>`, origin `'slack'`).
 *   7. The turn is queued behind any other in its conversation; the fourth
 *      waiting gets "send it again after I reply".
 *   8. When the turn's time comes, the install is read again: one that was
 *      disconnected (or reset) while the turn waited is dropped, logged as
 *      `slack_turns_dropped`, and its agent never runs.
 *
 * The dispatch resolves once the turn is queued: a turn can outlast the
 * ingress's shutdown drain, and isn't awaited (decisions: running DM turns
 * aren't). It never rejects. Every failure is logged with the install, a
 * stage or reason and a code, never an email, a Slack id or message text;
 * when someone admitted is waiting, they are told something went wrong.
 */

export interface RouterDeps extends DmTurnDeps {
  secrets: Pick<SecretStore, 'get'>;
  /** Read again when a queued turn starts: Disconnect may have removed the install meanwhile. */
  installs: Pick<InstallStore, 'get'>;
  queue: KeyedQueue;
}

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
 * (dm-turn.ts `pickPersonalAgent`), or null when they have none. The agent
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
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string | number> = {}): void => {
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

  const refused = (a: Exclude<Admission, { ok: true }>): void =>
    log(a.reason === 'lookup-failed' ? 'warn' : 'info', 'slack_sender_refused', {
      reason: a.reason,
      ...(a.code !== undefined ? { code: a.code } : {}),
    });

  if (screened.kind === 'mention') {
    let admission: Admission;
    try {
      admission = await answerMention(d.api, botToken, teamId, screened);
    } catch (err) {
      log('warn', 'slack_reply_failed', { stage: 'ephemeral', code: logCode(err) });
      return;
    }
    if (!admission.ok) refused(admission);
    return;
  }

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
    refused(admission);
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
    await runDmTurn(d, {
      install,
      botToken: token,
      channel: screened.channel,
      messageTs: screened.ts,
      threadTs: screened.threadTs,
      senderSlackId: screened.sender,
      senderName: admission.name,
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
