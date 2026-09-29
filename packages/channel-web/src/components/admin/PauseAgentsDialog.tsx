/**
 * The "Pause agents for <name>?" confirmation on the Usage tab.
 *
 * Pausing stops someone's running tasks and holds their new messages, so it
 * asks first — in plain words, saying it can be undone. It is a `Dialog`, not
 * an `AlertDialog`: that primitive is not installed and nothing else needs it.
 *
 * The request itself belongs to the caller (`UsageTab`): it owns the busy and
 * error state, so an error survives the dialog closing and a slow request
 * cannot be dismissed out from under itself. What lives HERE is only the
 * reason being typed, which resets on its own because Radix unmounts the
 * content whenever the dialog closes.
 */
import { useState, type FormEvent } from 'react';
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/** The server keeps at most this much of a reason. */
const NOTE_MAX_CHARS = 200;

export interface PauseAgentsDialogProps {
  open: boolean;
  /** Who is being paused. Stays set while the dialog animates closed. */
  personLabel: string;
  busy: boolean;
  /** A sentence to show inside the dialog, or `null`. */
  error: string | null;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}

function PauseForm({
  personLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: Omit<PauseAgentsDialogProps, 'open'>) {
  const [note, setNote] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) onConfirm(note);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{`Pause agents for ${personLabel}?`}</DialogTitle>
        <DialogDescription>
          We'll stop anything they have running and hold their new messages
          until you resume them. You can undo this at any time.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="usage-pause-note">
              Reason (only admins see this)
            </FieldLabel>
            <Input
              id="usage-pause-note"
              value={note}
              maxLength={NOTE_MAX_CHARS}
              onChange={(e) => setNote(e.target.value)}
              aria-describedby="usage-pause-note-help"
            />
            <FieldDescription id="usage-pause-note-help">
              Optional. A few words so the next admin knows why.
            </FieldDescription>
          </Field>
        </FieldGroup>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={busy}>
            {busy ? 'Pausing…' : 'Pause agents'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function PauseAgentsDialog({ open, ...form }: PauseAgentsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape and outside-click both land here. While a pause is in flight
        // they do nothing, so the answer (or the error) cannot be missed.
        if (!next && !form.busy) form.onCancel();
      }}
    >
      <DialogContent>
        <PauseForm {...form} />
      </DialogContent>
    </Dialog>
  );
}
