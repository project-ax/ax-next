import { useCallback, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface NewAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the trimmed name when the user confirms. */
  onCreate: (name: string) => void;
  /**
   * (TASK-340 / audit B4) `false` on first run, where there is no app behind
   * this dialog to go back to. The caller was already ignoring close attempts;
   * this stops the dialog OFFERING them — no ✕, no Escape, no outside-click —
   * so the first thing a new user touches does not silently refuse.
   */
  dismissible?: boolean;
}

/**
 * Name-capture dialog shown before the agent bootstrap flow starts.
 * The user must supply a name before the agent is created, so the
 * `display_name` column is correct from the start — no placeholder
 * that has to be overwritten later.
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
export function NewAgentDialog({
  open,
  onOpenChange,
  onCreate,
  dismissible = true,
}: NewAgentDialogProps) {
  const [name, setName] = useState('');

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 128;

  const handleCreate = useCallback(() => {
    if (!valid) return;
    onCreate(trimmed);
  }, [valid, trimmed, onCreate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" hideClose={!dismissible}>
        <DialogHeader>
          <DialogTitle>Name your agent</DialogTitle>
          {/* (B5) "Name your agent" assumes the reader knows what an agent is.
              On first run this is the first noun the product has ever used at
              them, so say what one is before asking them to name it. */}
          <DialogDescription>
            An agent is your personal assistant in ax. Give it a name to get
            started — it'll introduce itself in a moment.
          </DialogDescription>
          {!dismissible && (
            <DialogDescription>
              This is the one thing we need before you can chat.
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-agent-name">Agent name</Label>
            <Input
              id="new-agent-name"
              autoFocus
              placeholder="e.g. Research assistant"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
              maxLength={128}
            />
          </div>
          <div className="flex justify-end">
            <Button type="button" disabled={!valid} onClick={handleCreate}>
              Create agent
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
