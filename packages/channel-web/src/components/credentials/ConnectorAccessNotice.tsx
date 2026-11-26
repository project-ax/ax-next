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
 * A `Notice tone="info"` (role `status`), not a warning: this is a disclosure
 * that is simply there. An assertive `alert` every time a dialog opens would
 * overstate it, and would make `getByRole('alert')` stop meaning "something
 * went wrong" on the surfaces it sits inside. The headline is the Notice title;
 * the sentence about being tricked is its body.
 *
 * The wrapper keeps `data-testid="connector-access-notice"`: the workspace/ and
 * admin/ tests that mount this through their own surfaces still find it there.
 */
import { Notice } from '@project-ax/ui';
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
    <div data-testid="connector-access-notice" className={className}>
      <Notice tone="info" title={headline}>
        {/* The second paragraph carries the sentence about being tricked, which
            is the one least worth skimming — so it is the Notice body, not a
            footnote. */}
        {details}
      </Notice>
    </div>
  );
}
