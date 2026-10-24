/**
 * `/workspace/tasks/<agentId>/<routineId>` — one task's own page, of either
 * kind (TASK-910; "Get something done" with its steps, TASK-948).
 *
 * It reads like a thread (design §3.3): the latest update at the top, the
 * agent's reading under it when the latest report sent one (TASK-952), the
 * brief under that, then every check-in and the person's replies, then the
 * reply box (TASK-931; the latest update's ask has a Reply button that focuses
 * it). The header holds the page's two actions,
 * Check now and Pause, or Resume while it's paused. The page reads its own task
 * (`useTask`), so it only fetches while it is mounted; the shell keys it by the
 * task's ids, since a refresh keeps what's on screen.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. The task's name, its latest update and
 * ask, its reading's label, the agent's notes and a get-done task's steps were
 * written by a model, and an update can quote a ticket or an email; the brief
 * was written by a person. The server fenced and capped every one before it
 * left (`server/routes-workspace.ts`). Here they are only ever React text
 * children: never `dangerouslySetInnerHTML`, never the markdown renderer, and
 * no attribute is built from them. `**bold**` and `<img>` show as those
 * characters.
 *
 * THE ACTIONS go through the routines admin routes (`routineApi`), so the
 * routines services decide who may do what; the page only explains a button it
 * has to disable (decisions row 16). Resume needs `edit`, because only a
 * person who manages the agent's tasks resumes one (design §3.6). One press at
 * a time, and each reads the task again afterwards, so the next one carries the
 * revision it just read. A failure is worded per `RoutineApiError.code`, never
 * with its `message`, which speaks of routines.
 *
 * A PRESS WHOSE ANSWER NEVER CAME keeps its request (`FireNowControl`'s rule):
 * pressing the same action again sends the very same request, so the server
 * replays what it did the first time instead of doing it twice. That holds even
 * when the re-read shows the task changed meanwhile. A check-in that may have
 * started can only be found by its own request id, and a new id against the
 * new revision would start a second one; the old request is refused instead
 * (a revision conflict), and the press after that starts afresh. Any other
 * answer, a refusal included, ends the request.
 *
 * WHAT IS SAID OUT LOUD, AND BY WHOM: each outcome once (TASK-651). The
 * page's lines are said by one polite live region that is mounted with the
 * task, not inserted with its sentence (a region created and filled together
 * is the announcement screen readers drop most often). After Check now or a
 * reply starts a check-in it says "Checking in now…" while the page reads the
 * task again every 10 seconds (`useTaskPoll`, TASK-931), then "{agent}
 * finished checking in." when that check-in's update arrives, or "The
 * check-in didn’t finish. The reason is under Updates." when it arrived as an
 * error, or "Still checking in. …" after five minutes. A Check now press
 * clears the line first, so each press is heard again. The reply box speaks
 * its own sent line ("Sent. {agent} started checking in."), so when a reply
 * started it, the page's "Checking in now…" is shown but hidden from screen
 * readers. A failure is an `Alert`. None of them ever takes focus, so none is
 * heard twice. The 10-second re-reads are quiet (`refreshQuietly`): they
 * leave the buttons pressable and raise no alert when one fails.
 *
 * WHERE FOCUS GOES after a press. A browser drops focus on `<body>` from a
 * button the moment it goes disabled, and every button here is disabled while
 * a press and its re-read are on their way. When they're done, focus goes back
 * to the button that was pressed (Pause and Resume are one button, so pressing
 * Pause lands on Resume), or the other one if that can't be pressed now, or
 * else the line that says why neither can. Only from `<body>` or those
 * buttons: someone who moved on meanwhile stays where they went.
 */
import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { RESOLUTION_FOCUS_RING, takeResolutionFocus } from '@/lib/consent-focus';
import { HTTP_SESSION_ENDED, logRequestFailure } from '@/lib/http';
import { readAlertVariant, type AlertRegister } from '@/lib/read-register';
import { routeLinkProps } from '@/lib/route-link';
import { routineApi, RoutineApiError } from '@/lib/routines';
import { taskGroup, TASK_GROUP_LABELS } from '@/lib/task-groups';
import { TASK_KIND_LABELS } from '@/lib/task-kinds';
import { AUTO_PAUSED_LINE, missSummary, missWords } from '@/lib/task-miss';
import { latestUpdateCheckIn, missCheckIn } from '@/lib/task-updates';
import { cn } from '@/lib/utils';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { useTaskPoll } from '@/lib/use-task-poll';
import { useTask, type TaskReadError } from '@/lib/workspace-task';
import { checkInWhen } from '@/lib/workspace-time';
import type { TaskDetail, TaskReplyCheckIn } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';
import { TaskNotes } from './TaskNotes';
import { TaskReadingBlock } from './TaskReadingBlock';
import { TaskReplyBox } from './TaskReplyBox';
import { TaskSteps } from './TaskSteps';
import { TaskUpdates } from './TaskUpdates';
import { WorkspaceHeader } from './WorkspaceHeader';

const LABEL = 'text-[11.5px] text-muted-foreground break-words';
const VALUE = 'text-[13px] leading-relaxed text-foreground';

const LOAD_COPY: Record<TaskReadError, string> = {
  failed: 'We couldn’t load this task just now. Nothing was lost.',
  gone: 'We couldn’t find this task. It may have been deleted, or it belongs to someone else.',
  expired: HTTP_SESSION_ENDED,
};
const REFRESH_FAILED =
  'We couldn’t refresh this task just now, so what you see may be out of date.';
const CHECKING_IN = 'Checking in now…';
const DIDNT_FINISH = 'The check-in didn’t finish. The reason is under Updates.';
const STILL_CHECKING = 'Still checking in. Its update will be under Updates when it’s done.';
export const CANT_SHOW = 'It left an update we can’t show.';

type ActionKind = 'check' | 'pause' | 'resume';

/** The answer never came, or couldn't be read: the press may or may not have happened. */
const UNCONFIRMED: Record<ActionKind, string> = {
  check: 'We couldn’t confirm the check-in started. Try again, and it won’t start twice.',
  pause: 'We couldn’t confirm that change. Try again.',
  resume: 'We couldn’t confirm that change. Try again.',
};
/** Refused, or the check-in couldn't start, for a reason with no words of its own. */
const REFUSED: Record<ActionKind, string> = {
  check: 'We couldn’t start the check-in. Try again.',
  pause: 'We couldn’t pause this task just now. Try again.',
  resume: 'We couldn’t resume this task just now. Try again.',
};
const CHANGED_ELSEWHERE =
  'This task changed while you had it open. We’ve loaded the latest, so try again.';
const PAUSED_ELSEWHERE = 'This task is paused, so it can’t check in. Resume it first.';
const NOT_THEIRS = 'You can’t change this task any more.';

/**
 * Why a button is disabled, one line under the header, or null when nothing
 * is. For a task's owner `fire` and `stop` are both true or both false (both
 * need to manage the agent's tasks), so a few lines cover every state. A task
 * the host paused after missed check-ins says so first (TASK-930); resuming it
 * needs `edit`, like any other resume.
 */
function actionNote(detail: TaskDetail): string | null {
  if (!detail.enabled && detail.noRecentUpdate?.autoPaused) {
    return detail.permissions.edit
      ? `${AUTO_PAUSED_LINE} Fix what’s below, then Resume.`
      : `${AUTO_PAUSED_LINE} Only someone who manages this agent’s tasks can resume it.`;
  }
  if (!detail.enabled) {
    return detail.permissions.edit
      ? 'Paused. It won’t check in until you resume it.'
      : 'Paused. Only someone who manages this agent’s tasks can resume it.';
  }
  if (!detail.permissions.fire) {
    return 'You can’t start or pause this task’s check-ins, because you no longer manage this agent’s tasks.';
  }
  return null;
}

/** Status 0, a server error, or no `RoutineApiError` at all: nobody knows whether it happened. */
function unconfirmed(e: unknown): boolean {
  return !(e instanceof RoutineApiError) || e.status === 0 || e.status >= 500;
}

function pressFailure(kind: ActionKind, e: unknown): { text: string; register: AlertRegister } {
  if (!(e instanceof RoutineApiError) || unconfirmed(e)) {
    return { text: UNCONFIRMED[kind], register: 'destructive' };
  }
  // A session running out isn't a malfunction (`lib/read-register.ts`).
  if (e.status === 401) return { text: HTTP_SESSION_ENDED, register: 'default' };
  switch (e.code) {
    case 'revision-conflict':
      return { text: CHANGED_ELSEWHERE, register: 'destructive' };
    case 'disabled':
      return { text: PAUSED_ELSEWHERE, register: 'destructive' };
    case 'not-found':
    case 'forbidden':
      return { text: NOT_THEIRS, register: 'destructive' };
    default:
      return { text: REFUSED[kind], register: 'destructive' };
  }
}

/** What the last press left on the page when it failed: an alert. Success speaks through the poll. */
type Notice = { failed: string; register: AlertRegister } | null;

type TaskPoll = ReturnType<typeof useTaskPoll>;

interface PendingPress {
  kind: ActionKind;
  revision: string;
  requestId: string;
}

function useTaskActions(
  agentId: string,
  routineId: string,
  detail: TaskDetail | null,
  refresh: () => void,
  poll: Pick<TaskPoll, 'start' | 'stop'>,
) {
  const [acting, setActing] = useState<ActionKind | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const pending = useRef<PendingPress | null>(null);
  const inFlight = useRef(false);

  const press = async (kind: ActionKind) => {
    if (detail === null || inFlight.current) return;
    inFlight.current = true;
    setActing(kind);
    setNotice(null);
    // Clearing the line at the press is what lets the same words be heard again.
    if (kind === 'check') poll.stop();
    const op: PendingPress =
      pending.current?.kind === kind
        ? pending.current
        : { kind, revision: detail.revision, requestId: crypto.randomUUID() };
    pending.current = op;
    const request = {
      agentId,
      routineId,
      expectedRevision: op.revision,
      requestId: op.requestId,
    };
    try {
      if (kind === 'check') {
        const result = await routineApi.fireNow(request);
        if (result.status === 'ok') poll.start('check-now');
        else setNotice({ failed: REFUSED.check, register: 'destructive' });
      } else {
        await routineApi.update({ ...request, patch: { enabled: kind === 'resume' } });
      }
      pending.current = null;
    } catch (e) {
      logRequestFailure(e, 'task-actions');
      if (!unconfirmed(e)) pending.current = null;
      const { text, register } = pressFailure(kind, e);
      setNotice({ failed: text, register });
    } finally {
      inFlight.current = false;
      setActing(null);
      refresh();
    }
  };

  return { acting, notice, press };
}

/**
 * Hands focus back after a press (see WHERE FOCUS GOES, above). `pressed` is
 * set by the click and read once, when the press and its re-read are done.
 */
function useFocusAfterPress(
  busy: boolean,
  pressed: RefObject<'check' | 'toggle' | null>,
  check: RefObject<HTMLButtonElement | null>,
  toggle: RefObject<HTMLButtonElement | null>,
  note: RefObject<HTMLParagraphElement | null>,
) {
  // A layout effect, so focus is back in the same commit that enables the
  // buttons again, and a keystroke right then isn't lost on `<body>`.
  useLayoutEffect(() => {
    if (busy || pressed.current === null) return;
    const slot = pressed.current;
    pressed.current = null;
    const first = slot === 'check' ? check.current : toggle.current;
    const second = slot === 'check' ? toggle.current : check.current;
    const at = document.activeElement;
    if (at !== null && at !== document.body && at !== first && at !== second) return;
    const target =
      [first, second].find((b): b is HTMLButtonElement => b !== null && !b.disabled) ??
      note.current;
    if (target !== null && target !== at) takeResolutionFocus(target);
  }, [busy, pressed, check, toggle, note]);
}

export function TaskPage({
  agentId,
  routineId,
  leading,
  onNavigate,
}: {
  agentId: string;
  routineId: string;
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const { state, refresh, refreshQuietly } = useTask(agentId, routineId);
  const detail = state.kind === 'ready' ? state.detail : null;
  const poll = useTaskPoll(detail?.updates ?? null, refreshQuietly);
  const { acting, notice, press } = useTaskActions(agentId, routineId, detail, refresh, poll);
  const busy = acting !== null || (state.kind === 'ready' && state.refreshing);

  const noteId = useId();
  const checkRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const pressed = useRef<'check' | 'toggle' | null>(null);
  useFocusAfterPress(busy, pressed, checkRef, toggleRef, noteRef);

  const onPress = (kind: ActionKind) => {
    pressed.current = kind === 'check' ? 'check' : 'toggle';
    void press(kind);
  };

  // A reply that started a check-in watches for it like Check now does; every
  // reply reads the task again, so Updates shows it.
  const onReplySent = (checkIn: TaskReplyCheckIn) => {
    if (checkIn === 'started' || checkIn === 'replayed') poll.start('reply');
    refresh();
  };

  return (
    <>
      <WorkspaceHeader
        title={detail?.name ?? 'Task'}
        leading={
          <>
            {leading}
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <a {...routeLinkProps({ kind: 'tasks' }, onNavigate)}>Tasks</a>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </BreadcrumbList>
            </Breadcrumb>
          </>
        }
      >
        {detail !== null && (
          <TaskActions
            detail={detail}
            busy={busy}
            acting={acting}
            noteId={noteId}
            checkRef={checkRef}
            toggleRef={toggleRef}
            onPress={onPress}
          />
        )}
      </WorkspaceHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-6 pb-6">
          {state.kind === 'loading' && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {state.kind === 'failed' && <TaskLoadFailure error={state.error} onRetry={refresh} />}
          {state.kind === 'ready' && (
            <TaskBody
              agentId={agentId}
              routineId={routineId}
              detail={state.detail}
              refreshing={state.refreshing}
              refreshFailed={state.refreshFailed}
              notice={notice}
              poll={poll}
              noteId={noteId}
              noteRef={noteRef}
              onRefresh={refresh}
              onReplySent={onReplySent}
              onNavigate={onNavigate}
            />
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Check now, then Pause or Resume, always in that order and always the same
 * two buttons: React keeps each one's node, so pressing Pause leaves the person
 * on what is now Resume. One primary action at a time: Check now while it
 * runs, Resume while it's paused.
 */
function TaskActions({
  detail,
  busy,
  acting,
  noteId,
  checkRef,
  toggleRef,
  onPress,
}: {
  detail: TaskDetail;
  busy: boolean;
  acting: ActionKind | null;
  noteId: string;
  checkRef: RefObject<HTMLButtonElement | null>;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onPress: (kind: ActionKind) => void;
}) {
  const { enabled, permissions } = detail;
  const hasNote = actionNote(detail) !== null;
  const checkBlocked = !enabled || !permissions.fire;
  const toggleBlocked = enabled ? !permissions.stop : !permissions.edit;
  // Only a button the note explains points at it; one that's only waiting
  // for a press to finish needs no reason.
  const describedBy = (blocked: boolean) => (blocked && hasNote ? noteId : undefined);
  return (
    <>
      <Button
        ref={checkRef}
        size="sm"
        variant={enabled ? 'default' : 'outline'}
        disabled={checkBlocked || busy}
        aria-describedby={describedBy(checkBlocked)}
        onClick={() => onPress('check')}
      >
        {acting === 'check' && <Spinner data-icon="inline-start" aria-hidden="true" />}
        Check now
      </Button>
      <Button
        ref={toggleRef}
        size="sm"
        variant={enabled ? 'outline' : 'default'}
        disabled={toggleBlocked || busy}
        aria-describedby={describedBy(toggleBlocked)}
        onClick={() => onPress(enabled ? 'pause' : 'resume')}
      >
        {(acting === 'pause' || acting === 'resume') && (
          <Spinner data-icon="inline-start" aria-hidden="true" />
        )}
        {enabled ? 'Pause' : 'Resume'}
      </Button>
    </>
  );
}

/**
 * The page couldn't load at all. A failed read is ours to retry. A missing task
 * (or someone else's: the route answers 404 alike) and an ended session offer
 * no button, since pressing again can't fix either (`lib/read-register.ts`).
 */
function TaskLoadFailure({ error, onRetry }: { error: TaskReadError; onRetry: () => void }) {
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

function TaskBody({
  agentId,
  routineId,
  detail,
  refreshing,
  refreshFailed,
  notice,
  poll,
  noteId,
  noteRef,
  onRefresh,
  onReplySent,
  onNavigate,
}: {
  agentId: string;
  routineId: string;
  detail: TaskDetail;
  refreshing: boolean;
  refreshFailed: boolean;
  notice: Notice;
  poll: TaskPoll;
  noteId: string;
  noteRef: RefObject<HTMLParagraphElement | null>;
  onRefresh: () => void;
  onReplySent: (checkIn: TaskReplyCheckIn) => void;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // Times on the page are read against the clock when the task last arrived,
  // not when the page first opened. A layout effect, so a stale time never
  // reaches the screen.
  const [now, setNow] = useState(() => new Date());
  useLayoutEffect(() => setNow(new Date()), [detail]);
  const briefId = useId();
  const note = actionNote(detail);
  const { agentName } = detail;
  const kindMeta = `${agentName} · ${TASK_KIND_LABELS[detail.kind]}`;
  const meta = detail.schedule === null ? kindMeta : `${kindMeta} · checks in ${detail.schedule}`;

  return (
    <>
      {/*
        No title: this sits over a task the page can still show, and it knows
        nothing about what it couldn't load (`lib/read-register.ts`).
      */}
      {refreshFailed && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span className="min-w-0">{REFRESH_FAILED}</span>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={onRefresh}
              disabled={refreshing}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col">
        <p className="break-words text-[13px] text-muted-foreground">{meta}</p>
        {note !== null && (
          <p
            ref={noteRef}
            id={noteId}
            tabIndex={-1}
            className={cn(
              'mt-1 self-start rounded-sm text-[13px] text-muted-foreground',
              RESOLUTION_FOCUS_RING,
            )}
          >
            {note}
          </p>
        )}
        {/* Empty, and taking no room, until a check-in has something to say. */}
        <p role="status" className="mt-1 text-[13px] empty:mt-0">
          <PollLine poll={poll} agentName={agentName} />
        </p>
      </div>
      {notice !== null && (
        <Alert variant={notice.register}>
          <AlertDescription>{notice.failed}</AlertDescription>
        </Alert>
      )}
      <LatestUpdate
        detail={detail}
        now={now}
        agentId={agentId}
        routineId={routineId}
        onNavigate={onNavigate}
        onReply={() => replyRef.current?.focus()}
      />
      {/* Under a missed check-in too: its card still shows the last update this reading came with. */}
      <TaskReadingBlock agentName={agentName} task={detail.task} updates={detail.updates} />
      {detail.kind === 'get-done' && <TaskSteps steps={detail.steps} agentName={agentName} />}
      <section aria-labelledby={briefId} className="flex flex-col gap-3">
        <h2 id={briefId} className="sr-only">
          About this task
        </h2>
        <dl className="flex flex-col gap-3">
          <BriefRow
            label={`What ${agentName} does`}
            value={detail.brief.promptBody}
            missing="No instructions saved."
          />
          <BriefRow label="Going well when" value={detail.brief.goodWhen} missing="Nothing saved." />
          <TaskNotes
            agentId={agentId}
            routineId={routineId}
            agentName={agentName}
            notes={detail.task?.agentNotes ?? null}
            onCleared={onRefresh}
          />
        </dl>
        {/* Until design PR 4's ⋯ › Edit, the brief is changed in the agent's settings. */}
        <a
          {...routeLinkProps({ kind: 'agent-settings', id: agentId, section: 'routines' }, onNavigate)}
          className={cn(
            'self-start rounded-sm text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground',
            RESOLUTION_FOCUS_RING,
          )}
        >
          {`Change these in ${agentName}’s settings`}
        </a>
      </section>
      <TaskUpdates
        updates={detail.updates}
        replies={detail.replies}
        now={now}
        agentId={agentId}
        routineId={routineId}
        onNavigate={onNavigate}
      />
      <TaskReplyBox
        agentId={agentId}
        routineId={routineId}
        agentName={agentName}
        enabled={detail.enabled}
        canStart={detail.permissions.fire}
        inputRef={replyRef}
        onSent={onReplySent}
      />
    </>
  );
}

/**
 * The page's live line about a check-in a press or a reply started (see WHAT
 * IS SAID OUT LOUD, above). Nothing while no check-in is being watched.
 */
function PollLine({ poll, agentName }: { poll: TaskPoll; agentName: string }) {
  switch (poll.phase) {
    case 'idle':
      return null;
    case 'checking':
      return (
        // The reply box already said a reply started it: shown, not said again.
        <span
          aria-hidden={poll.startedBy === 'reply' || undefined}
          className="inline-flex items-center gap-1.5"
        >
          <Spinner aria-hidden="true" />
          {CHECKING_IN}
        </span>
      );
    case 'arrived':
      return poll.arrived?.status === 'error' ? DIDNT_FINISH : `${agentName} finished checking in.`;
    case 'timed-out':
      return STILL_CHECKING;
  }
}

/** One row of the brief, the `DecisionTaskBlock` row shape. The text keeps its own line breaks. */
function BriefRow({
  label,
  value,
  missing,
}: {
  label: string;
  value: string | null;
  missing: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className={LABEL}>{label}</dt>
      <dd
        className={cn(
          VALUE,
          'whitespace-pre-wrap break-words',
          value === null && 'text-muted-foreground',
        )}
      >
        {value ?? missing}
      </dd>
    </div>
  );
}

/**
 * The latest report: its mark and word, what the agent said, when it checked
 * and checks next, and what it asks. A task that has never reported says so,
 * and when it will first check in. Paused, it shows the last report it had.
 *
 * A task whose last check-in left no report leads with that instead (TASK-930):
 * its mark (`taskGroup`, the same as its Tasks row: No recent update, or Needs
 * you from the third in a row or when the last report needed you), why, the one
 * thing to do, and when it last checked in. The last report stays under it,
 * muted and dated. It is usually from a check-in that started before the silent
 * one (it may have reported later). Just after an agent reports, it can be from
 * one that started after those misses, until a later finish moves the count
 * (a report never does on its own; a Resume or a kind change also moves it,
 * and not every finish does). Its ask stays too, muted: a person is
 * still being waited on, and hiding the ask would hide that.
 * The reason and the fix are host-written words (`lib/task-miss.ts`); the last
 * update and its ask are agent-written.
 *
 * Wherever the ask shows, a Reply button follows it (TASK-931): the ask is the
 * person being waited on, and the reply box under Updates is how to answer.
 */
function LatestUpdate({
  detail,
  now,
  agentId,
  routineId,
  onNavigate,
  onReply,
}: {
  detail: TaskDetail;
  now: Date;
  agentId: string;
  routineId: string;
  onNavigate: (route: WorkspaceRoute) => void;
  /** Takes the person to the reply box. */
  onReply: () => void;
}) {
  const headingId = useId();
  const { task, enabled, agentName } = detail;
  const fromCheckIn = latestUpdateCheckIn(task, detail.updates);
  const next =
    enabled && detail.nextCheckAt !== null ? checkInWhen(detail.nextCheckAt, now) : null;
  const miss = detail.noRecentUpdate;
  if (miss !== null) {
    // Grouped as the Tasks row groups it, minus the pause: this card says "Paused" in its own line.
    const group = taskGroup({ enabled: true, task, noRecentUpdate: miss });
    const words = missWords(miss.reason, agentName, !enabled, {
      checkNow: detail.permissions.fire,
      edit: detail.permissions.edit,
    });
    const missedConversation = missCheckIn(miss, detail.updates);
    const reportedWhen = task === null ? null : checkInWhen(task.reportedAt, now);
    return (
      <section aria-labelledby={headingId}>
        <h2 id={headingId} className="sr-only">
          Latest update
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-2 px-5 py-4">
            <p className="flex items-center gap-2 text-[12.5px] font-medium">
              <StateDotSlot>
                <StateDot state={group} />
              </StateDotSlot>
              <span>{TASK_GROUP_LABELS[group]}</span>
            </p>
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
              {missSummary(miss)}
            </p>
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
              {words.fix}
            </p>
            {words.settingsLink && (
              <a
                {...routeLinkProps(
                  { kind: 'agent-settings', id: agentId, section: 'routines' },
                  onNavigate,
                )}
                className={cn(
                  'self-start rounded-sm text-[13px] underline underline-offset-2 hover:text-foreground',
                  RESOLUTION_FOCUS_RING,
                )}
              >
                {`Open ${agentName}’s settings`}
              </a>
            )}
            <CheckedLine
              label="Last check-in"
              at={miss.at}
              enabled={enabled}
              next={next}
              now={now}
              seeWhatItDid={
                missedConversation === null
                  ? null
                  : {
                      route: {
                        kind: 'task-checkin',
                        agentId,
                        routineId,
                        conversationId: missedConversation,
                      },
                      onNavigate,
                    }
              }
            />
            {task !== null && (
              <p className="whitespace-pre-wrap break-words text-[12px] text-muted-foreground">
                {`Last update${reportedWhen === null ? '' : ` ${reportedWhen}`}: ${
                  task.update === null || task.update === '' ? CANT_SHOW : task.update
                }`}
              </p>
            )}
            {task?.ask != null && (
              <>
                <p className="whitespace-pre-wrap break-words text-[12px] text-muted-foreground">
                  {`${agentName} asks: ${task.ask}`}
                </p>
                <ReplyButton onReply={onReply} />
              </>
            )}
          </CardContent>
        </Card>
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        Latest update
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-2 px-5 py-4">
          {task === null ? (
            <p className="flex items-center gap-2 text-[13px]">
              <StateDotSlot>
                <StateDot state="no-update" />
              </StateDotSlot>
              <span>{next === null ? 'No update yet.' : `No update yet. It’ll check in ${next}.`}</span>
            </p>
          ) : (
            <>
              <p className="flex items-center gap-2 text-[12.5px] font-medium">
                <StateDotSlot>
                  <StateDot state={task.status} />
                </StateDotSlot>
                <span>{TASK_GROUP_LABELS[task.status]}</span>
              </p>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                {task.update === null || task.update === '' ? CANT_SHOW : task.update}
              </p>
              <CheckedLine
                label="Checked"
                at={task.reportedAt}
                enabled={enabled}
                next={next}
                now={now}
                seeWhatItDid={
                  fromCheckIn === null
                    ? null
                    : {
                        route: {
                          kind: 'task-checkin',
                          agentId,
                          routineId,
                          conversationId: fromCheckIn,
                        },
                        onNavigate,
                      }
                }
              />
              {task.ask !== null && (
                <>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                    {`${agentName} asks: ${task.ask}`}
                  </p>
                  <ReplyButton onReply={onReply} />
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** Outline, so the page keeps one primary action (Check now, or Resume). */
function ReplyButton({ onReply }: { onReply: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" className="self-start" onClick={onReply}>
      Reply
    </Button>
  );
}

function CheckedLine({
  label,
  at,
  enabled,
  next,
  now,
  seeWhatItDid,
}: {
  /** "Checked" after a report; "Last check-in" when the last one left none (TASK-930). */
  label: 'Checked' | 'Last check-in';
  /** When that check-in started, ISO. */
  at: string;
  enabled: boolean;
  next: string | null;
  now: Date;
  /** The "See what it did" link's destination, or null when the card has none (TASK-911). */
  seeWhatItDid: { route: WorkspaceRoute; onNavigate: (route: WorkspaceRoute) => void } | null;
}) {
  const checked = checkInWhen(at, now);
  const parts = [
    checked === null ? null : `${label} ${checked}`,
    !enabled ? 'Paused' : next === null ? null : `Next check ${next}`,
    seeWhatItDid === null ? null : (
      <a
        key="see-what-it-did"
        {...routeLinkProps(seeWhatItDid.route, seeWhatItDid.onNavigate)}
        className={cn(
          'rounded-sm text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground',
          RESOLUTION_FOCUS_RING,
        )}
      >
        See what it did
      </a>
    ),
  ].filter((p): p is string | ReactElement => p !== null);
  if (parts.length === 0) return null;
  return (
    <p className="text-[12px] text-muted-foreground">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          {part}
        </Fragment>
      ))}
    </p>
  );
}
