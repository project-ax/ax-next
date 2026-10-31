/**
 * "Changes your agents made to themselves" — the FYI under Today's queue
 * (TASK-990).
 *
 * An agent that saves a change to its own identity or soul with
 * `update_identity` is allowed to; this is the host telling its owner it
 * happened, in the host's words (`SELF_CHANGE_WORDS`, picked by section). Not a
 * single word on this surface comes from the agent, there is no count, and it
 * is never described as something that is waiting: the note says there is
 * nothing to do. `Review` is the way to look anyway (Settings > Agents, where
 * every person edits their own agents' identity and soul).
 *
 * Empty means absent. A section that says "no changes" would be a claim the
 * read can fail to back, so with no rows there is no section at all.
 *
 * Built from the installed shadcn `Card` and `Button` and semantic tokens only
 * (invariant 6).
 */
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { timeAgo } from '@/lib/workspace-time';
import type { SelfChangeRow } from '@/lib/workspace-self-changes';

export const SELF_CHANGES_HEADING = 'Changes your agents made to themselves';
export const SELF_CHANGES_NOTE =
  'Just so you know — nothing to do here. You can edit any of it in Settings.';

interface Props {
  rows: readonly SelfChangeRow[];
  /** Absent means no Review button: a button that does nothing is worse than none. */
  onReview?: (() => void) | undefined;
}

export function AgentSelfChanges({ rows, onReview }: Props) {
  const headingId = useId();
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="mt-8 flex flex-col gap-1">
      <h2 id={headingId} className="text-[12.5px] font-medium text-muted-foreground">
        {SELF_CHANGES_HEADING}
      </h2>
      <p className="mb-1.5 text-[12.5px] text-muted-foreground">{SELF_CHANGES_NOTE}</p>
      <Card className="overflow-hidden p-0 shadow-none">
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const when = timeAgo(row.changedAt);
            return (
              <li
                key={row.key}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-[13.5px]"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{row.agentName}</span> {row.words}
                </span>
                {when !== null && (
                  <span className="shrink-0 text-[12.5px] text-muted-foreground">{when}</span>
                )}
                {onReview !== undefined && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Review: ${row.agentName} ${row.words}`}
                    onClick={onReview}
                    className="shrink-0"
                  >
                    Review
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}
