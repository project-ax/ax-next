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
}

/**
 * Name-capture dialog shown before the agent bootstrap flow starts.
 * The user must supply a name before the agent is created, so the
 * `display_name` column is correct from the start — no placeholder
 * that has to be overwritten later.
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
export function NewAgentDialog({ open, onOpenChange, onCreate }: NewAgentDialogProps) {
  const [name, setName] = useState('');

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 128;

  const handleCreate = useCallback(() => {
    if (!valid) return;
    onCreate(trimmed);
  }, [valid, trimmed, onCreate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Name your agent</DialogTitle>
          <DialogDescription>
            Give your new agent a name. It'll introduce itself once it's ready.
          </DialogDescription>
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
