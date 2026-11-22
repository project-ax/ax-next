import type { ChannelStore } from './channel-store.js';
import { COPY } from './copy.js';
import { logCode } from './log-code.js';
import { SlackApiError, type SlackApi } from './slack-api.js';

/**
 * A channel's memory notice (TASK-1203; design
 * docs/plans/2026-11-09-channel-slack-design.md §4c). A team agent's memory
 * is shared with anyone who talks to it, so what its own bot hears in a
 * channel can come up anywhere the agent works, for anyone there. Each channel is told so once, by the bot
 * itself: a top-level post for everyone there (COPY.memoryNotice), at the
 * channel's first turn (router.ts step 9b). A team bot hears only mentions,
 * so its first turn in a channel is where what it hears there starts; and a
 * channel bound before this notice existed is told at its next turn.
 *
 * Once per binding, whichever replica's turn comes first: the turn claims
 * the notice in one conditional write (channel-store.ts `claimNotice`) and
 * only the claim that wins posts. A post Slack refuses (a rate limit, Slack
 * down) gives the claim back, so the next turn tries again: telling a
 * channel twice, when Slack took a post we saw fail, is the better failure
 * for a privacy notice than never telling it. The one refusal no later turn
 * gets past is a channel where only admins post top-level but anyone may
 * reply in a thread (Slack answers `restricted_action`, or
 * `restricted_action_thread_only_channel`; which one an announcement-only
 * channel gets is unmeasured, so both. A read-only channel's
 * `restricted_action_read_only_channel` refuses thread replies too, so it
 * is an ordinary refusal: released, and the next turn tries again): the notice goes in the mention's thread instead, which reaches the
 * readers of that thread only, and the claim is kept once that lands (it is
 * given back only if the thread post fails too). So later threads there are
 * not told: accepted, since retrying would put a claim, two lookups and a
 * doomed post in front of every reply there, and tell nobody. A release gives back only the
 * claim this turn made (by the stamp `claimNotice` answered), never a newer
 * binding's after a remove and rebind. A crash between the claim and the post leaves that binding untold
 * (accepted: rare).
 *
 * The notice is one fixed line and names nobody: no team, no person (it used
 * to name the agent's team, until TASK-1209 let anyone who talks to the bot
 * read what it remembers, which "everyone on {team}" would understate).
 *
 * Nothing here stops the turn: it never throws. Log lines are code-only:
 * `slack_notice_posted` (with `stage: 'thread'` when it went in the thread),
 * `slack_notice_top_level_refused { code }` (info: an admins-only channel),
 * `slack_notice_failed { stage, code }` (stage `claim`, `post`, `thread` or
 * `release`), never a name, an id or a token, and never `slack_event_failed`, which means the
 * event's work stopped.
 */

export interface MemoryNoticeDeps {
  api: Pick<SlackApi, 'postToChannel'>;
  channels: Pick<ChannelStore, 'claimNotice' | 'releaseNotice'>;
}

type NoticeLog = (level: 'info' | 'warn', msg: string, fields?: Record<string, string>) => void;

/**
 * Claim the channel's notice; post it only when the claim won; give the
 * claim back when the post fails. `threadTs` is the thread the bot is about
 * to reply in (an announcement-only channel's notice goes there). Resolves
 * once done, never rejects.
 */
export async function postMemoryNotice(
  d: MemoryNoticeDeps,
  i: { installId: string; channelId: string; threadTs: string; agentId: string; botToken: string },
  log: NoticeLog,
): Promise<void> {
  /** A log line never changes what happens next. */
  const say: NoticeLog = (level, msg, fields) => {
    try {
      log(level, msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };

  let claimed: string | null;
  try {
    claimed = await d.channels.claimNotice(i.installId, i.channelId, i.agentId);
  } catch (err) {
    say('warn', 'slack_notice_failed', { stage: 'claim', code: logCode(err) });
    return;
  }
  // Told already (by an earlier turn, on any replica), or no longer this agent's channel.
  if (claimed === null) return;
  const stamp = claimed;

  const text = COPY.memoryNotice;
  const release = async (): Promise<void> => {
    try {
      // Only this turn's own claim: a binding removed and made again meanwhile keeps its new one.
      await d.channels.releaseNotice(i.installId, i.channelId, i.agentId, stamp);
    } catch (released) {
      say('warn', 'slack_notice_failed', { stage: 'release', code: logCode(released) });
    }
  };
  try {
    await d.api.postToChannel(i.botToken, { channel: i.channelId, text });
  } catch (err) {
    if (!isAdminsOnlyRefusal(err)) {
      say('warn', 'slack_notice_failed', { stage: 'post', code: logCode(err) });
      await release();
      return;
    }
    // Expected in such a channel, and the thread post below decides the outcome: not a failure line.
    say('info', 'slack_notice_top_level_refused', { code: logCode(err) });
    // An announcement-only channel: no later turn's top-level post would land, so the thread is where it goes.
    try {
      await d.api.postToChannel(i.botToken, { channel: i.channelId, text, threadTs: i.threadTs });
    } catch (threadErr) {
      say('warn', 'slack_notice_failed', { stage: 'thread', code: logCode(threadErr) });
      await release();
      return;
    }
    say('info', 'slack_notice_posted', { stage: 'thread' });
    return;
  }
  say('info', 'slack_notice_posted');
}

/** Slack's refusals of a top-level post where a thread reply would still land. */
const THREAD_STILL_OPEN = new Set(['restricted_action', 'restricted_action_thread_only_channel']);

/** Slack refused a top-level post because only admins may post one there, and a thread reply is still open. */
function isAdminsOnlyRefusal(err: unknown): boolean {
  return err instanceof SlackApiError && THREAD_STILL_OPEN.has(err.code);
}
