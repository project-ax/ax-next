import { mentionedUserName } from './admission.js';
import { RETRY_AFTER_CAP_MS, RETRY_AFTER_DEFAULT_MS } from './limits.js';
import { logCode } from './log-code.js';
import { SlackApiError, type SlackApi } from './slack-api.js';

/**
 * Names for the people a message mentions (TASK-1190), so the agent reads
 * `@moss` where Slack wrote `<@U0CL18D1JMA>` (format.ts `inboundText`).
 *
 * Why: found in the TASK-1189 walk. "@Fern ask @moss …" reached both agents
 * as raw ids; Fern tried to message a user id it couldn't place, and Moss,
 * not knowing the id was its own bot user, asked itself.
 *
 * The caller passes what it already knows (`known`: the bot's own user, the
 * sender, named by admission), so those cost no call. Every other id is asked
 * of users.info with the install's bot token, at most `perMessage` calls a
 * message; an id past them, or one whose lookup failed or found nothing
 * printable, gets no name, and the text says `@someone`. A name is Slack
 * profile text: untrusted, cleaned like a sender's (`cleanSenderName`, so no
 * brackets, parentheses, control or invisible characters), display text in
 * the message content only. Nothing reads it as identity, and it never
 * reaches a log.
 *
 * A name found is kept per workspace and user for `ttlMs` from when it
 * arrived, bounded (`max`, the oldest forgotten first), in memory like the
 * channel check's answers: a busy channel naming the same people costs no
 * call per message. A failure is never kept, so the next message asks again, except a
 * rate limit: then nobody is asked WITH THAT INSTALL'S TOKEN until Slack's
 * Retry-After has passed (RETRY_AFTER_DEFAULT_MS when it gave none, never
 * more than RETRY_AFTER_CAP_MS), so the users.info budget a sender's
 * admission needs isn't spent on display names. Slack's limits are per app
 * and workspace, and every install is its own app token, so the pause is per
 * install: one bot rate-limited never pauses another's lookups. At most `max`
 * installs are paused at once (expired pauses go first, then the oldest).
 * Ids not asked (`paused`, or `capped` past `perMessage`) read `@someone`.
 */
export interface MentionNames {
  /**
   * `ids`' names: `known` first, then kept ones, then users.info. Never
   * rejects. `failed` counts lookups that threw, and `code` is the first
   * one's (Slack's own, or logCode's; `ratelimited` whenever one was);
   * `capped` counts ids never asked because the message passed `perMessage`,
   * `paused` those never asked because this install is rate-limited. Known
   * and kept names resolve either way. For the caller to log.
   */
  lookup(i: {
    /** The install whose bot token asks: its own rate-limit pause. */
    installId: string;
    botToken: string;
    teamId: string;
    ids: readonly string[];
    known: ReadonlyMap<string, string>;
  }): Promise<{ names: Map<string, string>; failed: number; capped: number; paused: number; code?: string }>;
}

export function createMentionNames(o: {
  api: Pick<SlackApi, 'usersInfo'>;
  /** Epoch milliseconds. */
  now: () => number;
  ttlMs: number;
  max: number;
  perMessage: number;
}): MentionNames {
  for (const n of [o.ttlMs, o.max, o.perMessage]) {
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new RangeError('createMentionNames: ttlMs, max and perMessage must be positive integers');
    }
  }
  const { api, now, ttlMs, max, perMessage } = o;
  /** `${teamId}/${userId}` → the name, and when it stops being good. Insertion order is age. */
  const kept = new Map<string, { name: string; until: number }>();
  /** installId → epoch ms before which its token asks nobody: Slack rate-limited it. Insertion order is age. */
  const pausedUntil = new Map<string, number>();

  const pause = (installId: string, retryAfterMs: number | undefined): void => {
    const wait = Math.min(Math.max(retryAfterMs ?? RETRY_AFTER_DEFAULT_MS, 0), RETRY_AFTER_CAP_MS);
    const until = Math.max(pausedUntil.get(installId) ?? 0, now() + wait);
    pausedUntil.delete(installId);
    const t = now();
    for (const [key, at] of pausedUntil) if (at <= t) pausedUntil.delete(key);
    while (pausedUntil.size >= max) {
      const oldest = pausedUntil.keys().next();
      if (oldest.done === true) break;
      pausedUntil.delete(oldest.value);
    }
    pausedUntil.set(installId, until);
  };

  const isPaused = (installId: string): boolean => {
    const until = pausedUntil.get(installId);
    if (until === undefined) return false;
    if (until <= now()) {
      pausedUntil.delete(installId);
      return false;
    }
    return true;
  };

  const keep = (key: string, name: string): void => {
    kept.delete(key);
    while (kept.size >= max) {
      const oldest = kept.keys().next();
      if (oldest.done === true) break;
      kept.delete(oldest.value);
    }
    kept.set(key, { name, until: now() + ttlMs });
  };

  const keptName = (key: string): string | undefined => {
    const entry = kept.get(key);
    if (entry === undefined) return undefined;
    if (entry.until <= now()) {
      kept.delete(key);
      return undefined;
    }
    return entry.name;
  };

  return {
    async lookup({ installId, botToken, teamId, ids, known }) {
      const names = new Map<string, string>();
      const ask: string[] = [];
      let capped = 0;
      let pausedIds = 0;
      const paused = isPaused(installId);
      for (const id of ids) {
        if (names.has(id) || ask.includes(id)) continue;
        const given = known.get(id);
        if (given !== undefined && given !== '') {
          names.set(id, given);
          continue;
        }
        const k = keptName(`${teamId}/${id}`);
        if (k !== undefined) {
          names.set(id, k);
          continue;
        }
        if (paused) pausedIds += 1;
        else if (ask.length < perMessage) ask.push(id);
        else capped += 1;
      }
      let failed = 0;
      let code: string | undefined;
      await Promise.all(
        ask.map(async (id) => {
          try {
            const name = mentionedUserName(await api.usersInfo(botToken, id), id);
            if (name === '') return;
            names.set(id, name);
            keep(`${teamId}/${id}`, name);
          } catch (err) {
            failed += 1;
            code ??= logCode(err);
            if (err instanceof SlackApiError && err.code === 'ratelimited') {
              code = 'ratelimited';
              pause(installId, err.retryAfterMs);
            }
          }
        }),
      );
      const counts = { names, failed, capped, paused: pausedIds };
      return code === undefined ? counts : { ...counts, code };
    },
  };
}
