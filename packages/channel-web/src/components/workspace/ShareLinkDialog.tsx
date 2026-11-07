/**
 * The share link, for copying by hand, when the browser wouldn't let us put
 * it on the clipboard. Owner-only: the person holding it already owns the link.
 */
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export function ShareLinkDialog({ url, onClose }: { url: string | null; onClose(): void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (url === null) return;
    // After the dialog's own focus move, so the selection sticks.
    const t = setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [url]);

  return (
    <Dialog
      open={url !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Here’s the link</DialogTitle>
          <DialogDescription>Your browser wouldn’t let us copy it — here’s the link to copy yourself.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="artifact-share-link">Link</FieldLabel>
            <Input
              ref={input}
              id="artifact-share-link"
              readOnly
              value={url ?? ''}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
