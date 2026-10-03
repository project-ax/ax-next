/**
 * ConnectorKeyModeNotice — on the model-proposed connector approval card, says
 * who supplies the connector's key (TASK-711). Words in
 * `lib/connector-key-mode-copy.ts`, shared by the in-chat grant row and the
 * Settings approve dialog so the two cannot say different things.
 *
 * A shared company key gets an `Alert` (it is the case worth stopping for); a
 * personal key gets one muted line. `role="note"` for the same reason as
 * `ConnectorAccessNotice`: this is a disclosure, not an error, and must not
 * read as one to assistive tech or to `getByRole('alert')`. Unknown or missing
 * values render nothing — older drafts carry no key mode, and guessing one
 * would be worse than silence.
 *
 * shadcn `Alert` + semantic tokens only (invariant #6).
 */
import { Building2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { connectorKeyModeCopy } from '@/lib/connector-key-mode-copy';
import { cn } from '@/lib/utils';

export function ConnectorKeyModeNotice({
  keyMode,
  className,
}: {
  keyMode: unknown;
  /** Layout only (margin / max width) — the surface decides where it sits. */
  className?: string;
}) {
  const copy = connectorKeyModeCopy(keyMode);
  if (copy === null) return null;
  if (copy.details === undefined) {
    return (
      <p
        data-testid="connector-key-mode"
        data-key-mode={String(keyMode)}
        className={cn('text-[13px] leading-relaxed text-muted-foreground', className)}
      >
        {copy.headline}
      </p>
    );
  }
  return (
    <Alert
      role="note"
      data-testid="connector-key-mode"
      data-key-mode={String(keyMode)}
      className={className}
    >
      <Building2 className="size-4" aria-hidden="true" />
      <AlertDescription className="flex flex-col gap-1.5">
        <p className="font-medium">{copy.headline}</p>
        <p>{copy.details}</p>
      </AlertDescription>
    </Alert>
  );
}
