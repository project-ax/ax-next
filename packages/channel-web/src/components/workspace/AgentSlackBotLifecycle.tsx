/**
 * Set up again and Take over, the two things a team admin does about a live bot
 * that needs attention (TASK-1173, TASK-1187). Code names: `RebuildBotDialog`
 * and `ClaimBotDialog`. Both are confirmations opened from `AgentSlackBot`'s
 * `Live` card (a problem row's one button), and both name the bot the page
 * showed by its install id, so a page drawn before the bot changed can't touch
 * the new one: the server answers a stale id with a refusal `agentSlackBotStale`
 * knows, the dialog closes and the status is read again.
 *
 *   Set up again  the person who added the bot to Slack has left, so nobody can
 *                 replace its Slack token any more. It removes the bot (the same
 *                 call as Remove from Slack: the Slack app is deleted with the
 *                 leaver's stored token, or left on the list of apps we couldn't
 *                 delete), then the page opens the request form with the old
 *                 name offered back.
 *   Take over     the person who asked for the bot is no longer a team admin.
 *                 Taking over makes the viewer the one whose access people
 *                 outside the team borrow.
 *
 * Every sentence is pinned here or comes from `lib/agent-slack.ts`. These words
 * never name the product, the plumbing or a role.
 */
import { ConfirmAction } from '@project-ax/ui';
import {
  AGENT_SLACK_COPY,
  agentSlackBotErrorCopy,
  agentSlackBotStale,
  claimAgentSlackBot,
  disconnectSlackBot,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { logRequestFailure } from '@/lib/http';
import type { BotCancelled } from './AgentSlackBot';

/** The bot Set up again took away, so the form can offer its name back. */
export interface RebuildFrom {
  botName: string;
  handle: string | null;
}

type Live = Extract<Bot, { state: 'live' }>;

/** What the bot is called in a sentence: its handle when it has one, else its name. */
function whoIs(bot: Pick<Live, 'botName' | 'handle'>): string {
  return bot.handle !== null ? `@${bot.handle}` : bot.botName;
}

/** The name of a bot Set up again took away, as the form's notice says it. */
export function rebuildWho(from: RebuildFrom): string {
  return whoIs(from);
}

/**
 * Asks before setting a bot up again when the person who added it has left. Confirming removes
 * the bot the dialog shows (by `installId`), hands up how it went, then the
 * bot it was, then reads the status again, in that order: the status read
 * replaces everything below the page with its loading face, so what it needs
 * to show afterwards has to be held by the caller before it starts.
 */
export function RebuildBotDialog({
  open,
  onClose,
  agentId,
  bot,
  installId,
  onCancelled,
  onRebuilt,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  bot: Live;
  /** The install id of `bot`, the one this dialog names. */
  installId: string;
  onCancelled: (cancelled: BotCancelled) => void;
  onRebuilt: (from: RebuildFrom) => void;
  onChanged: () => void;
}) {
  const who = whoIs(bot);

  async function confirm() {
    try {
      const { appDeleted } = await disconnectSlackBot(agentId, installId);
      onCancelled({
        how: 'disconnected',
        appDeleted,
        approverIsViewer: bot.viewerIsApprover,
        approver: bot.approver,
        approverGone: bot.approverGone,
      });
      onRebuilt({ botName: bot.botName, handle: bot.handle });
      onChanged();
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      // The bot is already gone: closing and reading again is the whole answer, so return normally.
      if (agentSlackBotStale(err)) {
        onChanged();
        return;
      }
      throw err;
    }
  }

  return (
    <ConfirmAction
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Set up ${who} again?`}
      description={`We'll remove ${who} from Slack and delete its Slack app. Then you add it again here. It's a new bot in Slack, so invite it to each channel again. If Slack won't let us delete the old app, it may need deleting by hand in Slack's app settings.`}
      confirmLabel="Set up again"
      errorMessage={(err) => agentSlackBotErrorCopy(err).message}
      onConfirm={confirm}
    />
  );
}

/**
 * Asks before taking over a bot whose requester is no longer a team admin.
 * Confirming claims the bot the dialog shows (by `installId`) and reads the
 * status again. A refusal that says there was nothing to claim (someone else
 * got there first, or the requester is back) closes silently and reads again.
 */
export function ClaimBotDialog({
  open,
  onClose,
  agentId,
  bot,
  installId,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  bot: Live;
  /** The install id of `bot`, the one this dialog names. */
  installId: string;
  onChanged: () => void;
}) {
  const who = whoIs(bot);

  async function confirm() {
    try {
      await claimAgentSlackBot(agentId, installId);
      onChanged();
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      // Nothing left to claim: close silently and read again.
      if (agentSlackBotStale(err)) {
        onChanged();
        return;
      }
      throw err;
    }
  }

  return (
    <ConfirmAction
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Take over ${who}?`}
      description={`Right now ${who} answers only team members. Once you take over, it answers people outside the team with your access, and anything it needs approved waits in your Today.`}
      confirmLabel="Take over"
      tone="neutral"
      errorMessage={() => AGENT_SLACK_COPY.generic}
      onConfirm={confirm}
    />
  );
}
