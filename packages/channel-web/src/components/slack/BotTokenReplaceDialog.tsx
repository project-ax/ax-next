/**
 * "Replace your Slack token": the dialog where the person who set up a team
 * bot pastes a new configuration token (TASK-1173). Agent settings (the
 * Reconnect row on the Slack card, `ReconnectDialog` in `AgentSlackBotChanges`) and Admin › Slack open it. Each
 * passes its own request and its own words for a refusal, so the dialog never
 * knows which route it posts to. Only the bot's approver gets it: the surfaces
 * show it to nobody else, and the server refuses anyone else.
 *
 * The token is write-only, as in Admin › Slack's own Replace (`SlackTab`'s
 * `ReplaceTokenForm`). It goes in an uncontrolled password field
 * (`TokenField`), never React state. It is read once, trimmed, and cleared
 * before the request goes, whatever the answer, so a retry means pasting it
 * again. It is never rendered, and the dialog logs nothing: a refusal shows
 * only `errorCopy`'s words, never the error itself.
 *
 * Also as there, the dialog owns `busy`: Escape, the overlay and the close
 * button wait while Slack answers. The form under `DialogContent` remounts on
 * every opening (an empty field, no old error), and the dialog closes itself
 * before it calls back.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { SlackAppsLink, TokenField } from './SlackConfigToken';

/** What a refusal says, and whether it belongs under the token field. */
type ReplaceError = { field: 'refreshToken' | null; message: string };

export interface BotTokenReplaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The bot the page showed, named in the description. */
  botName: string;
  /** Sends the pasted refresh token; rejects with the surface's own error. */
  replace: (refreshToken: string) => Promise<void>;
  /** The words for a refusal. Never the error's own text. */
  errorCopy: (err: unknown) => ReplaceError;
  /** A refusal meaning the page is out of date: the dialog closes, then `onStale`. */
  isStale: (err: unknown) => boolean;
  /** Slack accepted the token and the server holds it. The dialog has closed. */
  onReplaced: () => void;
  /** Where focus goes once the dialog has closed (`preventDefault()` to take it from the opener). */
  onCloseAutoFocus?: (event: Event) => void;
  /** The page is out of date: read it again. The dialog has closed. */
  onStale: () => void;
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

export function BotTokenReplaceDialog({
  open,
  onOpenChange,
  botName,
  replace,
  errorCopy,
  isStale,
  onReplaced,
  onCloseAutoFocus,
  onStale,
}: BotTokenReplaceDialogProps) {
  const [busy, setBusy] = useState(false);
  // Escape, the overlay and the close button wait while Slack answers.
  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
  };
  // Don't count on the caller's re-read remounting this dialog: whichever way
  // the request ended, it closes itself first.
  const closeThen = (then: () => void) => {
    setBusy(false);
    onOpenChange(false);
    then();
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent {...(onCloseAutoFocus !== undefined ? { onCloseAutoFocus } : {})}>
        <ReplaceForm
          botName={botName}
          replace={replace}
          errorCopy={errorCopy}
          isStale={isStale}
          busy={busy}
          setBusy={setBusy}
          onCancel={() => close(false)}
          onReplaced={() => closeThen(onReplaced)}
          onStale={() => closeThen(onStale)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ReplaceForm({
  botName,
  replace,
  errorCopy,
  isStale,
  busy,
  setBusy,
  onCancel,
  onReplaced,
  onStale,
}: Pick<BotTokenReplaceDialogProps, 'botName' | 'replace' | 'errorCopy' | 'isStale'> & {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onReplaced: () => void;
  onStale: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ReplaceError | null>(null);

  // The token left with the failed attempt, so the next step is pasting one again.
  useEffect(() => {
    if (error !== null) inputRef.current?.focus();
  }, [error]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const refreshToken = (inputRef.current?.value ?? '').trim();
    // Write-only: the token leaves the page with this request, whatever Slack says.
    if (inputRef.current !== null) inputRef.current.value = '';
    setBusy(true);
    setError(null);
    try {
      await replace(refreshToken);
    } catch (err) {
      setBusy(false);
      if (isStale(err)) {
        onStale();
        return;
      }
      setError(errorCopy(err));
      return;
    }
    onReplaced();
  }

  const tokenError = error !== null && error.field === 'refreshToken' ? error.message : null;

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Replace your Slack token</DialogTitle>
        <DialogDescription>
          Do this when the configuration token we have for you stops working. {botName} stays in its channels, and
          nobody has to invite it again.
        </DialogDescription>
      </DialogHeader>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>
          Open <SlackAppsLink />. Under <strong>Your App Configuration Tokens</strong>, find this workspace. Slack
          allows one token per person there, so if one is listed, revoke it, then click{' '}
          <strong>Generate Token</strong>.
        </li>
        <li>Paste its refresh token below. We keep it encrypted, and nobody can read it back.</li>
      </ol>
      <FieldGroup>
        <TokenField
          id="slack-bot-replace-refresh-token"
          label="Refresh token"
          hint="Starts with xoxe-"
          inputRef={inputRef}
          error={tokenError}
          disabled={busy}
        />
      </FieldGroup>
      {error !== null && error.field === null && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Busy>Replacing…</Busy> : 'Replace token'}
        </Button>
      </DialogFooter>
    </form>
  );
}
