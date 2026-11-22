/**
 * An agent's Slack card (TASK-1167, TASK-1187): one card in a team agent's
 * Slack settings for the agent's own bot, the one people mention directly in
 * Slack. Its title says where things stand, in a sentence; what a person can
 * do about it is the one button for the next step, or an item in the card's ⋯
 * (`AgentSlackMenu`).
 *
 * What `bot` says (the status `GET /settings/slack/:agentId` carries) decides
 * the state:
 *   none     Not in Slack. A manager reads "<agent> isn't in Slack yet" and
 *            gets the bot's name (the agent's, or the one Set up again took
 *            away) and "Add to Slack", which by default asks an admin. A quiet
 *            link, "I can install Slack apps myself", switches to the
 *            install-it-myself path: the steps and the field to paste a
 *            configuration token into, unless the server holds one for the
 *            person. The form opens on that path when it does (they have
 *            installed Slack apps here before, and asking an admin could mean
 *            asking themselves); "Ask an admin instead" switches back.
 *   requested Waiting for an admin to approve it. The ⋯ holds "Cancel
 *            request" (no Slack app exists yet, so nothing is left over).
 *   pending  Almost there: the person who started it finishes it with
 *            "Continue in Slack", and any other manager reads who is finishing
 *            it. The ⋯ holds "Cancel request", which names the pending bot by
 *            its install id (with none, from an older server, there is no ⋯).
 *            A cancel whose Slack app couldn't be deleted leaves a note
 *            saying where to find it.
 *   live     the title is "<@handle> is in Slack" and the line under it says
 *            how to invite it. A manager's ⋯ holds Rename, Change picture
 *            (TASK-1171, `AgentSlackBotChanges`) and Remove from Slack
 *            (TASK-1172): it leaves its channels and its Slack app is deleted.
 *            Remove names the bot it showed by its install id, so a page drawn
 *            before the bot was replaced can't take the new one (the server
 *            says `no-bot`, and the page reads the status again); with no id
 *            (an older server) there is no Remove. A removal whose Slack app
 *            couldn't be deleted leaves the same kind of note a cancel does.
 *            The channels the bot has answered in sit inside the card
 *            (`AgentSlackBotChannels`), then a help line on who is asked when
 *            it needs an OK.
 *   live, with a problem (TASK-1173, TASK-1187): a problem shows only when
 *            there is one, as a row with its sentence and at most one button.
 *            The person who added it has left: it needs to be set up again
 *            (a manager, while Slack is connected, gets "Set up again": remove
 *            it, then ask for a new one with the old name offered back); this
 *            row shows alone, because setting it up again fixes the rest. The
 *            person who asked for it is no longer a team admin: people outside
 *            the team can't use it, and a manager gets "Take over". A change
 *            (rename, picture) refused because the bot's Slack token stopped
 *            working: the card says changes can't reach Slack, and the person
 *            who set it up gets "Reconnect" (the status says nothing about the
 *            token, so this appears only once a change has found it dead).
 *            Both name the bot the page showed by its install id
 *            (`AgentSlackBotLifecycle`).
 *
 * Until the bot is live, anyone who doesn't manage the agent sees only that it
 * isn't in Slack yet and that a team admin can add it: a request is the
 * managers' business.
 *
 * Asking an admin sends the name and nothing else: no token, no picture (the
 * admin's browser draws it at Approve).
 *
 * THE PASTED TOKEN NEVER LIVES IN REACT STATE. It is an uncontrolled password
 * input (as in Admin › Slack), read once on submit and cleared as the request
 * goes out, whatever Slack says; switching to asking an admin unmounts it with
 * whatever was pasted. Nothing on the page ever shows a stored one: the only
 * fact the server gives is whether the viewer has one.
 *
 * Every sentence comes from `lib/agent-slack.ts` (the card's own are
 * `AGENT_SLACK_CARD_COPY`) or the pinned copy below; nothing from a response
 * is shown but names (the bot's, its approver's) and the handle Slack gave the
 * bot. Not in Slack and Waiting never name a role, the plumbing or the product;
 * the install-it-myself path is where the token words belong (the words scan
 * is in `AgentSlack.test.tsx`).
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
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { SlackAppsLink, TokenField } from '@/components/slack/SlackConfigToken';
import { AgentSlackMenu } from './AgentSlackMenu';
import { AgentSlackBotChannels } from './AgentSlackBotChannels';
import { PictureDialog, ReconnectDialog, RenameDialog } from './AgentSlackBotChanges';
import { ClaimBotDialog, RebuildBotDialog, rebuildWho, type RebuildFrom } from './AgentSlackBotLifecycle';
import {
  AGENT_SLACK_BOT_CHANGE_COPY,
  AGENT_SLACK_CARD_COPY,
  agentSlackBotErrorCopy,
  agentSlackBotStale,
  askSlackBotApproval,
  botWho,
  cancelSlackBot,
  cancelSlackBotRequest,
  continueSlackBot,
  disconnectSlackBot,
  requestSlackBot,
  slackShortDate,
  type AgentSlackBot as Bot,
  type BotChannelRow,
} from '@/lib/agent-slack';
import { RESOLUTION_FOCUS_RING } from '@/lib/consent-focus';
import { logRequestFailure } from '@/lib/http';
import { goToSlack } from '@/lib/slack-admin';
import { renderSlackAvatar } from '@/lib/slack-avatar';
import { cn } from '@/lib/utils';
import { BOT_TOKEN_COPY } from '@/lib/slack-token-copy';

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
  /**
   * The approver has left the team, so there is nobody to name: the left-over
   * note doesn't send anyone to them to delete the app (TASK-1173).
   */
  approverGone?: boolean;
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
   * The bot Set up again just took away, so the request form can offer its name
   * back and say it was removed from Slack (TASK-1173). Held by the caller for
   * the same reason as `leftOver`.
   */
  rebuilding: RebuildFrom | null;
  /** The channels the live bot has answered in, drawn inside its card (live only). */
  channels?: BotChannelRow[];
  /**
   * Slack is connected. A bot request needs it, so Set up again (which ends in a
   * new request) is offered only then.
   */
  sharedConnected?: boolean;
  /** The request was cancelled or the bot disconnected (the status is read again right after). */
  onCancelled: (cancelled: BotCancelled) => void;
  /** Set up again removed the bot: remember which one, for the form that follows. */
  onRebuilt: (from: RebuildFrom) => void;
  /** A new bot is being asked for: whatever an old cancel left to say is moot. */
  onRequesting: () => void;
  /** The picture is out of date, or something changed: read the status again. */
  onChanged: () => void;
}

/** Who adds the bot in Slack: an admin, asked for the person, or the person themselves (the install-it-myself path). */
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

/**
 * The frame every state draws (TASK-1187). The title is where things stand, in
 * a sentence and as a heading, so a screen reader hears the state when it moves
 * by heading; the ⋯, when there is one, sits on its right.
 */
function SlackCard({
  title,
  description,
  menu,
  children,
}: {
  title: string;
  description?: ReactNode;
  menu?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card variant="settings">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-3">
          <CardTitle role="heading" aria-level={3} className="text-base">
            {title}
          </CardTitle>
          {description !== undefined && <CardDescription>{description}</CardDescription>}
        </div>
        {menu}
      </CardHeader>
      {children !== undefined && <CardContent className="flex flex-col gap-4">{children}</CardContent>}
    </Card>
  );
}

/** A cancel on its way: a quiet status line. The spinner is decoration, so its own status role stays hidden. */
function Cancelling() {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner aria-hidden="true" />
      {AGENT_SLACK_CARD_COPY.cancelling}
    </p>
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
        {leftOver.how === 'disconnected' ? 'We removed the bot from Slack' : 'We cancelled the request'}, but we
        couldn&apos;t confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn&apos;t delete.{' '}
        {/* Slack's app page lists only your own apps, so the link is only any use to the one who made it. */}
        {leftOver.approverIsViewer ? (
          <>
            Or delete it yourself: open it in <SlackAppsLink /> and click Delete App at the bottom of the page.
          </>
        ) : leftOver.approverGone === true ? null : (
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
  channels = [],
  leftOver,
  rebuilding,
  onCancelled,
  onRebuilt,
  onRequesting,
  onChanged,
}: AgentSlackBotProps) {
  // Until it's live, someone who doesn't manage the agent learns only that, and who can change it.
  if (!canManage && bot.state !== 'live') {
    return (
      <SlackCard title={AGENT_SLACK_CARD_COPY.notInSlack(agentName)} description={AGENT_SLACK_CARD_COPY.teamAdminCanAdd} />
    );
  }
  switch (bot.state) {
    case 'none':
      return (
        <RequestForm
          agentId={agentId}
          agentName={agentName}
          configTokenStored={bot.configTokenStored}
          initialBotName={rebuilding?.botName}
          notice={
            <>
              {rebuilding !== null && (
                <Alert>
                  <AlertDescription>{AGENT_SLACK_CARD_COPY.removedNotice(rebuildWho(rebuilding))}</AlertDescription>
                </Alert>
              )}
              {leftOver !== null && !leftOver.appDeleted && <AppLeftOverNote leftOver={leftOver} />}
            </>
          }
          onRequesting={onRequesting}
          onChanged={onChanged}
        />
      );
    case 'requested':
      return <Requested agentId={agentId} bot={bot} onChanged={onChanged} />;
    case 'pending':
      return <Pending agentId={agentId} bot={bot} onCancelled={onCancelled} onChanged={onChanged} />;
    case 'live':
      return (
        <Live
          agentId={agentId}
          agentName={agentName}
          bot={bot}
          canManage={canManage}
          sharedConnected={sharedConnected}
          channels={channels}
          onCancelled={onCancelled}
          onRebuilt={onRebuilt}
          onChanged={onChanged}
        />
      );
  }
}

function RequestForm({
  agentId,
  agentName,
  configTokenStored,
  initialBotName,
  notice,
  onRequesting,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  configTokenStored: boolean;
  /** The name to start with: the one Set up again took away, else the agent's. */
  initialBotName?: string | undefined;
  /** Something to say before the form: what a cancel just left behind. */
  notice: ReactNode;
  onRequesting: () => void;
  onChanged: () => void;
}) {
  const tokenRef = useRef<HTMLInputElement>(null);
  // Someone with a token on file has installed apps before; anyone else most likely can't.
  const [way, setWay] = useState<Way>(configTokenStored ? 'self' : 'admin');
  const [botName, setBotName] = useState(initialBotName ?? agentName);
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
      <SlackCard title={AGENT_SLACK_CARD_COPY.notInSlack(agentName)} description={AGENT_SLACK_CARD_COPY.addItLead}>
        {notice}
        <FieldGroup className="gap-4">
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
          {/* The install-it-myself path: the one place on the card the token words belong. */}
          {way === 'self' &&
            (showToken ? (
              <>
                <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
                  <li>
                    Open <SlackAppsLink />. Under <strong>Your App Configuration Tokens</strong>, click{' '}
                    <strong>Generate Token</strong> for your workspace.
                  </li>
                  <li>
                    Paste the refresh token below. We keep it for every Slack app you set up here, so you only do
                    this once.
                  </li>
                </ol>
                <TokenField
                  id="slack-bot-refresh-token"
                  label="Refresh token"
                  hint="Starts with xoxe-"
                  inputRef={tokenRef}
                  error={tokenError}
                  disabled={busy}
                  required
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                We&apos;ll use the configuration token you gave us before.
              </p>
            ))}
          {way === 'self' && <p className="text-sm text-muted-foreground">{AGENT_SLACK_CARD_COPY.slackHasFinalSay}</p>}
        </FieldGroup>
        {formError !== null && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" className="self-start" disabled={busy}>
          {busy ? <Busy>{way === 'admin' ? 'Asking…' : 'Adding…'}</Busy> : 'Add to Slack'}
        </Button>
        {way === 'admin' && <p className="text-sm text-muted-foreground">{AGENT_SLACK_CARD_COPY.adminWillApprove}</p>}
        {/* One link that flips the way, so focus stays on it when its words change. Not a submit: type="button". */}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto self-start p-0"
          disabled={busy}
          onClick={() => {
            // The old way's refusal (form-level or under a field) is not this way's.
            setError(null);
            setWay(way === 'admin' ? 'self' : 'admin');
          }}
        >
          {way === 'admin' ? AGENT_SLACK_CARD_COPY.selfPathLink : AGENT_SLACK_CARD_COPY.adminPathLink}
        </Button>
        <p className="text-sm text-muted-foreground">{AGENT_SLACK_CARD_COPY.memoryShared(agentName)}</p>
        <p className="text-sm text-muted-foreground">{AGENT_SLACK_CARD_COPY.outsidersUseYourAccess}</p>
        <p className="text-[12.5px] text-muted-foreground">{AGENT_SLACK_CARD_COPY.helpLine(agentName)}</p>
      </SlackCard>
    </form>
  );
}

/** Waiting for an admin. Nothing exists in Slack yet, so a cancel leaves nothing behind. */
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
    <SlackCard
      title={AGENT_SLACK_CARD_COPY.waitingForAdmin(bot.botName)}
      description={AGENT_SLACK_CARD_COPY.askedOn(slackShortDate(bot.requestedAt), bot.botName)}
      menu={
        <AgentSlackMenu
          label={`Actions for ${bot.botName}`}
          disabled={busy}
          items={[{ label: 'Cancel request', onSelect: () => void cancel() }]}
        />
      }
    >
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {busy && <Cancelling />}
    </SlackCard>
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

  // Cancel names the pending bot this page showed, so a stale tab can't take back a newer request (TASK-1173).
  const { installId } = bot;

  async function run(which: 'continue' | 'cancel') {
    if (busy !== null || (which === 'cancel' && installId === null)) return;
    setBusy(which);
    setError(null);
    try {
      if (which === 'continue') {
        const { installUrl } = await continueSlackBot(agentId);
        // The page is leaving for Slack, so it stays busy.
        goToSlack(installUrl);
      } else if (installId !== null) {
        const { appDeleted } = await cancelSlackBot(agentId, installId);
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
    <SlackCard
      title={
        bot.canContinue
          ? AGENT_SLACK_CARD_COPY.finishInSlack(bot.botName)
          : AGENT_SLACK_CARD_COPY.waitingForPerson(bot.approver, bot.botName)
      }
      menu={
        <AgentSlackMenu
          label={`Actions for ${bot.botName}`}
          disabled={busy !== null}
          // No install id (an older server): nothing to name, so no Cancel request, and so no ⋯.
          items={installId !== null ? [{ label: 'Cancel request', onSelect: () => void run('cancel') }] : []}
        />
      }
    >
      {bot.canContinue && (
        <Button className="self-start" disabled={busy !== null} onClick={() => void run('continue')}>
          {busy === 'continue' ? <Busy>Opening Slack…</Busy> : 'Continue in Slack'}
        </Button>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {busy === 'cancel' && <Cancelling />}
    </SlackCard>
  );
}

type LiveBot = Extract<Bot, { state: 'live' }>;
type LiveDialog = 'rename' | 'picture' | 'reconnect' | 'remove' | 'setUpAgain' | 'takeOver';
interface Problem {
  key: string;
  text: string;
  action: { label: string; dialog: LiveDialog } | null;
}

/**
 * What is wrong with a live bot, in the order the card shows it, each with at
 * most one action. The person who added it having left shows alone: setting it
 * up again fixes everything below it. `tokenDead` is the card's own knowledge,
 * from a change that was refused (the status never says).
 */
function problems({
  bot,
  who,
  canManage,
  installId,
  sharedConnected,
  tokenDead,
}: {
  bot: LiveBot;
  who: string;
  canManage: boolean;
  installId: string | null;
  sharedConnected: boolean;
  tokenDead: boolean;
}): Problem[] {
  const C = AGENT_SLACK_CARD_COPY;
  if (bot.approverGone) {
    const canSetUpAgain = installId !== null && sharedConnected;
    return [
      {
        key: 'set-up-again',
        text:
          C.setUpAgain(who) +
          (canSetUpAgain ? '' : canManage && !sharedConnected ? C.onceSlackIsBack : C.teamAdminCanFix),
        action: canSetUpAgain ? { label: 'Set up again', dialog: 'setUpAgain' } : null,
      },
    ];
  }
  const rows: Problem[] = [];
  if (tokenDead) {
    rows.push(
      canManage && bot.viewerIsApprover
        ? { key: 'token', text: C.changesCantReach(who), action: { label: 'Reconnect', dialog: 'reconnect' } }
        : { key: 'token', text: C.askToReconnect(who, bot.approver), action: null },
    );
  }
  if (bot.needsClaim) {
    rows.push({
      key: 'take-over',
      text: C.outsidersCantUse(who) + (installId !== null ? '' : C.teamAdminCanFix),
      action: installId !== null ? { label: 'Take over', dialog: 'takeOver' } : null,
    });
  }
  return rows;
}

function Live({
  agentId,
  agentName,
  bot,
  canManage,
  sharedConnected,
  channels,
  onCancelled,
  onRebuilt,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  bot: LiveBot;
  canManage: boolean;
  sharedConnected: boolean;
  channels: BotChannelRow[];
  onCancelled: (cancelled: BotCancelled) => void;
  onRebuilt: (from: RebuildFrom) => void;
  onChanged: () => void;
}) {
  const who = botWho(bot);
  const [dialog, setDialog] = useState<LiveDialog | null>(null);
  // A refused rename or picture change found the bot's Slack token dead; held until the status is read again.
  const [tokenDead, setTokenDead] = useState(false);
  // What just landed without a re-read: a picture, or a token. Opening any dialog clears it.
  const [saved, setSaved] = useState<'picture' | 'token' | null>(null);
  const open = (d: LiveDialog) => {
    setSaved(null);
    setDialog(d);
  };
  // A reconnect unmounts the token row that held the Reconnect button the dialog would return focus to, so the notice takes it.
  const savedNotice = useRef<HTMLDivElement>(null);
  const focusSavedNotice = (e: Event) => {
    if (savedNotice.current === null) return;
    e.preventDefault();
    savedNotice.current.focus();
  };
  const closeDialog = (next: boolean) => {
    if (!next) setDialog(null);
  };
  // The key Remove from Slack, Set up again and Take over take: only a manager gets one, and with none there is nothing to name.
  const installId = canManage ? bot.installId : null;
  const C = AGENT_SLACK_CARD_COPY;
  const rows = problems({ bot, who, canManage, installId, sharedConnected, tokenDead });
  return (
    <SlackCard
      title={C.inSlack(who)}
      description={
        bot.handle !== null ? (
          <>
            {C.inviteLead}
            <code className="font-mono">/invite @{bot.handle}</code>
          </>
        ) : (
          C.inviteNoHandle
        )
      }
      menu={
        canManage ? (
          <AgentSlackMenu
            label={`Actions for ${who}`}
            items={[
              { label: 'Rename', onSelect: () => open('rename') },
              { label: 'Change picture', onSelect: () => open('picture') },
              ...(installId !== null
                ? [{ label: 'Remove from Slack', onSelect: () => open('remove'), destructive: true }]
                : []),
            ]}
          />
        ) : undefined
      }
    >
      {rows.map((row) => {
        const action = row.action;
        return (
          <Alert key={row.key}>
            <AlertDescription className="flex flex-col items-start gap-3">
              <p>{row.text}</p>
              {action !== null && (
                <Button variant="outline" size="sm" onClick={() => open(action.dialog)}>
                  {action.label}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        );
      })}
      {saved !== null && (
        // Where focus lands after a Reconnect: a visible ring for a keyboard user (the TASK-427 landing rule).
        <Alert ref={savedNotice} tabIndex={-1} className={cn('rounded-sm', RESOLUTION_FOCUS_RING)}>
          <AlertDescription>
            {saved === 'picture' ? AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged : BOT_TOKEN_COPY.replaced(bot.botName)}
          </AlertDescription>
        </Alert>
      )}
      {channels.length > 0 && (
        <AgentSlackBotChannels invite={bot} channels={channels} />
      )}
      <p className="text-[12.5px] text-muted-foreground">{C.memoryShared(agentName)}</p>
      <p className="text-[12.5px] text-muted-foreground">{C.helpLine(who)}</p>
      {canManage && (
        <>
          <RenameDialog
            open={dialog === 'rename'}
            onOpenChange={closeDialog}
            agentId={agentId}
            bot={bot}
            onTokenDead={() => setTokenDead(true)}
            onChanged={onChanged}
          />
          <PictureDialog
            open={dialog === 'picture'}
            onOpenChange={closeDialog}
            agentId={agentId}
            bot={bot}
            onTokenDead={() => setTokenDead(true)}
            onSaved={() => setSaved('picture')}
            onChanged={onChanged}
          />
          <ReconnectDialog
            open={dialog === 'reconnect'}
            onOpenChange={closeDialog}
            agentId={agentId}
            bot={bot}
            onReconnected={() => {
              setTokenDead(false);
              setSaved('token');
            }}
            onCloseAutoFocus={focusSavedNotice}
            onStale={onChanged}
          />
        </>
      )}
      {installId !== null && (
        <>
          <DisconnectBotDialog
            open={dialog === 'remove'}
            onClose={() => setDialog(null)}
            agentId={agentId}
            bot={bot}
            installId={installId}
            onCancelled={onCancelled}
            onChanged={onChanged}
          />
          <RebuildBotDialog
            open={dialog === 'setUpAgain'}
            onClose={() => setDialog(null)}
            agentId={agentId}
            bot={bot}
            installId={installId}
            onCancelled={onCancelled}
            onRebuilt={onRebuilt}
            onChanged={onChanged}
          />
          <ClaimBotDialog
            open={dialog === 'takeOver'}
            onClose={() => setDialog(null)}
            agentId={agentId}
            bot={bot}
            installId={installId}
            onChanged={onChanged}
          />
        </>
      )}
    </SlackCard>
  );
}

/**
 * Asks before removing a live bot from Slack: it leaves its channels, and its Slack
 * app is deleted. Confirming names the bot the dialog shows by `installId`.
 */
function DisconnectBotDialog({
  open,
  onClose,
  agentId,
  bot,
  installId,
  onCancelled,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  bot: Extract<Bot, { state: 'live' }>;
  /** The install id of `bot`, the one this dialog names. */
  installId: string;
  onCancelled: (cancelled: BotCancelled) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = botWho(bot);

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
      onCancelled({
        how: 'disconnected',
        appDeleted,
        approverIsViewer: bot.viewerIsApprover,
        approver: bot.approver,
        approverGone: bot.approverGone,
      });
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
          <DialogTitle>{`Remove ${who} from Slack?`}</DialogTitle>
          <DialogDescription>
            {`${bot.botName} leaves every Slack channel it's in, and ${bot.handle !== null ? `@${bot.handle}` : 'mentioning it'} stops working. We'll delete its Slack app.`}
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
            {busy ? <Busy>Removing…</Busy> : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
