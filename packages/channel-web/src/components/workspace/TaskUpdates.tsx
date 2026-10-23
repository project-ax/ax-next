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
 * Each entry links to that check-in's transcript, read-only (See what it did,
 * TASK-911), when the check-in recorded one that no other entry shares. It is
 * a real link, so it opens in a new tab too, and its name carries the entry's
 * time, so a list of them still says which is which.
 *
 * NO LINK FOR A SHARED CONVERSATION. A routine that was once a repeat routine
 * with one shared conversation recorded the same id on every run. No single
 * run's report describes that transcript, so the check-in route answers 404
 * for a conversation more than one of the task's newest 200 check-ins
 * recorded, and a link from any of them would open the gone state
 * (`sharedConversationIds`).
 */
import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { RESOLUTION_FOCUS_RING } from '@/lib/consent-focus';
import { routeLinkProps } from '@/lib/route-link';
import { foldUpdates, sharedConversationIds, updateText } from '@/lib/task-updates';
import { TASK_GROUP_LABELS } from '@/lib/task-groups';
import { cn } from '@/lib/utils';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { updateStamp } from '@/lib/workspace-time';
import type { TaskUpdate } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';

/** Where an entry's "See what it did" goes: the task it is listed under. */
interface EntryLinks {
  agentId: string;
  routineId: string;
  onNavigate: (route: WorkspaceRoute) => void;
  /** Conversations more than one entry recorded: those entries get no link. */
  shared: ReadonlySet<string>;
}

export function TaskUpdates({
  updates,
  now,
  agentId,
  routineId,
  onNavigate,
}: {
  updates: TaskUpdate[];
  now: Date;
  agentId: string;
  routineId: string;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const headingId = useId();
  const links: EntryLinks = {
    agentId,
    routineId,
    onNavigate,
    shared: sharedConversationIds(updates),
  };
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
              <UpdateEntry
                key={`${item.update.firedAt}:${i}`}
                update={item.update}
                now={now}
                links={links}
              />
            ) : (
              <li key={`fold:${item.updates[0]?.firedAt}:${i}`}>
                <Fold updates={item.updates} now={now} links={links} />
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function Fold({ updates, now, links }: { updates: TaskUpdate[]; now: Date; links: EntryLinks }) {
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
            <UpdateEntry key={`${update.firedAt}:${i}`} update={update} now={now} links={links} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function UpdateEntry({
  update,
  now,
  links,
}: {
  update: TaskUpdate;
  now: Date;
  links: EntryLinks;
}) {
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
        <p className="whitespace-pre-wrap break-words text-[13px] leading-5">{updateText(update)}</p>
        {update.status === 'error' && (
          <p className="whitespace-pre-wrap break-words text-[12px] text-muted-foreground">
            {update.error ?? 'No reason was recorded.'}
          </p>
        )}
      </div>
      {update.conversationId !== null && !links.shared.has(update.conversationId) && (
        <a
          {...routeLinkProps(
            {
              kind: 'task-checkin',
              agentId: links.agentId,
              routineId: links.routineId,
              conversationId: update.conversationId,
            },
            links.onNavigate,
          )}
          className={cn(
            'shrink-0 rounded-sm text-[12px] leading-5 text-muted-foreground underline underline-offset-2 hover:text-foreground',
            RESOLUTION_FOCUS_RING,
          )}
        >
          See what it did
          {stamp !== null && <span className="sr-only">, {stamp}</span>}
        </a>
      )}
    </li>
  );
}
