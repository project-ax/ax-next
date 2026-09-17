/**
 * The agent's current conversation.
 *
 * One continuous thread per agent, compacted rather than forked — the `fold`
 * message is the compaction summarize rung surfaced as a fact the user can see
 * rather than an invisible cost optimisation. Past conversations live in the
 * rail; routine fires never appear here at all, or 612 unattended runs would
 * bury the two conversations the human actually had.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronRight,
  Layers,
  ListChecks,
  MessageSquare,
  Paperclip,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ATTACHMENT_ACCEPT } from '@/lib/attachment-upload';
import { signInWithGoogle } from '@/lib/auth';
import { readAlertVariant } from '@/lib/read-register';
import {
  activeMatch,
  buildFindIndex,
  findFieldKey,
  threadFindFields,
} from '@/lib/thread-find';
import {
  composerSendBlock,
  useWorkspaceAttachments,
} from '@/lib/workspace-attachments';
import { isOpenDecision } from '@/lib/workspace-types';
import type {
  Decision,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceReadStatus,
} from '@/lib/workspace-api';
import type { WorkspaceGrant } from '@/lib/workspace-grant-store';
import { AgentTile } from './bits';
import { ApprovalCard } from './ApprovalCard';
import { GrantRow } from './GrantRow';
import {
  COMPOSER_HOLD_COPY,
  DECISION_SESSION_EXPIRED,
  DECISION_THREAD_READ_FAILED,
} from './decision-copy';
import {
  FindHighlight,
  ThreadFindBar,
  ThreadFindToggle,
  type FindView,
} from './ThreadFind';
import { WorkspaceAttachmentChip } from './WorkspaceAttachmentChip';

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
  /**
   * `attachmentIds` are the uploaded files this message carries, in pick
   * order. An EMPTY LIST AND AN OMITTED ONE MEAN THE SAME THING: a plain
   * text-only send, which is why the text-only path still calls this with one
   * argument.
   */
  onSend: (text: string, attachmentIds?: readonly string[]) => void;
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
  /**
   * Open capability grants PRESENCE ROUTED HERE (TASK-351) — the ones this
   * agent raised while the person is demonstrably reading this thread. The
   * shell decides, because the shell owns the route (see
   * `workspace-grant-presence.ts`); this draws what it is handed.
   *
   * These are the queue's own row objects, not copies, and the Today queue is
   * still showing every one of them. That is the invariant: one grant, one
   * identity, two render sites, never two live copies. `onGrantResolved` is the
   * store's `resolve`, so answering here drops the row for both sites.
   *
   * REQUIRED, like `decisions` and for the same reason: a thread that silently
   * drew no grants is indistinguishable from an agent that asked for nothing,
   * and a default of `[]` is how the next caller forgets to pass them.
   */
  grants: readonly WorkspaceGrant[];
  /** A grant here was answered or turned down. The store's `resolve`. */
  onGrantResolved: (key: string) => void;
  /**
   * A grant here was APPROVED — pick the stopped agent back up (TASK-374).
   * Forwarded to the same `GrantRow` Today uses, so a grant answered in the
   * thread and one answered in the queue do the same thing.
   */
  onGranted: (grant: WorkspaceGrant) => Promise<boolean>;
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
  grants,
  onGrantResolved,
  onGranted,
}: Props) {
  const [draft, setDraft] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const { attachments, add, remove, retry, clear, attachmentIds, sendBlock } =
    useWorkspaceAttachments();

  /*
    TASK-275 — the composer holds while an approval is open IN THIS THREAD.
    `decisions` is the GLOBAL queue (every agent), so `decisions.some(...)`
    alone would quiet this composer over somebody else's waiting approval —
    the false hold the review caught. The thread's own approval pointers are
    the scope: this is the same linkage the `Message` renderer below uses to
    draw each card, so the hold and the card can never disagree about which
    thread a decision belongs to. No focus moves anywhere; the polite
    announcer below says the one stable sentence.
  */
  const held = thread.some(
    (m) =>
      m.kind === 'approval' &&
      decisions.some((d) => d.id === m.decisionId && isOpenDecision(d)),
  );

  /*
    THE ATTACHMENT HOLD, decided by the same shared rule the home composer
    uses (`lib/workspace-attachments`) rather than by a second copy of it here.
  */
  const attachBlock = composerSendBlock(
    sendBlock,
    draft.trim() !== '',
    attachments.length,
  );

  /*
    BOTH HOLDS CAN BE TRUE AT ONCE, and they are not equals, so the approval
    one is shown first. It is a fact about the agent — the turn is parked
    server-side and nothing the person types moves it until they answer — where
    the attachment hold is a fact about this draft that they can clear in a
    second. The attachment hold is not lost, only queued behind it: it still
    stops the send, and its sentence takes the spot the moment the approval is
    answered.
  */
  const holdReason = held ? COMPOSER_HOLD_COPY : attachBlock;

  const send = () => {
    const v = draft.trim();
    if (!v || busy || held || attachBlock !== null) return;
    setDraft('');
    const ids = attachmentIds;
    // One argument when nothing is attached — see the prop doc. An empty list
    // and no list are the same send, and the text-only call stays the call it
    // was before a file could ride along with it.
    if (ids.length > 0) onSend(v, ids);
    else onSend(v);
    // Only now. The chips stood for files that are already on the server and
    // have just been handed to the agent; leaving them would put the same file
    // on the next message too.
    clear();
  };

  /*
    TASK-354 — finding something in a long thread.

    The bar reads the thread THIS COMPONENT WAS HANDED, which is the current
    conversation on the live view and the read-only excerpt when the rail has
    one open. That is deliberate: "what did it say three weeks ago" is mostly a
    question about a past conversation, and the rail already re-reads those by
    `conversationId`, so each becomes the thread on screen in its turn. There is
    no second search wire, and no control hinting at one.

    `findStep` is a free-running counter rather than a clamped index — see
    `activeMatch`, which owns the wrap. Typing resets it to 0 so a new query
    starts at its first match instead of wherever the last one ended up.
  */
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findStep, setFindStep] = useState(0);
  const findToggleRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // No control over a thread with nothing in it to find. An empty thread's
  // find bar can only ever answer "No matches", which is a true sentence about
  // a question the reader was invited to ask for no reason.
  const searchable = useMemo(
    () => threadFindFields(thread).length > 0,
    [thread],
  );
  const findIndex = useMemo(
    () => buildFindIndex(thread, findOpen ? findQuery : ''),
    [thread, findOpen, findQuery],
  );
  const findActive = activeMatch(findStep, findIndex.total);
  const finding = findOpen && findQuery.trim().length > 0;
  const find: FindView | null = finding
    ? { query: findQuery, active: findActive, index: findIndex }
    : null;

  const closeFind = () => {
    /*
      Closing CLEARS the query. Leaving the thread painted with the bar gone
      would strand highlights on screen with nothing left to explain them or
      take them off again.

      WHERE FOCUS GOES, and why it is not simply "the toggle". Normally it is:
      the toggle stays mounted while the bar is open precisely so the element
      we restore to still exists when we get here.

      But this component is mounted ONCE and un-keyed — `AgentView` swaps its
      `thread` prop between the live conversation and a read-only excerpt — so
      find state outlives a thread change. Open find, click a past conversation
      in the rail, and while its excerpt is loading (a lone `status`
      placeholder) or after that read fails (`[]`), the pane holds nothing
      searchable. The toolbar is then up only because the open bar holds it
      there, so the close takes the TOGGLE with it.

      THE MECHANISM, MEASURED — because the obvious guess about it is wrong and
      leads straight to a fix that does nothing. The toggle is NOT detached when
      we call `focus()`. A probe of the unfixed code recorded, in this order:
      `document.contains(toggle) === true`, `toggle !== null`, and
      `document.activeElement` immediately after the call === the Find button.
      The focus lands. React batches `setFindOpen(false)` and flushes AFTER the
      handler returns; that commit unmounts the focused button, and the browser
      resets `document.activeElement` to `<body>`.

      So a null check does not help, and neither does `document.contains` —
      both are true at call time. The only thing that helps is choosing a target
      that is still mounted after the state update. `searchable` is exactly that
      question: the row's post-close condition is `searchable || findOpen` with
      `findOpen` about to be false, so `searchable` IS "the toggle survives".
      When it does not, focus goes to the transcript — always rendered, and the
      place the reader was already looking.

      Same family as the silent restore-to-nothing `use-opener-restore.ts` fixes
      for dialogs, but not the same cause, and the difference is the part worth
      keeping.
    */
    setFindOpen(false);
    setFindQuery('');
    setFindStep(0);
    if (searchable) findToggleRef.current?.focus();
    else scrollRef.current?.focus();
  };

  // Walk the reader to the match they asked for. Queried out of the DOM rather
  // than tracked with a ref per mark: which mark is current is already stated
  // in the markup, and a second copy of that fact is a second thing to get
  // wrong. `scrollIntoView` is guarded because jsdom only has it when the
  // suite's setup installs one.
  useEffect(() => {
    if (!finding) return;
    const el = scrollRef.current?.querySelector('[data-find-active="true"]');
    if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [finding, findActive, findQuery]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        `|| findOpen` so an open bar survives the thread going empty underneath
        it — a failed excerpt read renders `[]`, and a control that vanishes
        mid-keystroke takes the keyboard user's focus with it.
      */}
      {(searchable || findOpen) && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border px-6 py-1.5">
          <ThreadFindToggle
            open={findOpen}
            onOpen={() => setFindOpen(true)}
            onClose={closeFind}
            buttonRef={findToggleRef}
          />
          {findOpen && (
            <ThreadFindBar
              query={findQuery}
              onQuery={(next) => {
                setFindQuery(next);
                setFindStep(0);
              }}
              active={findActive}
              total={findIndex.total}
              onNext={() => setFindStep((n) => n + 1)}
              onPrev={() => setFindStep((n) => n - 1)}
              onClose={closeFind}
            />
          )}
        </div>
      )}
      {/*
        `tabIndex={-1}` makes the transcript focusable BY CODE without putting
        it in the tab order — the standard landing spot when a control that had
        focus is about to unmount (see `closeFind`). The reader's next Tab then
        continues from the conversation instead of from the top of the page.

        It is NAMED and it is VISIBLE when focused, because being dropped
        somewhere sensible in silence is still being dropped in silence. A bare
        `tabIndex={-1}` div is `role="generic"`, where `aria-label` is ignored,
        so the landing needs a real role to be announced at all — `region` plus
        the agent's name says where you have arrived. And `outline-none` alone
        would leave a sighted keyboard user with nothing to see, so the outline
        is replaced rather than removed.
      */}
      <div
        ref={scrollRef}
        tabIndex={-1}
        role="region"
        aria-label={`Conversation with ${agent.name}`}
        className="flex-1 overflow-y-auto px-6 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex max-w-[720px] flex-col gap-5">
          {thread.map((m, i) => {
            /*
              ONE KEY, not two. React's key and the find index's field key are
              the same string deliberately — see `findFieldKey`. Keying React by
              `m.id` alone while the index keyed by position left the drift this
              change is supposed to remove: on a duplicate id React drops or
              duplicates a `Message` and the painted marks stop matching the
              total. Measured cost of the position-bearing key: nothing in
              ordinary use (the thread only grows at the end), and a harmless
              remount if compaction ever rewrites the head.
            */
            const key = findFieldKey(i, m.id);
            return (
            <Message
              key={key}
              fieldKey={key}
              m={m}
              agent={agent}
              decisions={decisions}
              onApprove={onApprove}
              onDismiss={onDismiss}
              onUndo={onUndo}
              find={find}
              {...(busyIds !== undefined ? { busyIds } : {})}
              {...(notices !== undefined ? { notices } : {})}
            />
            );
          })}

          {/*
            TASK-250 — a thread with no turns says so, but only where it can
            say it honestly. This is where the messages would be, because that
            is where the reader is looking for them.

            `!readOnly` IS THE HONESTY GATE, not a style choice. `AgentView`
            passes `readOnly={past !== null}`, and its `pastThread` renders
            `[]` while `pastError` is set — see the comment at
            `AgentView.tsx:753`, which keeps that pane deliberately blank so
            the alert above it is the only thing speaking. So a past
            conversation whose excerpt read FAILED arrives here as an empty
            thread, and "Nothing here yet" over it would be a claim about the
            CONTENT built from a fact about the FETCH: the same substitution
            the approval notice below exists to stop. A read-only thread with
            zero messages therefore keeps rendering nothing.

            The live side has no matching hole: `AgentView` renders "Loading…"
            while `detail` is null, so `liveThread` reaches zero length only
            once the detail read has landed and come back with no turns. And a
            zero-turn transcript can carry no approval pointer either — an
            approval is raised during a turn — so this copy does not overlap
            with the read notice below even when that read failed.

            No suggestions, no example prompts, nothing about what the agent
            can do. It names where the reader is and what the box below is
            for, and stops there.
          */}
          {thread.length === 0 && !readOnly && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageSquare />
                </EmptyMedia>
                <EmptyTitle>Nothing here yet</EmptyTitle>
                <EmptyDescription>
                  This is where you and {agent.name} talk. Send something below
                  — {agent.name} picks it up from there.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

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

              `readAlertVariant` owns the branch since TASK-290; behaviour here
              is unchanged. No `retrying` is passed because there is no
              automatic retry behind this read — `useDecisionQueue` never got
              one — so the failure is terminal until the reader clicks.
            */
            <Alert variant={readAlertVariant(approvalRead)}>
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

      {/*
        THE SECOND RENDER SITE (TASK-351). Above the composer, where chat put
        it, and OUT OF BAND: not a `ThreadMessage` variant and not a transcript
        row, because a grant has no recorded call and is not part of what was
        said. (`kind: 'approval'` above is the `Decision` row and stays exactly
        that.)

        Same `GrantRow` as Today, in the same bordered frame Today gives its
        list, so it reads as the same kind of object in both places. A second,
        reduced renderer on the surface most people use is how the two would
        drift into asking the same question two different ways.

        NOT gated on `readOnly`. The composer is hidden while a past
        conversation is open, but a grant is not about the transcript being
        read — it is a live question that stops this agent until it is answered,
        and hiding it because somebody scrolled into history is exactly the
        orphaning this card exists to prevent.

        Capped and scrollable, as chat's approval stack is: two grants each
        asking for a key are tall enough to push the composer off screen, and a
        composer you cannot reach is a worse bug than a card you must scroll.

        KNOWN WRINKLE of presence being continuous: switching browser tabs
        unmounts this region, so a half-typed key in it is gone on return. It
        is the flow where that hurts — people leave to fetch the key from a
        password manager — but they leave BEFORE pasting far more often than
        after, the field is never the only copy of anything, and the grant
        itself is never lost (the queue still has it). Keeping the draft would
        mean lifting per-row input state out of `GrantRow` and into something
        that outlives both render sites, which is a second piece of shared
        grant state — the thing invariant 4 is about. Filed rather than fixed.
      */}
      {grants.length > 0 && (
        <div className="px-6 pt-4" data-testid="thread-grants">
          <div className="max-h-[50vh] max-w-[720px] overflow-y-auto rounded-lg border border-border bg-card shadow-sm [scrollbar-gutter:stable]">
            {grants.map((g) => (
              <GrantRow
                key={g.key}
                grant={g}
                onResolved={onGrantResolved}
                onGranted={onGranted}
              />
            ))}
          </div>
        </div>
      )}

      {!readOnly && (
        <div className="border-t border-border px-6 py-4">
          {attachments.length > 0 && (
            <div className="mb-2 flex max-w-[720px] flex-wrap gap-2">
              {attachments.map((a) => (
                <WorkspaceAttachmentChip
                  key={a.id}
                  attachment={a}
                  onRemove={() => remove(a.id)}
                  onRetry={() => retry(a.id)}
                />
              ))}
            </div>
          )}
          {/*
            TASK-275 — the hold reason, as real DOM text above the field: the
            same sentence as `/`. Shown for `held` and for an attachment hold,
            never for `busy` (a reply on its way is not something the reader
            has to do anything about).
          */}
          {holdReason !== null && (
            <div className="mb-2 max-w-[720px] text-[12.5px] text-muted-foreground">
              {holdReason}
            </div>
          )}
          {/*
            The announcer is a SEPARATE node from the cards above, mirroring
            `InThreadApprovals`: one stable sentence that changes only when the
            answer to "is something waiting" changes, and deliberately outside
            any ticking counter (a settled receipt's `Undo | Ns` re-renders once
            a second, which would bury the sentence that mattered).
          */}
          {/*
            `data-testid` because this surface now renders TWO `role="status"`
            nodes — this one and the find bar's match counter — so an unscoped
            `getByRole('status')` matches both and fails for a reason that has
            nothing to do with whichever of the two a test meant.
          */}
          <span
            data-testid="composer-announcer"
            className="sr-only"
            role="status"
            aria-live="polite"
          >
            {held
              ? 'Your agent is waiting for your approval.'
              : (attachBlock ?? '')}
          </span>
          <div className="flex max-w-[720px] items-center gap-2">
            {/*
              The input is plumbing, not a control: the labelled Button beside
              it is what a person (or a screen reader) operates, so the input
              stays out of the accessibility tree and out of the tab order
              rather than turning up as a second, unnamed thing to tab through.
            */}
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                add(e.target.files ?? []);
                // Picking the SAME file twice in a row is a no-op unless the
                // value is cleared: the input's value would not change, so no
                // `change` event fires and the second pick does nothing.
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach a file"
              disabled={busy || held}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip strokeWidth={1.5} aria-hidden="true" />
            </Button>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder={`Message ${agent.name}`}
              className="h-10"
              /*
                Deliberately NOT disabled on `attachBlock`: one of the two
                attachment holds is "you have not written anything", and the
                field is where a person fixes that. Quieting it would leave
                them with a hold they cannot clear.
              */
              disabled={busy || held}
            />
            <Button
              size="icon"
              onClick={send}
              aria-label="Send"
              disabled={busy || held || attachBlock !== null}
            >
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
  find,
  fieldKey,
}: {
  m: ThreadMessage;
  agent: WorkspaceAgent;
  decisions: Decision[];
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  busyIds?: ReadonlySet<string>;
  notices?: ReadonlyMap<string, string>;
  /** Null whenever find is shut or its field is blank — see `ThreadFind`. */
  find: FindView | null;
  /**
   * What the find index calls this message's text. Handed DOWN rather than
   * derived here, because it carries the message's position in the thread and
   * only the caller doing the mapping knows that — see `findFieldKey`.
   */
  fieldKey: string;
}) {
  if (m.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[13.5px] leading-relaxed text-primary-foreground">
          <FindHighlight fieldKey={fieldKey} text={m.text} find={find} />
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
          <FindHighlight fieldKey={fieldKey} text={m.text} find={find} />
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
          <FindHighlight fieldKey={fieldKey} text={m.text} find={find} />
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
