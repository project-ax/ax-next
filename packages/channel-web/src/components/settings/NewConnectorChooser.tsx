/**
 * NewConnectorChooser: "New connector" asks what kind first (TASK-1239).
 *
 * An MCP server opens the remote-server form. Services, an API or a
 * command-line tool open the general editor, the one with the compose paste.
 * The parent opens that editor from `onChosen`.
 *
 * FOCUS. `onChosen` runs only after this dialog has finished closing (its
 * `onCloseAutoFocus`, after the exit animation), one task later. By then the
 * dialog primitive (`use-opener-restore`) has put focus back on the button
 * that opened us, so the editor records that button as its own opener and
 * returns focus there when it closes. Opening the editor in the same commit
 * that removes this dialog would record `<body>` instead. Never swap this for
 * a count of timers: jsdom has no exit animation, so that passes the tests and
 * breaks in a browser. Same shape as MemoryActions (TASK-949).
 *
 * Fixed copy only. shadcn primitives and semantic tokens (invariant 6).
 */
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { NewConnectorKind } from './ConnectorEditDialog';

const KINDS: ReadonlyArray<{ value: NewConnectorKind; label: string; description: string }> = [
  { value: 'remote', label: 'MCP server', description: 'Tools from a remote server, like Linear or Notion.' },
  {
    value: 'general',
    label: 'Services, APIs or command-line tools',
    description: 'A database or cache from a Compose file, an API that takes a key, or a tool from npm or PyPI.',
  },
];

export function NewConnectorChooser({
  onCancel,
  onChosen,
}: {
  onCancel: () => void;
  onChosen: (kind: NewConnectorKind) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState<NewConnectorKind>('remote');
  const [open, setOpen] = useState(true);
  // Set by Continue; read once, when the dialog has finished closing.
  const chosen = useRef<NewConnectorKind | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        onCloseAutoFocus={() => {
          const kind = chosen.current;
          chosen.current = null;
          if (kind !== null) setTimeout(() => onChosen(kind), 0);
        }}
      >
        <DialogHeader>
          <DialogTitle>New connector</DialogTitle>
          <DialogDescription>What are you adding? You’ll fill in the details next.</DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend className="sr-only">Kind of connector</FieldLegend>
          <RadioGroup value={choice} onValueChange={(v) => setChoice(v === 'general' ? 'general' : 'remote')}>
            {KINDS.map((k) => (
              <Field key={k.value} orientation="horizontal">
                <RadioGroupItem value={k.value} id={`${id}-${k.value}`} />
                <FieldContent>
                  <FieldLabel htmlFor={`${id}-${k.value}`}>{k.label}</FieldLabel>
                  <FieldDescription>{k.description}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" onClick={() => { chosen.current = choice; setOpen(false); }}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
