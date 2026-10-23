/**
 * `/workspace/tasks` — every task the person owns, across the agents they can
 * see, grouped by what needs them (TASK-909).
 *
 * The page reads its own list (`useTasks`), so it only fetches while the Tasks
 * route is mounted (TASK-909 decisions row 10). `groupTasks` decides the groups
 * and their order; each group's mark is `StateDot`'s task mark, so a task
 * waiting on you looks exactly like an agent waiting on you.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. A task's `name` and its report's
 * `update` were written by a model, and an update can quote a ticket or an
 * email. The server fences both to one line and caps them before they leave
 * (`server/routes-workspace.ts`). Here they are only ever React text children:
 * never `dangerouslySetInnerHTML`, never the markdown renderer, so `**bold**`
 * or `<img>` in an update shows as those characters. Each clamped one keeps
 * the whole fenced value in a `title` (TASK-436).
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
import { cn } from '@/lib/utils';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { useTasks, type TasksReadError } from '@/lib/workspace-tasks';
import { timeAgo } from '@/lib/workspace-time';
import type { TaskRow, UnavailableAgent } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';
import { WorkspaceHeader } from './WorkspaceHeader';

/** How often "checked 4 min ago" is recomputed, as `LearnedInChat` does. */
const AGO_TICK_MS = 30_000;

const AGENT_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

const LOAD_COPY: Record<TasksReadError, string> = {
  expired: HTTP_SESSION_ENDED,
  failed: 'We couldn’t load your tasks just now. Nothing was lost.',
};

export function TasksPage({
  leading,
  onNavigate,
}: {
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const { state, retry } = useTasks();
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
  const { groups, paused } = groupTasks(tasks);

  // "checked 4 min ago" keeps moving on a tab left open, but the clock only
  // runs while a row (a paused one included) has a report to date.
  const [now, setNow] = useState(() => new Date());
  // New rows are dated against the clock now, not when the page first opened:
  // the interval below only runs while a row has a report, so a retry that
  // brings the first reported row in would otherwise read a stale `now`.
  // A layout effect, so the stale time never reaches the screen.
  useLayoutEffect(() => setNow(new Date()), [tasks]);
  const anyReported = tasks.some((t) => t.task !== null);
  useEffect(() => {
    if (!anyReported) return;
    const id = setInterval(() => setNow(new Date()), AGO_TICK_MS);
    return () => clearInterval(id);
  }, [anyReported]);

  return (
    <>
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
      {groups.map(({ group, rows }) => (
        <TaskGroupSection key={group} group={group} rows={rows} now={now} onNavigate={onNavigate} />
      ))}
      {paused.length > 0 && <PausedTasks rows={paused} now={now} onNavigate={onNavigate} />}
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
 * agent's latest update, or, when its last check-ins left none, why (TASK-930).
 * "checked" still dates the last real report. A never-reported task shows its agent's name alone:
 * a time on a row is a claim, and the task's last-run time moves when a
 * check-in is skipped, so it can't stand in for one (decisions rows 3 and 4).
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
  // has no recent update (the report is older than the silence, so it isn't
  // shown), else the last report's update (TASK-930). All of it host-written
  // except the update.
  const third =
    !row.enabled && row.noRecentUpdate?.autoPaused
      ? AUTO_PAUSED_LINE
      : row.noRecentUpdate !== null
        ? missSummary(row.noRecentUpdate)
        : (row.task?.update ?? null);
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
        {ago === null ? row.agentName : `${row.agentName} · checked ${ago}`}
      </span>
      {third !== null && (
        <p className="line-clamp-2 break-words text-[13px]" title={third}>
          {third}
        </p>
      )}
    </a>
  );
}
