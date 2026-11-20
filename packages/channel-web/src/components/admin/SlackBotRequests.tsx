/**
 * Bot requests in Admin › Slack (TASK-1169): the list an AX admin approves or
 * declines from. A team admin who can't install Slack apps asks for their
 * agent's own bot (agent settings, "Ask an AX admin"); each ask lands here.
 * It sits under the connected card, and renders nothing at all when no one
 * has asked.
 *
 * Approve opens a dialog. It creates the bot with THIS admin's configuration
 * token, so the dialog asks for one only when the server holds none for them
 * (`configTokenStored` is false) or after a refusal that says the one it holds
 * stopped working. Then it hands the page to Slack's Allow page, as the agent
 * form does. Decline takes the request off the list; the team can ask again.
 *
 * THE PASTED TOKEN NEVER LIVES IN REACT STATE. It is an uncontrolled password
 * input (as in Replace token), read once on submit and cleared as the request
 * goes out, whatever Slack says. The dialog's form is mounted under
 * `DialogContent`, so every opening starts empty.
 *
 * Every sentence comes from `lib/slack-bot-requests.ts` or the three
 * templated lines below; nothing from a response is shown but names and dates.
 * Card titles carry `role="heading"` (level 2) to keep the h1 -> h2 outline
 * (see TASK-446).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
import { FieldGroup } from '@/components/ui/field';
import { SlackAppsLink, TokenField } from '@/components/slack/SlackConfigToken';
import { Spinner } from '@/components/ui/spinner';
import { slackShortDate } from '@/lib/agent-slack';
import { logRequestFailure } from '@/lib/http';
import { goToSlack } from '@/lib/slack-admin';
import { renderSlackAvatar } from '@/lib/slack-avatar';
import {
  SLACK_BOT_REQUEST_COPY as COPY,
  approveSlackBotRequest,
  declineSlackBotRequest,
  fetchSlackBotRequests,
  slackBotRequestErrorCopy,
  slackBotRequestStale,
  type SlackBotRequest,
  type SlackBotRequestList,
} from '@/lib/slack-bot-requests';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; list: SlackBotRequestList };

/** A button's busy face: a spinner and what it's doing. */
function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <Spinner data-icon="inline-start" aria-hidden="true" />
      {children}
    </>
  );
}

export function SlackBotRequests() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [changed, setChanged] = useState(false);
  const [approving, setApproving] = useState<SlackBotRequest | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineFailed, setDeclineFailed] = useState<string | null>(null);
  const seq = useRef(0);

  // A re-read keeps the list on screen until the new one is in; only a failure replaces it.
  const read = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const list = await fetchSlackBotRequests();
      if (mine === seq.current) setLoad({ kind: 'ready', list });
    } catch (err) {
      if (mine !== seq.current) return;
      logRequestFailure(err, 'slack-bot-requests');
      setLoad({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void read();
    return () => {
      // A late answer after we're gone is nobody's.
      seq.current += 1;
    };
  }, [read]);

  /** What we drew is out of date: close what's open, say so, and read again. */
  const stale = useCallback(() => {
    setApproving(null);
    setChanged(true);
    void read();
  }, [read]);

  async function decline(request: SlackBotRequest) {
    if (declining !== null) return;
    setDeclining(request.requestId);
    setDeclineFailed(null);
    try {
      await declineSlackBotRequest(request.requestId);
      setChanged(false);
      await read();
    } catch (err) {
      logRequestFailure(err, 'slack-bot-requests');
      if (slackBotRequestStale(err)) {
        stale();
      } else {
        setDeclineFailed(request.requestId);
      }
    } finally {
      setDeclining(null);
    }
  }

  if (load.kind === 'loading') return null;
  if (load.kind === 'error') {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-col items-start gap-3">
          <p>{COPY['loadFailed']}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoad({ kind: 'loading' });
              void read();
            }}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { requests, configTokenStored, truncated } = load.list;
  if (requests.length === 0) {
    // Nothing left to act on. If that's why the dialog just closed, say so.
    return changed ? (
      <Alert>
        <AlertDescription>{COPY['changed']}</AlertDescription>
      </Alert>
    ) : null;
  }

  return (
    <>
      <Card variant="settings">
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="text-base">
            {COPY['title']}
          </CardTitle>
          <CardDescription>{COPY['description']}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {changed && (
            <Alert>
              <AlertDescription>{COPY['changed']}</AlertDescription>
            </Alert>
          )}
          <ul className="flex flex-col gap-4">
            {requests.map((request) => (
              <li key={request.requestId} className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm font-medium">
                    {`${request.botName} for ${request.agentName}${request.teamName !== null ? ` · ${request.teamName}` : ''}`}
                  </p>
                  <p className="text-[12.5px] text-muted-foreground">
                    {`Asked by ${request.requestedBy} on ${slackShortDate(request.requestedAt)}.`}
                  </p>
                  {declineFailed === request.requestId && (
                    <p role="alert" className="text-[12.5px] text-destructive">
                      {COPY['declineFailed']}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {/* Every row's buttons read the same, so each names its bot for a screen reader. */}
                  <Button
                    size="sm"
                    aria-label={`Approve ${request.botName}`}
                    disabled={declining !== null}
                    onClick={() => setApproving(request)}
                  >
                    Approve…
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    // While it works the visible "Declining…" is the name.
                    aria-label={declining === request.requestId ? undefined : `Decline ${request.botName}`}
                    disabled={declining !== null}
                    onClick={() => void decline(request)}
                  >
                    {declining === request.requestId ? <Busy>Declining…</Busy> : 'Decline'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {truncated && <p className="text-[12.5px] text-muted-foreground">{COPY['more']}</p>}
        </CardContent>
      </Card>
      <ApproveDialog
        request={approving}
        configTokenStored={configTokenStored}
        onClose={() => setApproving(null)}
        onStale={stale}
      />
    </>
  );
}

function ApproveDialog({
  request,
  configTokenStored,
  onClose,
  onStale,
}: {
  request: SlackBotRequest | null;
  configTokenStored: boolean;
  onClose: () => void;
  onStale: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Escape and the overlay wait while Slack answers.
  const close = (open: boolean) => {
    if (busy || open) return;
    onClose();
  };
  return (
    <Dialog open={request !== null} onOpenChange={close}>
      <DialogContent>
        {request !== null && (
          <ApproveForm
            request={request}
            configTokenStored={configTokenStored}
            busy={busy}
            setBusy={setBusy}
            onCancel={() => close(false)}
            onStale={() => {
              setBusy(false);
              onStale();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The form inside the Approve dialog. It lives under `DialogContent`, so every
 * opening mounts it empty; `busy` belongs to the dialog.
 */
function ApproveForm({
  request,
  configTokenStored,
  busy,
  setBusy,
  onCancel,
  onStale,
}: {
  request: SlackBotRequest;
  configTokenStored: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onStale: () => void;
}) {
  const tokenRef = useRef<HTMLInputElement>(null);
  // A refusal that says "paste a token" shows the field even when one is stored.
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<{ field: 'refreshToken' | null; message: string } | null>(null);
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
    try {
      // Best effort and never throws: no picture means the bot is made without one.
      const iconPng = await renderSlackAvatar();
      const { installUrl } = await approveSlackBotRequest(request.requestId, {
        ...(pasted !== '' ? { refreshToken: pasted } : {}),
        ...(iconPng !== null ? { iconPng } : {}),
      });
      // The page is leaving for Slack, so it stays busy.
      goToSlack(installUrl);
    } catch (err) {
      setBusy(false);
      logRequestFailure(err, 'slack-bot-requests');
      if (slackBotRequestStale(err)) {
        onStale();
        return;
      }
      const copy = slackBotRequestErrorCopy(err);
      if (copy.revealToken) setRevealed(true);
      setError({ field: copy.field, message: copy.message });
    }
  }

  const tokenError = error !== null && error.field === 'refreshToken' ? error.message : null;
  const formError = error !== null && error.field === null ? error.message : null;

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{`Approve ${request.botName}`}</DialogTitle>
        <DialogDescription>
          {`We'll create the bot in Slack with your configuration token, then take you to Slack to click Allow. When someone outside the team mentions it, it answers with ${request.requestedBy}'s access.`}
        </DialogDescription>
      </DialogHeader>
      {showToken ? (
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>
            Open <SlackAppsLink />. Under <strong>Your App Configuration Tokens</strong>, click{' '}
            <strong>Generate Token</strong> for your workspace.
          </li>
          <li>
            Paste the refresh token below. We keep it for every Slack app you set up here, so you only do this once.
          </li>
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{COPY['storedToken']}</p>
      )}
      {showToken && (
        <FieldGroup>
          <TokenField
            id="slack-approve-refresh-token"
            label="Refresh token"
            hint="Starts with xoxe-"
            inputRef={tokenRef}
            error={tokenError}
            disabled={busy}
            required
          />
        </FieldGroup>
      )}
      {formError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {COPY['cancel']}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Busy>Creating…</Busy> : COPY['approve']}
        </Button>
      </DialogFooter>
    </form>
  );
}
