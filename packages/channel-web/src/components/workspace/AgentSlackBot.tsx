/**
 * "Its own Slack bot" in a team agent's Slack settings (TASK-1167): give the
 * agent its own name in Slack, so people mention it directly instead of going
 * through the shared bot.
 *
 * What `bot` says (the status `GET /settings/slack/:agentId` carries) decides
 * what shows:
 *   none     a manager sees the form: first a choice of who sets it up in
 *            Slack ("Ask an AX admin" for someone who can't install apps, or
 *            "I can install apps in Slack"), then the bot's name, and, on the
 *            self path only and only if the server holds no configuration
 *            token for them, the steps and the field to paste one into;
 *            everyone else sees nothing. The choice opens on "self" when a
 *            token is stored and on "admin" when it isn't.
 *   requested a manager sees that an AX admin hasn't approved it yet, with
 *            "Cancel request" (no Slack app exists, so nothing is left over)
 *   pending  a manager sees where it stands, with "Continue in Slack" for the
 *            person who started it, and "Cancel request"; a cancel whose Slack
 *            app couldn't be deleted leaves a note saying where to find it
 *   live     everyone sees the @handle and how to invite it; a manager also
 *            sees who set it up, can rename it or change its picture
 *            (TASK-1171, `AgentSlackBotChanges`), and can disconnect it
 *            (TASK-1172): it leaves
 *            its channels and its Slack app is deleted. The Disconnect names
 *            the bot it showed by its install id, so a page drawn before the
 *            bot was replaced can't take the new one (the server says
 *            `no-bot`, and the page reads the status again); with no id (an
 *            older server) there is no Disconnect. A disconnect whose Slack
 *            app couldn't be deleted leaves the same kind of note a cancel
 *            does
 *
 * Asking an AX admin sends the name and nothing else: no token, no picture
 * (the admin's browser draws it at Approve).
 *
 * THE PASTED TOKEN NEVER LIVES IN REACT STATE. It is an uncontrolled password
 * input (as in Admin › Slack), read once on submit and cleared as the request
 * goes out, whatever Slack says. Nothing on the page ever shows a stored one:
 * the only fact the server gives is whether the viewer has one.
 *
 * Every sentence comes from `lib/agent-slack.ts` or the pinned copy below;
 * nothing from a response is shown but names (the bot's, its approver's) and
 * the handle Slack gave the bot.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { SlackAppsLink, TokenField } from '@/components/slack/SlackConfigToken';
import { BotChanges } from './AgentSlackBotChanges';
import {
  agentSlackBotErrorCopy,
  agentSlackBotStale,
  askSlackBotApproval,
  cancelSlackBot,
  cancelSlackBotRequest,
  continueSlackBot,
  disconnectSlackBot,
  requestSlackBot,
  slackShortDate,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { logRequestFailure } from '@/lib/http';
import { goToSlack } from '@/lib/slack-admin';
import { renderSlackAvatar } from '@/lib/slack-avatar';

/**
 * What a successful cancel (of a pending request) or disconnect (of a live
 * bot) said, and about whom. `appDeleted` false: its Slack
 * app may still be on Slack, where only `approver` (whose token made it) can
 * delete it. `approverIsViewer` is the pending view's `canContinue`, which is
 * also false for the approver while Slack isn't connected; they then read the
 * line that names them, which is still true.
 */
export interface BotCancelled {
  /** Which way the bot went: a pending request taken back, or a live bot disconnected. */
  how: 'cancelled' | 'disconnected';
  appDeleted: boolean;
  approverIsViewer: boolean;
  approver: string;
}

export interface AgentSlackBotProps {
  agentId: string;
  agentName: string;
  bot: Bot;
  /** Whether the viewer is a team admin of the agent's team (they may ask for, continue and cancel a bot). */
  canManage: boolean;
  /**
   * A cancel that left its Slack app behind, to say so above the request form.
   * Held by the caller: a cancel reads the status again, and this component
   * goes with the old picture.
   */
  leftOver: BotCancelled | null;
  /**
   * The shared app is connected, so the shared bot answers again in any channel
   * the agent was connected to through it once this bot goes (TASK-1172). Not
   * the listed channels: TASK-1168 drops a channel from that list once this bot
   * has answered there, but its shared binding stays. Only the Disconnect dialog
   * says so.
   */
  sharedConnected?: boolean;
  /** The request was cancelled or the bot disconnected (the status is read again right after). */
  onCancelled: (cancelled: BotCancelled) => void;
  /** A new bot is being asked for: whatever an old cancel left to say is moot. */
  onRequesting: () => void;
  /** The picture is out of date, or something changed: read the status again. */
  onChanged: () => void;
}

/** Who sets the bot up in Slack: an AX admin for the person, or the person themselves. */
type Way = 'admin' | 'self';

/** A button's busy face: a spinner and what it's doing. */
function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <Spinner data-icon="inline-start" aria-hidden="true" />
      {children}
    </>
  );
}

function Section({ description, children }: { description?: ReactNode; children: ReactNode }) {
  return (
    <Card variant="settings">
      <CardHeader>
        <CardTitle role="heading" aria-level={3} className="text-base">
          Its own Slack bot
        </CardTitle>
        {description !== undefined && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

/**
 * A cancelled request whose Slack app Slack wouldn't delete for us. The server
 * keeps it on Admin › Slack's list of leftover apps; the note says so, here,
 * because the pending view it came from is gone once the status is read again.
 * Exported for the no-workspace view, which shows no bot section once there is
 * no bot.
 */
export function AppLeftOverNote({ leftOver }: { leftOver: BotCancelled }) {
  return (
    <Alert>
      <AlertDescription>
        {leftOver.how === 'disconnected' ? 'We disconnected the bot' : 'We cancelled the request'}, but we
        couldn&apos;t confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn&apos;t delete.{' '}
        {/* Slack's app page lists only your own apps, so the link is only any use to the one who made it. */}
        {leftOver.approverIsViewer ? (
          <>
            Or delete it yourself: open it in <SlackAppsLink /> and click Delete App at the bottom of the page.
          </>
        ) : (
          `${leftOver.approver} set it up and can also delete it in Slack's app settings.`
        )}
      </AlertDescription>
    </Alert>
  );
}

export function AgentSlackBot({
  agentId,
  agentName,
  bot,
  canManage,
  sharedConnected = false,
  leftOver,
  onCancelled,
  onRequesting,
  onChanged,
}: AgentSlackBotProps) {
  switch (bot.state) {
    case 'none':
      return canManage ? (
        <RequestForm
          agentId={agentId}
          agentName={agentName}
          configTokenStored={bot.configTokenStored}
          notice={leftOver !== null && !leftOver.appDeleted ? <AppLeftOverNote leftOver={leftOver} /> : null}
          onRequesting={onRequesting}
          onChanged={onChanged}
        />
      ) : null;
    case 'requested':
      return canManage ? <Requested agentId={agentId} bot={bot} onChanged={onChanged} /> : null;
    case 'pending':
      return canManage ? (
        <Pending agentId={agentId} bot={bot} onCancelled={onCancelled} onChanged={onChanged} />
      ) : null;
    case 'live':
      return (
        <Live
          agentId={agentId}
          agentName={agentName}
          bot={bot}
          canManage={canManage}
          sharedConnected={sharedConnected}
          onCancelled={onCancelled}
          onChanged={onChanged}
        />
      );
  }
}

function RequestForm({
  agentId,
  agentName,
  configTokenStored,
  notice,
  onRequesting,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  configTokenStored: boolean;
  /** Something to say before the form: what a cancel just left behind. */
  notice: ReactNode;
  onRequesting: () => void;
  onChanged: () => void;
}) {
  const tokenRef = useRef<HTMLInputElement>(null);
  // Someone with a token on file has installed apps before; anyone else most likely can't.
  const [way, setWay] = useState<Way>(configTokenStored ? 'self' : 'admin');
  const [botName, setBotName] = useState(agentName);
  const [busy, setBusy] = useState(false);
  // A refusal that says "paste a token" shows the field even when one is stored.
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<{ field: 'botName' | 'refreshToken' | null; message: string } | null>(null);
  const showToken = way === 'self' && (!configTokenStored || revealed);

  // The token was cleared with the refused attempt, so the next step is pasting it again.
  useEffect(() => {
    if (revealed && error !== null && error.field === 'refreshToken') tokenRef.current?.focus();
  }, [revealed, error]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const pasted = showToken ? (tokenRef.current?.value ?? '').trim() : '';
    // Write-only: the token leaves the page with this request, whatever Slack says.
    if (tokenRef.current !== null) tokenRef.current.value = '';
    setBusy(true);
    setError(null);
    onRequesting();
    try {
      if (way === 'admin') {
        // The name only: no token, and no picture (the approving admin's browser draws it).
        await askSlackBotApproval(agentId, { botName });
        setBusy(false);
        onChanged();
        return;
      }
      // Best effort and never throws: no picture means the request goes on without one.
      const iconPng = await renderSlackAvatar();
      const { installUrl } = await requestSlackBot(agentId, {
        botName,
        ...(pasted !== '' ? { refreshToken: pasted } : {}),
        ...(iconPng !== null ? { iconPng } : {}),
      });
      // The page is leaving for Slack, so it stays busy.
      goToSlack(installUrl);
    } catch (err) {
      setBusy(false);
      logRequestFailure(err, 'agent-slack');
      if (agentSlackBotStale(err)) {
        onChanged();
        return;
      }
      const copy = agentSlackBotErrorCopy(err);
      if (copy.revealToken) setRevealed(true);
      setError({ field: copy.field, message: copy.message });
    }
  }

  const nameError = error !== null && error.field === 'botName' ? error.message : null;
  const tokenError = error !== null && error.field === 'refreshToken' ? error.message : null;
  const formError = error !== null && error.field === null ? error.message : null;

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Section
        description={`Give ${agentName} its own name in Slack. People mention it directly, and you add it to a channel with /invite. When someone outside the team mentions it, it answers them with your access.`}
      >
        {notice}
        <FieldSet>
          <FieldLegend variant="label">Who sets it up in Slack?</FieldLegend>
          <RadioGroup
            value={way}
            disabled={busy}
            onValueChange={(v) => {
              if (v === 'admin' || v === 'self') setWay(v);
            }}
          >
            <Field orientation="horizontal" data-disabled={busy || undefined}>
              <RadioGroupItem value="admin" id="slack-bot-way-admin" />
              <FieldContent>
                <FieldLabel htmlFor="slack-bot-way-admin">Ask an AX admin</FieldLabel>
                <FieldDescription>
                  We&apos;ll ask your AX admins. One of them approves it and finishes it in Slack, so you don&apos;t
                  need a token.
                </FieldDescription>
              </FieldContent>
            </Field>
            <Field orientation="horizontal" data-disabled={busy || undefined}>
              <RadioGroupItem value="self" id="slack-bot-way-self" />
              <FieldContent>
                <FieldLabel htmlFor="slack-bot-way-self">I can install apps in Slack</FieldLabel>
                <FieldDescription>
                  You set it up with your own Slack configuration token, then click Allow in Slack.
                </FieldDescription>
              </FieldContent>
            </Field>
          </RadioGroup>
          <FieldDescription>
            Either way, Slack has the final say: only someone allowed to install apps in your Slack workspace can add
            it.
          </FieldDescription>
        </FieldSet>
        {way === 'admin' ? null : showToken ? (
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>
              Open <SlackAppsLink />. Under <strong>Your App Configuration Tokens</strong>, click{' '}
              <strong>Generate Token</strong> for your workspace.
            </li>
            <li>
              Paste the refresh token below. We keep it for every Slack app you set up here, so you only do this
              once.
            </li>
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">We&apos;ll use the configuration token you gave us before.</p>
        )}
        <FieldGroup>
          {showToken && (
            <TokenField
              id="slack-bot-refresh-token"
              label="Refresh token"
              hint="Starts with xoxe-"
              inputRef={tokenRef}
              error={tokenError}
              disabled={busy}
              required
            />
          )}
          <Field data-invalid={nameError !== null || undefined}>
            <FieldLabel htmlFor="slack-agent-bot-name">Bot name</FieldLabel>
            <Input
              id="slack-agent-bot-name"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              disabled={busy}
              autoComplete="off"
              aria-invalid={nameError !== null || undefined}
              aria-describedby={nameError !== null ? 'slack-agent-bot-name-error' : undefined}
            />
            {nameError !== null && <FieldError id="slack-agent-bot-name-error">{nameError}</FieldError>}
          </Field>
        </FieldGroup>
        {formError !== null && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="submit" disabled={busy}>
            {way === 'admin' ? (
              busy ? (
                <Busy>Asking…</Busy>
              ) : (
                'Ask an AX admin'
              )
            ) : busy ? (
              <Busy>Creating…</Busy>
            ) : (
              'Create the Slack bot'
            )}
          </Button>
        </div>
      </Section>
    </form>
  );
}

/** Waiting for an AX admin. Nothing exists in Slack yet, so a cancel leaves nothing behind. */
function Requested({
  agentId,
  bot,
  onChanged,
}: {
  agentId: string;
  bot: Extract<Bot, { state: 'requested' }>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelSlackBotRequest(agentId);
      onChanged();
    } catch (err) {
      setBusy(false);
      logRequestFailure(err, 'agent-slack');
      if (agentSlackBotStale(err)) {
        onChanged();
        return;
      }
      setError(agentSlackBotErrorCopy(err).message);
    }
  }

  return (
    <Section>
      <p className="text-sm">Waiting for an AX admin to approve {bot.botName}.</p>
      <p className="text-[12.5px] text-muted-foreground">Asked on {slackShortDate(bot.requestedAt)}.</p>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button variant="outline" disabled={busy} onClick={() => void cancel()}>
          {busy ? <Busy>Cancelling…</Busy> : 'Cancel request'}
        </Button>
      </div>
    </Section>
  );
}

function Pending({
  agentId,
  bot,
  onCancelled,
  onChanged,
}: {
  agentId: string;
  bot: Extract<Bot, { state: 'pending' }>;
  onCancelled: (cancelled: BotCancelled) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'continue' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(which: 'continue' | 'cancel') {
    if (busy !== null) return;
    setBusy(which);
    setError(null);
    try {
      if (which === 'continue') {
        const { installUrl } = await continueSlackBot(agentId);
        // The page is leaving for Slack, so it stays busy.
        goToSlack(installUrl);
      } else {
        const { appDeleted } = await cancelSlackBot(agentId);
        onCancelled({ how: 'cancelled', appDeleted, approverIsViewer: bot.canContinue, approver: bot.approver });
        onChanged();
      }
    } catch (err) {
      setBusy(null);
      logRequestFailure(err, 'agent-slack');
      if (agentSlackBotStale(err)) {
        onChanged();
        return;
      }
      setError(agentSlackBotErrorCopy(err).message);
    }
  }

  return (
    <Section>
      <p className="text-sm">
        {bot.canContinue
          ? `Almost there: finish adding ${bot.botName} in Slack.`
          : `${bot.approver} is finishing this in Slack.`}
      </p>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {bot.canContinue && (
          <Button disabled={busy !== null} onClick={() => void run('continue')}>
            {busy === 'continue' ? <Busy>Opening Slack…</Busy> : 'Continue in Slack'}
          </Button>
        )}
        <Button variant="outline" disabled={busy !== null} onClick={() => void run('cancel')}>
          {busy === 'cancel' ? <Busy>Cancelling…</Busy> : 'Cancel request'}
        </Button>
      </div>
    </Section>
  );
}

function Live({
  agentId,
  agentName,
  bot,
  canManage,
  sharedConnected,
  onCancelled,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  bot: Extract<Bot, { state: 'live' }>;
  canManage: boolean;
  sharedConnected: boolean;
  onCancelled: (cancelled: BotCancelled) => void;
  onChanged: () => void;
}) {
  const handle = bot.handle;
  const [asking, setAsking] = useState(false);
  // The key the Disconnect takes: only a manager gets one, and with none there is nothing to name.
  const installId = canManage ? bot.installId : null;
  return (
    <Section>
      <p className="text-sm">
        {handle !== null
          ? `@${handle} is live. Invite it to a channel with /invite @${handle}.`
          : `${bot.botName} is live. Invite it to a channel with /invite.`}
      </p>
      {canManage && <p className="text-[12.5px] text-muted-foreground">Set up by {bot.approver}.</p>}
      {bot.needsClaim && (
        <p className="text-sm text-muted-foreground">
          {bot.botName} needs a team admin to claim it. Until then it answers team members only.
        </p>
      )}
      {canManage && <BotChanges agentId={agentId} bot={bot} onChanged={onChanged} />}
      {installId !== null && (
        <div>
          <Button variant="outline" onClick={() => setAsking(true)}>
            Disconnect bot
          </Button>
          <DisconnectBotDialog
            open={asking}
            onClose={() => setAsking(false)}
            agentId={agentId}
            agentName={agentName}
            bot={bot}
            installId={installId}
            sharedConnected={sharedConnected}
            onCancelled={onCancelled}
            onChanged={onChanged}
          />
        </div>
      )}
    </Section>
  );
}

/**
 * Asks before taking a live bot away: it leaves its channels, and its Slack
 * app is deleted. Confirming names the bot the dialog shows by `installId`.
 */
function DisconnectBotDialog({
  open,
  onClose,
  agentId,
  agentName,
  bot,
  installId,
  sharedConnected,
  onCancelled,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  bot: Extract<Bot, { state: 'live' }>;
  /** The install id of `bot`, the one this dialog names. */
  installId: string;
  sharedConnected: boolean;
  onCancelled: (cancelled: BotCancelled) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = bot.handle !== null ? `@${bot.handle}` : bot.botName;

  const close = (next: boolean) => {
    if (busy || next) return;
    setError(null);
    onClose();
  };

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { appDeleted } = await disconnectSlackBot(agentId, installId);
      // The bot is gone: say how it went before the status is read again and this section goes with it.
      onCancelled({ how: 'disconnected', appDeleted, approverIsViewer: false, approver: bot.approver });
      onChanged();
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      if (agentSlackBotStale(err)) {
        setError(null);
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
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Disconnect ${who}?`}</DialogTitle>
          <DialogDescription>
            {`${bot.botName} leaves every Slack channel it's in, and ${bot.handle !== null ? `@${bot.handle}` : 'mentioning it'} stops working. We'll delete its Slack app.`}
            {sharedConnected ? ` The shared bot answers for ${agentName} again in any channel it was connected to before.` : ''}
          </DialogDescription>
        </DialogHeader>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Busy>Disconnecting…</Busy> : 'Disconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
