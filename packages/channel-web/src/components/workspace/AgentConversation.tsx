/**
 * The agent's current conversation.
 *
 * One continuous thread per agent, compacted rather than forked — the `fold`
 * message is the compaction summarize rung surfaced as a fact the user can see
 * rather than an invisible cost optimisation. Past conversations live in the
 * rail; routine fires never appear here at all, or 612 unattended runs would
 * bury the two conversations the human actually had.
 */
import { useState } from 'react';
import { ArrowUp, ChevronRight, Layers, ListChecks } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { signInWithGoogle } from '@/lib/auth';
import type {
  Decision,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceReadStatus,
} from '@/lib/workspace-api';
import { AgentTile } from './bits';
import { ApprovalCard } from './ApprovalCard';
import {
  DECISION_SESSION_EXPIRED,
  DECISION_THREAD_READ_FAILED,
} from './decision-copy';

/**
 * What this thread can honestly say about its approvals.
 *
 * The three WIRE answers, plus one that never crosses the wire. `expired` is a
 * 401 on the client's queue read — a fact about the reader's SESSION, not about
 * the read — and it is the only one of the four where "Try again" is the wrong
 * offer, because every retry returns the same 401 until they sign in. Same line
 * TASK-276 drew on Today and on the in-thread card; drawing it differently here
 * would leave one surface pointing at a button that cannot work.
 */
export type ApprovalRead = WorkspaceReadStatus | 'expired';

interface Props {
  agent: WorkspaceAgent;
  thread: ThreadMessage[];
  decisions: Decision[];
  readOnly: boolean;
  /** True while a reply is streaming — the composer waits it out. */
  busy?: boolean;
  onSend: (text: string) => void;
  /**
   * The three ways out of a decision. REQUIRED: the routes behind them ship
   * with the rows, so there is no longer a state where a card is on screen with
   * nothing able to resolve it. Not optional-with-a-default — a card whose
   * buttons swallow the click is worse than no card, and a default no-op is
   * exactly how one gets added later without anyone noticing.
   */
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  /** Rows with a POST in flight. Their controls go quiet, never absent. */
  busyIds?: ReadonlySet<string>;
  /** Per-row line from an action that failed or was refused. */
  notices?: ReadonlyMap<string, string>;
  /**
   * How the approval set behind this thread was read — see `AgentView`, which
   * folds the two reads that stand behind it into this one answer.
   *
   * REQUIRED, and deliberately not optional-with-an-`'ok'`-default. The default
   * would be the exact claim this prop exists to stop us making by accident:
   * "nothing is waiting on you". That claim once got made because a caller
   * passed the queue's rows and handlers and quietly left its error behind, and
   * an optional prop is how the next such omission would stay invisible.
   */
  approvalRead: ApprovalRead;
  /** Re-runs every read behind `approvalRead` — see `AgentView`, which owns the list. */
  onRetryApprovals: () => void;
}

export function AgentConversation({
  agent,
  thread,
  decisions,
  readOnly,
  busy = false,
  onSend,
  onApprove,
  onDismiss,
  onUndo,
  busyIds,
  notices,
  approvalRead,
  onRetryApprovals,
}: Props) {
  const [draft, setDraft] = useState('');

  const send = () => {
    const v = draft.trim();
    if (!v || busy) return;
    setDraft('');
    onSend(v);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="flex max-w-[720px] flex-col gap-5">
          {thread.map((m) => (
            <Message
              key={m.id}
              m={m}
              agent={agent}
              decisions={decisions}
              onApprove={onApprove}
              onDismiss={onDismiss}
              onUndo={onUndo}
              {...(busyIds !== undefined ? { busyIds } : {})}
              {...(notices !== undefined ? { notices } : {})}
            />
          ))}

          {/*
            The notice sits where the missing cards would have been — the foot
            of the thread — because that is the spot the reader is about to
            draw a conclusion from. A banner at the top would be answering a
            question they have not asked yet.

            The two states we cannot see through get one — `failed`, which is
            ours to retry, and `expired`, which is the reader's to sign back
            into. `ok` and `unavailable` get nothing, and `unavailable` is the
            one worth spelling out: it means this deployment has no decisions
            producer at all, so no decision can exist and a thread without
            approval cards is COMPLETE, not short. A notice there would raise
            doubt about a thread we can vouch for.
          */}
          {(approvalRead === 'failed' || approvalRead === 'expired') && (
            /*
              THE REGISTER FOLLOWS THE FACT, the same way it does on Today.
              `destructive` is the red one and it says something has gone wrong,
              which is true of a blip and untrue of a session that simply ran
              out. And the offer follows the fact too: a blip is ours to retry,
              an expired session is not retryable at all.
            */
            <Alert variant={approvalRead === 'expired' ? 'default' : 'destructive'}>
              <AlertDescription className="flex flex-col items-start gap-2.5">
                <span className="text-[13px] leading-relaxed">
                  {approvalRead === 'expired'
                    ? DECISION_SESSION_EXPIRED
                    : DECISION_THREAD_READ_FAILED}
                </span>
                {approvalRead === 'expired' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      // Fire-and-forget, exactly as Today and the in-thread
                      // card do it: on success it navigates away, and a
                      // misconfigured provider throws with nowhere here to say
                      // why. Caught so that is a console line, not an unhandled
                      // rejection.
                      void signInWithGoogle().catch((err: unknown) => {
                        console.warn('[decisions] could not start sign-in', err);
                      });
                    }}
                  >
                    Sign in
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={onRetryApprovals}>
                    Try again
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>

      {!readOnly && (
        <div className="border-t border-border px-6 py-4">
          <div className="flex max-w-[720px] items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder={`Message ${agent.name}`}
              className="h-10"
              disabled={busy}
            />
            <Button size="icon" onClick={send} aria-label="Send" disabled={busy}>
              <ArrowUp size={15} />
            </Button>
          </div>
          {/*
            No suggestion chips. They were authored prose in the prototype and
            the wire never carried them — a chip that puts words in the user's
            mouth is only worth it when something real proposes them.
          */}
        </div>
      )}
    </div>
  );
}

function Message({
  m,
  agent,
  decisions,
  onApprove,
  onDismiss,
  onUndo,
  busyIds,
  notices,
}: {
  m: ThreadMessage;
  agent: WorkspaceAgent;
  decisions: Decision[];
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  busyIds?: ReadonlySet<string>;
  notices?: ReadonlyMap<string, string>;
}) {
  if (m.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[13.5px] leading-relaxed text-primary-foreground">
          {m.text}
        </div>
      </div>
    );
  }

  if (m.kind === 'fold') {
    return (
      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Layers size={11} />
          {m.text}
        </span>
        <Separator className="flex-1" />
      </div>
    );
  }

  if (m.kind === 'status') {
    return (
      <div className="flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        {m.text}
      </div>
    );
  }

  if (m.kind === 'approval') {
    /*
      The card renders the row from the QUEUE, not a copy carried on the
      message: `decisions` and the Today list are the same array, so a decision
      resolved in one place is resolved in the other without a second fetch and
      without two versions of one row disagreeing on screen.

      A message whose decision is not in that array renders nothing. What is
      left after `approvalRead` is SKEW between two independent fetches — the
      row was resolved and dropped from the open list, or the queue read has
      simply not landed yet (first mount, or a `decisionRaised` frame whose
      thread re-read beat its queue refresh). Every one of those settles on its
      own, and silence beats a card built from a stale copy, which would offer
      buttons for a decision that may already be closed.

      What this silence no longer stands for is a FAILED read. That was an
      opposite fact wearing the same silence — one means the question is
      answered, the other means we cannot see the question — and it is now
      announced by the notice at the foot of the thread instead of arriving
      here as a card that quietly does not appear.
    */
    const d = decisions.find((x) => x.id === m.decisionId);
    if (!d) return null;
    return (
      <div className="flex gap-3">
        <AgentTile agent={agent} />
        <ApprovalCard
          decision={d}
          onApprove={() => onApprove(d.id)}
          onDismiss={() => onDismiss(d.id)}
          onUndo={() => onUndo(d.id)}
          busy={busyIds?.has(d.id) === true}
          notice={notices?.get(d.id) ?? null}
        />
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <AgentTile agent={agent} />
      <div className="min-w-0 flex-1">
        <div className="max-w-[600px] text-[13.5px] leading-relaxed text-pretty">
          {m.text}
        </div>
        {m.kind === 'steps' && <Steps label={m.stepsLabel} steps={m.steps} />}
        <div className="mt-1.5 text-[11.5px] text-muted-foreground">{m.time}</div>
      </div>
    </div>
  );
}

function Steps({ label, steps }: { label: string; steps: string[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-3 max-w-[600px] overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-muted px-3.5 py-2 text-[12px] text-muted-foreground"
      >
        <ListChecks size={12} />
        {label}
        <ChevronRight
          size={12}
          className={open ? 'ml-auto rotate-90' : 'ml-auto'}
        />
      </button>
      {open && (
        <div className="px-3.5 py-1">
          {steps.map((s, i) => (
            <div
              key={s}
              className={
                i === 0
                  ? 'py-2 text-[12.5px] text-muted-foreground'
                  : 'border-t border-rule-soft py-2 text-[12.5px] text-muted-foreground'
              }
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
