/**
 * "Its own Slack bot" in a team agent's Slack settings (TASK-1167): give the
 * agent its own name in Slack, so people mention it directly instead of going
 * through the shared bot.
 *
 * What `bot` says (the status `GET /settings/slack/:agentId` carries) decides
 * what shows:
 *   none     a manager sees the form: the bot's name, and, only if the server
 *            holds no configuration token for them, the steps and the field to
 *            paste one into; everyone else sees nothing
 *   pending  a manager sees where it stands, with "Continue in Slack" for the
 *            person who started it, and "Cancel request"; a cancel whose Slack
 *            app couldn't be deleted leaves a note saying where to find it
 *   live     everyone sees the @handle and how to invite it; a manager also
 *            sees who set it up
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
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { SlackAppsLink, TokenField } from '@/components/slack/SlackConfigToken';
import {
  agentSlackBotErrorCopy,
  agentSlackBotStale,
  cancelSlackBot,
  continueSlackBot,
  requestSlackBot,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { logRequestFailure } from '@/lib/http';
import { goToSlack } from '@/lib/slack-admin';
import { renderSlackAvatar } from '@/lib/slack-avatar';

/**
 * What a successful cancel said, and about whom. `appDeleted` false: its Slack
 * app may still be on Slack, where only `approver` (whose token made it) can
 * delete it. `approverIsViewer` is the pending view's `canContinue`, which is
 * also false for the approver while Slack isn't connected; they then read the
 * line that names them, which is still true.
 */
export interface BotCancelled {
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
  /** The request was cancelled (the status is read again right after). */
  onCancelled: (cancelled: BotCancelled) => void;
  /** A new bot is being asked for: whatever an old cancel left to say is moot. */
  onRequesting: () => void;
  /** The picture is out of date, or something changed: read the status again. */
  onChanged: () => void;
}

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
        We cancelled the request, but we couldn&apos;t confirm its Slack app was deleted, so it may still be on
        Slack. An admin can find it in Admin › Slack, under the apps we couldn&apos;t delete.{' '}
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
    case 'pending':
      return canManage ? (
        <Pending agentId={agentId} bot={bot} onCancelled={onCancelled} onChanged={onChanged} />
      ) : null;
    case 'live':
      return <Live bot={bot} canManage={canManage} />;
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
  const [botName, setBotName] = useState(agentName);
  const [busy, setBusy] = useState(false);
  // A refusal that says "paste a token" shows the field even when one is stored.
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<{ field: 'botName' | 'refreshToken' | null; message: string } | null>(null);
  const showToken = !configTokenStored || revealed;

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
        description={`Give ${agentName} its own name in Slack. People mention it directly, and you add it to a channel with /invite. When someone outside the team mentions it, it answers them with your access. You need to be able to install apps in Slack.`}
      >
        {notice}
        {showToken ? (
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
            {busy ? <Busy>Creating…</Busy> : 'Create the Slack bot'}
          </Button>
        </div>
      </Section>
    </form>
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
        onCancelled({ appDeleted, approverIsViewer: bot.canContinue, approver: bot.approver });
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

function Live({ bot, canManage }: { bot: Extract<Bot, { state: 'live' }>; canManage: boolean }) {
  const handle = bot.handle;
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
    </Section>
  );
}
