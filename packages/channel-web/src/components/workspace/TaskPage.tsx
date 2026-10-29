/**
 * `/workspace/tasks/<agentId>/<routineId>` — one task's own page, of any kind
 * (TASK-910; "Get something done" with its steps, TASK-948, which its owner
 * edits there, TASK-949; "Repeat a job", PR 4).
 *
 * THE LAYOUT (the minimal redesign, 2026-10-29). Only what can't be said
 * another way is words: the name, the agent's own words, the status pill, the
 * one thing the page wants from you, and the reply box. Everything else is an
 * icon (whose words are its tooltip and its accessible name, `task-bits`), a
 * position, or one click down. The page draws its own header inside the
 * scroll column: a back link to Tasks (beside the shell's nav trigger, which
 * below `md` is the only door to the sidebar, TASK-404), the name as the H1
 * with the task's pill (`taskGroup`, the list's own grouping; "Scheduled" or
 * "Paused" for a Repeat job), a row of meta chips (the agent, the kind, how
 * often it checks in, a get-done task's finish date), and the actions on the
 * right. Under the header sits at most one banner, the page's question: a Done
 * task's Done line, else the agent's claim that it's finished, else a missed
 * check-in, else the agent's ask with the reply box inside it. Then two
 * columns (one below `lg`): the latest update and the check-ins on the left;
 * a get-done task's steps and the About list on the right (on a phone the
 * steps come straight after the latest update). The About list opens each
 * row in place: how we'll know it's going well, the instructions, the agent's
 * notes, app updates, a Repeat job's memory, and a link to what the agent may
 * do without asking, which lives in the agent's Settings. A Repeat job has
 * the same header and About list around one Runs card (`RepeatTaskBody`). The
 * page reads its own task (`useTask`), so it only fetches while it is
 * mounted; the shell keys it by the task's ids, since a refresh keeps what's
 * on screen.
 *
 * FINISHING A TASK (TASK-950). Only the person marks a task done. When the
 * agent says it thinks the task is finished (`task.doneClaimed`), the banner
 * says so, with Not yet and Mark done, the page's one primary action (Check
 * now and Pause/Resume stay icons). Not yet opens a what's-left box in place,
 * right under the banner. A get-done task that hasn't claimed anything has
 * Mark done under its steps, outline. With unticked steps the press asks
 * first. A Done task's banner is its Done line; its header holds Reopen, which
 * opens the same box in its reopen mode, and Duplicate (TASK-953: copying a
 * finished plan is its main use); it keeps its steps as they were, read-only,
 * its last update with every check-in one click down, and no reply box. The
 * in-place form closes after a successful send; its composer stays mounted and
 * its sent receipt stays visible outside the hidden fields. A later claim or
 * Done is a new question: it finds the box closed and empty.
 *
 * AN ASK THE BANNER CAN'T HOLD. A claim or a missed check-in takes the banner
 * first: the claim is the question the page most needs answered, and a miss is
 * newer than the report its ask came with. The ask then stays in the latest
 * card, muted, with a Reply that takes the person to the reply box, now at the
 * foot of the check-ins: a person who is still being waited on is never
 * hidden. A miss under a claim stays in the latest card the same way.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. The task's name, its latest update and
 * ask, its reading's label and the agent's notes were written by a model, and
 * so were a get-done task's steps, but for those the person added or reworded
 * (TASK-949); an update can quote a ticket or an email; the brief was written
 * by a person. The server fenced and capped every one before it
 * left (`server/routes-workspace.ts`). Here they are only ever React text
 * children: never `dangerouslySetInnerHTML`, never the markdown renderer, and
 * no attribute is built from them (so a clamped line has no `title`: its whole
 * text is still in the page for a screen reader, and on the check-in's page).
 * `**bold**` and `<img>` show as those characters. The quote marks around the
 * latest update are CSS, so they're never part of its text.
 *
 * A GET-DONE TASK'S FINISH DATE (TASK-951) is a meta chip, "Nov 14 · 9 days",
 * which is also the button that sets, changes or removes it
 * (`TaskFinishDate`, in a Popover). The host counts the days left in the
 * task's time zone (its schedule's, else its active hours', else the zone the
 * person set the date from, else UTC; TASK-955); a saved date shows at once
 * and the page then reads the task again (`useTask`'s `applyAnswer`). A
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
 * page doesn't read this task again. Delete (⋯ › Delete task…) asks first in a
 * dialog that offers Pause instead (`TaskDeleteDialog`), and keeps its own
 * request the same way.
 *
 * WHY A BUTTON IS OFF is one line under the meta chips (`actionNote`), which
 * every disabled button points at (`aria-describedby`). The plain paused line
 * is already the pill, so it is hidden text there, shown only when focus
 * lands on it; the others (no longer allowed, or auto-paused) are shown.
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
 * page's lines are said by one polite live region in the header that is
 * mounted with the task, not inserted with its sentence (a region created and
 * filled together is the announcement screen readers drop most often). After
 * Check now or a reply starts a check-in it says "Checking in now…" while the
 * page reads the task again every 10 seconds (`useTaskPoll`, TASK-931), then
 * "{agent} finished checking in." when that check-in's update arrives, or "The
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
 * to the button that was pressed (Pause and Resume are one slot, so pressing
 * Pause lands on Resume; Duplicate from the ⋯ lands on the ⋯, and a Done
 * task's Duplicate on itself), or the others if that can't be pressed now, or
 * else the line that says why none can. Only from `<body>` or those buttons:
 * someone who moved on meanwhile stays where they went. Mark done follows the
 * same rule: once the task reads as Done, focus goes to the Done line; after a
 * failure, back to the button (or into the question).
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  FileText,
  History,
  MessageSquare,
  MoreHorizontal,
  NotebookPen,
  Pause,
  Pencil,
  Play,
  Plug,
  RefreshCw,
  ShieldCheck,
  Target,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { RESOLUTION_FOCUS_RING, takeResolutionFocus } from '@/lib/consent-focus';
import { HTTP_SESSION_ENDED, isConfirmedRefusal, logRequestFailure } from '@/lib/http';
import { readAlertVariant, type AlertRegister } from '@/lib/read-register';
import { routeLinkProps } from '@/lib/route-link';
import { routineApi, RoutineApiError } from '@/lib/routines';
import { taskGroup, TASK_GROUP_LABELS, type TaskGroup } from '@/lib/task-groups';
import { TASK_KIND_LABELS } from '@/lib/task-kinds';
import { scheduleShort } from '@/lib/task-meta';
import { AUTO_PAUSED_LINE, missSummary, missWords } from '@/lib/task-miss';
import { latestUpdateCheckIn, missCheckIn } from '@/lib/task-updates';
import { cn } from '@/lib/utils';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import { useTaskPoll } from '@/lib/use-task-poll';
import { workspaceApi } from '@/lib/workspace-api';
import { useTask, type TaskReadError } from '@/lib/workspace-task';
import { checkInWhen, shortDay, timeAgo } from '@/lib/workspace-time';
import type { TaskDetail, TaskFinishBy, TaskReplyCheckIn, TaskStep } from '@/lib/workspace-types';
import { AgentTile, StateDot, StateDotSlot } from './bits';
import { IconAction, IconLink, MetaChip, TASK_KIND_ICONS, TASK_KIND_SHORT, TaskStatusPill } from './task-bits';
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
import { TaskDialog } from './TaskDialog';
import { TaskDeleteDialog } from './TaskOptions';
import { TaskAppUpdates } from './TaskAppUpdates';
import { RepeatTaskBody } from './RepeatTaskBody';

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
/** The plain paused note: the pill already says it, so it's hidden text (see WHY A BUTTON IS OFF). */
const PAUSED_NOTE = 'Paused. It won’t check in until you resume it.';

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
      ? PAUSED_NOTE
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

/** Which question the banner asks (see THE LAYOUT and AN ASK THE BANNER CAN'T HOLD), or none. */
type Banner = 'done' | 'claim' | 'miss' | 'ask' | null;

function bannerOf(detail: TaskDetail): Banner {
  if (detail.kind === 'repeat') return null;
  if (detail.doneAt !== null) return 'done';
  if (isClaimed(detail)) return 'claim';
  if (detail.noRecentUpdate !== null) return 'miss';
  return detail.task?.ask != null ? 'ask' : null;
}

/** The header's pill: the list's own group, or a Repeat job's "Scheduled" / "Paused". */
function pillOf(detail: TaskDetail): { group: TaskGroup; label?: string } {
  if (detail.kind === 'repeat' && detail.doneAt === null) {
    return detail.enabled ? { group: 'on-track', label: 'Scheduled' } : { group: 'paused' };
  }
  return { group: taskGroup(detail) };
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
function duplicateFailure(e: unknown): { text: string; register: AlertRegister } {
  if (!isConfirmedRefusal(e)) return { text: UNCONFIRMED.duplicate, register: 'destructive' };
  switch (e.status) {
    case 401:
      // A session running out isn't a malfunction (`lib/read-register.ts`).
      return { text: HTTP_SESSION_ENDED, register: 'default' };
    case 403:
      return { text: COPY_NOT_ALLOWED, register: 'destructive' };
    case 400:
      return {
        text: `We couldn’t copy this task as it is. Open Edit to review it first.`,
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
  onWriteSucceeded: () => void,
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
        const { text, register } = duplicateFailure(e);
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
      onWriteSucceeded();
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

/** The header's buttons a press hands focus back to, in header order. */
type FocusSlot = 'check' | 'toggle' | 'copy' | 'more';
type HeaderRefs = Record<FocusSlot, RefObject<HTMLButtonElement | null>>;

/**
 * Hands focus back after a press (see WHERE FOCUS GOES, above). `pressed` is
 * set by the click and read once, when the press and its re-read are done.
 */
function useFocusAfterPress(
  busy: boolean,
  pressed: RefObject<FocusSlot | null>,
  refs: HeaderRefs,
  note: RefObject<HTMLParagraphElement | null>,
) {
  // A layout effect, so focus is back in the same commit that enables the
  // buttons again, and a keystroke right then isn't lost on `<body>`.
  useLayoutEffect(() => {
    if (busy || pressed.current === null) return;
    const slot = pressed.current;
    pressed.current = null;
    // The pressed control first, then the others in header order.
    const inOrder = [refs.check.current, refs.toggle.current, refs.copy.current, refs.more.current];
    const pressedButton = refs[slot].current;
    const candidates = [pressedButton, ...inOrder.filter((b) => b !== pressedButton)];
    const at = document.activeElement;
    if (at !== null && at !== document.body && !inOrder.includes(at as HTMLButtonElement)) return;
    const target =
      candidates.find((b): b is HTMLButtonElement => b !== null && !b.disabled) ?? note.current;
    if (target !== null && target !== at) takeResolutionFocus(target);
  }, [busy, pressed, refs, note]);
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
  /** The shell's nav trigger below `md` (TASK-404), drawn before the back link. */
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
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const poll = useTaskPoll(detail?.updates ?? null, refreshQuietly);
  const { acting, notice, press } = useTaskActions(
    agentId,
    routineId,
    detail,
    refresh,
    poll,
    onDuplicated,
    onTaskWriteSucceeded,
  );
  const busy = acting !== null || (state.kind === 'ready' && state.refreshing);
  useEffect(() => {
    if (detail?.kind !== 'repeat' || (detail.repeat?.active ?? 0) === 0 && (!detail.enabled || (detail.repeat?.waiting ?? 0) === 0) || poll.phase === 'checking') return;
    const timer = setInterval(refreshQuietly, 10_000);
    return () => clearInterval(timer);
  }, [detail?.kind, detail?.enabled, detail?.repeat?.active, detail?.repeat?.waiting, poll.phase, refreshQuietly]);

  // One-way: the first read that shows the copy running, or Done, uses the
  // line up, so a later Pause or Reopen doesn't bring it back (see THE
  // PAUSED-COPY LINE).
  const [copyLine, setCopyLine] = useState(justCopied);
  const lineUsedUp = detail !== null && (detail.enabled || detail.doneAt !== null);
  useEffect(() => {
    if (lineUsedUp) setCopyLine(false);
  }, [lineUsedUp]);

  // Times on the page are read against the clock when the task last arrived,
  // not when the page first opened. A layout effect, so a stale time never
  // reaches the screen.
  const [now, setNow] = useState(() => new Date());
  useLayoutEffect(() => setNow(new Date()), [detail]);

  const noteId = useId();
  const checkRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [headerRefs] = useState<HeaderRefs>(() => ({ check: checkRef, toggle: toggleRef, copy: copyRef, more: moreRef }));
  const noteRef = useRef<HTMLParagraphElement>(null);
  const pressed = useRef<FocusSlot | null>(null);
  useFocusAfterPress(busy, pressed, headerRefs, noteRef);

  // Not yet and Reopen share one box under the banner (see FINISHING A TASK).
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

  const onPress = (kind: ActionKind, from?: FocusSlot) => {
    pressed.current = from ?? (kind === 'check' ? 'check' : kind === 'duplicate' ? 'more' : 'toggle');
    void press(kind);
  };

  // Watch started replies like Check now. A queued reply keeps its saved receipt
  // without claiming the next check-in has started; every reply refreshes Updates.
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
    refresh();
  };
  const onReplySendStart = () => {
    const captured = poll.capture();
    return (checkIn: TaskReplyCheckIn) => {
      if (checkIn === 'started' || checkIn === 'replayed') poll.start('reply', captured);
    };
  };

  // A saved finish date shows at once; the page then reads the task again (TASK-951).
  const onFinishBySaved = (finishBy: TaskFinishBy | null) =>
    applyAnswer((d) => ({ ...d, finishBy }));

  // Pause instead leaves the dialog for the press, whose own rule then places focus.
  const pausingInstead = useRef(false);

  const note = detail === null ? null : actionNote(detail);
  return (
    <>
      {detail !== null && <TaskDialog open={editing} onOpenChange={setEditing}
        agent={{ agentId, agentName: detail.agentName }} routineId={routineId}
        onWriteSucceeded={onTaskWriteSucceeded} onSaved={() => refresh()}
        onClosed={() => moreRef.current?.focus()} />}
      {detail !== null && (
        <TaskDeleteDialog
          open={deleting}
          onOpenChange={setDeleting}
          agentId={agentId}
          routineId={routineId}
          name={detail.name}
          revision={detail.revision}
          repeat={detail.kind === 'repeat'}
          canPauseInstead={detail.enabled && detail.doneAt === null && detail.permissions.stop}
          onPauseInstead={() => {
            pausingInstead.current = true;
            setDeleting(false);
            onPress('pause', 'toggle');
          }}
          onWriteSucceeded={onTaskWriteSucceeded}
          onDeleted={() => onNavigate({ kind: 'tasks' })}
          onRefresh={refresh}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (pausingInstead.current) {
              pausingInstead.current = false;
              return;
            }
            moreRef.current?.focus();
          }}
        />
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4 px-4 pb-8 pt-3 md:px-6 md:pt-5">
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-1 md:basis-full">
                {leading}
                <a
                  ref={tasksLinkRef}
                  {...routeLinkProps({ kind: 'tasks' }, onNavigate)}
                  className={cn(
                    '-ml-1 inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-[13px] text-muted-foreground hover:text-foreground',
                    RESOLUTION_FOCUS_RING,
                  )}
                >
                  <ChevronLeft aria-hidden="true" className="size-3.5" />
                  Tasks
                </a>
              </div>
              {/* Below `md` the actions share the back link's row and the title takes its own. */}
              <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1.5 md:order-none md:basis-0 md:flex-1">
                <h1 className="min-w-0 break-words text-[24px] font-semibold leading-tight tracking-[-0.01em]">
                  {detail?.name ?? 'Task'}
                </h1>
                {detail !== null && <TaskStatusPill {...pillOf(detail)} />}
              </div>
              {detail !== null && (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <TaskActions
                    detail={detail}
                    busy={busy}
                    acting={acting}
                    noteId={noteId}
                    refs={headerRefs}
                    onPress={onPress}
                    boxId={boxId}
                    reopenOpen={inPlace?.mode === 'reopen' && inPlace.open}
                    onReopen={() => toggleBox('reopen')}
                    onEdit={() => setEditing(true)}
                    onDelete={() => setDeleting(true)}
                  />
                </div>
              )}
            </div>
            {detail !== null && (
              <MetaRow
                detail={detail}
                agentId={agentId}
                routineId={routineId}
                now={now}
                onFinishBySaved={onFinishBySaved}
              />
            )}
            {note !== null && (
              <p
                ref={noteRef}
                id={noteId}
                tabIndex={-1}
                className={cn(
                  'self-start rounded-sm text-[13px] text-muted-foreground',
                  RESOLUTION_FOCUS_RING,
                  note === PAUSED_NOTE && 'sr-only focus:not-sr-only',
                )}
              >
                {note}
              </p>
            )}
            {/* Empty, and taking no room, until a check-in has something to say. */}
            <p role="status" className="text-[13px] empty:-mt-2">
              {detail !== null && <PollLine poll={poll} agentName={detail.agentName} />}
            </p>
          </header>
          {state.kind === 'loading' && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {state.kind === 'failed' && <TaskLoadFailure error={state.error} onRetry={refresh} />}
          {state.kind === 'ready' && (
            <>
              <PageAlerts
                refreshFailed={state.refreshFailed}
                refreshing={state.refreshing}
                onRefresh={refresh}
                copyLine={copyLine && !state.detail.enabled && state.detail.permissions.edit}
                notice={notice}
                onEdit={() => setEditing(true)}
              />
              {state.detail.kind === 'repeat' ? (
                <Columns
                  main={
                    <RepeatTaskBody
                      detail={state.detail}
                      agentId={agentId}
                      routineId={routineId}
                      onNavigate={onNavigate}
                    />
                  }
                  side={
                    <AboutList
                      detail={state.detail}
                      agentId={agentId}
                      routineId={routineId}
                      onEdit={() => setEditing(true)}
                      onNavigate={onNavigate}
                      onRefresh={refresh}
                    />
                  }
                />
              ) : (
                <TaskBody
                  agentId={agentId}
                  routineId={routineId}
                  detail={state.detail}
                  now={now}
                  busy={busy}
                  refreshing={state.refreshing}
                  refreshFailed={state.refreshFailed}
                  poll={poll}
                  boxId={boxId}
                  inPlace={inPlace}
                  onNotYet={() => toggleBox('not-yet')}
                  onRefresh={refresh}
                  onPress={onPress}
                  onReplySent={onReplySent}
                  onReplySendStart={onReplySendStart}
                  onTaskWriteSucceeded={onTaskWriteSucceeded}
                  onStepsChanged={replaceSteps}
                  onNavigate={onNavigate}
                  onEdit={() => setEditing(true)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The header's actions, always in the same slots: Check now (Run now for a
 * Repeat job), then Pause or Resume, then ⋯; on a Done task, Reopen, then
 * Duplicate, then ⋯. React keeps each slot's node where it can, and focus
 * follows the slot (`useFocusAfterPress`). One primary action at a time:
 * Resume is a text button while it's the page's one job (paused, no claim
 * waiting); otherwise every action here is an icon, and the claim's Mark done
 * (TASK-950) or nothing is primary. It's the ⋯ that is disabled without
 * `edit`, not its items: a disabled menu item can't take keyboard focus, so a
 * menu of disabled items would say nothing about why. Pause or Resume never
 * appears in the ⋯: a task that has them always has them here.
 */
function TaskActions({
  detail,
  busy,
  acting,
  noteId,
  refs,
  onPress,
  boxId,
  reopenOpen,
  onReopen,
  onEdit,
  onDelete,
}: {
  detail: TaskDetail;
  busy: boolean;
  acting: ActionKind | null;
  noteId: string;
  refs: HeaderRefs;
  onPress: (kind: ActionKind, from?: FocusSlot) => void;
  /** The in-place box's id, and whether it is open in its reopen mode. */
  boxId: string;
  reopenOpen: boolean;
  onReopen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // The chosen action runs once the menu has handed focus back to the ⋯ (TaskSteps' way).
  const chosen = useRef<(() => void) | null>(null);
  const { enabled, permissions } = detail;
  const done = detail.doneAt !== null;
  const hasNote = actionNote(detail) !== null;
  // Only a button the note explains points at it; one that's only waiting
  // for a press to finish needs no reason.
  const describedBy = (blocked: boolean) => (blocked && hasNote ? noteId : undefined);
  const more = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconAction
          ref={refs.more}
          icon={MoreHorizontal}
          label="More actions"
          variant="ghost"
          disabled={!permissions.edit || busy}
          aria-describedby={describedBy(!permissions.edit)}
          busy={acting === 'duplicate' && !done ? <Spinner aria-hidden="true" /> : undefined}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const action = chosen.current;
          chosen.current = null;
          if (action === null) return;
          event.preventDefault();
          refs.more.current?.focus();
          setTimeout(action, 0);
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => { chosen.current = onEdit; }}>
            <Pencil aria-hidden="true" />
            Edit task
          </DropdownMenuItem>
          {detail.kind !== 'repeat' && !done && (
            <DropdownMenuItem onSelect={() => { chosen.current = () => onPress('duplicate', 'more'); }}>
              <Copy aria-hidden="true" />
              Duplicate
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {permissions.stop && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => { chosen.current = onDelete; }}
              >
                <Trash2 aria-hidden="true" />
                Delete task…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (done) {
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
        <IconAction
          ref={refs.copy}
          icon={Copy}
          label="Duplicate"
          disabled={!permissions.edit || busy}
          aria-describedby={describedBy(!permissions.edit)}
          busy={acting === 'duplicate' ? <Spinner aria-hidden="true" /> : undefined}
          onClick={() => onPress('duplicate', 'copy')}
        />
        {more}
      </>
    );
  }
  const claimed = isClaimed(detail);
  const repeat = detail.kind === 'repeat';
  const checkBlocked = !enabled || !permissions.fire;
  const toggleBlocked = enabled ? !permissions.stop : !permissions.edit;
  const toggling = acting === 'pause' || acting === 'resume';
  return (
    <>
      <IconAction
        ref={refs.check}
        icon={repeat ? Play : RefreshCw}
        label={repeat ? 'Run now' : 'Check now'}
        disabled={checkBlocked || busy}
        aria-describedby={describedBy(checkBlocked)}
        busy={acting === 'check' ? <Spinner aria-hidden="true" /> : undefined}
        onClick={() => onPress('check')}
      />
      {!enabled && !claimed ? (
        // Resume is the page's one job: words, and primary.
        <Button
          ref={refs.toggle}
          size="sm"
          disabled={toggleBlocked || busy}
          aria-describedby={describedBy(toggleBlocked)}
          onClick={() => onPress('resume')}
        >
          {toggling ? (
            <Spinner data-icon="inline-start" aria-hidden="true" />
          ) : (
            <Play data-icon="inline-start" aria-hidden="true" />
          )}
          Resume
        </Button>
      ) : (
        <IconAction
          ref={refs.toggle}
          icon={enabled ? Pause : Play}
          label={enabled ? 'Pause' : 'Resume'}
          disabled={toggleBlocked || busy}
          aria-describedby={describedBy(toggleBlocked)}
          busy={toggling ? <Spinner aria-hidden="true" /> : undefined}
          onClick={() => onPress(enabled ? 'pause' : 'resume')}
        />
      )}
      {more}
    </>
  );
}

/** A chip's short words when there are any; with none it shows its icon alone. */
function withLabel(label: string | null): { label?: string } {
  return label === null ? {} : { label };
}

/**
 * The meta chips under the title: the agent (the one chip with words), the
 * kind, how often it checks in, and a get-done task's finish date (the chip is
 * the date's own control, `TaskFinishDate`). A Done task trades the schedule
 * and the date for the day it was marked done.
 */
function MetaRow({
  detail,
  agentId,
  routineId,
  now,
  onFinishBySaved,
}: {
  detail: TaskDetail;
  agentId: string;
  routineId: string;
  now: Date;
  onFinishBySaved: (finishBy: TaskFinishBy | null) => void;
}) {
  const { agentName } = detail;
  const done = detail.doneAt !== null;
  const next = detail.enabled && detail.nextCheckAt !== null ? checkInWhen(detail.nextCheckAt, now) : null;
  const doneWhen = done ? checkInWhen(detail.doneAt as string, now) : null;
  const doneDay = done ? shortDay(detail.doneAt as string) : '';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1.5 text-[13px]">
        <AgentTile agent={{ name: agentName }} size={18} />
        {agentName}
      </span>
      <MetaChip
        icon={TASK_KIND_ICONS[detail.kind]}
        label={TASK_KIND_SHORT[detail.kind]}
        description={TASK_KIND_LABELS[detail.kind]}
      />
      {!done && detail.schedule !== null && (
        <MetaChip
          icon={Clock}
          {...withLabel(scheduleShort(detail.schedule))}
          description={`${agentName} ${detail.kind === 'repeat' ? 'runs' : 'checks in'} ${detail.schedule}.${
            next === null ? '' : ` Next ${detail.kind === 'repeat' ? 'run' : 'check'} ${next}.`
          }`}
        />
      )}
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
      {done && doneDay !== '' && (
        <MetaChip
          icon={Check}
          label={doneDay}
          description={doneWhen === null ? 'You marked it done.' : `You marked it done ${doneWhen}.`}
        />
      )}
    </div>
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

/** A re-read that failed, the paused-copy line, and the last press's failure, over any kind of task. */
function PageAlerts({
  refreshFailed,
  refreshing,
  onRefresh,
  copyLine,
  notice,
  onEdit,
}: {
  refreshFailed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** This page was just opened by Duplicate, the copy hasn't run, and the viewer may edit it (TASK-953). */
  copyLine: boolean;
  notice: Notice;
  onEdit: () => void;
}) {
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
      {copyLine && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span className="min-w-0">{COPY_LINE}</span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={onEdit}>Edit task</Button>
          </AlertDescription>
        </Alert>
      )}
      {notice !== null && (
        <Alert variant={notice.register}>
          <AlertDescription>{notice.failed}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

/**
 * Two columns from `lg` (the side one 290px), one below it. On a phone the
 * side column's first card (a get-done task's steps) comes straight after the
 * main column's first (the latest update): both wrappers are `contents` there,
 * so their cards are ordered as one list.
 */
function Columns({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_290px] lg:items-start">
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">{main}</div>
      <div className="contents lg:flex lg:flex-col lg:gap-4">{side}</div>
    </div>
  );
}

function TaskBody({
  agentId,
  routineId,
  detail,
  now,
  busy,
  refreshing,
  refreshFailed,
  poll,
  boxId,
  inPlace,
  onNotYet,
  onRefresh,
  onPress,
  onReplySent,
  onReplySendStart,
  onTaskWriteSucceeded,
  onStepsChanged,
  onNavigate,
  onEdit,
}: {
  agentId: string;
  routineId: string;
  detail: TaskDetail;
  now: Date;
  busy: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  poll: TaskPoll;
  /** The in-place box's id and state (see FINISHING A TASK, above). */
  boxId: string;
  inPlace: InPlaceBox | null;
  onNotYet: () => void;
  onRefresh: () => void;
  onPress: (kind: ActionKind, from?: FocusSlot) => void;
  onReplySent: (checkIn: TaskReplyCheckIn, closeBox?: boolean) => void;
  onReplySendStart: () => (checkIn: TaskReplyCheckIn) => void;
  onTaskWriteSucceeded: () => void;
  /** A step change's answer: the steps as they now are, swapped in with no re-read (TASK-949). */
  onStepsChanged: (steps: TaskStep[]) => void;
  onNavigate: (route: WorkspaceRoute) => void;
  onEdit: () => void;
}) {
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const done = detail.doneAt !== null;
  const claimed = isClaimed(detail);
  const banner = bannerOf(detail);
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
  const { agentName } = detail;
  const completedCheckIn =
    poll.arrived === null ? null : `${poll.arrived.firedAt}|${poll.arrived.conversationId ?? ''}`;
  // One reply box on the page: in the ask's banner, else at the foot of the check-ins. A Done task
  // has nothing to reply to; Reopen is how a person writes to it.
  const replyBox = (
    <TaskReplyBox
      compact
      agentId={agentId}
      routineId={routineId}
      agentName={agentName}
      enabled={detail.enabled}
      canStart={detail.permissions.fire}
      inputRef={replyRef}
      completedCheckIn={completedCheckIn}
      onSent={onReplySent}
      onSendStart={onReplySendStart}
    />
  );
  const missFix = (
    <MissLine
      detail={detail}
      now={now}
      agentId={agentId}
      routineId={routineId}
      busy={busy}
      onNavigate={onNavigate}
      onPress={onPress}
      onEdit={onEdit}
    />
  );

  return (
    <>
      {banner === 'done' && <DoneBanner detail={detail} now={now} doneLineRef={doneLineRef} />}
      {banner === 'claim' && (
        <ClaimBanner detail={detail} finish={finish} unticked={unticked} />
      )}
      {banner === 'miss' && (
        <Card className="bg-muted p-4 shadow-none">{missFix}</Card>
      )}
      {banner === 'ask' && (
        <section aria-label={`${agentName} asks`}>
          <Card className="flex flex-col gap-3 bg-warning-soft p-4 shadow-none">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0">
                <AgentTile agent={{ name: agentName }} size={20} />
              </span>
              <p className="min-w-0 whitespace-pre-wrap break-words text-[15px] leading-relaxed">
                {detail.task?.ask}
              </p>
            </div>
            {replyBox}
          </Card>
        </section>
      )}
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
            completedCheckIn={completedCheckIn}
            onSent={(checkIn) => onReplySent(checkIn, true)}
            onSendStart={onReplySendStart}
          />
        )}
      </div>
      <Columns
        main={
          <>
            <Card className="order-1 flex flex-col gap-3 p-4 lg:order-none">
              <LatestUpdate
                detail={detail}
                now={now}
                agentId={agentId}
                routineId={routineId}
                onNavigate={onNavigate}
                onReply={() => replyRef.current?.focus()}
                missLine={banner === 'claim' && detail.noRecentUpdate !== null ? missFix : null}
              />
              {/* Under a missed check-in too: its card still shows the last update this reading came with. */}
              <TaskReadingBlock agentName={agentName} task={detail.task} updates={detail.updates} />
              {done && (
                <TaskUpdates
                  updates={detail.updates}
                  replies={detail.replies}
                  now={now}
                  agentId={agentId}
                  routineId={routineId}
                  onNavigate={onNavigate}
                  collapsed
                />
              )}
            </Card>
            {!done && (
              <Card className="order-3 flex flex-col gap-2 p-4 lg:order-none">
                <TaskUpdates
                  updates={detail.updates}
                  replies={detail.replies}
                  now={now}
                  agentId={agentId}
                  routineId={routineId}
                  onNavigate={onNavigate}
                  latest={detail.task}
                  shown={3}
                />
                {banner !== 'ask' && replyBox}
              </Card>
            )}
          </>
        }
        side={
          <>
            {detail.kind === 'get-done' && (
              <div className="order-2 lg:order-none">
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
              </div>
            )}
            <div className="order-4 lg:order-none">
              <AboutList
                detail={detail}
                agentId={agentId}
                routineId={routineId}
                onEdit={onEdit}
                onNavigate={onNavigate}
                onRefresh={onRefresh}
              />
            </div>
          </>
        }
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

/**
 * A time as the page shows it: a muted "2 hr ago" on screen, and the whole
 * sentence ("Checked at 10:02 AM · Next check at 1:00 PM") for a screen
 * reader. Nothing at all when there's nothing to say.
 */
function WhenLine({ short, full }: { short: string | null; full: string | null }) {
  if (short === null && full === null) return null;
  return (
    <span className="shrink-0 text-[12px] leading-6 tabular-nums text-muted-foreground">
      {short !== null && <span aria-hidden="true">{short}</span>}
      {full !== null && <span className="sr-only">{full}</span>}
    </span>
  );
}

/** "Checked at 10:02 AM · Next check at 1:00 PM", "… · Paused", or less when a time can't be read. */
function checkedSentence(label: 'Checked' | 'Last check-in', at: string, enabled: boolean, next: string | null, now: Date): string | null {
  const checked = checkInWhen(at, now);
  const parts = [
    checked === null ? null : `${label} ${checked}`,
    !enabled ? 'Paused' : next === null ? null : `Next check ${next}`,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The latest report: what the agent said, in quotes, when it checked (and
 * checks next) and a link to that check-in. A task that has never reported
 * says so, and when it will first check in. Paused, it shows the last report
 * it had; Done, its last report, as the record. The banner holds the page's
 * question; an ask the banner can't hold stays here, muted, with Reply, and so
 * does a miss under a claim (see AN ASK THE BANNER CAN'T HOLD).
 */
function LatestUpdate({
  detail,
  now,
  agentId,
  routineId,
  onNavigate,
  onReply,
  missLine,
}: {
  detail: TaskDetail;
  now: Date;
  agentId: string;
  routineId: string;
  onNavigate: (route: WorkspaceRoute) => void;
  /** Takes the person to the reply box. */
  onReply: () => void;
  /** A miss the banner can't hold (a claim took it). */
  missLine: ReactNode;
}) {
  const headingId = useId();
  const { task, enabled, agentName } = detail;
  const done = detail.doneAt !== null;
  const fromCheckIn = latestUpdateCheckIn(task, detail.updates);
  const next =
    enabled && detail.nextCheckAt !== null ? checkInWhen(detail.nextCheckAt, now) : null;
  const banner = bannerOf(detail);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="sr-only">
        Latest update
      </h2>
      {missLine !== null && <div className="text-muted-foreground">{missLine}</div>}
      {task === null ? (
        <p className="flex items-center gap-2 text-[14px] text-muted-foreground">
          <StateDotSlot>
            <StateDot state="no-update" />
          </StateDotSlot>
          <span>{next === null || done ? 'No update yet.' : `No update yet. It’ll check in ${next}.`}</span>
        </p>
      ) : (
        <div className="flex items-start gap-3">
          <p
            className={cn(
              'min-w-0 flex-1 whitespace-pre-wrap break-words text-[15px] leading-6',
              "before:content-['“'] after:content-['”']",
            )}
          >
            {task.update === null || task.update === '' ? CANT_SHOW : task.update}
          </p>
          <WhenLine
            short={timeAgo(task.reportedAt, now)}
            full={done ? `Last update ${checkInWhen(task.reportedAt, now) ?? ''}`.trim() : checkedSentence('Checked', task.reportedAt, enabled, next, now)}
          />
          {fromCheckIn === null ? null : (
            <IconLink
              icon={ArrowUpRight}
              label="See what it did"
              {...routeLinkProps({ kind: 'task-checkin', agentId, routineId, conversationId: fromCheckIn }, onNavigate)}
            />
          )}
        </div>
      )}
      {task?.ask != null && banner !== 'ask' && !done && (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-muted-foreground">
            {`${agentName} asks: ${task.ask}`}
          </p>
          <IconAction icon={MessageSquare} label="Reply" variant="ghost" className="size-7" onClick={onReply} />
        </div>
      )}
    </section>
  );
}

/**
 * A check-in that left no report (TASK-930): its mark (`taskGroup`, the same
 * as its Tasks row: No recent update, or Needs you from the third in a row or
 * when the last report needed you), the one-line reason, and the one thing to
 * do as a link-styled button that does it (Check now, Resume, or Edit for a
 * too-long brief; just words when there's nothing to press), with when it
 * missed and a link to that check-in. The reason and the fix are host-written
 * words (`lib/task-miss.ts`).
 */
function MissLine({
  detail,
  now,
  agentId,
  routineId,
  busy,
  onNavigate,
  onPress,
  onEdit,
}: {
  detail: TaskDetail;
  now: Date;
  agentId: string;
  routineId: string;
  busy: boolean;
  onNavigate: (route: WorkspaceRoute) => void;
  onPress: (kind: ActionKind, from?: FocusSlot) => void;
  onEdit: () => void;
}) {
  const headingId = useId();
  const miss = detail.noRecentUpdate;
  if (miss === null) return null;
  const { enabled, permissions, agentName } = detail;
  // Grouped as the Tasks row groups it, minus the pause: the pill already says "Paused".
  const group = taskGroup({ enabled: true, doneAt: null, task: detail.task, noRecentUpdate: miss });
  const words = missWords(miss.reason, agentName, !enabled, {
    checkNow: permissions.fire,
    edit: permissions.edit,
  });
  const next = enabled && detail.nextCheckAt !== null ? checkInWhen(detail.nextCheckAt, now) : null;
  const missed = missCheckIn(miss, detail.updates);
  // The button does what its words say: Edit, Resume or Check now. A too-long brief nobody here may
  // shorten names no action, so it stays words.
  const fix: (() => void) | null = words.settingsLink
    ? onEdit
    : miss.reason === 'brief-too-long'
      ? null
      : !enabled
        ? permissions.edit
          ? () => onPress('resume')
          : null
        : permissions.fire && miss.reason !== 'interrupted'
          ? () => onPress('check')
          : null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2.5">
        <span className="flex h-6 items-center">
          <StateDotSlot>
            <StateDot state={group} />
          </StateDotSlot>
        </span>
        <h2 id={headingId} className="sr-only">
          {TASK_GROUP_LABELS[group]}
        </h2>
        <p className="min-w-0 flex-1 break-words text-[14px] leading-6">{missSummary(miss)}</p>
        <WhenLine short={timeAgo(miss.at, now)} full={checkedSentence('Last check-in', miss.at, enabled, next, now)} />
        {missed !== null && (
          <IconLink
            icon={ArrowUpRight}
            label="See what it did"
            {...routeLinkProps({ kind: 'task-checkin', agentId, routineId, conversationId: missed }, onNavigate)}
          />
        )}
      </div>
      <div className="pl-[18px]">
        {fix === null ? (
          <p className="text-[13px] text-muted-foreground">{words.fix}</p>
        ) : (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto whitespace-normal p-0 text-left text-[13px]"
            disabled={busy && !words.settingsLink}
            onClick={fix}
          >
            {words.fix}
          </Button>
        )}
      </div>
    </section>
  );
}

/** A Done task's banner: when the person marked it done. Focus lands here after Mark done (WHERE FOCUS GOES). */
function DoneBanner({
  detail,
  now,
  doneLineRef,
}: {
  detail: TaskDetail;
  now: Date;
  doneLineRef: RefObject<HTMLParagraphElement | null>;
}) {
  const doneWhen = checkInWhen(detail.doneAt as string, now);
  return (
    <section aria-label="Done">
      <Card className="bg-primary-soft px-4 py-3 shadow-none">
        <p
          ref={doneLineRef}
          tabIndex={-1}
          className={cn('flex items-center gap-2 rounded-sm text-[14px] font-medium', RESOLUTION_FOCUS_RING)}
        >
          <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span>{doneWhen === null ? 'You marked this done.' : `You marked this done ${doneWhen}.`}</span>
        </p>
      </Card>
    </section>
  );
}

/** The agent thinks the task is finished (TASK-950): the page's one question, Not yet or Mark done. */
function ClaimBanner({ detail, finish, unticked }: { detail: TaskDetail; finish: Finish; unticked: number }) {
  const headingId = useId();
  const { agentName } = detail;
  return (
    <section aria-labelledby={headingId}>
      <Card className="flex flex-col gap-3 bg-primary-soft p-4 shadow-none sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="shrink-0">
            <AgentTile agent={{ name: agentName }} size={20} />
          </span>
          <h2 id={headingId} className="min-w-0 break-words text-[15px] font-medium">
            {detail.noRecentUpdate !== null
              ? `${agentName} said it thinks this is done.`
              : `${agentName} thinks this is done.`}
          </h2>
        </div>
        <MarkDoneControls
          variant="claim"
          finish={finish}
          unticked={unticked}
          canEdit={detail.permissions.edit}
          agentName={agentName}
          running={detail.enabled}
        />
      </Card>
    </section>
  );
}

/** One row of the About list: its icon, one line, a short fact and a chevron. It opens in place. */
function AboutRow({
  icon: Icon,
  label,
  meta,
  metaWords,
  children,
}: {
  icon: LucideIcon;
  /** Person- or host-written; one line on screen, the whole of it inside. */
  label: string;
  /** The short fact at the end ("On", "2"), shown. */
  meta?: string | undefined;
  /** What `meta` says in words, for a screen reader, when the shown fact is only a number. */
  metaWords?: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2.5 px-2.5 py-2 text-[14px] font-normal"
          >
            <Icon data-icon="inline-start" aria-hidden="true" className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            {meta !== undefined && (
              <span aria-hidden={metaWords !== undefined || undefined} className="text-[13px] text-muted-foreground">
                {meta}
              </span>
            )}
            {metaWords !== undefined && <span className="sr-only">{metaWords}</span>}
            <ChevronRight
              data-icon="inline-end"
              aria-hidden="true"
              className={cn('text-muted-foreground transition-transform', open && 'rotate-90')}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-2.5 pb-3 pt-1">{children}</CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * About this task: the side list whose rows open in place (see THE LAYOUT).
 * The brief was written by a person; the notes by the agent. Both are text
 * children only. Changing any of it is Edit's (⋯ › Edit task); a row that has
 * nothing yet points there.
 */
function AboutList({
  detail,
  agentId,
  routineId,
  onEdit,
  onNavigate,
  onRefresh,
}: {
  detail: TaskDetail;
  agentId: string;
  routineId: string;
  onEdit: () => void;
  onNavigate: (route: WorkspaceRoute) => void;
  onRefresh: () => void;
}) {
  const headingId = useId();
  const { agentName, brief, permissions } = detail;
  const repeat = detail.kind === 'repeat';
  const appOn = detail.appUpdates !== undefined || detail.repeat?.appUpdates === true;
  const notes = detail.task?.agentNotes ?? null;
  const noteLines = notes === null ? 0 : notes.split('\n').filter((l) => l.trim() !== '').length;
  const editLink = permissions.edit && (
    <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[13px]" onClick={onEdit}>
      Edit task
    </Button>
  );
  const text = 'whitespace-pre-wrap break-words text-[13px] leading-relaxed';
  return (
    <Card>
      <section aria-labelledby={headingId} className="p-1.5">
        <h2 id={headingId} className="sr-only">
          About this task
        </h2>
        <ul className="flex flex-col divide-y divide-border">
          {!repeat &&
            (brief.goodWhen !== null ? (
              <AboutRow icon={Target} label={brief.goodWhen}>
                <p className="text-[12px] text-muted-foreground">Going well when</p>
                <p className={text}>{brief.goodWhen}</p>
              </AboutRow>
            ) : permissions.edit ? (
              <li>
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2.5 px-2.5 py-2 text-[14px] font-normal text-muted-foreground"
                  onClick={onEdit}
                >
                  <Target data-icon="inline-start" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-left">Add how we’ll know it’s going well</span>
                </Button>
              </li>
            ) : (
              <li className="flex items-center gap-2.5 px-2.5 py-2 text-[14px] text-muted-foreground">
                <Target aria-hidden="true" className="size-4 shrink-0" />
                Nothing saved for how we’ll know it’s going well.
              </li>
            ))}
          <AboutRow icon={FileText} label="Instructions">
            <p className={cn(text, brief.promptBody === null && 'text-muted-foreground')}>
              {brief.promptBody ?? 'No instructions saved.'}
            </p>
          </AboutRow>
          {!repeat && (
            <AboutRow
              icon={NotebookPen}
              label={`${agentName}’s notes`}
              meta={noteLines > 0 ? String(noteLines) : undefined}
              metaWords={noteLines > 0 ? `, ${noteLines} ${noteLines === 1 ? 'line' : 'lines'}` : undefined}
            >
              <TaskNotes
                agentId={agentId}
                routineId={routineId}
                agentName={agentName}
                notes={notes}
                onCleared={onRefresh}
              />
            </AboutRow>
          )}
          <AboutRow icon={Plug} label="App updates" meta={appOn ? 'On' : 'Off'}>
            {!appOn ? (
              <p className="text-[13px] text-muted-foreground">
                Off. Turn it on in Edit task. {editLink}
              </p>
            ) : permissions.edit ? (
              <TaskAppUpdates key={`${agentId}/${routineId}/${detail.revision}`} agentId={agentId} routineId={routineId} onEdit={onEdit} />
            ) : (
              <p className="text-[13px] text-muted-foreground">
                On. Only someone who manages this agent’s tasks can see its setup.
              </p>
            )}
          </AboutRow>
          {repeat && (
            <AboutRow icon={History} label="Memory between runs" meta={detail.repeat?.sharedThread ? 'One thread' : 'Fresh'}>
              <p className="text-[13px] text-muted-foreground">
                {detail.repeat?.sharedThread
                  ? 'This job uses a shared thread. A transcript can include several runs.'
                  : 'Each run starts fresh.'}{' '}
                Change it in Edit task. {editLink}
              </p>
            </AboutRow>
          )}
          <li>
            <Button
              asChild
              variant="ghost"
              className="h-auto w-full justify-start gap-2.5 px-2.5 py-2 text-[13px] font-normal text-muted-foreground"
            >
              <a {...routeLinkProps({ kind: 'agent-settings', id: agentId, section: 'routines' }, onNavigate)}>
                <ShieldCheck data-icon="inline-start" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-left">{`What ${agentName} can do without asking`}</span>
                <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
              </a>
            </Button>
          </li>
        </ul>
      </section>
    </Card>
  );
}

type MarkDone = ReturnType<typeof useMarkDone>;

/** What the claim banner, the steps footer and the body share about finishing a task. */
interface Finish {
  /** Its `buttonRef` goes on whichever Mark done is on screen (the claim's or the footer's; never both), its `controlsRef` on what holds it. */
  markDone: MarkDone;
  doneLineRef: RefObject<HTMLParagraphElement | null>;
  boxId: string;
  notYetOpen: boolean;
  onNotYet: () => void;
}

/**
 * Mark done: in the claim banner as the page's primary action after Not yet,
 * or under the steps as an outline button. The words and the button need the
 * same permission (`edit`): without it the button is disabled and the line
 * says why, and nothing here names an action the viewer can't take. With
 * unticked steps the press opens a question in place of the row.
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
      {markDone.busy ? (
        <Spinner data-icon="inline-start" aria-hidden="true" />
      ) : (
        claim && <Check data-icon="inline-start" aria-hidden="true" />
      )}
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
            {button}
          </div>
          {!canEdit && (
            <p id={whyId} className="text-[12px] text-muted-foreground">
              {MARK_DONE_NOT_ALLOWED}
            </p>
          )}
        </>
      ) : (
        <div className="flex flex-col items-start gap-2">
          {button}
          <p id={whyId} className="text-[12px] text-muted-foreground">
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
