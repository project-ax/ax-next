/**
 * The three dialogs a manager opens from the live card (TASK-1171, TASK-1173,
 * TASK-1187): Rename and Change picture (from the card's ⋯), and Reconnect (from
 * the card's "Changes to … can't reach Slack right now" row). `AgentSlackBot`'s
 * `Live` owns which is open; each dialog owns its own busy state.
 *
 * Rename and picture go to the server, which uses the token of whoever set the
 * bot up: nobody approves anything again and nobody has to invite the bot
 * again. If that token stopped working, nothing changes and the dialog says what
 * to do and who can (`agentSlackBotChangeErrorCopy`), and calls `onTokenDead`
 * so the card can show its problem row with Reconnect (the status carries no
 * word about the token, so a refused change is how the page finds out).
 *
 * Rename is modelled on Admin › Slack's `RenameDialog`: the dialog owns `busy`
 * and ignores close requests while Slack answers, the form under
 * `DialogContent` remounts on every opening (prefilled, no leftover error), and
 * the dialog closes itself before it calls back. A rename that lands reads the
 * status again; the card's title then shows the @handle the server read again
 * after the rename (the display name people type, which follows it: TASK-1185).
 *
 * Change picture is modelled on BrandingTab's hidden file input. The browser
 * draws the pick on a white square (`drawPickedSlackAvatar`) and shows exactly
 * that, and the PNG shown is the PNG sent. AX keeps no copy, so a saved picture
 * changes nothing in the status: `onSaved` tells the card to say Slack has it,
 * and nothing is read again.
 *
 * Reconnect is the shared `BotTokenReplaceDialog` (components/slack), which
 * Admin › Slack opens too, and where the pasted token is write-only. Like a
 * picture, a reconnect changes nothing in the status: `onReconnected` tells the
 * card to clear its row and say the token was replaced. The server answers
 * anyone but the person who set the bot up 403 `not-approver`, so the card
 * offers it only to them.
 *
 * Every sentence comes from `lib/agent-slack.ts`, `lib/slack-token-copy.ts`, the
 * shared dialog, or the pinned copy below.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BotTokenReplaceDialog } from '@/components/slack/BotTokenReplaceDialog';
import { Button, Notice } from '@project-ax/ui';
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
import {
  AGENT_SLACK_BOT_CHANGE_COPY,
  agentSlackBotChangeErrorCopy,
  agentSlackBotReplaceErrorCopy,
  agentSlackBotReplaceStale,
  agentSlackBotStale,
  agentSlackBotTokenDead,
  renameAgentSlackBot,
  replaceAgentSlackBotToken,
  setAgentSlackBotPicture,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { ALLOWED_LOGO_TYPES } from '@/lib/branding';
import { logRequestFailure } from '@/lib/http';
import { drawPickedSlackAvatar } from '@/lib/slack-avatar';

type Live = Extract<Bot, { state: 'live' }>;
type ChangeError = { field: 'botName' | null; message: string };

export function ReconnectDialog({
  open,
  onOpenChange,
  agentId,
  bot,
  onReconnected,
  onCloseAutoFocus,
  onStale,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  bot: Live;
  /** The token was replaced: nothing in the status changes, so the card says so itself. */
  onReconnected: () => void;
  /** Where focus goes when the dialog closes; `preventDefault()` keeps it from going back to the opener. */
  onCloseAutoFocus?: (event: Event) => void;
  /** A refusal that says the page is out of date: read the status again. */
  onStale: () => void;
}) {
  return (
    <BotTokenReplaceDialog
      open={open}
      onOpenChange={onOpenChange}
      botName={bot.botName}
      replace={(refreshToken) => replaceAgentSlackBotToken(agentId, refreshToken)}
      errorCopy={agentSlackBotReplaceErrorCopy}
      isStale={agentSlackBotReplaceStale}
      onReplaced={onReconnected}
      {...(onCloseAutoFocus !== undefined ? { onCloseAutoFocus } : {})}
      onStale={onStale}
    />
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

export function RenameDialog({
  open,
  onOpenChange,
  agentId,
  bot,
  onTokenDead,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  bot: Live;
  /** A refusal said the bot's token stopped working: the card shows its row. */
  onTokenDead: () => void;
  onChanged: () => void;
}) {
  const { busy, setBusy, close } = useBusyDialog(onOpenChange);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <RenameForm
          agentId={agentId}
          bot={bot}
          onTokenDead={onTokenDead}
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
  onTokenDead,
  busy,
  setBusy,
  onCancel,
  onDone,
}: {
  agentId: string;
  bot: Live;
  onTokenDead: () => void;
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
      if (agentSlackBotTokenDead(err)) onTokenDead();
      setError(agentSlackBotChangeErrorCopy(err, bot));
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
        <Notice tone="danger">{error.message}</Notice>
      )}
      <DialogFooter className="gap-2">
        <Button type="button" intent="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" intent="primary" busy={busy}>
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PictureDialog({
  open,
  onOpenChange,
  agentId,
  bot,
  onTokenDead,
  onSaved,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  bot: Live;
  /** A refusal said the bot's token stopped working: the card shows its row. */
  onTokenDead: () => void;
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
          onTokenDead={onTokenDead}
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
  onTokenDead,
  busy,
  setBusy,
  onCancel,
  onSaved,
  onStale,
}: {
  agentId: string;
  bot: Live;
  onTokenDead: () => void;
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
      if (agentSlackBotTokenDead(err)) onTokenDead();
      setError(agentSlackBotChangeErrorCopy(err, bot));
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
        <Button type="button" intent="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
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
        <Notice tone="danger">{error !== null ? error.message : AGENT_SLACK_BOT_CHANGE_COPY.badPicture}</Notice>
      )}
      <DialogFooter className="gap-2">
        <Button type="button" intent="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" intent="primary" busy={busy} disabled={typeof png !== 'string'}>
          Save picture
        </Button>
      </DialogFooter>
    </form>
  );
}
