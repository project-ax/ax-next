/**
 * TaskDeleteDialog: the confirm behind the task page's ⋯ › "Delete task…"
 * (the minimal redesign, 2026-10-29). It replaces the "Task options"
 * collapsible at the bottom of the page. Its other two pieces moved: the
 * webhook signing secret lives in the App updates row (`TaskAppUpdates`), and
 * the agent-wide "what it can do without asking" lives in the agent's Settings
 * (`RoutinesTab`), linked from the About list.
 *
 * It asks once, and offers the gentler thing first: a running task can be
 * paused instead, which keeps it and its history. Delete goes through the
 * routines admin route (`routineApi.remove`) against the revision the page
 * last read, so a task changed elsewhere is refused rather than deleted
 * blind.
 *
 * THE REQUEST ID (`TaskOptions`' rule, kept). A delete nobody could confirm
 * (no answer, a 5xx) may or may not have happened. Pressing Delete again sends
 * the very same request, even after Cancel and reopening, so the server
 * replays its answer instead of deleting twice. An answered refusal ends the
 * request; a revision conflict also asks the page to read the task again
 * (`onRefresh`), and the next press is a new request against what it read.
 *
 * A landed delete is announced (`onWriteSucceeded`) even if the page has gone
 * meanwhile; only a page still there moves on to Tasks (`onDeleted`).
 */
import { useEffect, useRef, useState } from 'react';
import { Pause, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { logRequestFailure } from '@/lib/http';
import { routineApi, RoutineApiError } from '@/lib/routines';

const UNCONFIRMED = 'We couldn’t confirm the task was deleted. Try again, and it won’t happen twice.';
const CHANGED = 'This task changed while you had it open. We’ve loaded the latest, so try again.';
const REFUSED = 'We couldn’t delete this task. You may not manage this agent’s tasks any more.';

type Failure = 'unconfirmed' | 'changed' | 'refused';
const FAILURE_COPY: Record<Failure, string> = { unconfirmed: UNCONFIRMED, changed: CHANGED, refused: REFUSED };

export function TaskDeleteDialog({
  open,
  onOpenChange,
  agentId,
  routineId,
  name,
  revision,
  repeat,
  canPauseInstead,
  onPauseInstead,
  onWriteSucceeded,
  onDeleted,
  onRefresh,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  routineId: string;
  /** The task's name, agent-written: drawn only as text. */
  name: string;
  /** The revision the page last read: the delete's `expectedRevision`. */
  revision: string;
  /** A Repeat job says "runs" where a task says "check-ins". */
  repeat: boolean;
  /** The task is running and the viewer may pause it: offer that first. */
  canPauseInstead: boolean;
  onPauseInstead: () => void;
  onWriteSucceeded: () => void;
  onDeleted: () => void;
  /** A revision conflict: read the task again. */
  onRefresh: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const operation = useRef<{ requestId: string; revision: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function remove() {
    if (busy) return;
    operation.current ??= { requestId: crypto.randomUUID(), revision };
    setBusy(true);
    setFailure(null);
    try {
      await routineApi.remove({
        agentId,
        routineId,
        expectedRevision: operation.current.revision,
        requestId: operation.current.requestId,
      });
      operation.current = null;
      onWriteSucceeded();
      if (alive.current) onDeleted();
    } catch (error) {
      logRequestFailure(error, 'task-delete');
      const answered = error instanceof RoutineApiError && error.status >= 400 && error.status < 500;
      if (answered) operation.current = null;
      if (alive.current) {
        if (!answered) setFailure('unconfirmed');
        else if (error.status === 409) {
          setFailure('changed');
          onRefresh();
        } else setFailure('refused');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A delete on its way can't be dismissed out from under itself.
        if (busy) return;
        if (!next) setFailure(null);
        onOpenChange(next);
      }}
    >
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle className="break-words">{`Delete “${name}”?`}</DialogTitle>
          <DialogDescription>
            {repeat
              ? 'It leaves Tasks and no new runs will start. A run that’s already going may finish.'
              : 'It leaves Tasks and no new check-ins will start. A check-in that’s already running may finish.'}
          </DialogDescription>
        </DialogHeader>
        {canPauseInstead && (
          <p className="text-[14px]">Just need it to stop for a while? Pause it instead.</p>
        )}
        {failure !== null && (
          <Alert variant="destructive">
            <AlertDescription>{FAILURE_COPY[failure]}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {canPauseInstead && (
            <Button variant="outline" disabled={busy || failure === 'unconfirmed'} onClick={onPauseInstead}>
              <Pause data-icon="inline-start" aria-hidden="true" />
              Pause instead
            </Button>
          )}
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Trash2 data-icon="inline-start" aria-hidden="true" />
            )}
            Delete task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
