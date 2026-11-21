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
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
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

/** A button's busy face: a spinner and what it's doing. */
function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <Spinner data-icon="inline-start" aria-hidden="true" />
      {children}
    </>
  );
}

/** What the bot is called in a sentence: its handle when it has one, else its name. */
function whoIs(bot: Pick<Live, 'botName' | 'handle'>): string {
  return bot.handle !== null ? `@${bot.handle}` : bot.botName;
}

/** The name of a bot Set up again took away, as the form's notice says it. */
export function rebuildWho(from: RebuildFrom): string {
  return whoIs(from);
}

/**
 * The shape both dialogs share: a title and description, an error line, a
 * decline button and a confirm button that shows `busyLabel` while it works.
 * Close requests while the call is in flight are ignored.
 */
function ConfirmDialog({
  open,
  onClose,
  busy,
  error,
  title,
  description,
  decline,
  confirm,
  busyLabel,
  variant,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  busy: boolean;
  error: string | null;
  title: string;
  description: string;
  decline: string;
  confirm: string;
  busyLabel: string;
  variant: 'default' | 'destructive';
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy || next) return;
        onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {decline}
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={busy}>
            {busy ? <Busy>{busyLabel}</Busy> : confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = whoIs(bot);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
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
      if (agentSlackBotStale(err)) {
        onClose();
        onChanged();
      } else {
        setError(agentSlackBotErrorCopy(err).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={() => {
        setError(null);
        onClose();
      }}
      busy={busy}
      error={error}
      title={`Set up ${who} again?`}
      description={`We'll remove ${who} from Slack and delete its Slack app. Then you add it again here. It's a new bot in Slack, so invite it to each channel again. If Slack won't let us delete the old app, it may need deleting by hand in Slack's app settings.`}
      decline="Keep it"
      confirm="Set up again"
      busyLabel="Removing…"
      variant="destructive"
      onConfirm={() => void confirm()}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = whoIs(bot);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await claimAgentSlackBot(agentId, installId);
      onChanged();
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      if (agentSlackBotStale(err)) {
        onClose();
        onChanged();
      } else {
        setError(AGENT_SLACK_COPY.generic);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={() => {
        setError(null);
        onClose();
      }}
      busy={busy}
      error={error}
      title={`Take over ${who}?`}
      description={`Right now ${who} answers only team members. Once you take over, it answers people outside the team with your access, and anything it needs approved waits in your Today.`}
      decline="Not now"
      confirm="Take over"
      busyLabel="Taking over…"
      variant="default"
      onConfirm={() => void confirm()}
    />
  );
}
