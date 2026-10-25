/**
 * `/workspace/tasks` — every task the person owns, across the agents they can
 * see, grouped by what needs them (TASK-909).
 *
 * Two views (TASK-950). Current is the groups, then "Done this week" (tasks
 * marked done in the last 7 days, against the browser's clock), then paused
 * tasks behind their toggle. Done is every task ever marked done, newest first.
 * The switch between them shows only once a task is done; with none, the page
 * is the one it always was.
 *
 * The page draws the shell's tasks read (TASK-933), the same one Today and the
 * sidebar badge count from. `groupTasks` decides the groups
 * and their order; each group's mark is `StateDot`'s task mark, so a task
 * waiting on you looks exactly like an agent waiting on you.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. A task's `name`, its report's `update`
 * and its reading's label (TASK-952) were written by a model, and an update can
 * quote a ticket or an email. The server fences each to one line and caps it
 * before it leaves (`server/routes-workspace.ts`). Here they are only ever
 * React text children: never `dangerouslySetInnerHTML`, never the markdown
 * renderer, so `**bold**` or `<img>` in an update shows as those characters.
 * Each clamped one keeps the whole fenced value in a `title` (TASK-436).
 *
 * Each row opens its task page (TASK-910) through a real link, so it can open in a new tab too.
 */
import { useEffect, useId, useLayoutEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ListChecks } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { readAlertVariant } from '@/lib/read-register';
import { routeLinkProps } from '@/lib/route-link';
import { AUTO_PAUSED_LINE, missSummary } from '@/lib/task-miss';
import { TASK_GROUP_LABELS, groupTasks, type ActiveTaskGroup } from '@/lib/task-groups';
import { finishByCount } from '@/lib/task-finish-by';
import { formatReading } from '@/lib/task-reading';
import { cn } from '@/lib/utils';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import type { TasksReadError, TasksState } from '@/lib/workspace-tasks';
import { checkInWhen, timeAgo } from '@/lib/workspace-time';
import type { TaskRow, UnavailableAgent } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';
import { Segmented, WorkspaceHeader } from './WorkspaceHeader';

/** How often "checked 4 min ago" is recomputed, as `LearnedInChat` does. */
const AGO_TICK_MS = 30_000;

const AGENT_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

const LOAD_COPY: Record<TasksReadError, string> = {
  expired: HTTP_SESSION_ENDED,
  failed: 'We couldn’t load your tasks just now. Nothing was lost.',
};

export function TasksPage({
  state,
  retry,
  leading,
  onNavigate,
}: {
  state: TasksState;
  retry: () => void;
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  return (
    <>
      <WorkspaceHeader
        title="Tasks"
        subtitle="What your agents are looking after"
        leading={leading}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-6 pb-6">
          {state.kind === 'loading' && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {state.kind === 'failed' && (
            <TasksLoadFailure error={state.error} onRetry={retry} />
          )}
          {state.kind === 'ready' && (
            <TaskBoard
              tasks={state.tasks}
              unavailableAgents={state.unavailableAgents}
              refreshing={state.refreshing}
              refreshFailed={state.refreshFailed}
              onNavigate={onNavigate}
              onRetry={retry}
            />
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The page couldn't load at all. Borrowed from the old project page's
 * `ProjectLoadFailure` (e011da3) without its "All projects" button, and private
 * until a second surface wants it (decisions row 12). A failed read is ours to
 * retry. An expired session is the reader's to sign back into, so it offers no
 * button, in the default register (`lib/read-register.ts`).
 */
function TasksLoadFailure({
  error,
  onRetry,
}: {
  error: TasksReadError;
  onRetry: () => void;
}) {
  return (
    <Alert variant={readAlertVariant(error)}>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span className="min-w-0">{LOAD_COPY[error]}</span>
        {error === 'failed' && (
          <Button variant="secondary" size="sm" className="ml-auto" onClick={onRetry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Which list the Tasks page shows (TASK-950). */
type TasksView = 'current' | 'done';

function TaskBoard({
  tasks,
  unavailableAgents,
  refreshing,
  refreshFailed,
  onNavigate,
  onRetry,
}: {
  tasks: TaskRow[];
  unavailableAgents: UnavailableAgent[];
  refreshing: boolean;
  refreshFailed: boolean;
  onNavigate: (route: WorkspaceRoute) => void;
  onRetry: () => void;
}) {
  // "checked 4 min ago" keeps moving on a tab left open, but the clock only
  // runs while a row (a paused one included) has a report or a done time to date.
  const [now, setNow] = useState(() => new Date());
  const { groups, paused, doneRecently, doneAll } = groupTasks(tasks, now);
  // What the person picked; with nothing done there is nothing to pick, so the
  // page is Current whatever was chosen before (the last done task was reopened),
  // and the choice goes back to Current too: the next task marked done brings
  // the toggle back on Current instead of switching the page to Done by itself.
  // Set while rendering, React's way to adjust state to new props.
  const [chosen, setChosen] = useState<TasksView>('current');
  if (doneAll.length === 0 && chosen !== 'current') setChosen('current');
  const view: TasksView = doneAll.length === 0 ? 'current' : chosen;
  // New rows are dated against the clock now, not when the page first opened:
  // the interval below only runs while a row has a report, so a retry that
  // brings the first reported row in would otherwise read a stale `now`.
  // A layout effect, so the stale time never reaches the screen.
  useLayoutEffect(() => setNow(new Date()), [tasks]);
  const anyReported = tasks.some((t) => t.task !== null || t.doneAt !== null);
  useEffect(() => {
    if (!anyReported) return;
    const id = setInterval(() => setNow(new Date()), AGO_TICK_MS);
    return () => clearInterval(id);
  }, [anyReported]);

  return (
    <>
      {doneAll.length > 0 && (
        <div className="self-start">
          <Segmented<TasksView>
            label="Which tasks to show"
            value={view}
            onValueChange={setChosen}
            options={[
              { value: 'current', label: 'Current' },
              { value: 'done', label: 'Done', count: doneAll.length },
            ]}
          />
        </div>
      )}
      {/*
        No title: this sits over rows the page can still show, and it knows
        nothing about the tasks it couldn't load (`lib/read-register.ts`).
      */}
      {(refreshFailed || unavailableAgents.length > 0) && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span className="flex min-w-0 flex-col gap-1">
              {refreshFailed && (
                <span>We couldn’t refresh your tasks just now, so this list may be out of date.</span>
              )}
              {unavailableAgents.length > 0 && (
                <span>
                  We couldn’t load tasks from{' '}
                  {AGENT_LIST.format(unavailableAgents.map((a) => a.agentName))} just now, so
                  some may be missing.
                </span>
              )}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={onRetry}
              disabled={refreshing}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {/* Only when nothing is missing: zero rows plus an agent we couldn't read is not "no tasks". */}
      {tasks.length === 0 && unavailableAgents.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecks aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No tasks yet</EmptyTitle>
            <EmptyDescription>
              Ask an agent in chat to keep an eye on something for you, like an inbox or a
              queue.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {view === 'current' && (
        <>
          {groups.map(({ group, rows }) => (
            <TaskGroupSection key={group} group={group} rows={rows} now={now} onNavigate={onNavigate} />
          ))}
          {doneRecently.length > 0 && (
            <DoneSection title="Done this week" rows={doneRecently} now={now} onNavigate={onNavigate} />
          )}
          {paused.length > 0 && <PausedTasks rows={paused} now={now} onNavigate={onNavigate} />}
          {groups.length === 0 &&
            doneRecently.length === 0 &&
            paused.length === 0 &&
            doneAll.length > 0 && (
              <p className="text-[13px] text-muted-foreground">
                No tasks need looking after right now. Finished ones are under Done.
              </p>
            )}
        </>
      )}
      {view === 'done' && (
        <DoneSection title="Done" rows={doneAll} now={now} onNavigate={onNavigate} />
      )}
    </>
  );
}

function TaskGroupSection({
  group,
  rows,
  now,
  onNavigate,
}: {
  group: ActiveTaskGroup;
  rows: TaskRow[];
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className="flex items-center gap-2 text-[12.5px] font-medium">
        <StateDotSlot>
          <StateDot state={group} />
        </StateDotSlot>
        <span>
          {TASK_GROUP_LABELS[group]}{' '}
          <span className="text-muted-foreground">· {rows.length}</span>
        </span>
      </h2>
      <TaskList rows={rows} now={now} onNavigate={onNavigate} />
    </section>
  );
}

/** Tasks marked done, under a heading with a check, headed like a group (TASK-950). */
function DoneSection({
  title,
  rows,
  now,
  onNavigate,
}: {
  title: string;
  rows: TaskRow[];
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className="flex items-center gap-2 text-[12.5px] font-medium">
        <StateDotSlot>
          <StateDot state="done" />
        </StateDotSlot>
        <span>
          {title} <span className="text-muted-foreground">· {rows.length}</span>
        </span>
      </h2>
      <TaskList rows={rows} now={now} onNavigate={onNavigate} />
    </section>
  );
}

/** Only a person resumes a paused task, so paused tasks wait behind a toggle, closed at first. */
function PausedTasks({
  rows,
  now,
  onNavigate,
}: {
  rows: TaskRow[];
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = rows.length;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2.5">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-3 self-start">
          <StateDotSlot>
            <StateDot state="paused" />
          </StateDotSlot>
          {open
            ? 'Hide paused tasks'
            : count === 1
              ? 'Show 1 paused task'
              : `Show ${count} paused tasks`}
          <ChevronDown
            data-icon="inline-end"
            aria-hidden="true"
            className={cn('transition-transform', open && 'rotate-180')}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <TaskList rows={rows} now={now} onNavigate={onNavigate} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function TaskList({
  rows,
  now,
  onNavigate,
}: {
  rows: TaskRow[];
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  // `overflow-hidden`: a row's hover fill must follow the card's rounded
  // corners, and its focus ring is drawn inside the row for the same reason.
  return (
    <Card className="overflow-hidden">
      <ul>
        {rows.map((row, i) => (
          <li key={`${row.agentId}:${row.routineId}`}>
            {i > 0 && <Separator />}
            <TaskItem row={row} now={now} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * One task: its name, whose it is and when it last checked in, then the
 * agent's latest update, or, when its last check-ins left none, why (TASK-930),
 * and the agent's reading from that update's report (TASK-952).
 * A get-done task's finish date, when it has one, ends the second line
 * ("2 of 5 steps · 9 days left", TASK-951), unless the task is done.
 * "checked" still dates the last real report. A never-reported task shows its agent's name alone:
 * a time on a row is a claim, and the task's last-run time moves when a
 * check-in is skipped, so it can't stand in for one (decisions rows 3 and 4).
 * A done task (TASK-950) says when it was marked done in place of either, and
 * shows its last update whatever misses it had before: it is finished, and the
 * update is what the person accepted.
 */
function TaskItem({
  row,
  now,
  onNavigate,
}: {
  row: TaskRow;
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const ago = row.task === null ? null : timeAgo(row.task.reportedAt, now);
  // The third line, in order: why a paused-by-misses task is paused, why a task
  // has no recent update, else the last report's update (TASK-930). With
  // misses, the report isn't shown: it's usually from a check-in that started
  // before the silent one. One that started after them sits beside the misses
  // until a later finish moves the count: a report alone never does (a Resume
  // or a kind change also moves it, and not every finish does). All of it
  // host-written except the update.
  // The agent's reading (TASK-952) shows only beside that update: next to a
  // miss, the same stale report's number would contradict it, and with no
  // update line (it fenced to nothing) it would hang under nothing.
  const isDone = row.doneAt !== null;
  const third = isDone
    ? (row.task?.update ?? null)
    : !row.enabled && row.noRecentUpdate?.autoPaused
      ? AUTO_PAUSED_LINE
      : row.noRecentUpdate !== null
        ? missSummary(row.noRecentUpdate)
        : (row.task?.update ?? null);
  const reading =
    (isDone || row.noRecentUpdate === null) && row.task?.update != null ? (row.task.reading ?? null) : null;
  // A get-done task with steps says how far along it is where a stay-on-top
  // one says when it last checked in (TASK-948). One with none yet reads as any
  // other, so a row never claims "0 of 0 steps".
  const doneWhen = row.doneAt === null ? null : checkInWhen(row.doneAt, now);
  const progress = isDone
    ? doneWhen === null
      ? `${row.agentName} · Done`
      : `${row.agentName} · Done ${doneWhen}`
    : row.kind === 'get-done' && row.steps !== null && row.steps.total > 0
      ? `${row.agentName} · ${row.steps.done} of ${row.steps.total} steps`
      : ago === null
        ? row.agentName
        : `${row.agentName} · checked ${ago}`;
  // A get-done task with a finish date says how long is left after that (TASK-951), unless it is
  // Done (TASK-950): a finished task has no days left to count, and its row says when it was done.
  const secondLine =
    !isDone && row.kind === 'get-done' && row.finishBy !== null
      ? `${progress} · ${finishByCount(row.finishBy.daysLeft)}`
      : progress;
  return (
    <a
      {...routeLinkProps(
        { kind: 'task', agentId: row.agentId, routineId: row.routineId },
        onNavigate,
      )}
      className="flex min-w-0 flex-col gap-1 px-5 py-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="truncate text-[13px] font-medium" title={row.name}>
        {row.name}
      </span>
      <span className="break-words text-[12px] text-muted-foreground">
        {secondLine}
      </span>
      {third !== null && (
        <p className="line-clamp-2 break-words text-[13px]" title={third}>
          {third}
        </p>
      )}
      {reading !== null && (
        <p className="break-words text-[12px] text-muted-foreground">
          {`${row.agentName}’s reading · ${reading.label}: ${formatReading(reading.value)}`}
        </p>
      )}
    </a>
  );
}
