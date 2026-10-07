/**
 * ConnectorAccessNotice — the launch disclosure for TASK-328 (TASK-700): what a
 * key, a sign-in or an attachment lets an assistant do.
 *
 * Rendered INLINE, at the place the decision is made, on every surface that
 * hands an agent access to a service (the list is in
 * `docs/plans/2026-09-29-task-700-connector-attach-disclosure.md`). Not a modal
 * and not a checkbox: the person is already in a dialog or a form doing the
 * thing, and a second gate on top of the consent gates that already exist would
 * teach them to click through. The words are `lib/connector-access-copy.ts`,
 * shared, so five surfaces cannot drift into saying different things.
 *
 * `role="note"`, not the Alert default `role="alert"`. This is a disclosure that
 * is simply there; announcing it as an assertive live region every time a dialog
 * opens would overstate it, and it would make `getByRole('alert')` stop meaning
 * "something went wrong" on the surfaces it sits inside. The `props` spread on
 * `Alert` lands after its own `role`, so the override is the primitive's own
 * extension point, not a fork.
 *
 * No `AlertTitle`: `ui/alert.tsx` hardcodes it to an `h5`, which jumps the heading
 * outline (TASK-446) in every host surface. The emphasised first sentence carries
 * the point instead — the same call `RememberedSitesPanel` makes.
 *
 * shadcn `Alert` + semantic tokens only (invariant #6). The `TriangleAlert` icon
 * and `size-4` are what `GrantRow` already uses for its authored-skill warning.
 */
import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  connectorAccessCopy,
  type ConnectorAccessNoticeKind,
} from '@/lib/connector-access-copy';

export function ConnectorAccessNotice({
  kind,
  className,
}: {
  kind: ConnectorAccessNoticeKind;
  /** Layout only (margin / max width) — the surface decides where it sits. */
  className?: string;
}) {
  const { headline, details } = connectorAccessCopy(kind);
  return (
    <Alert role="note" data-testid="connector-access-notice" className={className}>
      <TriangleAlert className="size-4" aria-hidden="true" />
      <AlertDescription className="flex flex-col gap-1.5">
        <p className="font-medium">{headline}</p>
        {/* Regular weight, NOT muted: the second paragraph carries the sentence
            about being tricked, which is the one least worth skimming. Both
            inherit the Alert's foreground token. */}
        <p>{details}</p>
      </AlertDescription>
    </Alert>
  );
}
