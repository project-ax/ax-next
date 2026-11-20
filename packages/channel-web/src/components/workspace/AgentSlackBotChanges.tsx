/**
 * Rename a team agent's live Slack bot, or change its picture (TASK-1171). Shown
 * to a manager on the live view (`AgentSlackBot`'s `Live`).
 *
 * Both go to the server, which uses the token of whoever set the bot up: nobody
 * approves anything again and nobody has to invite the bot again. If that token
 * stopped working, nothing changes and the dialog says whose it is
 * (`AGENT_SLACK_BOT_CHANGE_COPY`).
 *
 * Rename is modelled on Admin › Slack's `RenameDialog`: the dialog owns `busy`
 * and ignores close requests while Slack answers, the form under
 * `DialogContent` remounts on every opening (prefilled, no leftover error), and
 * the dialog closes itself before it calls back. A rename that lands reads the
 * status again; the "Bot name" row then shows the new name, which matters
 * because Slack may keep the old @handle.
 *
 * Change picture is modelled on BrandingTab's hidden file input. The browser
 * draws the pick on a white square (`drawPickedSlackAvatar`) and shows exactly
 * that, and the PNG shown is the PNG sent. AX keeps no copy, so a saved picture
 * changes nothing in the status: it says Slack has it and doesn't read again.
 *
 * A refusal that says the page is out of date (the bot was disconnected, or a
 * new request is pending) closes the dialog and reads the status again.
 *
 * Every sentence comes from `lib/agent-slack.ts` or the pinned copy below.
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  AGENT_SLACK_BOT_CHANGE_COPY,
  agentSlackBotChangeErrorCopy,
  agentSlackBotStale,
  renameAgentSlackBot,
  setAgentSlackBotPicture,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { ALLOWED_LOGO_TYPES } from '@/lib/branding';
import { logRequestFailure } from '@/lib/http';
import { drawPickedSlackAvatar } from '@/lib/slack-avatar';

type Live = Extract<Bot, { state: 'live' }>;
type ChangeError = { field: 'botName' | null; message: string };

/** A button's busy face: a spinner and what it's doing. */
function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <Spinner data-icon="inline-start" aria-hidden="true" />
      {children}
    </>
  );
}

export function BotChanges({
  agentId,
  bot,
  onChanged,
}: {
  agentId: string;
  bot: Live;
  /** A rename landed, or a refusal said the page is stale: read the status again. */
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [changing, setChanging] = useState(false);
  // After a picture lands; opening either dialog clears it.
  const [pictureSaved, setPictureSaved] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col text-sm">
        <div className="flex min-h-12 items-center justify-between gap-4 border-b border-border">
          <dt>Bot name</dt>
          <dd className="flex items-center gap-3">
            <span className="text-muted-foreground">{bot.botName}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPictureSaved(false);
                setRenaming(true);
              }}
            >
              Rename
            </Button>
          </dd>
        </div>
        <div className="flex min-h-12 items-center justify-between gap-4 border-b border-border">
          <dt>Picture</dt>
          <dd>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPictureSaved(false);
                setChanging(true);
              }}
            >
              Change picture
            </Button>
          </dd>
        </div>
      </dl>
      {pictureSaved && (
        <Alert>
          <AlertDescription>{AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged}</AlertDescription>
        </Alert>
      )}
      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        agentId={agentId}
        bot={bot}
        onChanged={onChanged}
      />
      <PictureDialog
        open={changing}
        onOpenChange={setChanging}
        agentId={agentId}
        bot={bot}
        onSaved={() => setPictureSaved(true)}
        onChanged={onChanged}
      />
    </div>
  );
}

/**
 * The dialog owns `busy`: Escape and the overlay wait while Slack answers. Both
 * dialogs are this shell around a form that remounts on every opening.
 */
function useBusyDialog(onOpenChange: (open: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
  };
  return { busy, setBusy, close };
}

function RenameDialog({
  open,
  onOpenChange,
  agentId,
  bot,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  bot: Live;
  onChanged: () => void;
}) {
  const { busy, setBusy, close } = useBusyDialog(onOpenChange);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <RenameForm
          agentId={agentId}
          bot={bot}
          busy={busy}
          setBusy={setBusy}
          onCancel={() => close(false)}
          // Don't count on the re-read remounting this dialog: whichever way the request ended, it closes itself.
          onDone={() => {
            setBusy(false);
            onOpenChange(false);
            onChanged();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  agentId,
  bot,
  busy,
  setBusy,
  onCancel,
  onDone,
}: {
  agentId: string;
  bot: Live;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(bot.botName);
  const [error, setError] = useState<ChangeError | null>(null);

  // The next step after a refused name is changing it.
  useEffect(() => {
    if (error !== null && error.field === 'botName') inputRef.current?.focus();
  }, [error]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await renameAgentSlackBot(agentId, name);
      onDone();
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      setBusy(false);
      if (agentSlackBotStale(err)) {
        onDone();
        return;
      }
      setError(agentSlackBotChangeErrorCopy(err, bot.approver));
    }
  }

  const nameError = error !== null && error.field === 'botName' ? error.message : null;

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Rename the bot</DialogTitle>
        <DialogDescription>
          Only the name changes. It stays in the channels it&apos;s in, and nobody has to invite it again.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={nameError !== null || undefined}>
          <FieldLabel htmlFor="slack-agent-bot-rename">Bot name</FieldLabel>
          <Input
            id="slack-agent-bot-rename"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            aria-invalid={nameError !== null || undefined}
            aria-describedby={
              nameError !== null
                ? 'slack-agent-bot-rename-hint slack-agent-bot-rename-error'
                : 'slack-agent-bot-rename-hint'
            }
          />
          <FieldDescription id="slack-agent-bot-rename-hint">The name people see in Slack.</FieldDescription>
          {nameError !== null && <FieldError id="slack-agent-bot-rename-error">{nameError}</FieldError>}
        </Field>
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
          {busy ? <Busy>Renaming…</Busy> : 'Rename'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PictureDialog({
  open,
  onOpenChange,
  agentId,
  bot,
  onSaved,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  bot: Live;
  onSaved: () => void;
  onChanged: () => void;
}) {
  const { busy, setBusy, close } = useBusyDialog(onOpenChange);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <PictureForm
          agentId={agentId}
          bot={bot}
          busy={busy}
          setBusy={setBusy}
          onCancel={() => close(false)}
          onSaved={() => {
            setBusy(false);
            onOpenChange(false);
            onSaved();
          }}
          onStale={() => {
            setBusy(false);
            onOpenChange(false);
            onChanged();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PictureForm({
  agentId,
  bot,
  busy,
  setBusy,
  onCancel,
  onSaved,
  onStale,
}: {
  agentId: string;
  bot: Live;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
  onStale: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  // The latest pick wins: a slower drawing of an earlier one is dropped.
  const pickRef = useRef(0);
  // undefined: nothing picked. null: the browser couldn't draw it. string: the PNG Slack gets.
  const [png, setPng] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<ChangeError | null>(null);

  async function choose(file: File) {
    const mine = ++pickRef.current;
    setError(null);
    const drawn = await drawPickedSlackAvatar(file);
    if (pickRef.current === mine) setPng(drawn);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || typeof png !== 'string') return;
    setBusy(true);
    setError(null);
    try {
      await setAgentSlackBotPicture(agentId, png);
      onSaved();
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      setBusy(false);
      if (agentSlackBotStale(err)) {
        onStale();
        return;
      }
      setError(agentSlackBotChangeErrorCopy(err, bot.approver));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Change the bot&apos;s picture</DialogTitle>
        <DialogDescription>
          Pick an image from your computer. We&apos;ll center it on a white square for Slack.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col items-start gap-3">
        <input
          ref={fileRef}
          type="file"
          accept={ALLOWED_LOGO_TYPES.join(',')}
          aria-label="Image file"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void choose(file);
            e.target.value = '';
          }}
        />
        <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
          {png === undefined ? 'Choose an image' : 'Choose another'}
        </Button>
        {typeof png === 'string' && (
          <img
            src={`data:image/png;base64,${png}`}
            alt="The new picture"
            className="size-32 rounded-md border border-border"
          />
        )}
      </div>
      {(png === null || error !== null) && (
        <Alert variant="destructive">
          <AlertDescription>{error !== null ? error.message : AGENT_SLACK_BOT_CHANGE_COPY.badPicture}</AlertDescription>
        </Alert>
      )}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || typeof png !== 'string'}>
          {busy ? <Busy>Saving…</Busy> : 'Save picture'}
        </Button>
      </DialogFooter>
    </form>
  );
}
