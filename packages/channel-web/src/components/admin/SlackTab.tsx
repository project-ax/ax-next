/**
 * SlackTab — Admin › Slack (TASK-1093).
 *
 * Connect one Slack workspace so people can DM the bot to talk to their own
 * agent, see whose configuration token is in use, and disconnect. The routes
 * live in @ax/channel-slack; every request goes through `lib/slack-admin.ts`,
 * and every sentence an error becomes comes from there too.
 *
 * What `GET /admin/slack` says decides what shows:
 *   unavailable    this server doesn't run Slack: one line, nothing to press
 *   not-connected  the three steps and the form, or, without a public https
 *                  address, why Slack can't reach us yet (and no form)
 *   pending        the app exists but nobody clicked Allow: continue or cancel
 *   connected      the workspace, the bot, who added the token and when
 *
 * THE TWO PASTED TOKENS NEVER LIVE IN REACT STATE. They are uncontrolled
 * password inputs (so React never writes them into a `value` attribute),
 * read once on submit and cleared as the request goes out, whatever Slack
 * says. Nothing on the page holds them afterwards, and nothing ever shows the
 * stored one. Connect hands the page to Slack's Allow page; Slack sends the
 * admin back to `/?slack=…`, which App.tsx turns into a toast and this tab.
 *
 * After a disconnect one step is the admin's alone: revoking the
 * configuration token on Slack's own page (Slack has no API for it). The
 * alert that says so stays until they leave the tab.
 *
 * Card titles carry `role="heading"` (level 2) so the outline stays h1 -> h2
 * without the `h5` that `AlertTitle` would add (see TASK-446).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { MessageSquare } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  connectSlack,
  disconnectSlack,
  fetchSlackStatus,
  goToSlack,
  resumeSlackInstall,
  slackErrorCopy,
  slackStateChanged,
  type SlackErrorField,
  type SlackStatus,
  type SlackStatusRead,
} from '@/lib/slack-admin';

const SLACK_APPS_URL = 'https://api.slack.com/apps';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; status: SlackStatusRead };

/** A note above the tab that outlives the re-read after it. */
type Notice = { kind: 'disconnected'; appDeleted: boolean } | { kind: 'changed' };

interface Actions {
  /** A disconnect went through: say what's left to do, then read again. */
  onDisconnected: (appDeleted: boolean) => void;
  /** Someone else changed things first: read again, and say why it moved. */
  onChanged: () => void;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function SlackAppsLink() {
  return (
    <a
      href={SLACK_APPS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-4"
    >
      Slack&apos;s app settings
    </a>
  );
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

// ── Around the states ──────────────────────────────────────────────────────

function Loading() {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">Loading Slack settings…</span>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-10 w-full" aria-hidden="true" />
      ))}
    </div>
  );
}

function ReadError({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>We couldn&apos;t load your Slack settings.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function DisconnectedNotice({ appDeleted }: { appDeleted: boolean }) {
  return (
    <Alert>
      <AlertDescription className="flex flex-col gap-2">
        <p>
          Slack is disconnected. One more step only you can do: on <SlackAppsLink />, under{' '}
          <strong>Your App Configuration Tokens</strong>, click <strong>Revoke</strong>. Slack doesn&apos;t let
          us do that part.
        </p>
        {!appDeleted && <p>We couldn&apos;t remove the Slack app itself. Delete it on the same page.</p>}
      </AlertDescription>
    </Alert>
  );
}

// ── The states ─────────────────────────────────────────────────────────────

function Unavailable() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquare aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Slack isn&apos;t set up on this server.</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function NeedsHttps() {
  return (
    <Alert>
      <AlertDescription>
        Slack needs a public https address to reach this server, and the server doesn&apos;t have one yet.
        Whoever runs it can add one with{' '}
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">onboarding.publicBaseUrl</code> in
        the Helm values.
      </AlertDescription>
    </Alert>
  );
}

/**
 * A write-only field for one pasted configuration token. It is a password
 * field so the token isn't shown, which also makes password managers offer to
 * save it: the `data-*ignore` attributes tell 1Password, LastPass and
 * Bitwarden to leave it alone (`autoComplete="off"` alone doesn't stop them).
 */
function TokenField({
  id,
  label,
  hint,
  inputRef,
  error,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  inputRef: RefObject<HTMLInputElement | null>;
  error: string | null;
  disabled: boolean;
}) {
  const invalid = error !== null;
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        ref={inputRef}
        type="password"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        spellCheck={false}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-hint ${id}-error` : `${id}-hint`}
      />
      <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      {invalid && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

function ConnectForm({ defaultBotName, onChanged }: { defaultBotName: string; onChanged: () => void }) {
  const accessRef = useRef<HTMLInputElement>(null);
  const refreshRef = useRef<HTMLInputElement>(null);
  const [botName, setBotName] = useState(defaultBotName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: SlackErrorField; message: string } | null>(null);

  // Both tokens were cleared with the failed attempt, so the next step is
  // pasting the first one again.
  useEffect(() => {
    if (error !== null) accessRef.current?.focus();
  }, [error]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const accessToken = (accessRef.current?.value ?? '').trim();
    const refreshToken = (refreshRef.current?.value ?? '').trim();
    // Write-only: the tokens leave the page with this request, whatever Slack says.
    if (accessRef.current !== null) accessRef.current.value = '';
    if (refreshRef.current !== null) refreshRef.current.value = '';
    setBusy(true);
    setError(null);
    try {
      const { installUrl } = await connectSlack({ accessToken, refreshToken, botName });
      // The page is leaving for Slack, so it stays busy.
      goToSlack(installUrl);
    } catch (err) {
      setBusy(false);
      if (slackStateChanged(err)) {
        onChanged();
        return;
      }
      setError(slackErrorCopy(err));
    }
  }

  const fieldError = (field: SlackErrorField): string | null =>
    error !== null && error.field === field ? error.message : null;
  const nameError = fieldError('botName');

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Card variant="settings">
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="text-lg">
            Connect a Slack workspace
          </CardTitle>
          <CardDescription>People can then DM the bot to talk to their own agent.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>
              Open <SlackAppsLink />. Under <strong>Your App Configuration Tokens</strong>, click{' '}
              <strong>Generate Token</strong> for your workspace.
            </li>
            <li>Paste both values below. We keep only the refresh token, encrypted, and nobody can read it back.</li>
            <li>
              Pick the bot&apos;s name and click <strong>Connect</strong>. Slack will ask you to{' '}
              <strong>Allow</strong> it.
            </li>
          </ol>
          <FieldGroup>
            <TokenField
              id="slack-access-token"
              label="Access token"
              hint="Starts with xoxe.xoxp-"
              inputRef={accessRef}
              error={fieldError('accessToken')}
              disabled={busy}
            />
            <TokenField
              id="slack-refresh-token"
              label="Refresh token"
              hint="Starts with xoxe-"
              inputRef={refreshRef}
              error={fieldError('refreshToken')}
              disabled={busy}
            />
            <Field data-invalid={nameError !== null || undefined}>
              <FieldLabel htmlFor="slack-bot-name">Bot name</FieldLabel>
              <Input
                id="slack-bot-name"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                disabled={busy}
                aria-invalid={nameError !== null || undefined}
                aria-describedby={nameError !== null ? 'slack-bot-name-hint slack-bot-name-error' : 'slack-bot-name-hint'}
              />
              <FieldDescription id="slack-bot-name-hint">The name people see in Slack.</FieldDescription>
              {nameError !== null && <FieldError id="slack-bot-name-error">{nameError}</FieldError>}
            </Field>
          </FieldGroup>
          <p className="text-sm text-muted-foreground">
            Slack keeps a copy of everything the agent says there, under your workspace&apos;s retention rules.
          </p>
          {error !== null && error.field === null && (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={busy}>
            {busy ? <Busy>Connecting…</Busy> : 'Connect'}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

const DIALOG_COPY = {
  connected: {
    title: 'Disconnect Slack?',
    body: "The bot leaves Slack and people can't reach their agents there. Every channel connected to an agent is disconnected too. Their conversations stay here.",
    keep: 'Keep connected',
    confirm: 'Disconnect',
    working: 'Disconnecting…',
  },
  // Nobody could reach an agent yet, so the words are about the app we started.
  pending: {
    title: 'Stop connecting Slack?',
    body: "We'll delete the Slack app we started. You can connect again any time.",
    keep: 'Keep going',
    confirm: 'Stop connecting',
    working: 'Stopping…',
  },
} as const;

function DisconnectDialog({
  open,
  onOpenChange,
  kind,
  onDisconnected,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: keyof typeof DIALOG_COPY;
} & Actions) {
  const copy = DIALOG_COPY[kind];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (busy) return;
    setError(null);
    onOpenChange(next);
  };

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { appDeleted } = await disconnectSlack();
      onDisconnected(appDeleted);
    } catch (err) {
      setBusy(false);
      if (slackStateChanged(err)) {
        onChanged();
        return;
      }
      setError(slackErrorCopy(err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            {copy.keep}
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Busy>{copy.working}</Busy> : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingCard({ status, ...actions }: { status: Extract<SlackStatus, { state: 'pending' }> } & Actions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function resume() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { installUrl } = await resumeSlackInstall();
      // The page is leaving for Slack, so it stays busy.
      goToSlack(installUrl);
    } catch (err) {
      setBusy(false);
      if (slackStateChanged(err)) {
        actions.onChanged();
        return;
      }
      setError(slackErrorCopy(err).message);
    }
  }

  return (
    <Card variant="settings">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle role="heading" aria-level={2} className="text-lg">
            Finish in Slack
          </CardTitle>
          <Badge variant="warning">Not finished</Badge>
        </div>
        <CardDescription>Almost there: finish installing the bot in Slack.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Started by {status.connectedBy} on {shortDate(status.connectedAt)}. Bot name: {status.botName}.
        </p>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button onClick={() => void resume()} disabled={busy}>
          {busy ? <Busy>Opening Slack…</Busy> : 'Continue in Slack'}
        </Button>
        <Button variant="outline" onClick={() => setConfirming(true)} disabled={busy}>
          Cancel
        </Button>
      </CardFooter>
      <DisconnectDialog open={confirming} onOpenChange={setConfirming} kind="pending" {...actions} />
    </Card>
  );
}

function ConnectedCard({ status, ...actions }: { status: Extract<SlackStatus, { state: 'connected' }> } & Actions) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Card variant="settings">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle role="heading" aria-level={2} className="text-lg">
            Connected to {status.workspaceName !== '' ? status.workspaceName : 'Slack'}
          </CardTitle>
          <Badge variant="secondary">Connected</Badge>
        </div>
        <CardDescription>People can now DM the bot to talk to their own agent.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col text-sm">
          <div className="flex min-h-12 items-center justify-between gap-4 border-b border-border">
            <dt>Bot name</dt>
            <dd className="text-muted-foreground">{status.botName}</dd>
          </div>
          <div className="flex min-h-12 items-center justify-between gap-4 border-b border-border">
            <dt>Configuration token</dt>
            <dd className="text-muted-foreground">
              Added by {status.connectedBy} on {shortDate(status.connectedAt)}
            </dd>
          </div>
        </dl>
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={() => setConfirming(true)}>
          Disconnect
        </Button>
      </CardFooter>
      <DisconnectDialog open={confirming} onOpenChange={setConfirming} kind="connected" {...actions} />
    </Card>
  );
}

function StatusView({ status, ...actions }: { status: SlackStatusRead } & Actions) {
  switch (status.state) {
    case 'unavailable':
      return <Unavailable />;
    case 'not-connected':
      return status.canConnect ? (
        <ConnectForm defaultBotName={status.defaultBotName} onChanged={actions.onChanged} />
      ) : (
        <NeedsHttps />
      );
    case 'pending':
      return <PendingCard status={status} {...actions} />;
    case 'connected':
      return <ConnectedCard status={status} {...actions} />;
  }
}

export function SlackTab() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [notice, setNotice] = useState<Notice | null>(null);
  const seq = useRef(0);

  const read = useCallback(async () => {
    const mine = ++seq.current;
    setLoad({ kind: 'loading' });
    try {
      const status = await fetchSlackStatus();
      if (mine === seq.current) setLoad({ kind: 'ready', status });
    } catch {
      if (mine === seq.current) setLoad({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void read();
    return () => {
      // Whatever is still in flight belongs to a tab that is gone.
      seq.current += 1;
    };
  }, [read]);

  const onDisconnected = useCallback(
    (appDeleted: boolean) => {
      setNotice({ kind: 'disconnected', appDeleted });
      void read();
    },
    [read],
  );
  const onChanged = useCallback(() => {
    setNotice({ kind: 'changed' });
    void read();
  }, [read]);

  return (
    <div className="flex flex-col gap-6 font-sans">
      {notice?.kind === 'disconnected' && <DisconnectedNotice appDeleted={notice.appDeleted} />}
      {notice?.kind === 'changed' && (
        <Alert>
          <AlertDescription>This changed while you were here, so we&apos;ve refreshed it.</AlertDescription>
        </Alert>
      )}
      {load.kind === 'loading' && <Loading />}
      {load.kind === 'error' && <ReadError onRetry={() => void read()} />}
      {load.kind === 'ready' && (
        <StatusView status={load.status} onDisconnected={onDisconnected} onChanged={onChanged} />
      )}
    </div>
  );
}
