/**
 * `/workspace/tasks/<agentId>/<routineId>` — one task's own page, of either
 * kind (TASK-910; "Get something done" with its steps, TASK-948, which its
 * owner edits there, TASK-949).
 *
 * It reads like a thread (design §3.3): the latest update at the top, the
 * agent's reading under it when the latest report sent one (TASK-952), a
 * get-done task's steps under that (TASK-948), the brief under those, then
 * every check-in and the person's replies, then the reply box (TASK-931; the
 * latest update's ask has a Reply button that focuses it). The header holds
 * Check now, Pause (or Resume while it's paused) and ⋯ with Duplicate
 * (TASK-953). The page reads its own task
 * (`useTask`), so it only fetches while it is mounted; the shell keys it by the
 * task's ids, since a refresh keeps what's on screen.
 *
 * FINISHING A TASK (TASK-950). Only the person marks a task done. When the
 * agent says it thinks the task is finished (`task.doneClaimed`), the latest
 * update leads with that and Mark done becomes the page's one primary action
 * (Check now and Pause/Resume go outline), beside Not yet, which opens a
 * what's-left box in place. A get-done task that hasn't claimed anything has
 * Mark done under its steps, outline. With unticked steps the press asks
 * first. A Done task shows a Done line instead of an update card, keeps its
 * steps as they were, read-only, has no reply box, and its header holds
 * Reopen, which opens the same box in its reopen mode, and the ⋯ with
 * Duplicate (TASK-953: copying a finished plan is its main use). The in-place
 * form closes after a successful send; its composer stays mounted and its
 * sent receipt stays visible outside the hidden fields. A later claim or Done
 * is a new question: it finds the box closed and empty.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. The task's name, its latest update and
 * ask, its reading's label and the agent's notes were written by a model, and
 * so were a get-done task's steps, but for those the person added or reworded
 * (TASK-949); an update can quote a ticket or an email; the brief was written
 * by a person. The server fenced and capped every one before it
 * left (`server/routes-workspace.ts`). Here they are only ever React text
 * children: never `dangerouslySetInnerHTML`, never the markdown renderer, and
 * no attribute is built from them. `**bold**` and `<img>` show as those
 * characters.
 *
 * A GET-DONE TASK'S FINISH DATE (TASK-951) shows right under the meta line,
 * with its own field to set, change or remove it (`TaskFinishDate`). The host
 * counts the days left in the task's time zone (its schedule's, else its
 * active hours', else the zone the person set the date from, else UTC;
 * TASK-955); a saved date shows at once and the page then reads the task
 * again (`useTask`'s `applyAnswer`). A
 * stay-on-top task shows none, whatever it carries, and neither does a Done
 * one (TASK-950): it has no days left to count, and nothing to set.
 *
 * THE ACTIONS go through the routines admin routes (`routineApi`), so the
 * routines services decide who may do what; the page only explains a button it
 * has to disable (decisions row 16). Resume needs `edit`, because only a
 * person who manages the agent's tasks resumes one (design §3.6). One press at
 * a time, and each reads the task again afterwards, so the next one carries the
 * revision it just read. A failure is worded per `RoutineApiError.code`, never
 * with its `message`, which speaks of routines. Duplicate goes through
 * `workspaceApi` to the page's own route instead, and is worded from the
 * status (`duplicateFailure`); on success the shell opens the copy, so the
 * page doesn't read this task again.
 *
 * THE PAUSED-COPY LINE (TASK-953). A copy opens paused, and its page says so
 * once, with the way to change it. The shell tells the page it was just
 * opened by Duplicate (`justCopied`, shell memory, never the URL, so a reload
 * or Back and Forward say nothing); the page keeps that as a one-way latch the
 * first read showing the copy running or Done clears, so Resume (or Mark done,
 * which leaves no Resume to press) uses the line up and a later Pause or
 * Reopen doesn't bring it back. Only a person who may edit sees it, since it
 * says "press Resume".
 *
 * A STEP CHANGE (TASK-949) is `TaskSteps`' own, and moves no revision. Its
 * answer is the steps as they now are, which the page swaps in with no re-read
 * (`useTask().replaceSteps`), so a tick leaves the rest of the page as it was.
 * A Done task's steps take none (TASK-950): they show as a record, and the
 * host refuses a change to them.
 *
 * A PRESS WHOSE ANSWER NEVER CAME keeps its request (`FireNowControl`'s rule):
 * pressing the same action again sends the very same request, so the server
 * replays what it did the first time instead of doing it twice. That holds for
 * Duplicate too: a retry answers the first press's copy. That holds even
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
 * Pause lands on Resume; Duplicate lands on the ⋯), or the others if that can't
 * be pressed now, or else the line that says why none can. Only from `<body>`
 * or those buttons: someone who moved on meanwhile stays where they went. Mark
 * done follows the same rule: once the task reads as Done, focus goes to the
 * Done line; after a failure, back to the button (or into the question).
 */
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { MoreHorizontal } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { RESOLUTION_FOCUS_RING, takeResolutionFocus } from '@/lib/consent-focus';
import { HTTP_SESSION_ENDED, isConfirmedRefusal, logRequestFailure } from '@/lib/http';
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
import { workspaceApi } from '@/lib/workspace-api';
import { useTask, type TaskReadError } from '@/lib/workspace-task';
import { checkInWhen } from '@/lib/workspace-time';
import type { TaskDetail, TaskFinishBy, TaskReplyCheckIn, TaskStep } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';
import { TaskFinishDate } from './TaskFinishDate';
import {
  MARK_DONE_NOT_ALLOWED,
  MarkDoneConfirmation,
  useMarkDone,
} from './TaskMarkDone';
import { TaskNotes } from './TaskNotes';
import { TaskReadingBlock } from './TaskReadingBlock';
import { TaskReplyBox, type TaskReplyMode } from './TaskReplyBox';
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

type ActionKind = 'check' | 'pause' | 'resume' | 'duplicate';

/** The answer never came, or couldn't be read: the press may or may not have happened. */
const UNCONFIRMED: Record<ActionKind, string> = {
  check: 'We couldn’t confirm the check-in started. Try again, and it won’t start twice.',
  pause: 'We couldn’t confirm that change. Try again.',
  resume: 'We couldn’t confirm that change. Try again.',
  duplicate: 'We couldn’t confirm the copy was made. Try again, and it won’t be made twice.',
};
/** Refused, or the check-in couldn't start, for a reason with no words of its own. */
const REFUSED: Record<ActionKind, string> = {
  check: 'We couldn’t start the check-in. Try again.',
  pause: 'We couldn’t pause this task just now. Try again.',
  resume: 'We couldn’t resume this task just now. Try again.',
  duplicate: 'We couldn’t copy this task just now. Try again.',
};
/** Duplicate's 403, and the note when only the ⋯ is off: the person no longer manages the agent's tasks. */
const COPY_NOT_ALLOWED =
  'You can’t copy this task, because you no longer manage this agent’s tasks.';
const COPY_LINE = 'This is a paused copy. Change what you need, then press Resume.';
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
  // A Done task is off too, but it isn't paused: Reopen and Duplicate are left, and both need edit.
  if (detail.doneAt !== null) {
    return detail.permissions.edit
      ? null
      : 'Done. Only someone who manages this agent’s tasks can reopen or copy it.';
  }
  if (!detail.enabled && detail.noRecentUpdate?.autoPaused) {
    return detail.permissions.edit
      ? `${AUTO_PAUSED_LINE} Fix what’s below, then Resume.`
      : `${AUTO_PAUSED_LINE} Only someone who manages this agent’s tasks can resume or copy it.`;
  }
  if (!detail.enabled) {
    return detail.permissions.edit
      ? 'Paused. It won’t check in until you resume it.'
      : 'Paused. Only someone who manages this agent’s tasks can resume or copy it.';
  }
  if (!detail.permissions.fire) {
    return detail.permissions.edit
      ? 'You can’t start or pause this task’s check-ins, because you no longer manage this agent’s tasks.'
      : 'You can’t start or pause this task’s check-ins, or copy the task, because you no longer manage this agent’s tasks.';
  }
  // Nothing produces this for a task (`fire` and `edit` are one answer for its owner), but the ⋯ is off and shouldn't be silent.
  if (!detail.permissions.edit) return COPY_NOT_ALLOWED;
  return null;
}

/** The agent says it thinks the task is finished, and the person hasn't answered. */
function isClaimed(detail: TaskDetail): boolean {
  return detail.doneAt === null && detail.task?.doneClaimed === true;
}

/**
 * The in-place box: which words it speaks (Not yet, or Reopen on a Done task),
 * whether it shows, and whether the claim or Done state it was opened for has
 * ended since (then the next claim or Done closes and empties it).
 */
type InPlaceBox = { mode: Exclude<TaskReplyMode, 'reply'>; open: boolean; ended: boolean };

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

/**
 * A failed Duplicate, worded from the status and never the message. Whether the
 * answer came decides what the retry sends (`isConfirmedRefusal`, the
 * workspace routes' rule).
 */
function duplicateFailure(e: unknown, agentName: string): { text: string; register: AlertRegister } {
  if (!isConfirmedRefusal(e)) return { text: UNCONFIRMED.duplicate, register: 'destructive' };
  switch (e.status) {
    case 401:
      // A session running out isn't a malfunction (`lib/read-register.ts`).
      return { text: HTTP_SESSION_ENDED, register: 'default' };
    case 403:
      return { text: COPY_NOT_ALLOWED, register: 'destructive' };
    case 400:
      return {
        text: `We couldn’t copy this task as it is. Change it in ${agentName}’s settings first.`,
        register: 'destructive',
      };
    case 404:
      return { text: LOAD_COPY.gone, register: 'destructive' };
    default:
      return { text: REFUSED.duplicate, register: 'destructive' };
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
  onDuplicated: (routineId: string) => void,
) {
  const [acting, setActing] = useState<ActionKind | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // Duplicate keeps its own slot: a copy whose answer never came must survive
  // any Check now, Pause or Resume in between (and theirs must survive it), or
  // the retry mints a new id and the server makes a second copy (or check-in).
  const pending = useRef<PendingPress | null>(null);
  const pendingCopy = useRef<string | null>(null);
  const inFlight = useRef(false);

  const press = async (kind: ActionKind) => {
    if (detail === null || inFlight.current) return;
    inFlight.current = true;
    setActing(kind);
    setNotice(null);
    // Clearing the line at the press is what lets the same words be heard again.
    if (kind === 'check') poll.stop();
    let opened = false;
    if (kind === 'duplicate') {
      const requestId = pendingCopy.current ?? crypto.randomUUID();
      pendingCopy.current = requestId;
      try {
        const copy = await workspaceApi.duplicateTask(agentId, routineId, { requestId });
        pendingCopy.current = null;
        // The shell opens the copy and this page goes away: nothing to read again.
        opened = true;
        onDuplicated(copy.routineId);
      } catch (e) {
        logRequestFailure(e, 'task-actions');
        if (isConfirmedRefusal(e)) pendingCopy.current = null;
        const { text, register } = duplicateFailure(e, detail.agentName);
        setNotice({ failed: text, register });
      } finally {
        inFlight.current = false;
        setActing(null);
        if (!opened) refresh();
      }
      return;
    }
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

type FocusSlot = 'check' | 'toggle' | 'more';

/**
 * Hands focus back after a press (see WHERE FOCUS GOES, above). `pressed` is
 * set by the click and read once, when the press and its re-read are done.
 */
function useFocusAfterPress(
  busy: boolean,
  pressed: RefObject<FocusSlot | null>,
  check: RefObject<HTMLButtonElement | null>,
  toggle: RefObject<HTMLButtonElement | null>,
  more: RefObject<HTMLButtonElement | null>,
  note: RefObject<HTMLParagraphElement | null>,
) {
  // A layout effect, so focus is back in the same commit that enables the
  // buttons again, and a keystroke right then isn't lost on `<body>`.
  useLayoutEffect(() => {
    if (busy || pressed.current === null) return;
    const slot = pressed.current;
    pressed.current = null;
    // The pressed control first, then the others in header order.
    const inOrder = [check.current, toggle.current, more.current];
    const pressedButton = { check: check, toggle: toggle, more: more }[slot].current;
    const candidates = [pressedButton, ...inOrder.filter((b) => b !== pressedButton)];
    const at = document.activeElement;
    if (at !== null && at !== document.body && !inOrder.includes(at as HTMLButtonElement)) return;
    const target =
      candidates.find((b): b is HTMLButtonElement => b !== null && !b.disabled) ?? note.current;
    if (target !== null && target !== at) takeResolutionFocus(target);
  }, [busy, pressed, check, toggle, more, note]);
}

export function TaskPage({
  agentId,
  routineId,
  leading,
  onNavigate,
  onDuplicated,
  onTaskWriteSucceeded,
  justCopied = false,
}: {
  agentId: string;
  routineId: string;
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
  /** The copy Duplicate made (same agent): the shell opens it. */
  onDuplicated: (routineId: string) => void;
  /** A landed write can change Today and its badge, independently of the next detail read. */
  onTaskWriteSucceeded: () => void;
  /** This page was just opened by Duplicate, so it says once that it's a paused copy. */
  justCopied?: boolean;
}) {
  const { state, refresh, refreshQuietly, replaceSteps, applyAnswer } = useTask(agentId, routineId);
  const detail = state.kind === 'ready' ? state.detail : null;
  const poll = useTaskPoll(detail?.updates ?? null, refreshQuietly);
  const { acting, notice, press } = useTaskActions(
    agentId,
    routineId,
    detail,
    refresh,
    poll,
    onDuplicated,
  );
  const busy = acting !== null || (state.kind === 'ready' && state.refreshing);

  // One-way: the first read that shows the copy running, or Done, uses the
  // line up, so a later Pause or Reopen doesn't bring it back (see THE
  // PAUSED-COPY LINE).
  const [copyLine, setCopyLine] = useState(justCopied);
  const lineUsedUp = detail !== null && (detail.enabled || detail.doneAt !== null);
  useEffect(() => {
    if (lineUsedUp) setCopyLine(false);
  }, [lineUsedUp]);

  const noteId = useId();
  const checkRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const pressed = useRef<FocusSlot | null>(null);
  useFocusAfterPress(busy, pressed, checkRef, toggleRef, moreRef, noteRef);

  // Not yet and Reopen share one box under the latest update (see FINISHING A TASK).
  const boxId = useId();
  const tasksLinkRef = useRef<HTMLAnchorElement>(null);
  const [inPlace, setInPlace] = useState<InPlaceBox | null>(null);
  const toggleBox = (mode: InPlaceBox['mode']) =>
    setInPlace((cur) =>
      cur !== null && cur.mode === mode
        ? { ...cur, open: !cur.open }
        : { mode, open: true, ended: false },
    );
  // What the page asks the person now, in the box's terms: a Done task's Reopen, a claim's Not yet.
  const question: InPlaceBox['mode'] | null =
    detail === null ? null : detail.doneAt !== null ? 'reopen' : isClaimed(detail) ? 'not-yet' : null;
  // A closed, sent box stays mounted until a new question comes: then it empties.
  // A layout effect, so a new claim never shows Not yet expanded over the old answer.
  useLayoutEffect(() => {
    if (detail === null) return;
    setInPlace((cur) => {
      if (cur === null) return cur;
      if (question === null) return cur.ended ? cur : { ...cur, ended: true };
      return question === cur.mode && !cur.ended ? cur : null;
    });
  }, [detail, question]);

  const onPress = (kind: ActionKind) => {
    pressed.current = kind === 'check' ? 'check' : kind === 'duplicate' ? 'more' : 'toggle';
    void press(kind);
  };

  // A reply that started a check-in watches for it like Check now does; every
  // reply reads the task again, so Updates shows it.
  const onReplySent = (checkIn: TaskReplyCheckIn, closeBox = false) => {
    onTaskWriteSucceeded();
    if (closeBox) {
      const at = document.activeElement;
      const hadFocus = at === null || at === document.body ||
        document.getElementById(boxId)?.contains(at) === true;
      setInPlace((cur) => cur === null ? cur : { ...cur, open: false });
      // The task state (and its action buttons) may change on the re-read.
      // This link stays visible through either outcome; never focus the hidden composer.
      if (hadFocus) tasksLinkRef.current?.focus();
    }
    if (checkIn === 'started' || checkIn === 'replayed') poll.start('reply');
    refresh();
  };

  // A saved finish date shows at once; the page then reads the task again (TASK-951).
  const onFinishBySaved = (finishBy: TaskFinishBy | null) =>
    applyAnswer((d) => ({ ...d, finishBy }));

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
                    <a ref={tasksLinkRef} {...routeLinkProps({ kind: 'tasks' }, onNavigate)}>Tasks</a>
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
            moreRef={moreRef}
            onPress={onPress}
            boxId={boxId}
            reopenOpen={inPlace?.mode === 'reopen' && inPlace.open}
            onReopen={() => toggleBox('reopen')}
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
              boxId={boxId}
              inPlace={inPlace}
              onNotYet={() => toggleBox('not-yet')}
              copyLine={copyLine}
              onRefresh={refresh}
              onReplySent={onReplySent}
              onTaskWriteSucceeded={onTaskWriteSucceeded}
              onStepsChanged={replaceSteps}
              onFinishBySaved={onFinishBySaved}
              onNavigate={onNavigate}
            />
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Check now, then Pause or Resume, then ⋯ with Duplicate, always in that order
 * and always the same three buttons: React keeps each one's node, so pressing
 * Pause leaves the person on what is now Resume. One primary action at a time:
 * Check now while it runs, Resume while it's paused, and neither while the
 * agent's claim waits for Mark done (TASK-950). It's the ⋯ that is disabled
 * without `edit`, not its one item: a disabled menu item can't take keyboard
 * focus, so a menu of one disabled item would say nothing about why. A Done
 * task has Reopen and the same ⋯: copying a finished plan is Duplicate's main
 * use, and the copy is a fresh, paused task that isn't Done.
 */
function TaskActions({
  detail,
  busy,
  acting,
  noteId,
  checkRef,
  toggleRef,
  moreRef,
  onPress,
  boxId,
  reopenOpen,
  onReopen,
}: {
  detail: TaskDetail;
  busy: boolean;
  acting: ActionKind | null;
  noteId: string;
  checkRef: RefObject<HTMLButtonElement | null>;
  toggleRef: RefObject<HTMLButtonElement | null>;
  moreRef: RefObject<HTMLButtonElement | null>;
  onPress: (kind: ActionKind) => void;
  /** The in-place box's id, and whether it is open in its reopen mode. */
  boxId: string;
  reopenOpen: boolean;
  onReopen: () => void;
}) {
  // The chosen action runs once the menu has handed focus back to the ⋯ (TaskSteps' way).
  const chosen = useRef<(() => void) | null>(null);
  const { enabled, permissions } = detail;
  const hasNote = actionNote(detail) !== null;
  // Only a button the note explains points at it; one that's only waiting
  // for a press to finish needs no reason.
  const describedBy = (blocked: boolean) => (blocked && hasNote ? noteId : undefined);
  const more = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={moreRef}
          type="button"
          size="icon"
          variant="ghost"
          aria-label="More actions"
          disabled={!permissions.edit || busy}
          aria-describedby={describedBy(!permissions.edit)}
        >
          {acting === 'duplicate' ? (
            <Spinner aria-hidden="true" />
          ) : (
            <MoreHorizontal aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const action = chosen.current;
          chosen.current = null;
          if (action === null) return;
          event.preventDefault();
          moreRef.current?.focus();
          setTimeout(action, 0);
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => {
              chosen.current = () => onPress('duplicate');
            }}
          >
            Duplicate
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (detail.doneAt !== null) {
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          disabled={!permissions.edit}
          aria-describedby={describedBy(!permissions.edit)}
          aria-expanded={reopenOpen}
          aria-controls={boxId}
          onClick={onReopen}
        >
          Reopen
        </Button>
        {more}
      </>
    );
  }
  const claimed = isClaimed(detail);
  const checkBlocked = !enabled || !permissions.fire;
  const toggleBlocked = enabled ? !permissions.stop : !permissions.edit;
  return (
    <>
      <Button
        ref={checkRef}
        size="sm"
        variant={enabled && !claimed ? 'default' : 'outline'}
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
        variant={enabled || claimed ? 'outline' : 'default'}
        disabled={toggleBlocked || busy}
        aria-describedby={describedBy(toggleBlocked)}
        onClick={() => onPress(enabled ? 'pause' : 'resume')}
      >
        {(acting === 'pause' || acting === 'resume') && (
          <Spinner data-icon="inline-start" aria-hidden="true" />
        )}
        {enabled ? 'Pause' : 'Resume'}
      </Button>
      {more}
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
  boxId,
  inPlace,
  onNotYet,
  copyLine,
  onRefresh,
  onReplySent,
  onTaskWriteSucceeded,
  onStepsChanged,
  onFinishBySaved,
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
  /** The in-place box's id and state (see FINISHING A TASK, above). */
  boxId: string;
  inPlace: InPlaceBox | null;
  onNotYet: () => void;
  /** This page was just opened by Duplicate and hasn't run yet (TASK-953). */
  copyLine: boolean;
  onRefresh: () => void;
  onReplySent: (checkIn: TaskReplyCheckIn, closeBox?: boolean) => void;
  onTaskWriteSucceeded: () => void;
  /** A step change's answer: the steps as they now are, swapped in with no re-read (TASK-949). */
  onStepsChanged: (steps: TaskStep[]) => void;
  onFinishBySaved: (finishBy: TaskFinishBy | null) => void;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const done = detail.doneAt !== null;
  const claimed = isClaimed(detail);
  const unticked = detail.steps.filter((s) => !s.done).length;

  // Mark done (TASK-950). Its success reads the task again; once that shows it
  // Done, focus goes to the Done line, from `<body>` only (WHERE FOCUS GOES).
  // A step change refused because the task was marked done elsewhere asks the
  // same of its re-read (`onStepsRefused`): the steps turn into a record, the
  // control focus was on goes, and focus would be left on `<body>`.
  const doneLineRef = useRef<HTMLParagraphElement>(null);
  const focusDoneLine = useRef(false);
  const markDone = useMarkDone({
    agentId,
    routineId,
    doneAt: detail.doneAt,
    claim: claimed ? (detail.task?.reportedAt ?? null) : null,
    unticked,
    onDone: () => {
      onTaskWriteSucceeded();
      focusDoneLine.current = true;
      onRefresh();
    },
  });
  const onStepsRefused = () => {
    focusDoneLine.current = true;
    onRefresh();
  };
  // Asked once, of the re-read Mark done (or a refused step change) started: if that read fails,
  // a later one that shows the task Done (a poll's, say) answers something else and leaves focus
  // alone. The read has settled once the task isn't refreshing and a new task or a failure has
  // arrived: `onRefresh` marks it refreshing in the same commit as the press settles, but a fast
  // answer can land in that commit too. A failed press, and Cancel, put focus back themselves
  // (`useMarkDone`).
  useLayoutEffect(() => {
    if (!focusDoneLine.current || refreshing) return;
    focusDoneLine.current = false;
    if (detail.doneAt === null) return;
    const at = document.activeElement;
    if (at === null || at === document.body) takeResolutionFocus(doneLineRef.current);
  }, [detail, refreshing, refreshFailed]);

  // Opening the in-place box puts the cursor in it, as Today's Reply does.
  const boxOpen = inPlace?.open === true;
  const boxMode = inPlace?.mode;
  useEffect(() => {
    if (boxOpen) boxRef.current?.focus();
  }, [boxOpen, boxMode]);

  const finish: Finish = {
    markDone,
    doneLineRef,
    boxId,
    notYetOpen: inPlace?.mode === 'not-yet' && inPlace.open,
    onNotYet,
  };
  // Times on the page are read against the clock when the task last arrived,
  // not when the page first opened. A layout effect, so a stale time never
  // reaches the screen.
  const [now, setNow] = useState(() => new Date());
  useLayoutEffect(() => setNow(new Date()), [detail]);
  const briefId = useId();
  const note = actionNote(detail);
  const { agentName } = detail;
  const kindMeta = `${agentName} · ${TASK_KIND_LABELS[detail.kind]}`;
  const meta = done || detail.schedule === null ? kindMeta : `${kindMeta} · checks in ${detail.schedule}`;

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
        {/* A Done task has no date left to keep (TASK-950): it shows neither the date nor the field. */}
        {detail.kind === 'get-done' && !done && (
          <TaskFinishDate
            agentId={agentId}
            routineId={routineId}
            agentName={agentName}
            finishBy={detail.finishBy}
            onSaved={onFinishBySaved}
          />
        )}
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
      {copyLine && !detail.enabled && detail.permissions.edit && (
        <Alert>
          <AlertDescription className="flex flex-col gap-1">
            <span>{COPY_LINE}</span>
            <a
              {...routeLinkProps({ kind: 'agent-settings', id: agentId, section: 'routines' }, onNavigate)}
              className={cn(
                'self-start rounded-sm underline underline-offset-2 hover:text-foreground',
                RESOLUTION_FOCUS_RING,
              )}
            >
              {`Change it in ${agentName}’s settings`}
            </a>
          </AlertDescription>
        </Alert>
      )}
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
        finish={finish}
      />
      {/*
        Not yet and Reopen open this. It is mounted from its first opening and
        only its form hides after a successful send. Its single sent status
        stays outside that hidden form, visible and accessible after closure.
      */}
      <div id={boxId}>
        {inPlace !== null && (
          <TaskReplyBox
            key={inPlace.mode}
            mode={inPlace.mode}
            formHidden={!boxOpen}
            agentId={agentId}
            routineId={routineId}
            agentName={agentName}
            enabled={detail.enabled}
            canStart={detail.permissions.fire}
            inputRef={boxRef}
            completedCheckIn={poll.arrived === null ? null : `${poll.arrived.firedAt}|${poll.arrived.conversationId ?? ''}`}
            onSent={(checkIn) => onReplySent(checkIn, true)}
          />
        )}
      </div>
      {/* Under a missed check-in too: its card still shows the last update this reading came with. */}
      <TaskReadingBlock agentName={agentName} task={detail.task} updates={detail.updates} />
      {detail.kind === 'get-done' && (
        <TaskSteps
          agentId={agentId}
          routineId={routineId}
          steps={detail.steps}
          agentName={agentName}
          onChanged={onStepsChanged}
          onRefused={onStepsRefused}
          readOnly={done}
          footer={
            done || claimed ? undefined : (
              <MarkDoneControls
                variant="footer"
                finish={finish}
                unticked={unticked}
                canEdit={detail.permissions.edit}
                agentName={agentName}
                running={detail.enabled}
              />
            )
          }
        />
      )}
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
      {/* A Done task has nothing to reply to; Reopen is how a person writes to it. */}
      {!done && (
        <TaskReplyBox
          agentId={agentId}
          routineId={routineId}
          agentName={agentName}
          enabled={detail.enabled}
          canStart={detail.permissions.fire}
          inputRef={replyRef}
          completedCheckIn={poll.arrived === null ? null : `${poll.arrived.firedAt}|${poll.arrived.conversationId ?? ''}`}
          onSent={onReplySent}
        />
      )}
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
 *
 * A claim (TASK-950) adds a line saying the agent thinks the task is done, and
 * Mark done and Not yet after the ask, so a pending ask is never hidden by it.
 * A Done task leads with its Done line instead and shows the last update, muted.
 */
function LatestUpdate({
  detail,
  now,
  agentId,
  routineId,
  onNavigate,
  onReply,
  finish,
}: {
  detail: TaskDetail;
  now: Date;
  agentId: string;
  routineId: string;
  onNavigate: (route: WorkspaceRoute) => void;
  /** Takes the person to the reply box. */
  onReply: () => void;
  finish: Finish;
}) {
  const headingId = useId();
  const { task, enabled, agentName } = detail;
  const fromCheckIn = latestUpdateCheckIn(task, detail.updates);
  const next =
    enabled && detail.nextCheckAt !== null ? checkInWhen(detail.nextCheckAt, now) : null;
  const miss = detail.noRecentUpdate;
  const claimed = isClaimed(detail);
  const claimActions = claimed && (
    <MarkDoneControls
      variant="claim"
      finish={finish}
      unticked={detail.steps.filter((s) => !s.done).length}
      canEdit={detail.permissions.edit}
      agentName={agentName}
      running={enabled}
    />
  );
  if (detail.doneAt !== null) {
    const doneWhen = checkInWhen(detail.doneAt, now);
    const reportedWhen = task === null ? null : checkInWhen(task.reportedAt, now);
    return (
      <section aria-labelledby={headingId}>
        <h2 id={headingId} className="sr-only">
          Latest update
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-2 px-5 py-4">
            <p
              ref={finish.doneLineRef}
              tabIndex={-1}
              className={cn(
                'flex items-center gap-2 self-start rounded-sm text-[12.5px] font-medium',
                RESOLUTION_FOCUS_RING,
              )}
            >
              <StateDotSlot>
                <StateDot state="done" />
              </StateDotSlot>
              <span>
                {doneWhen === null
                  ? 'Done · You marked it done.'
                  : `Done · You marked it done ${doneWhen}.`}
              </span>
            </p>
            {task !== null && (
              <p className="whitespace-pre-wrap break-words text-[12px] text-muted-foreground">
                {`Last update${reportedWhen === null ? '' : ` ${reportedWhen}`}: ${
                  task.update === null || task.update === '' ? CANT_SHOW : task.update
                }`}
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    );
  }
  if (miss !== null) {
    // Grouped as the Tasks row groups it, minus the pause: this card says "Paused" in its own line.
    const group = taskGroup({ enabled: true, doneAt: null, task, noRecentUpdate: miss });
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
            {claimed && (
              <p className="text-[12px] text-muted-foreground">
                {`${agentName} said it thinks this is done.`}
              </p>
            )}
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
            {claimActions}
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
              {claimed && <p className="text-[13px] font-medium">{`${agentName} thinks this is done.`}</p>}
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
              {claimActions}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

type MarkDone = ReturnType<typeof useMarkDone>;

/** What the latest-update card, the steps footer and the body share about finishing a task. */
interface Finish {
  /** Its `buttonRef` goes on whichever Mark done is on screen (the claim's or the footer's; never both), its `controlsRef` on what holds it. */
  markDone: MarkDone;
  doneLineRef: RefObject<HTMLParagraphElement | null>;
  boxId: string;
  notYetOpen: boolean;
  onNotYet: () => void;
}

/**
 * Mark done: in the claim card as the page's primary action beside Not yet, or
 * under the steps as an outline button. The words and the button need the same
 * permission (`edit`): without it the button is disabled and the line says why,
 * and nothing here names an action the viewer can't take. With unticked steps
 * the press opens a question in place of the row.
 */
function MarkDoneControls({
  variant,
  finish,
  unticked,
  canEdit,
  agentName,
  running,
}: {
  variant: 'claim' | 'footer';
  finish: Finish;
  unticked: number;
  canEdit: boolean;
  agentName: string;
  /** Switched on, not paused. */
  running: boolean;
}) {
  const whyId = useId();
  const { markDone } = finish;
  const claim = variant === 'claim';
  const button = (
    <Button
      ref={markDone.buttonRef}
      type="button"
      size="sm"
      variant={claim ? 'default' : 'outline'}
      disabled={!canEdit || markDone.busy}
      aria-describedby={claim && canEdit ? undefined : whyId}
      onClick={markDone.press}
    >
      {markDone.busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
      Mark done
    </Button>
  );
  const footerLine = !canEdit
    ? MARK_DONE_NOT_ALLOWED
    : running
      ? `Only you can mark this task done. When ${agentName} thinks it’s finished, it’ll ask you here and on Today.`
      : 'Only you can mark this task done.';
  return (
    <div ref={markDone.controlsRef} className="flex flex-col gap-2">
      {markDone.confirming ? (
        <MarkDoneConfirmation
          unticked={unticked}
          primary={claim}
          busy={markDone.busy}
          onConfirm={markDone.confirm}
          onCancel={markDone.cancel}
        />
      ) : claim ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {button}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-expanded={finish.notYetOpen}
              aria-controls={finish.boxId}
              onClick={finish.onNotYet}
            >
              Not yet
            </Button>
          </div>
          {!canEdit && (
            <p id={whyId} className="text-[12px] text-muted-foreground">
              {MARK_DONE_NOT_ALLOWED}
            </p>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {button}
          <p id={whyId} className="text-[13px] text-muted-foreground">
            {footerLine}
          </p>
        </div>
      )}
      {markDone.failure !== null && (
        <Alert variant={markDone.failure.register}>
          <AlertDescription>{markDone.failure.text}</AlertDescription>
        </Alert>
      )}
    </div>
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
