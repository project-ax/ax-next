import { mentionedUserName } from './admission.js';
import { logCode } from './log-code.js';
import type { SlackApi } from './slack-api.js';

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
 * call per message. A failure is never kept, so the next message asks again.
 */
export interface MentionNames {
  /**
   * `ids`' names: `known` first, then kept ones, then users.info. Never
   * rejects. `failed` counts lookups that threw, and `code` is the first
   * one's (Slack's own, or logCode's), for the caller to log.
   */
  lookup(i: {
    botToken: string;
    teamId: string;
    ids: readonly string[];
    known: ReadonlyMap<string, string>;
  }): Promise<{ names: Map<string, string>; failed: number; code?: string }>;
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
    async lookup({ botToken, teamId, ids, known }) {
      const names = new Map<string, string>();
      const ask: string[] = [];
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
        if (ask.length < perMessage) ask.push(id);
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
          }
        }),
      );
      return code === undefined ? { names, failed } : { names, failed, code };
    },
  };
}
