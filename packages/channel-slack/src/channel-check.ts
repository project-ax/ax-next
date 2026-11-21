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
 *     `missing_scope` (CHANNEL_REFUSED_CODES). `missing_scope` is definitive
 *     here, not a broken grant: a binding exists only after this install's
 *     own token read this channel, so that token has `channels:read`, and
 *     the channel is no longer one it can read (the TASK-1174 walk measured
 *     it for a channel made private);
 *   - unknown: Slack couldn't say. A rate limit, a token Slack refuses, a
 *     5xx, an unreadable answer, a network failure, or an answer about some
 *     other channel (`id-mismatch`). It says nothing about the channel, so
 *     the caller runs no turn and changes nothing durable.
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
 * In-process and bounded (`max` channels, the oldest forgotten first), like
 * the event-id dedupe and the signing-secret cache. It never logs: the
 * caller logs the result's code.
 */

/**
 * conversations.info refusals that are about the channel, not Slack failing:
 * definitive, never "try again". Both apps read public channels only (each
 * manifest's `channels:read`, and no `groups:read`), so a private channel or
 * a group DM a bot was added to anyway is `channel_not_found` or
 * `missing_scope` to it. A team agent's own bot binds nothing there, in
 * silence, as for a channel Slack describes as one it can't serve (router.ts
 * `bindBotChannel`); a channel already bound is refused (above).
 */
export const CHANNEL_REFUSED_CODES: ReadonlySet<string> = new Set(['channel_not_found', 'missing_scope']);

export type ChannelCheckResult =
  | { kind: 'allowed' }
  /** Definitive. code: 'not-public' | 'archived' | 'shared' (from the flags) or Slack's 'channel_not_found' | 'missing_scope'. */
  | { kind: 'refused'; code: string }
  /** Slack couldn't say. code: Slack's own, logCode's, or 'id-mismatch'. */
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

  return {
    async check(installId, botToken, channelId) {
      // `/` is in neither an install id (INSTALL_ID_RE) nor a Slack id (SLACK_ID_RE).
      const key = `${installId}/${channelId}`;
      const until = allowedUntil.get(key);
      if (until !== undefined && now() < until) return { kind: 'allowed' };
      allowedUntil.delete(key);

      let info: SlackChannel;
      try {
        info = await api.conversationsInfo(botToken, channelId);
      } catch (err) {
        if (err instanceof SlackApiError && CHANNEL_REFUSED_CODES.has(err.code)) {
          return { kind: 'refused', code: err.code };
        }
        return { kind: 'unknown', code: logCode(err) };
      }
      // Unexplained, so not a refusal: a refusal deletes a binding, and this says nothing about this channel.
      if (info.id !== channelId) return { kind: 'unknown', code: 'id-mismatch' };
      if (!connectable(info)) return { kind: 'refused', code: refusalCode(info) };

      while (allowedUntil.size >= max) {
        const oldest = allowedUntil.keys().next();
        if (oldest.done === true) break;
        allowedUntil.delete(oldest.value);
      }
      // From when the answer arrived, not from when Slack was asked.
      allowedUntil.set(key, now() + ttlMs);
      return { kind: 'allowed' };
    },
  };
}
