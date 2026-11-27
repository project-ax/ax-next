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
  // Cancel, Escape or a click outside. It also wins over a Continue still
  // closing (an Escape during the exit animation): drop the pending choice so
  // `onCloseAutoFocus` opens nothing.
  //
  // WHY THE DialogContent HANDLERS. After Continue our controlled `open` is
  // already false, and Radix only calls `onOpenChange` when the value differs
  // from the prop, so during the ~200 ms exit animation Escape and an outside
  // click never reach it. `onEscapeKeyDown` and `onPointerDownOutside` do still
  // fire, so during the exit (and only then) they call `cancel` directly.
  // While the dialog is open they leave it to Radix: it ignores a right-click
  // or ctrl+click on the backdrop, and otherwise calls `onOpenChange(false)`,
  // so the parent hears one cancel, not two.
  // NOT COVERED: the X button. Its Close calls `onOpenChange`, a no-op once
  // `open` is false, so an X press within ~200 ms of Continue still opens the
  // editor. Accepted: rare, and the admin did just press Continue.
  const cancel = () => {
    chosen.current = null;
    onCancel();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) cancel(); }}>
      <DialogContent
        onEscapeKeyDown={() => { if (!open) cancel(); }}
        onPointerDownOutside={() => { if (!open) cancel(); }}
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
          <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
          <Button type="button" onClick={() => { chosen.current = choice; setOpen(false); }}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
