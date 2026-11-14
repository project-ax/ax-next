import type { AgentContext, HookBus, Logger } from '@ax/core';
import type { SlackEnvelope } from './events.js';
import { cleanSenderName } from './format.js';
import { EMAIL_MAX } from './limits.js';
import { logCode } from './log-code.js';
import type { SlackApi } from './slack-api.js';
import type { InstallRow } from './store.js';

/**
 * Who may talk to the bot, and where. Design §1.2, §1.4, §1.6, §2.
 *
 * Every sender must first be a full member of the install's workspace (no
 * guest, bot, deactivated, invited or other-workspace account) whose email
 * Slack has confirmed. Identity comes ONLY from `users.info`, fetched with the
 * install's bot token for the event's Slack user id. Nothing in a message's
 * text is ever read for identity: the screened event carries the sender's id,
 * and admission takes nothing else. Then the member's email decides who they
 * are to AX: an account (`findSenderUser`, `auth:find-user-by-email`) or, in
 * a connected channel only, an address on one of the install's approved
 * domains (`isApprovedSender`, `auth:is-approved-email`).
 *
 * Where: a 1:1 DM reaches the sender's own personal agent, and an @mention in
 * a channel connected to a team agent reaches that agent (router.ts says how,
 * channel-route.ts as whom). A channel shared with another company (Slack
 * Connect) and anything a bot sent get silence. Any other message outside a
 * DM is ignored: the bot only hears what is addressed to it. A mention where
 * no agent is connected gets one private (ephemeral) line, and only an
 * admitted member gets even that. A refused sender always gets silence: a
 * non-member learns nothing from the bot. A users.info call that failed only
 * because Slack was briefly unavailable refuses nobody
 * (`isTemporaryLookupFailure`): the router tells that sender, and only them,
 * to try again (in a DM, or privately in a connected channel).
 *
 * The router (router.ts) runs these in order: screenEvent → the bot token →
 * admitSender (or answerMention) → findSenderUser (→ isApprovedSender).
 */

// ── Who: the sender, from users.info ────────────────────────────────────────

export type RefusalReason =
  | 'bot'
  | 'deactivated'
  | 'guest'
  | 'other-workspace'
  | 'invited'
  | 'email-unconfirmed'
  | 'no-email'
  | 'lookup-failed';

/**
 * Admitted: the sender's users.info email, and their Slack display name
 * (`cleanSenderName`'d, '' when they have none) for the label the agent reads
 * (format.ts `dmSenderLabel`). The name is display text only, never identity.
 *
 * `code` only on a `lookup-failed` that a users.info call caused: the Slack
 * client's code-only error (`ratelimited`, `account_inactive`, …) or
 * `user-mismatch`, so an operator can tell a revoked token from a rate limit.
 */
export type Admission =
  | { ok: true; email: string; name: string }
  | { ok: false; reason: RefusalReason; code?: string };

const SLACKBOT_ID = 'USLACKBOT';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A flag that refuses when set. Absent, null and `false` are unset; anything
 * else, a non-boolean included, is set, so a field we can't read fails closed.
 */
function flagged(user: Record<string, unknown>, key: string): boolean {
  const value = user[key];
  return value !== undefined && value !== null && value !== false;
}

const refuse = (reason: RefusalReason): Admission => ({ ok: false, reason });

/**
 * What Slack shows for the sender: their display name, else their full name
 * (the profile's, then the account's), cleaned; '' when none has anything
 * printable.
 */
function displayNameOf(user: Record<string, unknown>): string {
  const profile = isRecord(user['profile']) ? user['profile'] : {};
  for (const raw of [profile['display_name'], profile['real_name'], user['real_name']]) {
    if (typeof raw !== 'string') continue;
    const name = cleanSenderName(raw);
    if (name.length > 0) return name;
  }
  return '';
}

/**
 * Pure. Admit a users.info `user` object for the install's workspace, or say
 * why not. The first rule that fires wins:
 *   1. not an object → lookup-failed
 *   2. Slackbot (`USLACKBOT`, which has `is_bot: false`), `is_bot` or
 *      `is_workflow_bot` → bot
 *   3. `deleted` → deactivated
 *   4. `is_restricted` or `is_ultra_restricted` → guest
 *   5. `is_stranger`, or `team_id` not the install's → other-workspace
 *   6. `is_invited_user` → invited
 *   7. `is_email_confirmed` anything but `true` (absent included) → email-unconfirmed
 *   8. `profile.email` not a string of 1 to EMAIL_MAX characters → no-email
 * Otherwise the email, verbatim: `auth:find-user-by-email` does its own
 * (ASCII-only) case folding, and a trimmed or lowercased address could name
 * a different account. `is_app_user` is not a refusal: it means "authorized
 * this app". The display name comes along for the sender label.
 */
export function admitSlackUser(user: unknown, teamId: string): Admission {
  if (!isRecord(user)) return refuse('lookup-failed');
  if (user['id'] === SLACKBOT_ID || flagged(user, 'is_bot') || flagged(user, 'is_workflow_bot')) {
    return refuse('bot');
  }
  if (flagged(user, 'deleted')) return refuse('deactivated');
  if (flagged(user, 'is_restricted') || flagged(user, 'is_ultra_restricted')) return refuse('guest');
  if (flagged(user, 'is_stranger') || user['team_id'] !== teamId) return refuse('other-workspace');
  if (flagged(user, 'is_invited_user')) return refuse('invited');
  if (user['is_email_confirmed'] !== true) return refuse('email-unconfirmed');
  const profile = user['profile'];
  const email = isRecord(profile) ? profile['email'] : undefined;
  if (typeof email !== 'string' || email.length < 1 || email.length > EMAIL_MAX) {
    return refuse('no-email');
  }
  return { ok: true, email, name: displayNameOf(user) };
}

/**
 * One `users.info` call with the install's bot token for the event's Slack
 * user id, then `admitSlackUser`. Any failure of the call is `lookup-failed`
 * with its code (never its message). So is an answer about anyone but the
 * sender: that would hand them someone else's email, and so their agent.
 */
export async function admitSender(
  api: SlackApi,
  botToken: string,
  slackUserId: string,
  teamId: string,
): Promise<Admission> {
  let user: unknown;
  try {
    user = await api.usersInfo(botToken, slackUserId);
  } catch (err) {
    return { ok: false, reason: 'lookup-failed', code: logCode(err) };
  }
  if (isRecord(user) && user['id'] !== slackUserId) {
    return { ok: false, reason: 'lookup-failed', code: 'user-mismatch' };
  }
  return admitSlackUser(user, teamId);
}

/**
 * "Slack, or the way to it, was briefly not there". Two sources:
 *
 *   - our client's own codes (slack-api.ts): rate limited, timed out,
 *     unreachable, or a 5xx;
 *   - Slack's own `ok: false` codes for a problem on its side, which arrive on
 *     an HTTP 200 as plain codes (`internal_error`, `fatal_error`,
 *     `service_unavailable`, `request_timeout`). Slack documents each as
 *     transient on every Web API method, so a retry is the right advice.
 */
const TEMPORARY_LOOKUP_CODE =
  /^(?:ratelimited|timeout|network|http-5\d\d|internal_error|fatal_error|service_unavailable|request_timeout)$/;

/**
 * A users.info failure that says nothing about the sender, only that Slack was
 * briefly unavailable. The sender may well be a member waiting on an answer,
 * so in a 1:1 DM (where only they can see it) the router says "try again"
 * instead of nothing. Everything else stays silent: a refusal is about the
 * sender, and a code like `token_revoked`, `user_not_found` or `user-mismatch`
 * is about the install or the account, which no retry fixes.
 */
export function isTemporaryLookupFailure(a: Admission): boolean {
  return !a.ok && a.reason === 'lookup-failed' && a.code !== undefined && TEMPORARY_LOOKUP_CODE.test(a.code);
}

// ── Where: which events are answered at all ─────────────────────────────────

export type IgnoreReason = 'slack-connect' | 'bot' | 'not-dm' | 'subtype' | 'incomplete' | 'other';

/** A message in a 1:1 DM with the bot. Not yet admitted. */
export interface DirectMessage {
  kind: 'dm';
  /** Slack's user id for the sender: what admission looks up. */
  sender: string;
  channel: string;
  /** The message itself: where 👀 goes while the agent works. */
  ts: string;
  /** The thread the reply goes in: the message's own ts at the top level. */
  threadTs: string;
  /** The owner's words to their agent. Never read for identity. */
  text: string;
  /** Slack's `file_share`: the bot can't read files yet. */
  fileShare: boolean;
}

/** An @mention of the bot anywhere but a DM (a channel or a group DM). Not yet admitted. */
export interface Mention {
  kind: 'mention';
  sender: string;
  channel: string;
  /** The mention itself: where 👀 goes, and outside a thread the root of the reply's. */
  ts: string;
  /**
   * The event's `thread_ts`: present only when the mention was inside a
   * thread. Lines for the sender alone go there and nowhere else: an
   * ephemeral sent with a `thread_ts` that has no thread yet is never shown.
   * The reply's thread is `threadTs ?? ts`.
   */
  threadTs?: string;
  /** The sender's words, the bot's own `<@U…>` included. Never read for identity. */
  text: string;
}

export type ScreenedEvent = DirectMessage | Mention | { kind: 'ignore'; reason: IgnoreReason };

const ignore = (reason: IgnoreReason): ScreenedEvent => ({ kind: 'ignore', reason });

/**
 * Pure: what a verified event for an active install asks of the bot, before
 * any Slack call. In order:
 *   - a channel shared with another company (Slack Connect) → ignore, even a
 *     DM or a member's mention: the reply would land in front of them;
 *   - no sender, a `bot_id`, or our own bot user → ignore (bot);
 *   - a `message` outside a 1:1 DM (`channel_type` not `im`: a channel, a
 *     private channel, a group DM) → ignore (not-dm);
 *   - a DM `subtype` other than `file_share` (an edit, a delete, a broadcast)
 *     → ignore;
 *   - a DM or a mention with no channel or ts → ignore (nothing to answer
 *     in, nothing to put 👀 on);
 *   - an `app_mention` → a mention (it never fires in DMs); any other event
 *     type → ignore.
 */
export function screenEvent(
  install: Pick<InstallRow, 'botUserId'>,
  envelope: SlackEnvelope,
): ScreenedEvent {
  const { event } = envelope;
  if (envelope.isExtSharedChannel) return ignore('slack-connect');
  if (event.user === undefined || event.botId !== undefined || event.user === install.botUserId) {
    return ignore('bot');
  }
  const sender = event.user;
  if (event.type === 'message') {
    if (event.channelType !== 'im') return ignore('not-dm');
    if (event.subtype !== undefined && event.subtype !== 'file_share') return ignore('subtype');
    if (event.channel === undefined || event.ts === undefined) return ignore('incomplete');
    return {
      kind: 'dm',
      sender,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.threadTs ?? event.ts,
      text: event.text ?? '',
      fileShare: event.subtype === 'file_share',
    };
  }
  if (event.type === 'app_mention') {
    if (event.channel === undefined || event.ts === undefined) return ignore('incomplete');
    return {
      kind: 'mention',
      sender,
      channel: event.channel,
      ts: event.ts,
      ...(event.threadTs !== undefined ? { threadTs: event.threadTs } : {}),
      text: event.text ?? '',
    };
  }
  return ignore('other');
}

// ── A mention no agent takes ────────────────────────────────────────────────

/**
 * A mention no turn will come of, where the router has nothing to go on but
 * the sender (no agent is connected, or the binding couldn't be read): an
 * admitted member gets `text` once, ephemeral, so only they see it, in the
 * mention's thread when it was in one (never a thread under the mention's
 * own ts: one that doesn't exist yet hides the line); a refused sender gets
 * silence. The line is the caller's, a COPY line. A refusal comes back for
 * the caller to log; a failed post throws.
 */
export async function answerMention(
  api: SlackApi,
  botToken: string,
  teamId: string,
  mention: Mention,
  text: string,
): Promise<Admission> {
  const admission = await admitSender(api, botToken, mention.sender, teamId);
  if (!admission.ok) return admission;
  await api.postEphemeral(botToken, {
    channel: mention.channel,
    user: mention.sender,
    text,
    ...(mention.threadTs !== undefined ? { threadTs: mention.threadTs } : {}),
  });
  return admission;
}

// ── The verified email to an AX account ─────────────────────────────────────

const FIND_USER_BY_EMAIL = 'auth:find-user-by-email';

/**
 * The AX user an admitted sender's email belongs to, or null. The email goes
 * to `auth:find-user-by-email` exactly as admission returned it from
 * users.info (TASK-1092's caller contract: never one from message text).
 * Anything but `{ userId: <non-empty string> }` is null: an answer we can't
 * read never maps anyone.
 *
 * EVERY null logs `slack_sender_not_mapped` with the install id and nothing
 * else (never the email): auth says no more than "no account we can vouch
 * for", and this line is how an operator sees that a Slack member keeps
 * missing. A failed lookup throws to the caller instead; it is not a miss.
 */
export async function findSenderUser(
  bus: HookBus,
  ctx: AgentContext,
  email: string,
  log: { installId: string; logger: Logger },
): Promise<string | null> {
  const found = await bus.call<{ email: string }, unknown>(FIND_USER_BY_EMAIL, ctx, { email });
  if (isRecord(found)) {
    const userId = found['userId'];
    if (typeof userId === 'string' && userId.length > 0) return userId;
  }
  try {
    log.logger.info('slack_sender_not_mapped', { installId: log.installId });
  } catch {
    // A log line never changes the answer.
  }
  return null;
}

const IS_APPROVED_EMAIL = 'auth:is-approved-email';

/**
 * Is an admitted sender AX has no account for on one of the install's
 * approved domains? (A connected channel's tier C: a company member who never
 * signed in.) The email goes to `auth:is-approved-email` exactly as admission
 * returned it from users.info (its caller contract: never one from message
 * text). Only `{ approved: true }` is a yes: an answer we can't read admits
 * nobody. A failed call throws to the caller: an outage is not a "no". Logs
 * nothing: the caller logs its own outcome, by code.
 */
export async function isApprovedSender(bus: HookBus, ctx: AgentContext, email: string): Promise<boolean> {
  const answer = await bus.call<{ email: string }, unknown>(IS_APPROVED_EMAIL, ctx, { email });
  return isRecord(answer) && answer['approved'] === true;
}
