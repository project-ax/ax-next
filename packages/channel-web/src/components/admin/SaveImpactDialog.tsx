import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { impactExplain, impactLine, impactTitle } from '@/lib/models-copy';

export interface ImpactLine {
  label: string;
  agentCount: number;
}

export interface SaveImpactDialogProps {
  open: boolean;
  /** `null` = we could not count; say so honestly instead of guessing. */
  lines: ImpactLine[] | null;
  defaultLabel: string;
  saving: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function SaveImpactDialog({ open, lines, defaultLabel, saving, onConfirm, onCancel }: SaveImpactDialogProps) {
  const total = lines === null ? null : lines.reduce((n, l) => n + l.agentCount, 0);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{impactTitle(total, defaultLabel)}</DialogTitle>
          <DialogDescription>{impactExplain(defaultLabel, lines !== null)}</DialogDescription>
        </DialogHeader>
        {lines !== null && (
          <ul className="flex flex-col gap-1 text-sm">
            {lines.map((l) => (
              <li key={l.label}>{impactLine(l.label, l.agentCount)}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Go back
          </Button>
          <Button type="button" onClick={onConfirm} disabled={saving}>
            {saving ? 'Saving…' : 'Save and move them'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
