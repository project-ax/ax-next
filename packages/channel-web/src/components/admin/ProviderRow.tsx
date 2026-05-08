import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { StatusDot, type StatusDotVariant } from './StatusDot';
import { cn } from '@/lib/utils';

export interface ProviderRowProps {
  /** Two-letter mark (e.g., 'An', 'OA'). */
  mark: string;
  name: string;
  status: StatusDotVariant;
  /** Override the default label for the status (e.g., 'Adding key…'). */
  statusLabel?: string;
  /** Configured masked key stub. */
  keyStub?: string;
  /** When true, the action button is hidden and `body` is rendered below the head. */
  editing?: boolean;
  /** Inline form (typically `<KeyForm/>`) rendered when editing. */
  body?: ReactNode;
  onEdit?: () => void;
}

const DEFAULT_LABEL: Record<StatusDotVariant, string> = {
  empty: 'Not configured',
  ok: 'Configured',
  bad: 'Error',
  pending: 'Validating…',
};

export function ProviderRow({
  mark,
  name,
  status,
  statusLabel,
  keyStub,
  editing,
  body,
  onEdit,
}: ProviderRowProps) {
  const label = statusLabel ?? DEFAULT_LABEL[status];
  const buttonVariant = status === 'ok' ? 'outline' : 'default';
  const buttonLabel = status === 'ok' ? 'Edit key' : 'Add key';

  return (
    <div className="border-b border-rule-soft last:border-b-0 py-[1.125rem]">
      <div className="flex items-center gap-3.5">
        <span className="w-8 h-8 rounded-md bg-muted inline-flex items-center justify-center text-[13px] font-medium text-foreground/75 shrink-0 tracking-[-0.01em]">
          {mark}
        </span>
        <span className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[15px] font-medium tracking-[-0.01em] leading-tight">
            {name}
          </span>
          <span className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <StatusDot variant={status} />
            <span className={cn(status === 'bad' && 'text-destructive')}>{label}</span>
            {keyStub && (
              <>
                <span aria-hidden="true" className="opacity-40">·</span>
                <span className="font-mono text-[11.5px] tracking-[0.05em]">
                  {keyStub}
                </span>
              </>
            )}
          </span>
        </span>
        {!editing && onEdit && (
          <Button
            type="button"
            variant={buttonVariant}
            size="default"
            onClick={onEdit}
          >
            {buttonLabel}
          </Button>
        )}
      </div>
      {editing && body}
    </div>
  );
}
