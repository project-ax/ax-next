/**
 * A task's Updates thread (TASK-910): one entry per check-in, newest first, so
 * a person can see what the agent has been telling them over time.
 *
 * A task that checks in every hour writes a dozen "all on track" lines a day,
 * so `foldUpdates` keeps the newest of each quiet run and folds the rest
 * behind one closed line. Anything else (a failed check-in, one that left
 * nothing, one that said needs-you or off-track) always stands alone.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. An update was written by a model and
 * can quote a ticket or an email, and a failed check-in's reason can carry
 * text from outside. The server fences both to one line before they leave
 * (`server/routes-workspace.ts`). Here they are only ever React text children:
 * never `dangerouslySetInnerHTML`, never the markdown renderer, so `**bold**`
 * or `<img>` shows as those characters.
 *
 * Each entry's body is `min-w-0 flex-1` and stops short of the row's end on
 * purpose: TASK-911 adds a "See what it did" link after it.
 */
import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { foldUpdates } from '@/lib/task-updates';
import { TASK_GROUP_LABELS } from '@/lib/task-groups';
import { cn } from '@/lib/utils';
import { updateStamp } from '@/lib/workspace-time';
import type { TaskUpdate } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';

export function TaskUpdates({ updates, now }: { updates: TaskUpdate[]; now: Date }) {
  const headingId = useId();
  const items = foldUpdates(updates);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className="text-[12.5px] font-medium">
        Updates
      </h2>
      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No check-ins yet.</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((item, i) =>
            item.kind === 'update' ? (
              <UpdateEntry key={`${item.update.firedAt}:${i}`} update={item.update} now={now} />
            ) : (
              <li key={`fold:${item.updates[0]?.firedAt}:${i}`}>
                <Fold updates={item.updates} now={now} />
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function Fold({ updates, now }: { updates: TaskUpdate[]; now: Date }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-3 self-start text-muted-foreground">
          <ChevronRight
            data-icon="inline-start"
            aria-hidden="true"
            className={cn('transition-transform', open && 'rotate-90')}
          />
          {updates.length} earlier check-ins, all on track
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col">
          {updates.map((update, i) => (
            <UpdateEntry key={`${update.firedAt}:${i}`} update={update} now={now} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What the entry says: the agent's update, or why there isn't one. */
function entryText(update: TaskUpdate): string {
  const { report } = update;
  if (report !== null) {
    return report.update === null || report.update === ''
      ? 'It left an update we can’t show.'
      : report.update;
  }
  return update.status === 'error'
    ? 'This check-in didn’t finish.'
    : 'Checked in but didn’t leave an update';
}

function UpdateEntry({ update, now }: { update: TaskUpdate; now: Date }) {
  const mark = update.report?.status ?? 'no-update';
  const stamp = updateStamp(update.firedAt, now);
  return (
    <li className="flex items-start gap-3 py-2">
      <span className="w-28 shrink-0 text-[12px] leading-5 tabular-nums text-muted-foreground">
        {stamp}
      </span>
      <span className="flex h-5 items-center">
        <StateDotSlot>
          <StateDot state={mark} />
        </StateDotSlot>
      </span>
      <span className="sr-only">{TASK_GROUP_LABELS[mark]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-5">{entryText(update)}</p>
        {update.status === 'error' && (
          <p className="whitespace-pre-wrap break-words text-[12px] text-muted-foreground">
            {update.error ?? 'No reason was recorded.'}
          </p>
        )}
      </div>
    </li>
  );
}
