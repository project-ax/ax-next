/**
 * A task's check-ins (TASK-910, TASK-931): one entry per check-in and one per
 * reply the person sent, newest first, so a person can see what the agent has
 * been telling them, and what they told it, over time.
 *
 * ONE LINE EACH (the minimal redesign, 2026-10-29). An entry is its mark (with
 * its word, hidden), what it said, a short time ("7:13 PM", "Fri 7:13 PM",
 * "Oct 23"; the whole date hidden beside it, `RowTime`) and an icon link. On the task
 * page the list leaves out the entry the latest card already shows (`latest`),
 * shows the newest few (`shown`) and puts the rest behind one "N earlier"
 * button; a Done task's whole list starts behind "N check-ins" (`collapsed`).
 * Called with neither, it lists everything, as it always did.
 *
 * A task that checks in every hour writes a dozen "all on track" lines a day,
 * so `foldTimeline` keeps the newest of each quiet run and folds the rest
 * behind one closed line. Anything else (a failed check-in, one that left
 * nothing, one that said needs-you or off-track) always stands alone, and a
 * reply ends a quiet run and is never folded.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. An update was written by a model and
 * can quote a ticket or an email, and a failed check-in's reason can carry
 * text from outside. A reading's label (TASK-952) is the agent's too: an entry
 * adds it after the update, muted. The server fences all three to one line
 * before they leave (`server/routes-workspace.ts`). Here they are only ever
 * React text children: never `dangerouslySetInnerHTML`, never the markdown
 * renderer, and no attribute is built from them, so `**bold**` or `<img>`
 * shows as those characters. So is a reply, which keeps its line breaks
 * (`whitespace-pre-wrap`) and has no link. An entry is clamped to two lines
 * on screen; the whole of it is still there for a screen reader, and on the
 * check-in's own page.
 *
 * A failed check-in's reason is worded by `runFailureText`: the routines
 * store's own sentences ("…interrupted by a host restart.") become the page's
 * plain ones, and anything else reads as it was recorded.
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
import { ArrowUpRight, ChevronRight, History } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { routeLinkProps } from '@/lib/route-link';
import { readingText } from '@/lib/task-reading';
import {
  entryCount,
  foldTimeline,
  runFailureText,
  sharedConversationIds,
  updateText,
  withoutLatest,
  type TimelineItem,
} from '@/lib/task-updates';
import { TASK_GROUP_LABELS } from '@/lib/task-groups';
import { cn } from '@/lib/utils';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { updateStamp } from '@/lib/workspace-time';
import type { TaskDetailReport, TaskReply, TaskUpdate } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';
import { IconLink, RowTime } from './task-bits';

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
  replies,
  now,
  agentId,
  routineId,
  onNavigate,
  latest = null,
  shown,
  collapsed = false,
}: {
  updates: TaskUpdate[];
  replies: TaskReply[];
  now: Date;
  agentId: string;
  routineId: string;
  onNavigate: (route: WorkspaceRoute) => void;
  /** The report the page's latest card shows: its entry, when it's the newest, isn't listed again. */
  latest?: Pick<TaskDetailReport, 'status' | 'update'> | null;
  /** Show this many entries, and the rest behind "N earlier". Every entry when omitted. */
  shown?: number;
  /** A Done task's record: the whole list starts behind "N check-ins". */
  collapsed?: boolean;
}) {
  const headingId = useId();
  const restId = useId();
  const [open, setOpen] = useState(false);
  const links: EntryLinks = {
    agentId,
    routineId,
    onNavigate,
    shared: sharedConversationIds(updates),
  };
  const all = foldTimeline(updates, replies);
  const items = withoutLatest(all, latest);
  const head = collapsed ? [] : shown === undefined ? items : items.slice(0, shown);
  const rest = items.slice(head.length);
  const restCount = entryCount(rest);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h2 id={headingId} className="sr-only">
        Updates
      </h2>
      {all.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No check-ins yet.</p>
      ) : (
        <>
          {head.length > 0 && <Entries items={head} now={now} links={links} />}
          {rest.length > 0 && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 h-7 self-start px-2 text-[13px] font-normal text-muted-foreground"
                aria-expanded={open}
                aria-controls={restId}
                onClick={() => setOpen((o) => !o)}
              >
                <History data-icon="inline-start" aria-hidden="true" />
                {collapsed
                  ? `${restCount} ${restCount === 1 ? 'check-in' : 'check-ins'}`
                  : `${restCount} earlier`}
              </Button>
              <div id={restId} hidden={!open}>
                {open && <Entries items={rest} now={now} links={links} />}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Entries({ items, now, links }: { items: TimelineItem[]; now: Date; links: EntryLinks }) {
  return (
    <ul className="flex flex-col">
      {items.map((item, i) => {
        if (item.kind === 'update') {
          return (
            <UpdateEntry key={`${item.update.firedAt}:${i}`} update={item.update} now={now} links={links} />
          );
        }
        if (item.kind === 'reply') {
          return <ReplyEntry key={`reply:${item.reply.sentAt}:${i}`} reply={item.reply} now={now} />;
        }
        return (
          <li key={`fold:${item.updates[0]?.firedAt}:${i}`}>
            <Fold updates={item.updates} now={now} links={links} />
          </li>
        );
      })}
    </ul>
  );
}

function Fold({ updates, now, links }: { updates: TaskUpdate[]; now: Date; links: EntryLinks }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 self-start px-2 text-[13px] font-normal text-muted-foreground"
        >
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

/** What the person sent: who said it, the words as plain text, and their time. No mark, no link. */
function ReplyEntry({ reply, now }: { reply: TaskReply; now: Date }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <Badge
        variant="accent"
        size="compact"
        className="mt-0.5 shrink-0 rounded-sm px-1.5 py-1 text-[12px] font-medium"
      >
        {reply.byYou ? 'You' : 'Someone else'}
      </Badge>
      <p className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words text-[14px] leading-6">
        {reply.text ?? 'We can’t show this reply.'}
      </p>
      <RowTime iso={reply.sentAt} now={now} className="pt-0.5 leading-5" />
      {/* Holds the link column, so every row's time lines up. */}
      <span aria-hidden="true" className="size-7 shrink-0" />
    </li>
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
  const mark = update.report?.status ?? 'no-recent-update';
  const stamp = updateStamp(update.firedAt, now);
  // Here, not in the shared `updateText`: a check-in's own page draws its
  // reading on a line of its own, labelled as the agent's, through the same
  // `readingText` (TASK-956).
  const reading = update.report?.reading ?? null;
  const linked = update.conversationId !== null && !links.shared.has(update.conversationId);
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className="flex h-6 items-center">
        <StateDotSlot>
          <StateDot state={mark} />
        </StateDotSlot>
      </span>
      <span className="sr-only">{TASK_GROUP_LABELS[mark]}</span>
      <p className="line-clamp-2 min-w-0 flex-1 break-words text-[14px] leading-6">
        {updateText(update)}
        {reading !== null && (
          <span className="text-muted-foreground">
            {` · ${readingText(reading)}`}
          </span>
        )}
        {update.status === 'error' && (
          <>
            <span aria-hidden="true" className="text-muted-foreground">{' · '}</span>
            <span className="text-muted-foreground">{runFailureText(update.error)}</span>
          </>
        )}
      </p>
      <RowTime iso={update.firedAt} now={now} className="pt-0.5 leading-5" />
      {linked ? (
        <IconLink
          icon={ArrowUpRight}
          label="See what it did"
          {...routeLinkProps(
            {
              kind: 'task-checkin',
              agentId: links.agentId,
              routineId: links.routineId,
              conversationId: update.conversationId as string,
            },
            links.onNavigate,
          )}
        >
          {stamp !== null && <span className="sr-only">, {stamp}</span>}
        </IconLink>
      ) : (
        <span aria-hidden="true" className="size-7 shrink-0" />
      )}
    </li>
  );
}
