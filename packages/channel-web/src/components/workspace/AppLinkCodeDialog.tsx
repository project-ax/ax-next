/**
 * The one-time link code, shown once. The person hands it to their apps
 * platform (or to the agent building the app); the platform trades it for a
 * link to this agent. There is no app id to type anywhere: the platform says
 * which app it is when it claims the code.
 *
 * The code lives in the parent's state only while this dialog is open, and is
 * dropped the moment it closes; this dialog keeps drawing it only until its
 * close animation ends. It is never logged.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { LinkCodeResponse } from '@ax/apps-bridge-contract';
import { formatTimestamp } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { useHeldThroughClose } from './use-held-through-close';

/** "3:45 PM", in the person's own locale; a value that isn't a time shows as it came. */
function shortTime(iso: string): string {
  return formatTimestamp(iso, { format: 'clock' }) ?? iso;
}

export function AppLinkCodeDialog({
  minted,
  onDone,
}: {
  /** The code to show; `null` keeps the dialog closed. */
  minted: LinkCodeResponse | null;
  /** Closed, by Done or otherwise: the parent drops the code and reads the list again. */
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const { held: shown, release } = useHeldThroughClose(minted);

  async function copy(code: string) {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // No clipboard here (an insecure origin, a refused permission): the code is still selectable.
      setCopyFailed(true);
    }
  }

  return (
    <Dialog
      open={minted !== null}
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
    >
      <DialogContent
        onCloseAutoFocus={() => {
          release();
          setCopied(false);
          setCopyFailed(false);
        }}
      >
        <DialogHeader>
          <DialogTitle>Link an app</DialogTitle>
          <DialogDescription>
            Give this code to your apps platform, or to the agent building the app. It works once, until{' '}
            {shown !== null ? shortTime(shown.expiresAt) : ''}.
          </DialogDescription>
        </DialogHeader>
        {shown !== null && (
          <Field>
            <FieldLabel htmlFor="app-link-code">Link code</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="app-link-code"
                readOnly
                value={shown.code}
                className="font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={() => void copy(shown.code)}>
                  {copied ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
                  {copied ? 'Copied' : 'Copy'}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {copyFailed && (
              <FieldDescription role="alert">We couldn&apos;t copy it. Select the code and copy it yourself.</FieldDescription>
            )}
          </Field>
        )}
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
