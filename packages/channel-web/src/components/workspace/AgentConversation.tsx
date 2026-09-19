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
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  Hand,
  Layers,
  ListChecks,
  MessageSquare,
  Paperclip,
  type LucideIcon,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type {
  WorkspaceStep,
  WorkspaceStepStatus,
} from '@/lib/workspace-steps';
import { ATTACHMENT_ACCEPT } from '@/lib/attachment-upload';
import { signInWithGoogle } from '@/lib/auth';
import { readAlertVariant } from '@/lib/read-register';
import {
  activeMatch,
  buildFindIndex,
  findFieldKey,
  grantFieldKeyBase,
  threadFindFields,
} from '@/lib/thread-find';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import {
  composerSendBlock,
  useWorkspaceAttachments,
  type SendableAttachment,
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
import { RESOLUTION_FOCUS_RING } from '@/lib/consent-focus';
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
import {
  clampAttachmentName,
  WorkspaceAttachmentChip,
} from './WorkspaceAttachmentChip';
import { AttachmentChip } from '@/components/AttachmentChip';

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

/**
 * What the transcript amounts to right now, as one string — TASK-418's growth
 * signal for the stick-to-bottom rule.
 *
 * TEXT LENGTHS, NOT THE TEXT. This runs on every render of a thread that can be
 * hundreds of turns long, and the question it answers is only "did anything get
 * bigger or change shape". A length is enough for that and costs nothing;
 * joining the whole transcript would allocate the conversation twice a token
 * during streaming.
 *
 * The switch is exhaustive on purpose rather than falling back to `m.id`: the
 * variants that grow (a streaming `agent` text, a `steps` row gaining steps)
 * are exactly the ones a default clause would silently stop tracking, and
 * `ThreadMessage` is a list this file's own header says gains producers.
 */
function threadGrowthKey(thread: readonly ThreadMessage[]): string {
  return thread
    .map((m) => {
      switch (m.kind) {
        /*
          No text of its own: the card is drawn from the `decisions` prop, so
          its height changes without this key changing — a resolving approval
          swaps buttons for an undo row. That growth is the `ResizeObserver`'s
          to catch, not this key's, which is exactly why the hook has one.
        */
        case 'approval':
          return `approval:${m.id}`;
        case 'steps':
          return `steps:${m.id}:${m.text.length}:${m.steps.length}`;
        /*
          A user message grows when its files are drawn (TASK-424), and
          `text.length` cannot see that: a caption-less attachment has an empty
          text and a bubble taller than nothing.

          WHAT THIS TERM DOES NOT COVER, said plainly because the first draft of
          this comment got it wrong. It is NOT what catches the live name-only
          chip becoming a reloaded thumbnail — that count is 1 on both sides.
          What catches THAT is the `m.id` term: the transient turn is
          `pending-user` and the re-read turn is a real `turnId`, so the key
          changes anyway. And the image decoding after layout is caught by
          neither; that is the `ResizeObserver`'s job (TASK-418's own note says
          so, and it is why the hook has one).
        */
        case 'user':
          return `user:${m.id}:${m.text.length}:${(m.attachments ?? []).length}`;
        case 'agent':
        case 'status':
        case 'fold':
          return `${m.kind}:${m.id}:${m.text.length}`;
        /*
          THE EXHAUSTIVENESS IS ENFORCED, not merely intended. `tsconfig.base`
          does not set `noImplicitReturns`, so without this a seventh
          `ThreadMessage` kind would quietly return `undefined` here and stop
          being tracked — silently, which is the failure this key exists to
          prevent. `workspace-types.ts` says the union is meant to gain
          producers, so make the next one a compile error.
        */
        default: {
          const unreached: never = m;
          return unreached;
        }
      }
    })
    .join('|');
}

interface Props {
  agent: WorkspaceAgent;
  thread: ThreadMessage[];
  /**
   * The conversation `thread` was read from, or `null` when the agent has
   * never had one.
   *
   * Needed to draw a person's own attachments (TASK-424): `GET /api/files`
   * scopes every download to a conversation, so without this id a committed
   * file has a path and still no URL. A null id is not an error here — the
   * chip falls back to naming the file, which is the whole point of the card.
   */
  conversationId: string | null;
  decisions: Decision[];
  readOnly: boolean;
  /** True while a reply is streaming — the composer waits it out. */
  busy?: boolean;
  /**
   * `attachments` are the uploaded files this message carries, in pick order,
   * each carrying the id the wire needs AND the name and type the transcript
   * needs (TASK-424 — the caller has to draw the person's own file in their
   * bubble, and an id alone cannot be drawn). An EMPTY LIST AND AN OMITTED ONE
   * MEAN THE SAME THING: a plain text-only send, which is why the text-only
   * path still calls this with one argument.
   */
  onSend: (text: string, attachments?: readonly SendableAttachment[]) => void;
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
  /**
   * WHICH conversation the `thread` above is (TASK-418) — scroll position is
   * meaningless across a change of it.
   *
   * This component is mounted ONCE and un-keyed: `AgentView` swaps `thread`
   * between the live conversation and a read-only past excerpt under it (the
   * same fact `closeFind` below has to account for). The scroller is therefore
   * the same DOM element across that swap, and a raw `scrollTop` from the
   * previous conversation carried onto a different one lands wherever it
   * happens to land. Changing this lands the new conversation on its newest
   * line instead.
   *
   * OPTIONAL, and the default is not a guess: absent means "the thread on
   * screen is one continuous conversation", which is true of every caller that
   * never swaps it — the surface behaves exactly as it did before TASK-418.
   * `AgentView` is the one caller that does swap, and it passes this. (Compare
   * `approvalRead`, which is required precisely because ITS default would make
   * a claim about data — "nothing is waiting on you" — rather than describe the
   * caller's own shape.)
   */
  conversationKey?: string;
}

export function AgentConversation({
  agent,
  thread,
  conversationId,
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
  conversationKey = 'one-conversation',
}: Props) {
  const [draft, setDraft] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const { attachments, add, remove, retry, clear, sendable, sendBlock } =
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
    const files = sendable;
    // One argument when nothing is attached — see the prop doc. An empty list
    // and no list are the same send, and the text-only call stays the call it
    // was before a file could ride along with it.
    if (files.length > 0) onSend(v, files);
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
  // The column inside the scroller — the box whose height IS the transcript's.
  // See `useStickToBottom`, which observes it for growth React cannot predict.
  const contentRef = useRef<HTMLDivElement>(null);

  // No control over a thread with nothing in it to find. An empty thread's
  // find bar can only ever answer "No matches", which is a true sentence about
  // a question the reader was invited to ask for no reason.
  const searchable = useMemo(
    () => threadFindFields(thread, decisions, grants).length > 0,
    [thread, decisions, grants],
  );
  const findIndex = useMemo(
    () => buildFindIndex(thread, decisions, grants, findOpen ? findQuery : ''),
    [thread, decisions, grants, findOpen, findQuery],
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

  /*
    TASK-418 — the transcript follows the newest line.

    It did not, and the walk measured the cost: after a send, `scrollTop` was 0
    with the reply 471px below the fold. The reply was there and correct; it was
    off-screen, which reads to a person as "the agent didn't respond".

    THE RULE: stick to the bottom only when the reader was already at (or within
    a line of) it — `useStickToBottom` owns it and explains why. Someone who has
    scrolled up to read earlier history is left exactly where they are, because
    dragging them back down on every streamed token is the worse bug.

    `contentKey` is the growth signal, and it is deliberately not `thread`
    itself: `AgentView` rebuilds `liveThread` (`[...detail.thread]` plus the
    in-flight turn) on EVERY render, so an identity dep would re-pin on
    keystrokes in the composer. It is also deliberately not `thread.length`: a
    streaming reply is one message whose text lengthens, so a length key would
    pin on the first token and let the rest run off the bottom.

    `approvalRead` is in it because the alert at the foot of the scroller
    appears and disappears with it, and that is content growing too.

    NOT WRAPPED IN `useMemo`, deliberately. The dep would have to be `thread`,
    which is a fresh array every render, so the memo would never hit — it would
    only look like it did. The join is over string lengths and runs in the same
    pass as `threadFindFields` above it.

    Everything that grows the scroller WITHOUT changing this string — an image
    decoding, a font swapping, an approval card resolving — is the hook's
    `ResizeObserver`'s job, which is why this key does not chase `decisions`.
  */
  const contentKey = `${approvalRead}#${threadGrowthKey(thread)}`;
  const onThreadScroll = useStickToBottom({
    viewportRef: scrollRef,
    contentRef,
    contentKey,
    conversationKey,
  });

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
        onScroll={onThreadScroll}
        tabIndex={-1}
        role="region"
        aria-label={`Conversation with ${agent.name}`}
        className="flex-1 overflow-y-auto px-6 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div ref={contentRef} className="flex max-w-[720px] flex-col gap-5">
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
              conversationId={conversationId}
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
            `[]` while `pastError` is set — see the comment on `pastThread`
            in that file, which keeps that pane deliberately blank so the
            alert above it is the only thing speaking. So a past
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

            `grants.length === 0` IS THE SECOND HALF OF THAT SWEEP, and it is
            not symmetry. The grants block below is gated on neither `readOnly`
            nor the thread, and presence admits a row on agent id alone
            (`grantBelongsInThread`) — no conversation id, no emptiness test
            — while the store is seeded at mount from `GET /grants`, which is
            how one raised while the workspace was closed arrives. So a grant
            left open on a past conversation, or raised on a routine fire —
            which this file's header says never appears in the thread at all —
            lands here over an empty one. Without this condition the reader
            gets "send something below, {name} picks it up from there"
            directly above a card that is BLOCKING {name} until they answer
            it: an invitation to start, over the thing actually waiting. The
            grant card then speaks alone, which is what the blank read-only
            pane above does for the same reason.

            No suggestions, no example prompts, nothing about what the agent
            can do. It names where the reader is and what the box below is
            for, and stops there.
          */}
          {thread.length === 0 && !readOnly && grants.length === 0 && (
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

        WRINKLE FIXED (TASK-389). Presence being continuous means switching
        browser tabs (or navigating away from this thread) unmounts this
        region, and a plain `useState` in `GrantRow` used to lose whatever was
        half-typed when that happened. `workspace-grant-drafts.ts` now holds
        that draft outside the component, keyed by the grant, so a value typed
        here survives the unmount and reappears — in this thread, or in
        Today's copy of the same row — until the grant is answered or
        withdrawn. It is not a second copy of the GRANT (invariant 4 still
        holds: `workspace-grant-store.ts` is the only place a grant's own
        state lives) — only of what was typed and not yet submitted anywhere.
      */}
      {/*
        THE CONSENT REGION (TASK-427), and it is deliberately OUTSIDE the
        `grants.length > 0` gate. Answering the last grant removes the row AND
        the box around it, so a region drawn inside the gate would unmount
        along with the thing it was supposed to catch — handing focus straight
        back to `<body>`, which is the bug. This wrapper carries no classes, so
        an empty one costs nothing in layout.

        `role="group"` rather than `region` so an empty grants area does not
        add a permanent landmark to every agent thread.
      */}
      <div
        data-consent-region=""
        tabIndex={-1}
        role="group"
        aria-label={`Permission requests for ${agent.name}`}
        className={RESOLUTION_FOCUS_RING}
      >
        {grants.length > 0 && (
          <div className="px-6 pt-4" data-testid="thread-grants">
            <div className="max-h-[50vh] max-w-[720px] overflow-y-auto rounded-lg border border-border bg-card shadow-sm [scrollbar-gutter:stable]">
              {grants.map((g) => (
                <GrantRow
                  key={g.key}
                  grant={g}
                  onResolved={onGrantResolved}
                  onGranted={onGranted}
                  find={find}
                  fieldKeyBase={grantFieldKeyBase(g.key)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

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
  conversationId,
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
  /** See `Props.conversationId` — what turns an attachment path into a URL. */
  conversationId: string | null;
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
    const attachments = m.attachments ?? [];
    return (
      <div
        data-testid="workspace-user-message"
        className="flex flex-col items-end gap-1.5"
      >
        {/*
          TASK-424 — the files the person sent, ABOVE their words.

          Outside the bubble rather than inside it, which is where chat puts
          them too (`MessagePrimitive.Attachments` sits above `msg-body`). The
          bubble is `bg-primary`, and a `bg-card` chip dropped inside it would
          be a card-coloured island on a primary field — two surfaces fighting,
          and a contrast pair nobody checked. Above it, the chip sits on the
          page background it was drawn for.

          A turn can be attachment-only: `buildThread` no longer drops a user
          turn that has a file and no caption, so the bubble below is skipped
          when there is nothing to put in it. An empty bubble is worse than no
          bubble — but the FILE is not nothing, which is the whole bug.
        */}
        {attachments.length > 0 && (
          <div className="flex max-w-[80%] flex-col items-end gap-1.5">
            {attachments.map((a, i) => {
              /*
                CLAMPED, not merely truncated. A filename comes off the
                person's own disk and can be any length at all, and the chip's
                CSS `truncate` hides the overflow visually while leaving the
                whole string in the accessibility tree and in the chip's
                `aria-label` / `alt` — a screen reader reading four hundred
                characters is its own kind of broken. Same rule, and the same
                function, the composer's own chips already use.

                This is also the honest place to say what CANNOT reach here.
                `turnAttachments` runs on `turn.role === 'user'` ONLY, and user
                turns are persisted host-side by `@ax/chat-orchestrator` from
                the person's own content blocks — the runner never writes one
                (see its TASK-66 note). So a model that emits an `attachment`
                block of its own gets no chip, no `<img>` and no
                `/api/files` URL out of this renderer: the assistant branch
                below never asks for attachments at all. Nothing on this path
                is model- or tool-authored, which is the one reason a label
                here is safe to draw when a step label built from tool input
                would not be.
              */
              const name = clampAttachmentName(a.displayName);
              return (
              <AttachmentChip
                /*
                  Position-bearing, like the step rows: one message can legally
                  carry the same file twice, and a key that was just the name
                  would be a duplicate React key across siblings.
                */
                key={`${i}-${a.path ?? a.displayName}`}
                {...(a.path !== null && conversationId !== null
                  ? {
                      path: a.path,
                      conversationId,
                      displayName: name,
                      mediaType: a.mediaType,
                      ...(a.sizeBytes === undefined
                        ? {}
                        : { sizeBytes: a.sizeBytes }),
                    }
                  : {
                      /*
                        No path yet (the live frame, before the commit), or no
                        conversation to scope a download to. We still know WHAT
                        they sent, so we say so — the alternative is the bug
                        this card is about, in a smaller window.
                      */
                      variant: 'pending' as const,
                      displayName: name,
                      mediaType: a.mediaType,
                    })}
                />
              );
            })}
          </div>
        )}
        {m.text.length > 0 && (
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[13.5px] leading-relaxed text-primary-foreground">
            <FindHighlight fieldKey={fieldKey} text={m.text} find={find} />
          </div>
        )}
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
          find={find}
          fieldKey={fieldKey}
        />
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <AgentTile agent={agent} />
      <div className="min-w-0 flex-1">
        {/*
          A turn that only ran tools has no prose, and the step panel IS the
          reply. The empty bubble is dropped rather than drawn, so the reader
          is not left with a blank line they cannot account for.
        */}
        {m.text.length > 0 && (
          <div className="max-w-[600px] text-[13.5px] leading-relaxed text-pretty">
            <FindHighlight fieldKey={fieldKey} text={m.text} find={find} />
          </div>
        )}
        {m.kind === 'steps' && <Steps label={m.stepsLabel} steps={m.steps} />}
        <div className="mt-1.5 text-[11.5px] text-muted-foreground">{m.time}</div>
      </div>
    </div>
  );
}

/**
 * What the agent did, as a list you can shut.
 *
 * `label` and `steps` come from ONE producer — `lib/workspace-steps.ts`'s
 * `shapeSteps` — whether this turn is streaming or was read back from the
 * transcript, so the header's count is `steps.length` by construction rather
 * than by agreement. This draws them and derives nothing.
 *
 * Open by default: the panel exists to answer "what did it actually do", and a
 * disclosure that starts shut answers that only for people who thought to
 * click. (Chat's chain-of-thought starts CLOSED for the opposite reason —
 * invariant J4, it holds reasoning. This one holds no reasoning at all.)
 *
 * A real `ul`/`li`, not a stack of divs: it is a list, and a screen reader that
 * announces "list, 4 items" is telling the reader the same thing the header
 * does. The key is position-bearing because two steps can still read the same
 * — TASK-419 gave rows a qualifier, but two calls with the same qualifier are
 * legal — and a key that was just the sentence would be a duplicate React key
 * across siblings, which is a reconciliation bug waiting for the first list
 * that grows in the middle. `AgentConversationSteps.test.tsx` renders that case.
 *
 * A FAILED ROW LOOKS FAILED (TASK-419). It used to be the same grey as every
 * other row, with the difference carried by three trailing words — so a walk
 * against the live deployment read a step that had failed as one that had
 * worked. The state comes off `shapeSteps`, never off matching our own copy,
 * and it lands on the tokens the rest of the product already uses for the same
 * two ideas: `text-destructive` for a failure (chat's tool panel, the activity
 * feed's stopped row), `text-warning` for a hold. The mark is an ICON AND a
 * colour, because colour alone is not a signal a colour-blind reader can read.
 */
const STEP_MARK: Record<
  WorkspaceStepStatus,
  { Icon: LucideIcon; tone: string } | null
> = {
  // A finished step and one still going get no mark: the panel is mostly
  // these, and a row of icons saying "fine" is noise the exceptions have to
  // compete with.
  done: null,
  running: null,
  failed: { Icon: AlertTriangle, tone: 'text-destructive' },
  waiting: { Icon: Hand, tone: 'text-warning' },
};

function Steps({ label, steps }: { label: string; steps: WorkspaceStep[] }) {
  return (
    <Collapsible
      defaultOpen
      data-testid="workspace-steps"
      className="mt-3 max-w-[600px] overflow-hidden rounded-lg border border-border"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 bg-muted px-3.5 py-2 text-[12px] text-muted-foreground">
        <ListChecks size={12} aria-hidden="true" />
        {label}
        <ChevronRight
          size={12}
          aria-hidden="true"
          className="ml-auto transition-transform duration-150 group-data-[state=open]:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="px-3.5 py-1">
          {steps.map((s, i) => {
            const mark = STEP_MARK[s.status];
            return (
              <li
                key={`${i}-${s.text}`}
                className={cn(
                  'flex items-start gap-1.5 py-2 text-[12.5px]',
                  i > 0 && 'border-t border-rule-soft',
                  mark === null ? 'text-muted-foreground' : mark.tone,
                )}
              >
                {mark !== null && (
                  <mark.Icon size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1">{s.text}</span>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
