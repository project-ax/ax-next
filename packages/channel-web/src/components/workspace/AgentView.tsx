/**
 * One agent: its current conversation, what it did, what it wrote, what it
 * remembers — plus the rail.
 *
 * The agent is the object you navigate to, and the conversation is one of its
 * properties. That inversion is the whole point of the refresh: chat stops
 * being the noun.
 *
 * There is no Pause/Resume control. Pausing an agent has no backend, and a
 * button wired to a route that answers 501 is half-wired code with a friendly
 * face on it. It arrives with the halted/paused state itself, which nothing
 * produces yet.
 *
 * Sending goes to the SHIPPED chat wire (`workspaceApi.sendMessage` →
 * `streamReply`), not to a workspace route of its own — starting a turn has one
 * source of truth. While the reply streams we show a transient bubble; when the
 * turn ends we re-read the detail so the server's durable thread replaces it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowRight, ChevronLeft } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HTTP_SESSION_ENDED, logRequestFailure } from '@/lib/http';
import {
  readAlertVariant,
  toReadOutcome,
  type ReadOutcome,
} from '@/lib/read-register';
import { workspaceApi, type AgentDetail, type Decision } from '@/lib/workspace-api';
import type { DecisionReadError } from '@/lib/workspace-decisions';
import { ActivityFeed } from './ActivityFeed';
import { AgentConversation, type ApprovalRead } from './AgentConversation';
import { AgentFiles } from './AgentFiles';
import { AgentMemory } from './AgentMemory';
import { AgentRail } from './AgentRail';
import { AgentStateLabel, AgentTile } from './bits';
import type {
  ActivityEvent,
  ThreadMessage,
  WorkspaceAgent,
} from '@/lib/workspace-api';

export type AgentTab = 'chat' | 'did' | 'files' | 'memory';

interface Props {
  agentId: string;
  tab: AgentTab;
  onTab: (t: AgentTab) => void;
  decisions: Decision[];
  activity: ActivityEvent[];
  /** Threaded straight through to the `did` tab's `ActivityFeed` — see there. */
  activityHasMore?: boolean;
  onActivityLoadMore?: () => void;
  activityLoading?: boolean;
  activityError?: string | null;
  agents: WorkspaceAgent[];
  onBack: () => void;
  /**
   * The three ways out of a decision. REQUIRED — see `AgentConversation` for
   * why they are not optional-with-a-default.
   */
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  /** Rows with a POST in flight, and any per-row notice from the last action. */
  busyIds?: ReadonlySet<string>;
  notices?: ReadonlyMap<string, string>;
  /**
   * Non-null means we do not have the QUEUE, so `decisions` above is empty for
   * a reason that has nothing to do with what is waiting on this person. Its
   * `kind` decides which sentence the reader gets — a blip we can retry, or a
   * session that ran out and needs them to sign in.
   *
   * REQUIRED. Every other piece of the queue — the rows, the three handlers,
   * `busyIds`, `notices` — was already threaded down here, and this one was
   * not: the tab rendered a thread with no approval cards over a queue it had
   * failed to read, and said nothing. An optional prop defaulting to `null`
   * would restore that silence for the next caller who forgets, so a caller has
   * to state the answer even when it is "the read was fine".
   */
  decisionsError: DecisionReadError | null;
  /**
   * The agent stopped mid-turn to ask for something. Fired from the live SSE
   * stream so the card appears in the thread as it happens rather than on the
   * reader's next refresh — the shell re-reads the queue and this panel.
   */
  onDecisionRaised?: (decisionId: string) => void;
  /** Bumped by the shell whenever the board changes, to re-pull detail. */
  version: number;
  onChanged: () => void;
  /**
   * A message the shell already sent on this agent's behalf (the home
   * composer). We stream its reply as soon as we mount.
   */
  pendingReply?: { reqId: string; text: string } | null;
  onPendingReplyConsumed?: () => void;
}

/*
  THE WORDS FOR THIS PANEL'S THREE FAILED READS.

  Three surfaces × three outcomes, kept as `Record<ReadOutcome, string>` so the
  compiler is the thing that notices a missing branch. A `switch` with a
  `default` arm was the alternative and it is worse in exactly the way this card
  is about: `default` is how a 404 ends up wearing the sentence written for a
  500.

  NOT IN `decision-copy.ts`. That file is a decisions vocabulary by its own
  stated design (see its header), and none of these nine sentences is about a
  decision.

  WHY THE SENTENCES DIFFER PER SURFACE while `lib/read-register.ts` insists the
  REGISTER must not: an unopenable agent, an unfinished reply and an unopenable
  old conversation cost the reader three different things, and the whole reason
  the register is shared is to buy the words that freedom.

  WHY ALL THREE `expired` ARMS SHARE ONE STRING, against that grain: on a 401
  the three surfaces know the SAME thing. The session ended, the fix is to sign
  in, and which pane you were looking at when it happened is moot. So they use
  the app-wide `HTTP_SESSION_ENDED` rather than three near-duplicates —
  consistency here is what `read-register.ts` is protecting, not an exception to
  it.

  WHAT THE OLD COPY GOT WRONG, and what to not put back. Two of these alerts
  asserted a possible DELETION on every failure mode — "It may have been
  removed", "It may have been deleted since this list was drawn" — so a 500 sent
  the reader hunting for a deletion that never happened, and a 401 told them
  their agent might be gone when they were simply signed out. That sentence was
  right; it was right for ONE mode. It now appears only under `gone`.

  And the reassurance moved with the same logic: "nothing was lost, its work and
  its memory are safe" is TRUE of a blip and a LIE of a removal, so it lives on
  `failed` only.
*/
const LOAD_COPY: Record<ReadOutcome, string> = {
  expired: HTTP_SESSION_ENDED,
  gone: 'We could not open this agent. It may have been removed, or it may belong to someone else.',
  failed:
    'We could not load this agent just now. Nothing was lost — its work and its memory are safe.',
};

const TURN_COPY: Record<ReadOutcome, string> = {
  expired: HTTP_SESSION_ENDED,
  gone: 'That reply didn’t finish, and this conversation is no longer available. It may have been removed.',
  // No "we may have lost the connection": `failed` covers a 500 as well as a
  // dropped socket, and naming the connection states a cause we do not know.
  failed: 'That reply didn’t finish. Nothing you sent was lost.',
};

const PAST_COPY: Record<ReadOutcome, string> = {
  expired: HTTP_SESSION_ENDED,
  gone: 'We could not open that conversation. It may have been deleted since this list was drawn.',
  failed: 'We could not open that conversation just now.',
};

export function AgentView({
  agentId,
  tab,
  onTab,
  decisions,
  activity,
  activityHasMore,
  onActivityLoadMore,
  activityLoading,
  activityError,
  agents,
  onBack,
  onApprove,
  onDismiss,
  onUndo,
  busyIds,
  notices,
  decisionsError,
  onDecisionRaised,
  version,
  onChanged,
  pendingReply = null,
  onPendingReplyConsumed,
}: Props) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  /*
    THE OUTCOME, NOT THE SENTENCE. These three used to hold the string a
    surface would print. Holding the kind instead is what lets one state pick
    both its words and its CONTROLS — the bug was never only the copy, it was
    that a single string could not tell "Try again" whether it would work.

    Every gate on these is an explicit `!== null` / `=== null` check (see
    `pastThread` and `excerptOpening` below), never a truthiness test, so
    swapping `string` for `ReadOutcome` is behaviour-preserving at all of them.
    That is checked by a test rather than by reading, because it is one careless
    `if (pastError)` away from being false.
  */
  const [loadError, setLoadError] = useState<ReadOutcome | null>(null);
  const [pastId, setPastId] = useState<string | null>(null);
  /**
   * The excerpt for the past conversation the rail has open, fetched on demand
   * and kept SEPARATE from `detail` so the current conversation's id — the one
   * a send lands in — is never overwritten by a read-only view.
   */
  const [pastDetail, setPastDetail] = useState<AgentDetail | null>(null);
  const [pastError, setPastError] = useState<ReadOutcome | null>(null);
  /**
   * Bumped to re-fetch the excerpt on demand.
   *
   * `version` deliberately does NOT drive the excerpt's effect: it is a frozen
   * read-only view, and re-pulling it every time somebody approves a row would
   * blank it back to "Opening…" for no reason. But the approval notice can be
   * reporting the EXCERPT's failed read, and a retry that only re-ran the
   * current conversation's read would leave that notice on screen with nothing
   * on the page able to clear it. This is the retry's way in.
   */
  const [pastReload, setPastReload] = useState(0);

  /** The turn in flight: what we sent, what has streamed back, how it ended. */
  const [sent, setSent] = useState<string | null>(null);
  const [streamed, setStreamed] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [turnError, setTurnError] = useState<ReadOutcome | null>(null);
  /** Set by a send before the re-read lands, so a follow-up hits the same row. */
  const conversationRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await workspaceApi.agent(agentId);
      setDetail(next);
      conversationRef.current = next.conversationId;
      setLoadError(null);
    } catch (e) {
      setDetail(null);
      // The operator's half goes to the console; the reader's half is chosen
      // from the kind, not carried out of the error as a string.
      logRequestFailure(e, 'workspace-agent');
      setLoadError(toReadOutcome(e));
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  /*
    Open one of the rail's past conversations. The excerpt is a real re-read
    (`?conversationId=`), not something the roster response carried: `past`
    rows used to ship `msgs: []` and a `folded: 0`, which the pane rendered as
    "Earlier turns were summarised into memory · 0 messages folded" above an
    empty transcript. Nothing had been summarised and nothing had been read.
  */
  useEffect(() => {
    if (pastId === null) {
      setPastDetail(null);
      setPastError(null);
      return;
    }
    let cancelled = false;
    setPastDetail(null);
    setPastError(null);
    void (async () => {
      try {
        const excerpt = await workspaceApi.agent(agentId, pastId);
        if (!cancelled) setPastDetail(excerpt);
      } catch (e) {
        if (!cancelled) {
          logRequestFailure(e, 'workspace-agent-past');
          setPastError(toReadOutcome(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, pastId, pastReload]);

  /**
   * The approval notice's "Try again", for whichever read is behind it.
   *
   * Three reads can put that notice on screen and the reader cannot be asked
   * which, so the retry re-runs all of them: `onChanged` re-pulls the shell's
   * queue and bumps `version` (which re-runs this panel's current-conversation
   * read), and `pastReload` re-fetches the read-only excerpt, which `version`
   * deliberately does not reach. Miss that last one and the notice over an
   * excerpt has a button that cannot clear it.
   */
  const retryApprovals = useCallback(() => {
    setPastReload((n) => n + 1);
    onChanged();
  }, [onChanged]);

  useEffect(() => {
    setPastId(null);
    setSent(null);
    setStreamed('');
    setStreaming(false);
    setTurnError(null);
  }, [agentId]);

  // Abort any live stream when we unmount or switch agents — a reader left
  // running would keep writing into a component nobody is looking at.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [agentId]);

  const streamFrom = useCallback(
    async (reqId: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);
      setStreamed('');
      setTurnError(null);
      await workspaceApi.streamReply(reqId, {
        signal: ac.signal,
        onText: (chunk) => setStreamed((prev) => prev + chunk),
        onDone: () => {
          setStreaming(false);
          setSent(null);
          setStreamed('');
          // The durable thread is the source of truth — re-read it rather than
          // keeping our transient copy around to drift.
          void load();
          onChanged();
        },
        onError: (message) => {
          // Never leave the spinner up. A stale answer is a state we can
          // render; an absence is not (design H7).
          setStreaming(false);
          /*
            ALWAYS `failed`, and the stream's own sentence goes to the console.

            `onError` hands back a string, not a status, so there is nothing
            here to classify — and `failed` is the honest reading anyway: a
            stream that dropped mid-reply tells us nothing about whether the
            conversation still exists, so Resend is a control that genuinely
            might work.

            The message used to be RENDERED, on its own line under the prose.
            Two of its three producers are authored sentences that just restate
            the prose ("the reply stream ended without finishing" under "that
            reply didn't finish"), and the third is whatever the host put in an
            SSE error frame — arbitrary text on a path where we have promised
            not to print plumbing. It is worth keeping for whoever is debugging
            the turn, which is what a console is for.
          */
          console.warn(`[workspace-agent-turn] ${message}`);
          setTurnError('failed');
        },
        /*
          The agent stopped to ask for something. NON-TERMINAL: the stream
          stays open, the turn is parked waiting for an answer, and the
          spinner stays up because the agent genuinely is still going.

          The frame carries only an id and a one-line summary, so we do not
          render it — we re-read. `load()` brings back the thread with the
          approval message on the end of it, and `onChanged()` pulls the
          decision itself into the queue the card reads from. The card is then
          the same row Today shows rather than a second description of it.
        */
        onDecisionRaised: ({ decisionId }) => {
          void load();
          onDecisionRaised?.(decisionId);
          onChanged();
        },
      });
    },
    [load, onChanged, onDecisionRaised],
  );

  /*
    Pick up a turn the home composer already started for this agent. Keyed on
    the reqId rather than on the prop's identity: the shell rebuilds that object
    on every render, and re-opening the same stream twice would double the
    reply.
  */
  const consumedReqId = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingReply) return;
    if (consumedReqId.current === pendingReply.reqId) return;
    consumedReqId.current = pendingReply.reqId;
    setSent(pendingReply.text);
    onPendingReplyConsumed?.();
    void streamFrom(pendingReply.reqId);
  }, [pendingReply, streamFrom, onPendingReplyConsumed]);

  const send = useCallback(
    async (text: string) => {
      setSent(text);
      setTurnError(null);
      try {
        const { conversationId, reqId } = await workspaceApi.sendMessage({
          agentId,
          conversationId: conversationRef.current,
          text,
        });
        conversationRef.current = conversationId;
        await streamFrom(reqId);
      } catch (e) {
        setStreaming(false);
        logRequestFailure(e, 'workspace-agent-send');
        const kind = toReadOutcome(e);
        /*
          A 404 HERE MEANS THE CONVERSATION WE AIMED AT IS NOT THERE, and
          `conversationRef` is still pointing at it. Leaving it set makes the
          composer a control that cannot work: every following message re-targets
          the same vanished row and 404s again, so the reader is stuck for the
          rest of the session with no way to tell why. Clearing it means the next
          message starts a fresh conversation — `sendMessage` takes
          `conversationId: null` for exactly that, and the server mints the row.

          This is the same rule as the missing "Try again" one line down, applied
          to the control nobody thinks of as one.
        */
        if (kind === 'gone') conversationRef.current = null;
        setTurnError(kind);
      }
    },
    [agentId, streamFrom],
  );

  if (loadError !== null) {
    /*
      The prose, then exactly one way out — and WHICH way out is the point.

      This alert replaces the WHOLE pane, header and Back button included, so
      whatever control it offers is the only one on screen. It used to offer
      "Try again" unconditionally over a sentence that said the agent "may have
      been removed": it knew a 404 was possible and still handed the reader a
      button that a 404 makes useless. So `gone` loses the retry (TASK-290's
      ruling) and gains a way off the dead pane instead, because a branch with
      no control at all would be the same trap wearing a different hat.

      `expired` takes the same exit for the same reason, and deliberately does
      NOT get a local "Sign in": the 401 latch in `lib/http.ts` fires on the
      response and `App.tsx` swaps the whole app for `<LoginPage />`, which
      already holds the real sign-in control. A second one here would be a
      duplicate of a button on the screen that is about to replace this one.

      The raw detail is not printed on any branch. It used to be — `workspace
      /agents/ag_x → 404`, in a mono span — and a status code in a mono span is
      how someone learns their session expired by reading a number.
      `logRequestFailure` puts it in the console for operators (TASK-288).
    */
    return (
      <div className="flex flex-1 items-start justify-center p-6">
        <Alert variant={readAlertVariant(loadError)} className="max-w-[520px]">
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{LOAD_COPY[loadError]}</span>
            {loadError === 'failed' ? (
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={onBack}>
                Back to agents
              </Button>
            )}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  const { agent } = detail;
  const past = detail.past.find((p) => p.id === pastId) ?? null;

  /*
    The transient turn, appended to the durable thread while it is in flight.
    It disappears on `done`, when the re-read brings back the server's version
    of the same two messages.
  */
  const liveThread: ThreadMessage[] = [...detail.thread];
  if (sent !== null) {
    liveThread.push({ kind: 'user', id: 'pending-user', text: sent });
  }
  if (streaming || streamed.length > 0) {
    liveThread.push(
      streamed.length > 0
        ? { kind: 'agent', id: 'pending-agent', text: streamed, time: '' }
        : { kind: 'status', id: 'pending-status', text: 'Thinking…' },
    );
  }

  /*
    The read-only excerpt. While it is in flight the pane says so rather than
    rendering an empty transcript — an empty thread reads as "this
    conversation had nothing in it", which is a claim about the content, not
    about the fetch. On failure the alert above carries the news and the pane
    stays blank rather than repeating it.
  */
  const pastThread: ThreadMessage[] =
    pastDetail !== null
      ? pastDetail.thread
      : pastError !== null
        ? []
        : [{ kind: 'status', id: 'past-loading', text: 'Opening…' }];

  /*
    How trustworthy the approval cards in the thread on screen are.

    TWO reads stand behind those cards and either one failing costs the reader
    the same thing, so they collapse into one answer:

      - the SERVER's per-thread read (`decisions.status`), which decides whether
        the thread carries approval pointers at all;
      - the SHELL's queue read, which carries the rows those pointers name. A
        pointer whose row is missing renders nothing (see `AgentConversation`),
        so a failed queue read empties the thread's cards just as thoroughly.

    Read off the detail actually being rendered — the read-only excerpt has its
    own read, and borrowing the current conversation's status while an excerpt
    is up would put a notice over a thread it says nothing about.

    `unavailable` is not a failure and is not folded in: no decisions producer
    means no decision can exist, so a thread with no approval cards is true.

    An EXPIRED session outranks a failed server read, and the order is the
    point rather than a tie-break: a 401 says this reader is signed out, so
    every read behind this thread will keep coming back empty until they sign
    in. Telling them a read failed and handing them "Try again" would be a
    button that cannot work — the exact offer TASK-276 took off the other two
    decision surfaces.

    And nothing is claimed while an excerpt is still opening: the pane is a
    placeholder, not a thread, so there is no conversation on screen for "this
    conversation" to be about yet. The answer arrives with the excerpt.
  */
  const excerptOpening = past !== null && pastDetail === null && pastError === null;
  const shownRead = (past !== null ? pastDetail : detail)?.decisions.status ?? 'ok';
  const approvalRead: ApprovalRead = excerptOpening
    ? 'ok'
    : decisionsError?.kind === 'expired'
      ? 'expired'
      : shownRead === 'failed' || decisionsError !== null
        ? 'failed'
        : shownRead;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border px-6 pt-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ChevronLeft size={16} />
          </Button>
          <AgentTile agent={agent} size={30} />
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-medium">{agent.name}</span>
            <AgentStateLabel agent={agent} />
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => onTab(v as AgentTab)}
          className="mt-3"
        >
          <TabsList className="h-auto bg-transparent p-0">
            {(
              [
                ['chat', 'Conversation'],
                ['did', 'What it did'],
                ['files', 'Files'],
                ['memory', 'Memory'],
              ] as const
            ).map(([v, label]) => (
              <TabsTrigger
                key={v}
                value={v}
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-3 pt-0 text-[13px] text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none [&:not(:first-child)]:ml-6"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {tab === 'chat' && (
            <>
              {past && (
                <div className="flex items-center gap-2.5 border-b border-border bg-muted px-6 py-2.5">
                  <Archive size={13} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
                    {past.title} · {past.meta} · read-only
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPastId(null)}
                    className="h-7 gap-1.5 text-[12px] text-primary"
                  >
                    Back to current
                    <ArrowRight size={11} />
                  </Button>
                </div>
              )}
              {turnError !== null && !past && (
                /*
                  One sentence about one event, then the way out — and no
                  second line under it.

                  This used to concatenate our prose with whatever string the
                  transport handed back — "That reply did not finish. We lost
                  the connection before the reply finished. Send it again to
                  pick up where we left off. Send it again when you are ready."
                  — three sentences saying one thing twice, with a raw
                  `(500)` landing mid-paragraph. Worse, "send it again" meant
                  RETYPE: the composer clears its draft on send. We still hold
                  the text in `sent`, so the honest control is a button that
                  re-fires it.

                  Splitting the prose from the transport string fixed the
                  paragraph but left the string ON SCREEN, one line lower. Two
                  of its producers only restate the prose and the third is
                  arbitrary text out of an SSE error frame, so it is a console
                  line now (see `streamFrom`) and the branch sentence is the
                  whole message.
                */
                <div className="px-6 pt-4">
                  <Alert variant={readAlertVariant(turnError)}>
                    <AlertDescription className="flex flex-col items-start gap-2">
                      <span>{TURN_COPY[turnError]}</span>
                      <div className="flex items-center gap-2">
                        {/*
                          RESEND ONLY WHEN RESENDING CAN WORK. On `gone` the
                          conversation we aimed at is not there and on `expired`
                          the session is not, so both would re-fire straight
                          into the same status — the dead-button offer TASK-276
                          spent a card removing. Dismiss survives on every
                          branch: the strip sits over a live conversation the
                          reader may want to carry on reading.
                        */}
                        {sent !== null && turnError === 'failed' && (
                          <Button
                            size="sm"
                            onClick={() => void send(sent)}
                            disabled={streaming}
                          >
                            Resend
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setTurnError(null)}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                </div>
              )}
              {past && pastError !== null && (
                /*
                  THE ONE ALERT ON THIS SURFACE THAT HAD NO WAY OUT AT ALL — no
                  retry, no sign-in, not even a dismiss. `retryApprovals` was
                  already bumping `pastReload`, which is exactly the re-read this
                  needs, but it was wired only to `AgentConversation`'s approval
                  notice: a reader whose excerpt failed on a blip was stranded
                  until they happened to click a different rail row.

                  And its single sentence claimed a DELETION on every mode. That
                  claim is true of a 404 and false of a 500, so it now appears
                  only under `gone` — where it also correctly has no retry,
                  because nothing brings a deleted conversation back.

                  No dismiss on the other branches, deliberately: unlike
                  `turnError` this alert stands over a pane that is BLANK
                  (`pastThread` renders `[]` while `pastError` is set), so
                  dismissing it would leave an empty transcript with nothing on
                  screen saying why. "Back to current" in the header above is
                  the exit.
                */
                <div className="px-6 pt-4">
                  <Alert variant={readAlertVariant(pastError)}>
                    <AlertDescription className="flex flex-col items-start gap-2">
                      <span>{PAST_COPY[pastError]}</span>
                      {pastError === 'failed' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setPastReload((n) => n + 1)}
                        >
                          Try again
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                </div>
              )}
              <AgentConversation
                agent={agent}
                thread={past ? pastThread : liveThread}
                decisions={decisions}
                readOnly={past !== null}
                busy={streaming}
                onSend={(text) => void send(text)}
                onApprove={onApprove}
                onDismiss={onDismiss}
                onUndo={onUndo}
                {...(busyIds !== undefined ? { busyIds } : {})}
                {...(notices !== undefined ? { notices } : {})}
                approvalRead={approvalRead}
                onRetryApprovals={retryApprovals}
              />
            </>
          )}

          {tab === 'did' && (
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <ActivityFeed
                events={activity}
                agents={agents}
                agentId={agent.id}
                {...(activityHasMore !== undefined ? { hasMore: activityHasMore } : {})}
                {...(onActivityLoadMore ? { onLoadMore: onActivityLoadMore } : {})}
                {...(activityLoading !== undefined ? { loading: activityLoading } : {})}
                {...(activityError !== undefined ? { error: activityError } : {})}
              />
            </div>
          )}

          {/*
            The Files tab reads the agent's workspace itself (AW-12) rather
            than taking a `files` array off `detail`. A sub-array of the detail
            response could not carry the difference between "this agent has
            written nothing" and "we could not read its workspace", and the tab
            has to be able to say which.
          */}
          {tab === 'files' && (
            <AgentFiles agentId={agent.id} agentName={agent.name} />
          )}

          {tab === 'memory' && (
            <AgentMemory
              docs={detail.memory}
              agentName={agent.name}
              onSaveRules={async (body) => {
                const saved = await workspaceApi.saveRules(agent.id, body);
                // Re-read so what the tab shows is what the server stored, not
                // what we typed. If the write landed somewhere unexpected, the
                // user finds out here rather than three weeks later.
                onChanged();
                // The editor adopts the STORED text (the writer normalizes),
                // so it never sits one newline away from "saved".
                return saved.body;
              }}
            />
          )}
        </div>

        {tab === 'chat' && (
          <AgentRail
            detail={detail}
            openPastId={pastId}
            onOpenPast={setPastId}
          />
        )}
      </div>
    </div>
  );
}
