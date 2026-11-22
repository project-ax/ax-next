import type { AgentContext, HookBus } from '@ax/core';
import type { ChannelStore } from './channel-store.js';
import { COPY } from './copy.js';
import { logCode } from './log-code.js';
import type { SlackApi } from './slack-api.js';
import { agentTeamName } from './team-name.js';

/**
 * A channel's memory notice (TASK-1203; design
 * docs/plans/2026-11-09-channel-slack-design.md §4c). A team agent's memory
 * is shared with its whole team, so what its own bot hears in a channel can
 * come up anywhere the agent works. Each channel is told so once, by the bot
 * itself: a top-level post for everyone there (COPY.memoryNotice), at the
 * channel's first turn (router.ts step 9b). A team bot hears only mentions,
 * so its first turn in a channel is where what it hears there starts; and a
 * channel bound before this notice existed is told at its next turn.
 *
 * Once per binding, whichever replica's turn comes first: the turn claims
 * the notice in one conditional write (channel-store.ts `claimNotice`) and
 * only the claim that wins posts. A post Slack refuses (an announcement-only
 * channel, a rate limit, Slack down) gives the claim back, so the next turn
 * tries again: telling a channel twice, when Slack took a post we saw fail,
 * is the better failure for a privacy notice than never telling it. A crash
 * between the claim and the post leaves that binding untold (accepted:
 * rare).
 *
 * The team is named as the person the turn runs as sees it (team-name.ts
 * `agentTeamName`); its name is from outside, so COPY escapes it. Without
 * one the notice says "my team".
 *
 * Nothing here stops the turn: it never throws. Log lines are code-only:
 * `slack_notice_posted`, `slack_notice_failed { stage, code }` (stage
 * `claim`, `post` or `release`) and `slack_team_name_failed { code }`, never
 * a name, an id or a token, and never `slack_event_failed`, which means the
 * event's work stopped.
 */

export interface MemoryNoticeDeps {
  bus: HookBus;
  api: Pick<SlackApi, 'postToChannel'>;
  channels: Pick<ChannelStore, 'claimNotice' | 'releaseNotice'>;
}

type NoticeLog = (level: 'info' | 'warn', msg: string, fields?: Record<string, string>) => void;

/**
 * Claim the channel's notice; post it only when the claim won; give the
 * claim back when the post fails. `userId` is the person the turn runs as;
 * `ctx` is a lookup ctx for them. Resolves once done, never rejects.
 */
export async function postMemoryNotice(
  d: MemoryNoticeDeps,
  ctx: AgentContext,
  i: { installId: string; channelId: string; agentId: string; botToken: string; userId: string },
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

  let claimed: boolean;
  try {
    claimed = await d.channels.claimNotice(i.installId, i.channelId, i.agentId);
  } catch (err) {
    say('warn', 'slack_notice_failed', { stage: 'claim', code: logCode(err) });
    return;
  }
  // Told already (by an earlier turn, on any replica), or no longer this agent's channel.
  if (!claimed) return;

  const team = await agentTeamName(d.bus, ctx, { agentId: i.agentId, userId: i.userId }, (err) =>
    say('warn', 'slack_team_name_failed', { code: logCode(err) }),
  );
  try {
    await d.api.postToChannel(i.botToken, { channel: i.channelId, text: COPY.memoryNotice(team) });
  } catch (err) {
    say('warn', 'slack_notice_failed', { stage: 'post', code: logCode(err) });
    try {
      await d.channels.releaseNotice(i.installId, i.channelId, i.agentId);
    } catch (released) {
      say('warn', 'slack_notice_failed', { stage: 'release', code: logCode(released) });
    }
    return;
  }
  say('info', 'slack_notice_posted');
}
