import { connectable } from './channels.js';
import { logCode } from './log-code.js';
import { SlackApiError, type SlackApi, type SlackChannel } from './slack-api.js';

/**
 * Slack's word that a bound channel is still one a bot may answer in: public,
 * live, and not Slack Connect (TASK-1184).
 *
 * Why: a channel is checked when it is bound (channels.ts `connectChannel`,
 * and a team agent's own bot at its first mention there, router.ts
 * `bindBotChannel`), but it can change after that: made private, archived,
 * or shared with another company. An `app_mention` carries no channel type
 * to notice that by, so the router asks Slack's `conversations.info` again,
 * with the install's own bot token, when each channel turn starts.
 *
 * What Slack's untrusted answer becomes:
 *   - allowed: an answer about this channel that channels.ts `connectable`
 *     accepts, the same test a connect makes, so the two can't disagree;
 *   - refused, which is definitive: an answer about this channel that
 *     `connectable` refuses (`not-public`, `archived` or `shared`, named in
 *     connectChannel's order), or Slack's own `channel_not_found` or
 *     `missing_scope` (CHANNEL_REFUSED_CODES). A bot that reads public
 *     channels only gets `missing_scope` for a channel it can't read as
 *     one: the TASK-1174 walk measured it at a bot's first bind, for a
 *     channel private from the start. Nobody has measured a channel made
 *     private later, nor what Slack's `needed` says for either;
 *   - unknown: Slack couldn't say. A rate limit, a token Slack refuses, a
 *     5xx, an unreadable answer, a network failure, an answer about some
 *     other channel (`id-mismatch`), or a `missing_scope` whose `needed` is
 *     exactly `channels:read`. That one is the token's: it lacks the scope
 *     every public channel is read with (say its app was reinstalled without
 *     it: a token keeps its string, and its scopes follow the app's
 *     configuration at the reinstall), so it reads no channel at all, and a
 *     refusal would disconnect every channel with a false "it's private
 *     now". Any other `missing_scope` is still refused. None of these says
 *     anything about the channel, so the caller runs no turn and changes
 *     nothing durable.
 * A code is Slack's own, logCode's, or one of this file's: never anything
 * else from the answer.
 *
 * Only an allowed answer is kept, per install and channel, for `ttlMs` from
 * when it arrived: a mention flood in one channel then costs one Slack call
 * a minute, not a rate limit that turns every channel turn in the workspace
 * into "try again". A refusal is never kept: the caller acts on it at once
 * (the binding goes), and a kept one would remove a binding made again within
 * the minute. A failure is never kept either, so the next turn asks as soon
 * as Slack can answer, and an expired allowed answer is never used in its
 * place.
 *
 * Two turns in one channel can ask at once, and Slack's answers can arrive in
 * any order. So a refusal also forgets the allowed answer kept for that
 * install and channel, and an allowed answer still on its way when a refusal
 * for them lands is not kept: it may describe the channel as it was before.
 * Its own turn still gets it, as every turn gets its own answer.
 *
 * In-process and bounded (`max` channels, the oldest forgotten first), like
 * the event-id dedupe and the signing-secret cache; an install and channel
 * is tracked for the race above only while an ask about it is on its way. It
 * never logs: the caller logs the result's code.
 */

/**
 * conversations.info refusals that are about the channel, not Slack failing:
 * definitive, never "try again". Both apps read public channels only (each
 * manifest's `channels:read`, and no `groups:read`), so a private channel or
 * a group DM a bot was added to anyway is `channel_not_found` or
 * `missing_scope` to it. A team agent's own bot binds nothing there, in
 * silence, as for a channel Slack describes as one it can't serve (router.ts
 * `bindBotChannel`); a channel already bound is refused (above), unless
 * Slack's `needed` says the token itself lacks `channels:read` (TOKEN_SCOPE).
 */
export const CHANNEL_REFUSED_CODES: ReadonlySet<string> = new Set(['channel_not_found', 'missing_scope']);

/** The scope a bot reads every public channel with. A `missing_scope` that needs exactly this one is the token's. */
const TOKEN_SCOPE = 'channels:read';

export type ChannelCheckResult =
  | { kind: 'allowed' }
  /** Definitive. code: 'not-public' | 'archived' | 'shared' (from the flags) or Slack's 'channel_not_found' | 'missing_scope'. */
  | { kind: 'refused'; code: string }
  /** Slack couldn't say. code: Slack's own (a token missing `channels:read` is `missing_scope`), logCode's, or 'id-mismatch'. */
  | { kind: 'unknown'; code: string };

export interface ChannelCheck {
  /** Never rejects. Asks Slack only when no allowed answer younger than ttlMs is kept. */
  check(installId: string, botToken: string, channelId: string): Promise<ChannelCheckResult>;
}

/** Why `connectable` refused a channel, in channels.ts connectChannel's order. */
function refusalCode(c: SlackChannel): 'not-public' | 'archived' | 'shared' {
  if (!c.isChannel || c.isPrivate) return 'not-public';
  if (c.isArchived) return 'archived';
  return 'shared';
}

/** Slack's answer about one channel, sorted. Never rejects. */
async function ask(
  api: Pick<SlackApi, 'conversationsInfo'>,
  botToken: string,
  channelId: string,
): Promise<ChannelCheckResult> {
  let info: SlackChannel;
  try {
    info = await api.conversationsInfo(botToken, channelId);
  } catch (err) {
    if (err instanceof SlackApiError && CHANNEL_REFUSED_CODES.has(err.code)) {
      // The token can't read any public channel: about the token, not this one (header).
      if (err.code === 'missing_scope' && err.needed === TOKEN_SCOPE) return { kind: 'unknown', code: err.code };
      return { kind: 'refused', code: err.code };
    }
    return { kind: 'unknown', code: logCode(err) };
  }
  // Unexplained, so not a refusal: a refusal deletes a binding, and this says nothing about this channel.
  if (info.id !== channelId) return { kind: 'unknown', code: 'id-mismatch' };
  if (!connectable(info)) return { kind: 'refused', code: refusalCode(info) };
  return { kind: 'allowed' };
}

export function createChannelCheck(o: {
  api: Pick<SlackApi, 'conversationsInfo'>;
  /** Epoch milliseconds. */
  now: () => number;
  ttlMs: number;
  max: number;
}): ChannelCheck {
  if (!Number.isSafeInteger(o.ttlMs) || o.ttlMs <= 0 || !Number.isSafeInteger(o.max) || o.max <= 0) {
    throw new RangeError('createChannelCheck: ttlMs and max must be positive integers');
  }
  const { api, now, ttlMs, max } = o;
  /** `${installId}/${channelId}` → when its allowed answer stops being good. Insertion order is age. */
  const allowedUntil = new Map<string, number>();
  /**
   * The keys Slack is being asked about now: how many asks are on their way,
   * and how many refusals have landed since the oldest of them left. A key
   * goes once its last ask is answered, so it never holds more keys than
   * there are asks on their way.
   */
  const asking = new Map<string, { inFlight: number; refusals: number }>();

  /** Keep an allowed answer, the newest, forgetting the oldest beyond `max`. */
  const keep = (key: string): void => {
    allowedUntil.delete(key);
    while (allowedUntil.size >= max) {
      const oldest = allowedUntil.keys().next();
      if (oldest.done === true) break;
      allowedUntil.delete(oldest.value);
    }
    // From when the answer arrived, not from when Slack was asked.
    allowedUntil.set(key, now() + ttlMs);
  };

  return {
    async check(installId, botToken, channelId) {
      // `/` is in neither an install id (INSTALL_ID_RE) nor a Slack id (SLACK_ID_RE).
      const key = `${installId}/${channelId}`;
      const until = allowedUntil.get(key);
      if (until !== undefined && now() < until) return { kind: 'allowed' };
      allowedUntil.delete(key);

      const flight = asking.get(key) ?? { inFlight: 0, refusals: 0 };
      asking.set(key, flight);
      flight.inFlight += 1;
      const refusalsBefore = flight.refusals;
      try {
        const result = await ask(api, botToken, channelId);
        if (result.kind === 'refused') {
          // What another ask kept, or still brings back, may be from before this.
          flight.refusals += 1;
          allowedUntil.delete(key);
        } else if (result.kind === 'allowed' && flight.refusals === refusalsBefore) {
          keep(key);
        }
        return result;
      } finally {
        flight.inFlight -= 1;
        if (flight.inFlight === 0) asking.delete(key);
      }
    },
  };
}
