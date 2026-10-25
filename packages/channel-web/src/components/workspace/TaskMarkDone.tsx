/**
 * TaskMarkDone: the person's Mark done press and its confirmation (TASK-950).
 *
 * ONLY A PERSON MARKS A TASK DONE. An agent can say "I think it's done" (a
 * claim), but the task stops checking in only when its owner presses this.
 * The hook and the confirmation are shared by the task page and by Today's
 * claimed block, so the press behaves the same wherever it is made.
 *
 * THE REQUEST ID. A press nobody can confirm (the network dropped, the host
 * answered 5xx, 408 or 429, the answer was unreadable) may or may not have
 * finished the task. Pressing again carries the SAME id, so the host
 * recognises the retry and finishes nothing twice, even if the task was
 * reopened in between. The id is dropped on success and on a confirmed
 * refusal, where a retry is a new attempt (TaskPage's pending-press rule). It
 * is dropped too, with any failure on screen and any open question, once the
 * page shows the task in another state (Done or no longer, another claim or
 * none): the press was answering the old one. Which claim counts, not only
 * whether there is one, since a claim taken back and made again between two
 * reads is a new question. Kept, a press on a task reopened since would replay
 * the old receipt, report success, and leave the task running. A read that
 * shows the same task keeps all three. The reset happens while rendering, not
 * in an effect, so neither the old failure nor the old question reaches the
 * screen beside the new state, even for one commit: the question takes focus
 * as it opens, and its Mark done anyway is one Enter from finishing the task.
 *
 * THE CONFIRMATION asks only when steps are unticked, and says they stay on
 * the task as they are. A task with every step ticked, or with none, is
 * finished on the first press: nobody should have to confirm the obvious. Its
 * count follows the steps as they change (a person can tick one right above
 * it, TASK-949), and once none is left unticked the question closes.
 *
 * WHERE FOCUS GOES, on both pages alike. The caller puts `buttonRef` on Mark
 * done and `controlsRef` on what holds it, the question and the failure. A
 * press disables its button, and Cancel unmounts itself, and either drops
 * focus on `<body>`. So after a failed press focus goes back to the button (or
 * into the question, if it is open), and after Cancel to the button, unless
 * the person moved on meanwhile (TaskPage's rule). A press that lands is the
 * caller's to place: the task page focuses its Done line, Today the consent
 * region.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { takeResolutionFocus } from '@/lib/consent-focus';
import { HTTP_SESSION_ENDED, isConfirmedRefusal, logRequestFailure } from '@/lib/http';
import type { AlertRegister } from '@/lib/read-register';
import { workspaceApi } from '@/lib/workspace-api';

export const MARK_DONE_NOT_ALLOWED =
  'You can’t mark this task done, because you no longer manage this agent’s tasks.';
const UNCONFIRMED =
  'We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.';
const NOT_FOUND = 'We couldn’t find this task any more. It may have been deleted.';
const REFUSED = 'We couldn’t mark this task done just now. Try again.';

/** What the confirmation says about the steps that aren't ticked. */
export function untickedLine(unticked: number): string {
  return unticked === 1
    ? '1 step isn’t ticked. It’ll stay on the task as it is.'
    : `${unticked} steps aren’t ticked. They’ll stay on the task as they are.`;
}

type Failure = { text: string; register: AlertRegister };

/** The words for a failed press, and whether it reads as a malfunction. */
export function markDoneFailure(e: unknown): Failure {
  if (!isConfirmedRefusal(e)) return { text: UNCONFIRMED, register: 'destructive' };
  // A session running out isn't a malfunction (`lib/read-register.ts`).
  if (e.status === 401) return { text: HTTP_SESSION_ENDED, register: 'default' };
  if (e.status === 403) return { text: MARK_DONE_NOT_ALLOWED, register: 'destructive' };
  if (e.status === 404) return { text: NOT_FOUND, register: 'destructive' };
  return { text: REFUSED, register: 'destructive' };
}

export function useMarkDone({
  agentId,
  routineId,
  doneAt,
  claim,
  unticked,
  onDone,
}: {
  agentId: string;
  routineId: string;
  /**
   * The task as the page shows it: when it was marked done (else null), and
   * which claim it shows, by its report's time (else null). Which claim, not
   * whether: one taken back and made again between two reads is a new one.
   */
  doneAt: string | null;
  claim: string | null;
  /** How many steps aren't ticked; above zero, the first press asks. */
  unticked: number;
  /** Runs once the host has answered that the task is done. */
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // The id of a press nobody could confirm, sent again by the next one (THE REQUEST ID).
  const [pending, setPending] = useState<string | null>(null);
  const inFlight = useRef(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  // Set by a press that is on its way, and by Cancel; read once, in the effect below.
  const wasBusy = useRef(false);
  const cancelled = useRef(false);

  // A layout effect, so focus is back in the commit that enables the buttons again.
  useLayoutEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    const afterFailure = wasBusy.current && failure !== null;
    const afterCancel = cancelled.current && !confirming;
    wasBusy.current = false;
    cancelled.current = false;
    if (!afterFailure && !afterCancel) return;
    const target = confirming
      ? controlsRef.current?.querySelector('button')
      : buttonRef.current;
    const at = document.activeElement;
    const here = at === null || at === document.body || controlsRef.current?.contains(at) === true;
    if (here && target != null && target !== at) takeResolutionFocus(target);
  }, [busy, failure, confirming]);

  // A new state of the task starts afresh (THE REQUEST ID). Adjusted while rendering (React's
  // "storing information from previous renders"): React renders again before committing anything.
  const [shown, setShown] = useState({ doneAt, claim });
  if (shown.doneAt !== doneAt || shown.claim !== claim) {
    setShown({ doneAt, claim });
    setPending(null);
    setFailure(null);
    setConfirming(false);
  }
  // Every step got ticked while the question was open (the task page's boxes sit above it, TASK-949):
  // nothing is left to confirm, so it closes, and the next press finishes.
  if (confirming && unticked === 0) setConfirming(false);

  const send = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const requestId = pending ?? crypto.randomUUID();
    setPending(requestId);
    try {
      await workspaceApi.completeTask(agentId, routineId, { requestId });
      setPending(null);
      setConfirming(false);
      onDone();
    } catch (e) {
      logRequestFailure(e, 'task-mark-done');
      if (isConfirmedRefusal(e)) setPending(null);
      setFailure(markDoneFailure(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return {
    busy,
    confirming,
    failure,
    buttonRef,
    controlsRef,
    press: () => {
      if (inFlight.current) return;
      if (unticked > 0) {
        setFailure(null);
        setConfirming(true);
      } else {
        void send();
      }
    },
    confirm: () => void send(),
    cancel: () => {
      if (inFlight.current) return;
      cancelled.current = true;
      setConfirming(false);
      setFailure(null);
    },
  };
}

/** Asked in place of the action row when steps are unticked; takes focus when it opens. */
export function MarkDoneConfirmation({
  unticked,
  primary,
  busy,
  onConfirm,
  onCancel,
}: {
  unticked: number;
  /** Whether Mark done anyway is the page's main action (a claim) or a side one. */
  primary: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  return (
    <Alert>
      <AlertDescription>
        <p>{untickedLine(unticked)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            ref={first}
            type="button"
            size="sm"
            variant={primary ? 'default' : 'outline'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Mark done anyway
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
