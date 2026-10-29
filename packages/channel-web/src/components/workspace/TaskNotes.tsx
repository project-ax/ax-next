/**
 * TaskNotes: the agent's notes on a task's own page (TASK-910). Since the
 * minimal redesign (2026-10-29) it is what the About list's "{agent}’s notes"
 * row opens in place: the row is the Show, and this is what it shows.
 *
 * WHY THEY'RE ON THE PAGE AT ALL. An agent keeps notes between a task's
 * check-ins, and each check-in's message hands them back to it. A model wrote
 * them, and a check-in reads tickets and emails, so an instruction injected
 * through one could persist in the notes from one check-in to the next. Design
 * §7's answer is that the person can see them and clear them. They start
 * folded away behind their About row (the design's "Show"), always one click
 * from view, and a clear waits for a confirm.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. The server fenced and capped the notes
 * before they left it (`server/routes-workspace.ts`). Here they are only ever
 * a React text child: never `dangerouslySetInnerHTML`, never the markdown
 * renderer, and no attribute is built from them. `**bold**` and `<img>` show
 * as those characters.
 *
 * THE CLEAR. Only the task's owner may clear its notes, and the server decides
 * that under its own lock; a refusal comes back as a 404. A clear holds
 * against a check-in already running: no run that started before it can write
 * the notes back (TASK-910 decisions row 2). When it goes through, the confirm
 * closes and the page reads the task again (`onCleared`). The row stays open,
 * so the person sees what the clear left.
 *
 * WHERE FOCUS GOES. After a clear goes through, focus lands on "Notes
 * cleared.", TASK-644's rule (`MemoryCorrection.tsx`): the re-read takes the
 * notes away, and with them the button that opened the confirm, so handing
 * focus back to that button would drop the person on `<body>`. The line is
 * inert (`tabIndex={-1}`) and not a live region, because focus already reads
 * it and a line that is both gets heard twice (TASK-651). Cancel and Escape
 * hand focus back to the button, which is still there.
 */
import { useRef, useState } from 'react';
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
import { RESOLUTION_FOCUS_RING, takeResolutionFocus } from '@/lib/consent-focus';
import { HTTP_SESSION_ENDED, logRequestFailure } from '@/lib/http';
import { toReadOutcome, type ReadOutcome } from '@/lib/read-register';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/workspace-api';

/**
 * What a failed clear says, one sentence per outcome, as a `Record` so a
 * fourth outcome is a type error. Only `failed` invites another try: a 404
 * means the task is gone or no longer theirs, and an ended session needs a
 * sign-in first, so pressing again can't work for either.
 */
const CLEAR_FAILED: Record<ReadOutcome, string> = {
  expired: HTTP_SESSION_ENDED,
  gone: 'We couldn’t find this task any more. It may have been deleted.',
  failed: 'We couldn’t clear the notes just now. Try again.',
};

/**
 * "Notes cleared." stays while the row shows what that clear left behind: the
 * notes it cleared (until the page reads the task again), and then none. It
 * goes once a later check-in writes notes, even in the same words, so it never
 * sits beside notes the person hasn't cleared.
 */
type Cleared = { from: string | null; sawEmpty: boolean } | null;

export function TaskNotes({
  agentId,
  routineId,
  agentName,
  notes,
  onCleared,
}: {
  agentId: string;
  routineId: string;
  agentName: string;
  notes: string | null;
  onCleared: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReadOutcome | null>(null);
  const [cleared, setCleared] = useState<Cleared>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  // Set just before a clear that went through closes the confirm, so only
  // that close lands on the outcome line.
  const landOnOutcome = useRef(false);

  // Adjusted while rendering (React's "storing information from previous
  // renders"), so the line is never painted beside newer notes, even once.
  if (cleared !== null) {
    if (notes === null) {
      if (!cleared.sawEmpty) setCleared({ from: cleared.from, sawEmpty: true });
    } else if (cleared.sawEmpty || notes !== cleared.from) {
      setCleared(null);
    }
  }

  const openConfirm = () => {
    setFailure(null);
    setConfirming(true);
  };

  const clear = () => {
    const shown = notes;
    setBusy(true);
    setFailure(null);
    workspaceApi.clearTaskNotes(agentId, routineId).then(
      () => {
        landOnOutcome.current = true;
        setBusy(false);
        setConfirming(false);
        setCleared({ from: shown, sawEmpty: false });
        onCleared();
      },
      (e: unknown) => {
        logRequestFailure(e, 'task-notes');
        setBusy(false);
        setFailure(toReadOutcome(e));
      },
    );
  };

  return (
    <div className="flex flex-col gap-2 text-[13px] leading-relaxed">
      {cleared !== null && (
        <p ref={outcome} tabIndex={-1} className={cn('self-start rounded-sm', RESOLUTION_FOCUS_RING)}>
          Notes cleared.
        </p>
      )}
      {notes === null ? (
        <p className="text-muted-foreground">None. It keeps notes here between check-ins.</p>
      ) : (
        <>
          <p className="text-[12px] text-muted-foreground">{`${agentName} keeps these for its next check-in.`}</p>
          <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-3 py-2">
            {notes}
          </p>
          <Button variant="outline" size="sm" className="self-start" onClick={openConfirm}>
            Clear notes
          </Button>
        </>
      )}
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          // A clear on its way can't be dismissed out from under itself.
          if (!next && !busy) setConfirming(false);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (!landOnOutcome.current) return;
            landOnOutcome.current = false;
            if (outcome.current === null) return;
            event.preventDefault();
            takeResolutionFocus(outcome.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>{`Clear ${agentName}’s notes?`}</DialogTitle>
            <DialogDescription>
              {`${agentName} won’t see them at its next check-in. You can’t undo this.`}
            </DialogDescription>
          </DialogHeader>
          {failure !== null && (
            // An ended session is drawn neutral, as `LoginPage` draws it:
            // nothing broke, and the way on is to sign in, not to repair.
            <Alert variant={failure === 'expired' ? 'default' : 'destructive'}>
              <AlertDescription>{CLEAR_FAILED[failure]}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || failure === 'expired' || failure === 'gone'}
              onClick={clear}
            >
              {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {busy ? 'Clearing…' : 'Clear notes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
