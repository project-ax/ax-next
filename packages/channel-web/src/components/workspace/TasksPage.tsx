/**
 * `/workspace/tasks` — every task the person owns, across the agents they can
 * see, grouped by what needs them (TASK-909), in the minimal layout
 * (2026-10-29): one line per task on desktop, two on a phone.
 *
 * The groups come first, then enabled Repeat jobs, then two toggles at the
 * bottom: "N paused" (only a person resumes a paused task) and "N done"
 * (TASK-950: every task ever marked done, newest first). With nothing running
 * the page says so in one quiet line, whatever is done.
 *
 * The page draws the shell's tasks read (TASK-933), the same one Today and the
 * sidebar badge count from. `groupTasks` decides the groups
 * and their order; each group's mark is `StateDot`'s task mark, so a task
 * waiting on you looks exactly like an agent waiting on you. With more than
 * one agent among the rows, an agent filter narrows them, client-side.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. A task's `name`, its report's `update`
 * and its `ask` were written by a model, and an update can quote a ticket or
 * an email. The server fences each to one line and caps it before it leaves
 * (`server/routes-workspace.ts`). Here they are only ever React text
 * children: never `dangerouslySetInnerHTML`, never the markdown renderer, so
 * `**bold**` or `<img>` in an update shows as those characters. Each clamped
 * one keeps the whole fenced value in a `title` (TASK-436).
 *
 * Each row opens its task page (TASK-910) through a real link, so it can open
 * in a new tab too. A needs-you row's Reply button sits beside that link,
 * never inside it: a button nested in a link is two controls in one.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Bot, ChevronDown, ListChecks, MessageSquare, Plus, Repeat2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { TASK_GROUP_LABELS, groupTasks, taskGroup, type ActiveTaskGroup } from '@/lib/task-groups';
import { rowFact, rowLatest } from '@/lib/task-row-line';
import { cn } from '@/lib/utils';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import type { TasksReadError, TasksState } from '@/lib/workspace-tasks';
import type { TaskRow, UnavailableAgent } from '@/lib/workspace-types';
import { AgentTile, StateDot, StateDotSlot } from './bits';
import { IconAction, TaskKindIcon } from './task-bits';
import { TaskDialog } from './TaskDialog';

/** How often "checked 4 min ago" is recomputed, as `LearnedInChat` does. */
const AGO_TICK_MS = 30_000;

const AGENT_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

const LOAD_COPY: Record<TasksReadError, string> = {
  expired: HTTP_SESSION_ENDED,
  failed: 'We couldn’t load your tasks just now. Nothing was lost.',
};

interface AgentChoice {
  agentId: string;
  agentName: string;
}

/** The distinct agents among the rows, by name. */
function rowAgents(tasks: readonly TaskRow[]): AgentChoice[] {
  const byId = new Map<string, string>();
  for (const task of tasks) if (!byId.has(task.agentId)) byId.set(task.agentId, task.agentName);
  return [...byId]
    .map(([agentId, agentName]) => ({ agentId, agentName }))
    .sort((a, b) => a.agentName.localeCompare(b.agentName) || (a.agentId < b.agentId ? -1 : 1));
}

const ALL_AGENTS = '';

/** A task's own page: where a row's link and its Reply go. */
type TaskRoute = Extract<WorkspaceRoute, { kind: 'task' }>;

export function TasksPage({
  state,
  retry,
  leading,
  onNavigate,
  onReply,
  onTaskWriteSucceeded,
}: {
  state: TasksState;
  retry: () => void;
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
  /** A needs-you row's Reply: the shell opens the task with its reply box focused, once. */
  onReply: (route: TaskRoute) => void;
  onTaskWriteSucceeded: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const createRef = useRef<HTMLButtonElement>(null);
  const tasks = state.kind === 'ready' ? state.tasks : null;
  const agents = useMemo(() => (tasks === null ? [] : rowAgents(tasks)), [tasks]);
  // What the person picked; an agent no longer among the rows (its last task
  // went) reads as All agents, so a filter can never hide every row.
  const [picked, setPicked] = useState(ALL_AGENTS);
  const agent = agents.length > 1 ? (agents.find((a) => a.agentId === picked) ?? null) : null;
  return (
    <>
      {/*
        The shared `WorkspaceHeader`'s 15px title is the other pages' metric;
        this page's title is 24px. The header sits in the rows' centred column,
        so the title and New task line up with the list's edges. It stays
        outside the scroller, and below `md` the shell's nav trigger
        (`leading`, TASK-404) still leads it.
      */}
      <header className="shrink-0 pb-2 pt-4">
        <div className="mx-auto flex min-h-10 w-full max-w-[900px] items-center gap-3 px-6">
          {leading}
          <h1 className="text-[24px] font-semibold tracking-[-0.01em]">Tasks</h1>
          <div className="ml-auto flex items-center gap-2">
            {agents.length > 1 && (
              <AgentFilter agents={agents} agent={agent} onValueChange={setPicked} />
            )}
            <Button ref={createRef} onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              <span className="max-sm:sr-only">New task</span>
            </Button>
          </div>
        </div>
      </header>
      <TaskDialog open={creating} onOpenChange={setCreating} onWriteSucceeded={onTaskWriteSucceeded}
        onSaved={(agentId, routineId) => onNavigate({ kind: 'task', agentId, routineId })}
        onClosed={() => createRef.current?.focus()} />
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
              agent={agent}
              unavailableAgents={state.unavailableAgents}
              refreshing={state.refreshing}
              refreshFailed={state.refreshFailed}
              onNavigate={onNavigate}
              onReply={onReply}
              onRetry={retry}
            />
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The Bot icon's menu: All agents, then each agent among the rows. While the
 * rows are narrowed, the button wears that agent's tile and says so in its
 * name and tooltip, so the filter is never on without the page showing it.
 */
function AgentFilter({
  agents,
  agent,
  onValueChange,
}: {
  agents: AgentChoice[];
  agent: AgentChoice | null;
  onValueChange: (agentId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {agent === null ? (
          <IconAction icon={Bot} label="Filter by agent" />
        ) : (
          <IconAction
            icon={Bot}
            label={`Showing ${agent.agentName}’s tasks. Change filter`}
            busy={<AgentTile agent={{ name: agent.agentName }} size={22} />}
            className="bg-primary-soft ring-2 ring-primary-soft"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuRadioGroup
          aria-label="Show tasks from"
          value={agent?.agentId ?? ALL_AGENTS}
          onValueChange={onValueChange}
        >
          <DropdownMenuRadioItem value={ALL_AGENTS}>All agents</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {agents.map((a) => (
            <DropdownMenuRadioItem key={a.agentId} value={a.agentId}>
              <span className="truncate" title={a.agentName}>{a.agentName}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  agent,
  unavailableAgents,
  refreshing,
  refreshFailed,
  onNavigate,
  onReply,
  onRetry,
}: {
  tasks: TaskRow[];
  /** The agent the rows are narrowed to, or null for all of them. */
  agent: AgentChoice | null;
  unavailableAgents: UnavailableAgent[];
  refreshing: boolean;
  refreshFailed: boolean;
  onNavigate: (route: WorkspaceRoute) => void;
  onReply: (route: TaskRoute) => void;
  onRetry: () => void;
}) {
  // "checked 4 min ago" keeps moving on a tab left open, but the clock only
  // runs while a row (a paused one included) has a report or a done time to date.
  const [now, setNow] = useState(() => new Date());
  const [pausedOpen, setPausedOpen] = useState(false);
  const pausedToggle = useRef<HTMLButtonElement>(null);
  const shown = agent === null ? tasks : tasks.filter((task) => task.agentId === agent.agentId);
  const repeats = shown.filter((task) => task.kind === 'repeat');
  const runningRepeats = repeats.filter((task) => task.enabled);
  const grouped = groupTasks(shown.filter((task) => task.kind !== 'repeat'), now);
  const { groups, doneAll } = grouped;
  const paused = [...grouped.paused, ...repeats.filter((task) => !task.enabled)];
  // New rows are dated against the clock now, not when the page first opened:
  // the interval below only runs while a row has a report, so a retry that
  // brings the first reported row in would otherwise read a stale `now`.
  // A layout effect, so the stale time never reaches the screen.
  useLayoutEffect(() => setNow(new Date()), [tasks]);
  const anyReported = tasks.some((t) => t.task !== null || t.doneAt !== null || t.repeat?.lastRunAt != null);
  useEffect(() => {
    if (!anyReported) return;
    const id = setInterval(() => setNow(new Date()), AGO_TICK_MS);
    return () => clearInterval(id);
  }, [anyReported]);
  // Nothing running: one quiet line, so a page of closed toggles never looks broken.
  const calm = shown.length > 0 && groups.length === 0 && runningRepeats.length === 0;

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
        <TaskGroupSection key={group} group={group} rows={rows} now={now} onNavigate={onNavigate} onReply={onReply} />
      ))}
      {runningRepeats.length > 0 && (
        <RowSection
          mark={<Repeat2 aria-hidden="true" className="size-3.5" />}
          title="Repeat jobs"
          rows={runningRepeats}
          now={now}
          onNavigate={onNavigate}
        />
      )}
      {calm && (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
          <span>Nothing is running right now.</span>
          {paused.length > 0 && !pausedOpen && (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-[13px]"
              onClick={() => {
                setPausedOpen(true);
                // This button goes once the list opens; focus lands on the toggle that closes it.
                requestAnimationFrame(() => pausedToggle.current?.focus());
              }}
            >
              {`Show ${paused.length} paused`}
            </Button>
          )}
        </p>
      )}
      {(paused.length > 0 || doneAll.length > 0) && (
        <div className="flex flex-col gap-1">
          {paused.length > 0 && (
            <RowsToggle
              state="paused"
              word="paused"
              rows={paused}
              open={pausedOpen}
              onOpenChange={setPausedOpen}
              triggerRef={pausedToggle}
              now={now}
              onNavigate={onNavigate}
            />
          )}
          {doneAll.length > 0 && (
            <DoneToggle rows={doneAll} now={now} onNavigate={onNavigate} />
          )}
        </div>
      )}
    </>
  );
}

function TaskGroupSection({
  group,
  rows,
  now,
  onNavigate,
  onReply,
}: {
  group: ActiveTaskGroup;
  rows: TaskRow[];
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
  onReply: (route: TaskRoute) => void;
}) {
  return (
    <RowSection
      mark={<StateDot state={group} />}
      title={TASK_GROUP_LABELS[group]}
      rows={rows}
      now={now}
      onNavigate={onNavigate}
      onReply={onReply}
    />
  );
}

/** A heading (its mark, the muted word and a muted count) over its rows. */
function RowSection({
  mark,
  title,
  rows,
  now,
  onNavigate,
  onReply,
}: {
  mark: ReactNode;
  title: string;
  rows: TaskRow[];
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
  /** Only the active groups' rows can need you, so only they take a Reply. */
  onReply?: (route: TaskRoute) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <StateDotSlot>{mark}</StateDotSlot>
        <span>
          {title} <span className="font-normal tabular-nums">{rows.length}</span>
        </span>
      </h2>
      <TaskList rows={rows} now={now} onNavigate={onNavigate} onReply={onReply} />
    </section>
  );
}

/** "N done": every task marked done, newest first, opened in place (TASK-950). */
function DoneToggle({
  rows,
  now,
  onNavigate,
}: {
  rows: TaskRow[];
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <RowsToggle state="done" word="done" rows={rows} open={open} onOpenChange={setOpen} now={now} onNavigate={onNavigate} />
  );
}

/** A bottom toggle, closed at first: its mark and "N paused" / "N done", then its rows in place. */
function RowsToggle({
  state,
  word,
  rows,
  open,
  onOpenChange,
  triggerRef,
  now,
  onNavigate,
}: {
  state: 'paused' | 'done';
  word: string;
  rows: TaskRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const count = rows.length;
  const noun = count === 1 ? 'task' : 'tasks';
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <Button ref={triggerRef} variant="ghost" size="sm" className="-ml-3 self-start text-[13px] text-muted-foreground">
          <StateDotSlot>
            <StateDot state={state} />
          </StateDotSlot>
          <span>
            {`${count} ${word}`}
            <span className="sr-only">{` ${noun}`}</span>
          </span>
          <ChevronDown
            data-icon="inline-end"
            aria-hidden="true"
            className={cn('transition-transform', open && 'rotate-180')}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <TaskList rows={rows} now={now} onNavigate={onNavigate} label={`${word === 'done' ? 'Done' : 'Paused'} tasks`} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function TaskList({
  rows,
  now,
  onNavigate,
  onReply,
  label,
}: {
  rows: TaskRow[];
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
  onReply?: ((route: TaskRoute) => void) | undefined;
  label?: string;
}) {
  // `overflow-hidden`: a row's hover fill must follow the card's rounded
  // corners, and its focus ring is drawn inside the row for the same reason.
  return (
    <Card className="overflow-hidden">
      <ul aria-label={label}>
        {rows.map((row, i) => (
          <li key={`${row.agentId}:${row.routineId}`}>
            {i > 0 && <Separator />}
            <TaskItem row={row} now={now} onNavigate={onNavigate} onReply={onReply} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * One task: its agent's tile, its name, at most one latest line
 * (`rowLatest`), its kind's icon and one short right-hand fact (`rowFact`),
 * whose whole sentence is in the link's name and a `title`; a needs-you row
 * keeps that fact, which may be the late finish-date warning, and has Reply
 * after it. Below `sm` the
 * name and the latest line stack. A needs-you row quotes its ask in the
 * foreground and gets a Reply button beside the link, which opens the task
 * page with its reply box focused (the shell's one-shot memory, `onReply`),
 * where the ask is the first thing.
 */
function TaskItem({
  row,
  now,
  onNavigate,
  onReply,
}: {
  row: TaskRow;
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
  onReply?: ((route: TaskRoute) => void) | undefined;
}) {
  const nameId = useId();
  const route: TaskRoute = { kind: 'task', agentId: row.agentId, routineId: row.routineId };
  const needsYou = row.kind !== 'repeat' && taskGroup(row) === 'needs-you';
  const latest = rowLatest(row);
  const fact = rowFact(row, now);
  return (
    <div className="flex items-center gap-1 transition-colors hover:bg-accent">
      <a
        {...routeLinkProps(route, onNavigate)}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="shrink-0" title={row.agentName}>
          <AgentTile agent={{ name: row.agentName }} size={22} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <span id={nameId} className="truncate text-sm font-medium sm:max-w-[60%] sm:shrink-0" title={row.name}>
            {row.name}
          </span>
          {latest !== null && (
            <span
              className={cn('min-w-0 truncate text-[13px]', needsYou ? 'text-foreground' : 'text-muted-foreground')}
              title={latest.text}
            >
              {latest.ask ? '“' : null}
              {latest.text}
              {latest.ask ? '”' : null}
            </span>
          )}
        </span>
        <TaskKindIcon kind={row.kind} className="hidden sm:inline-flex" />
        <span className="sr-only">{row.agentName}</span>
        {/* Every row keeps its fact (a late finish date is the one in the error colour); a needs-you row's Reply follows it, beside the link. */}
        {fact !== null && (
          <span
            className={cn('shrink-0 text-[13px] tabular-nums', fact.late ? 'text-destructive' : 'text-muted-foreground')}
            title={fact.full}
          >
            <span aria-hidden="true">{fact.short}</span>
            <span className="sr-only">{fact.full}</span>
          </span>
        )}
      </a>
      {needsYou && (
        <IconAction
          icon={MessageSquare}
          label="Reply"
          aria-describedby={nameId}
          className="mr-3 shrink-0"
          onClick={() => (onReply ?? onNavigate)(route)}
        />
      )}
    </div>
  );
}
