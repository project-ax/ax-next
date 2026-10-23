/**
 * TodayTaskGroup — one task's block on Today (TASK-933).
 *
 * WHAT IT SAYS. A task is on Today when it needs a person (`todayTaskReason`):
 * its agent's last report said Needs you (the block shows the ask, else the
 * update), three check-ins in a row left no update (how many, and why), or the
 * host paused it after five (why it stopped). Any other task is here only for
 * the approvals raised during its check-ins: its name, how many are waiting,
 * and nothing about the task itself. Those approvals are drawn under the block
 * by its parent, as `children`.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. The task's name, its ask and its update
 * were written by a model or a person; the server fenced each to one line and
 * capped it before it left (`server/routes-workspace.ts`). Here they are only
 * React text children: never markdown, never `dangerouslySetInnerHTML`. The
 * only attribute built from one is a `title` holding the same fenced value, so
 * a clamped line can still be read whole (TASK-436). Open task's address is
 * built from the task's ids, never from its text.
 *
 * REPLY shows wherever the block shows the agent's Needs you report: its ask
 * (else its update), or, under a miss or an auto-pause, a second line: "{agent}
 * asks: …", else "{agent} said: {update}", else that it can't be shown
 * (TASK-930: a miss never hides a pending ask). It opens TASK-931's reply box
 * in place, focused. The box stays mounted while it is closed, so a half-typed
 * reply and its retry id survive a collapse; `hidden` is what closes it,
 * because Radix keeps a force-mounted panel open. `canStart` is false: a
 * `TaskRow` carries no permissions, so the box never promises a check-in Today
 * can't vouch for, and the server's answer says what happened. A sent reply
 * calls `onReplied`, so Today can read the tasks again.
 *
 * OPEN TASK is always shown, in the block's own actions, and is a real link,
 * so it can open in a new tab too (`routeLinkProps`).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { routeLinkProps } from '@/lib/route-link';
import { TASK_GROUP_LABELS, type TodayTaskReason } from '@/lib/task-groups';
import { AUTO_PAUSED_LINE, missSummary } from '@/lib/task-miss';
import type { TodayGroup } from '@/lib/today-queue';
import { cn } from '@/lib/utils';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { isOpenDecision, type TaskRow } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';
import { CANT_SHOW } from './TaskPage';
import { TaskReplyBox } from './TaskReplyBox';

/** The heading's mark, as the Tasks page draws it: Needs you for an ask or three misses, Paused once the host paused it. */
const MARK: Record<TodayTaskReason, 'needs-you' | 'paused'> = {
  asks: 'needs-you',
  escalated: 'needs-you',
  'auto-paused': 'paused',
};

/** Text with something in it, else null. An empty string is nothing to show, as the task page reads an update. */
function legible(text: string | null | undefined): string | null {
  return text === null || text === undefined || text === '' ? null : text;
}

/**
 * Under a miss or an auto-pause, the agent's Needs you report the person still
 * owes an answer to, as one line: its ask, else what it said, else that it
 * can't be shown. Null when its last report didn't say Needs you.
 *
 * The can't-show line isn't `CANT_SHOW` ("It left an update we can't show."):
 * it sits right under the line saying the last check-ins left no update, so it
 * names the earlier report instead.
 */
function stillNeedsYouLine(row: TaskRow, agentName: string): string | null {
  if (row.task?.status !== 'needs-you') return null;
  const ask = legible(row.task.ask);
  if (ask !== null) return `${agentName} asks: ${ask}`;
  const update = legible(row.task.update);
  return update === null
    ? `${agentName} said it needs you before this, but we can’t show what it said.`
    : `${agentName} said: ${update}`;
}

/** The line under the heading: what the task needs, or how many of its approvals are waiting. */
function bodyLine(group: TodayGroup): string | null {
  switch (group.reason) {
    case 'asks':
      return legible(group.row.task?.ask) ?? legible(group.row.task?.update) ?? CANT_SHOW;
    case 'escalated':
      return group.row.noRecentUpdate === null ? null : missSummary(group.row.noRecentUpdate);
    case 'auto-paused':
      return AUTO_PAUSED_LINE;
    case null: {
      const waiting = group.decisions.filter(isOpenDecision).length;
      if (waiting === 0) return null;
      return waiting === 1 ? '1 approval waiting' : `${waiting} approvals waiting`;
    }
  }
}

export function TodayTaskGroup({
  group,
  onNavigate,
  onReplied,
  children,
}: {
  group: TodayGroup;
  onNavigate: (route: WorkspaceRoute) => void;
  /** A reply was sent from this block's box: the shell reads the tasks again. */
  onReplied: () => void;
  /**
   * The block's approvals, already drawn as `DecisionRow`s, in `group.decisions`
   * order. Draw them without `onNavigate`: the block's own Open task is its
   * only one (TASK-933 decisions row 8).
   */
  children?: ReactNode;
}) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // Opening the box puts the cursor in it. An effect, so it runs after the
  // commit that drops `hidden`: a hidden textarea can't take focus.
  useEffect(() => {
    if (open) replyRef.current?.focus();
  }, [open]);

  const mark = group.reason === null ? null : MARK[group.reason];
  const meta = `Task · ${group.agentName}`;
  const body = bodyLine(group);
  // Under a miss or an auto-pause, the Needs you report still waiting on the person.
  const askLine =
    group.reason === 'escalated' || group.reason === 'auto-paused'
      ? stillNeedsYouLine(group.row, group.agentName)
      : null;
  // Reply goes wherever the block shows the agent's Needs you words.
  const replyTo = group.reason === 'asks' || askLine !== null ? group.row : null;
  // The box unmounts with the ask. Close it then, so a later ask doesn't
  // arrive already open and take focus.
  const canReply = replyTo !== null;
  useEffect(() => {
    if (!canReply) setOpen(false);
  }, [canReply]);

  return (
    // A labelled group, not a `<section>`: a labelled section is a region
    // landmark, and Today can hold many blocks (TodayView's consent wrapper
    // does the same).
    <div
      role="group"
      aria-labelledby={headingId}
      className="min-w-0 border-b border-rule-soft last:border-b-0"
    >
      <div className="flex min-w-0 flex-col gap-1 px-5 py-3.5">
        <h2 id={headingId} className="flex min-w-0 items-start gap-3">
          {/* `h-5` is the first line's height, so the mark stays on it however the heading wraps. */}
          <span className="flex h-5 shrink-0 items-center">
            <StateDotSlot>{mark !== null && <StateDot state={mark} />}</StateDotSlot>
          </span>
          {/* At phone width the agent's name wraps under the task's instead of squeezing it. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span
              className="min-w-0 max-w-full truncate text-[13px] font-medium leading-5"
              title={group.taskName}
            >
              {group.taskName}
            </span>
            {/* The mark is `aria-hidden`, so the state is said here (`StateDot`'s rule). */}
            {mark !== null && (
              <span className="sr-only">{`, ${TASK_GROUP_LABELS[mark].toLowerCase()}`}</span>
            )}
            <span
              className="min-w-0 max-w-full truncate text-[12.5px] leading-5 text-muted-foreground"
              title={meta}
            >
              {meta}
            </span>
          </span>
        </h2>
        {body !== null && (
          <p
            className={cn(
              'line-clamp-2 break-words pl-5',
              group.reason === null
                ? 'text-[12.5px] text-muted-foreground'
                : 'text-[13.5px] leading-relaxed',
            )}
            title={body}
          >
            {body}
          </p>
        )}
        {askLine !== null && (
          <p
            className="line-clamp-2 break-words pl-5 text-[12.5px] text-muted-foreground"
            title={askLine}
          >
            {askLine}
          </p>
        )}
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          className="flex min-w-0 flex-col gap-2 pl-5 pt-1.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            {replyTo !== null && (
              <CollapsibleTrigger asChild>
                {/* Outline: Approve stays the one primary action on Today. */}
                <Button variant="outline" size="sm">
                  Reply
                </Button>
              </CollapsibleTrigger>
            )}
            {/* First in its row, a ghost button lines its text up with the lines above. */}
            <Button
              asChild
              size="sm"
              variant="ghost"
              className={cn(replyTo === null && '-ml-3')}
            >
              <a
                {...routeLinkProps(
                  { kind: 'task', agentId: group.agentId, routineId: group.routineId },
                  onNavigate,
                )}
              >
                Open task
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </a>
            </Button>
          </div>
          {replyTo !== null && (
            // No display utility on this element: a `flex` class would beat
            // Tailwind's `[hidden]` rule and show the box while it's closed.
            <CollapsibleContent forceMount hidden={!open}>
              <TaskReplyBox
                agentId={group.agentId}
                routineId={group.routineId}
                agentName={group.agentName}
                enabled={replyTo.enabled}
                canStart={false}
                onSent={() => onReplied()}
                inputRef={replyRef}
              />
            </CollapsibleContent>
          )}
        </Collapsible>
      </div>
      {group.decisions.length > 0 && (
        // Indented so each approval's mark sits under the task's name.
        <div className="min-w-0 pl-5">
          <Separator />
          {children}
        </div>
      )}
    </div>
  );
}
