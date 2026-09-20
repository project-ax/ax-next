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
import { Archive, ArrowRight, ChevronLeft, Menu, PanelRight } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsCompact } from '@/lib/use-compact';
import { relativeDay } from '@/lib/workspace-time';
import { HTTP_SESSION_ENDED, logRequestFailure } from '@/lib/http';
import {
  readAlertVariant,
  toReadOutcome,
  type ReadOutcome,
} from '@/lib/read-register';
import { workspaceApi, type AgentDetail, type Decision } from '@/lib/workspace-api';
import type { DecisionReadError } from '@/lib/workspace-decisions';
/*
  The one shaping function, shared with the server's reload path
  (`server/routes-workspace.ts`). Both sides normalize their own frames/blocks
  into `WorkspaceToolCall` and then call `shapeSteps`, so a live step row and a
  reloaded step row are the same sentence by construction rather than by two
  people remembering the same wording.
*/
import {
  applyToolResult,
  applyToolUse,
  shapeSteps,
  type WorkspaceToolCall,
} from '@/lib/workspace-steps';
import type { SendableAttachment } from '@/lib/workspace-attachments';
import type { PhaseKind } from '@/server/types';
import { ActivityFeed } from './ActivityFeed';
import { AgentConversation, type ApprovalRead } from './AgentConversation';
import { AgentFiles } from './AgentFiles';
import { AgentMemory } from './AgentMemory';
import { AgentRail, AgentRailContent } from './AgentRail';
import { AgentStateLabel, AgentTile } from './bits';
import type {
  ActivityEvent,
  ThreadMessage,
  WorkspaceAgent,
} from '@/lib/workspace-api';
import {
  workspaceGrantActions,
  type WorkspaceGrant,
} from '@/lib/workspace-grant-store';
import { WORKSPACE_AGENT_TABS, type AgentTab } from '@/lib/workspace-route';

// The tab vocabulary lives with the URL grammar that has to name it — one
// list, so a tab cannot exist that no link can reach.
export type { AgentTab } from '@/lib/workspace-route';

/**
 * What each tab is CALLED — the trigger's word and the panel's heading, from
 * one map (TASK-446).
 *
 * The triggers used to carry these strings inline. Now that the open panel is
 * also headed by its name, two copies would be two places for the word to
 * drift, and the one that drifted would be the one nobody can see: a reader
 * navigating by heading would land on "Conversation" while the strip they
 * cannot see says something else. `Record<AgentTab, string>` also makes a new
 * tab a compile error here rather than a panel with no heading.
 */
const TAB_LABELS: Record<AgentTab, string> = {
  chat: 'Conversation',
  did: 'What it did',
  files: 'Files',
  memory: 'Memory',
};

interface Props {
  agentId: string;
  tab: AgentTab;
  onTab: (t: AgentTab) => void;
  decisions: Decision[];
  /**
   * Open capability grants presence routed to THIS thread (TASK-351).
   *
   * Passed through rather than read from the store here, for the same reason
   * `decisions` is: the shell owns the route, and the route is half of the
   * presence rule. Deciding it here would mean a second reader of the URL,
   * disagreeing with the shell's own route state the moment the two drift.
   *
   * Forwarded as-is to `AgentConversation`. The rule (`threadGrants`) has
   * already checked the tab, so this is empty on every tab but `chat`.
   */
  threadGrants: readonly WorkspaceGrant[];
  /** A grant answered in the thread. The store's `resolve`. */
  onGrantResolved: (key: string) => void;
  /**
   * A grant approved in the thread — pick the stopped agent back up
   * (TASK-374). Owned by the shell for the same reason `threadGrants` is: the
   * resume re-issues a turn in the grant's OWN conversation, which may not be
   * the one this panel has open, and a grant answered on Today has no panel at
   * all. One implementation, both render sites.
   */
  onGranted: (grant: WorkspaceGrant) => Promise<boolean>;
  activity: ActivityEvent[];
  /** Threaded straight through to the `did` tab's `ActivityFeed` — see there. */
  activityHasMore?: boolean;
  onActivityLoadMore?: () => void;
  activityLoading?: boolean;
  activityError?: string | null;
  agents: WorkspaceAgent[];
  onBack: () => void;
  /**
   * Opens the shell's off-canvas nav (TASK-404). Only ever passed — and only
   * ever rendered — below `md`, where the sidebar is a `Sheet` and this pane
   * fills the screen. Without it the agent route could reach the roster only
   * by going Back to Today first, which costs the reader their place in a
   * thread to do something as ordinary as switching agent.
   *
   * Optional because `AgentView` is rendered directly by several tests that
   * have no shell around them, and a required prop there would be ceremony
   * rather than safety. The trigger simply does not render without it.
   */
  onOpenNav?: (() => void) | undefined;
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
  pendingReply?: {
    reqId: string;
    text: string;
    conversationId: string;
    /** The files that message carried — see `WorkspaceShell`'s own field. */
    attachments: readonly SendableAttachment[];
  } | null;
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
  gone: 'That reply didn’t finish, and this conversation is no longer available. It may have been removed, or is no longer yours.',
  // No "we may have lost the connection": `failed` covers a 500 as well as a
  // dropped socket, and naming the connection states a cause we do not know.
  failed: 'That reply didn’t finish. Nothing you sent was lost.',
};

const PAST_COPY: Record<ReadOutcome, string> = {
  expired: HTTP_SESSION_ENDED,
  /*
    "or is no longer yours" carries the 403 half of `gone`. A reviewer caught
    the first draft asserting a DELETION alone, which is the 404 story — and
    `toReadOutcome` maps 403 here too, so on an ownership change the alert would
    have stated a cause that had not happened. Rare, and still wrong.
  */
  gone: 'We could not open that conversation. It may have been deleted since this list was drawn, or is no longer yours.',
  failed: 'We could not open that conversation just now.',
};

export function AgentView({
  agentId,
  tab,
  onTab,
  decisions,
  threadGrants,
  onGrantResolved,
  onGranted,
  activity,
  activityHasMore,
  onActivityLoadMore,
  activityLoading,
  activityError,
  agents,
  onBack,
  onOpenNav,
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
  /**
   * Below `md` the rail is an off-canvas panel rather than a column, and this
   * is whether it is open (TASK-404). It is not reset when the viewport widens
   * — above `md` the `Sheet` is not mounted at all, so the flag is inert, and a
   * rotation back to portrait reopening the panel the person last had open is
   * the behaviour they would expect rather than a bug.
   */
  const compact = useIsCompact();
  const [railOpen, setRailOpen] = useState(false);
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

  /**
   * The turn in flight: what we sent, what has streamed back, how it ended.
   *
   * `attachments` is not decoration — it is what makes "Resend" honest, and
   * since TASK-424 it is also the only thing that can DRAW the person's file.
   * The composer clears its chips the moment it hands the message over, so
   * after a failed send the ONLY record that a file was part of this message
   * is right here. A resend that read the text alone would quietly deliver
   * less than the person wrote, which is the exact failure TASK-353 exists to
   * prevent, reintroduced on the error path.
   *
   * `resendable` FLIPS THE INSTANT THE POST LANDS, and that is the other half
   * of the rule. `attachments:commit` consumes each temp upload into that turn
   * (`server/routes-chat.ts` calls it once per `attachment_ref` block), so a
   * second message naming the same ids gets `attachment-not-found` — a resend
   * that could never work. Once the POST has returned, the file is already in
   * the conversation and the only thing left worth retrying is the reply.
   *
   * The LIST itself no longer empties there, which is the TASK-424 half: the
   * turn is on screen for as long as it runs, and a bubble that forgets the
   * file the moment the POST succeeds is the bug this card fixed, in a
   * smaller window.
   *
   * WHAT THE REJECTED CASE DOES *NOT* GUARANTEE, so nobody reads more into
   * this than it says: a rejected POST does not mean nothing was committed.
   * The handler's commit loop is a PREFIX operation (`server/routes-chat.ts`
   * says so itself) — refs #1..#k land and then #k+1 refuses, so a 400 or a
   * 413 can leave earlier uploads already spent. Resending then re-names a
   * consumed id and 400s again. The ids are still kept on this path because
   * the common rejection is a transport failure where nothing was consumed
   * and the file WOULD otherwise be dropped silently, and because a repeated
   * visible refusal beats a message that quietly arrives without its
   * attachment. Telling those two rejections apart needs the server's error
   * CODE, which `sendMessage` does not surface today (it throws a bare
   * `HttpError`); the honest answer for the partial-commit case is not a
   * Resend at all but a "re-attach your files", and that is a follow-up.
   */
  interface SentTurn {
    text: string;
    /**
     * The files, NAME AND TYPE INCLUDED, not just their ids (TASK-424). Ids
     * were enough while this only fed "Resend"; the transient bubble below now
     * draws them too, and a bubble cannot draw an id.
     *
     * THIS LIST SURVIVES THE POST. What used to happen on success — emptying
     * it — is now `resendable`, because the two facts it was standing for are
     * different: "these ids can be spent again" (no, the commit consumed them)
     * and "the person attached these files" (yes, permanently, and the
     * composer has already forgotten).
     */
    attachments: readonly SendableAttachment[];
    /**
     * Whether those ids are still spendable. `attachments:commit` consumes
     * each temp upload into the turn, so once the POST returns a second
     * message naming the same ids gets `attachment-not-found` — a resend that
     * could never work. False from that moment on; the words alone go back.
     */
    resendable: boolean;
  }
  const [sent, setSent] = useState<SentTurn | null>(null);
  const [streamed, setStreamed] = useState('');
  const [streaming, setStreaming] = useState(false);
  /**
   * The tool calls this turn has made so far (TASK-352).
   *
   * Separate state from `streamed` because it is not a string append: a
   * `tool-result` REVISES a row the `tool-use` already added, so a running step
   * becomes done, failed or waiting in place. It is shaped into the panel by
   * the same `shapeSteps` the server's reload path calls, which is the whole
   * point — the live row and the reloaded row cannot word themselves
   * differently if only one function words them.
   *
   * Transient, like `streamed`: it clears on `done`, when the re-read brings
   * back the server's version of the same turn.
   */
  const [liveCalls, setLiveCalls] = useState<readonly WorkspaceToolCall[]>([]);
  /**
   * The agent's last reported phase, shown as the pre-content status line.
   *
   * Cleared at the start of every turn so a stale `sandbox-starting` cannot
   * outlive the sandbox it described.
   */
  const [phase, setPhase] = useState<PhaseKind | null>(null);
  /**
   * The turn's failure: the outcome (which controls to offer) plus the
   * producer's own sentence when it has one worth reading.
   *
   * `sentence` is NOT the thing this card set out to remove. What it removes is
   * a request path, a status, and a raw reason code. What survives is authored
   * copy: `streamReply` hands back `WORKSPACE_STREAM_LOST`,
   * `httpErrorMessage(status)`, or a Fault A label from `ERROR_LABELS` with the
   * optional TASK-160 `detail` line under it — and `server/types.ts` is
   * explicit that `detail` is bounded, sanitized and MEANT to be rendered. It
   * is the only actionable specifics a reader gets ("this dev service failed,
   * at this path"), so collapsing it into our generic sentence would cost them
   * the one line that says what to do.
   *
   * `null` on the send path: `toReadOutcome` already picked the sentence there,
   * and printing `HTTP_NOT_FOUND` under our own `gone` copy would say the same
   * thing twice.
   */
  const [turnError, setTurnError] = useState<{
    kind: ReadOutcome;
    sentence: string | null;
  } | null>(null);
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
    setLiveCalls([]);
    setPhase(null);
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
      setLiveCalls([]);
      setPhase(null);
      setTurnError(null);
      await workspaceApi.streamReply(reqId, {
        signal: ac.signal,
        onText: (chunk) => setStreamed((prev) => prev + chunk),
        /*
          What the agent is doing, as it does it (TASK-352). `applyToolUse`
          adds the row; `applyToolResult` revises the one already there, which
          is why this is a list of calls rather than an append-only list of
          sentences — a step that failed has to stop claiming it ran.
        */
        onToolUse: (call) => setLiveCalls((prev) => applyToolUse(prev, call)),
        onToolResult: (result) =>
          setLiveCalls((prev) => applyToolResult(prev, result)),
        /*
          Pre-content only, and the gate is structural: the status row below
          exists ONLY while the turn has produced no text and no steps, so a
          phase arriving after content has nowhere to render. Chat gets the
          same rule from `ctx.contentSeen`; here it falls out of the shape.
        */
        onPhase: (next) => setPhase(next),
        onDone: () => {
          setStreaming(false);
          setSent(null);
          setStreamed('');
          setLiveCalls([]);
          setPhase(null);
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
            ALWAYS `failed`, and the stream's own sentence is KEPT.

            `onError` hands back a string, not a status, so there is nothing
            here to classify — and `failed` is the honest reading anyway: a
            stream that dropped mid-reply tells us nothing about whether the
            conversation still exists, so Resend is a control that genuinely
            might work.

            EVERY producer of this string is authored copy, which is why it is
            rendered rather than logged. `WORKSPACE_STREAM_LOST` and
            `httpErrorMessage(status)` are constants from `http.ts`, and the
            Fault A frame arrives as an `ERROR_LABELS` label plus the optional
            TASK-160 `detail` line — `workspace-api.ts` maps the reason code
            now, so the raw `dev-service-failed` that used to come through here
            cannot. A 503 on stream-open is the case that proves the point: it
            says "that part of the app is not running in this deployment",
            which our own `failed` sentence would have replaced with an
            invitation to Resend forever.
          */
          setTurnError({ kind: 'failed', sentence: message });
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
        /*
          The agent is asking for a capability it does not have (TASK-350).

          Unlike a decision, there is nothing to re-read: a grant is not a row
          anybody else owns, and `GET /api/workspace/decisions` knows nothing
          about it. The frame IS the record, so it goes straight into the store
          the Today queue renders from.

          Writing the store from here rather than from `workspace-api` follows
          this surface's own idiom — `streamReply` hands the caller callbacks
          and the component decides what they mean. (Chat does the opposite and
          writes its store from the transport, which is why its reader cannot
          be reused by anything that renders differently.)
        */
        onPermissionRequest: (request) => {
          /*
            `agentId` is recorded alongside the conversation (TASK-351) so
            presence can route the row back into THIS thread. It comes from the
            prop — the view already knows whose turn it is streaming — rather
            than from a new field on the frame, which would put a client
            routing concern on the wire (invariant 1).
          */
          workspaceGrantActions.raise(request, {
            conversationId: conversationRef.current,
            agentId,
          });
        },
      });
    },
    [agentId, load, onChanged, onDecisionRaised],
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
    /*
      Adopt the conversation the send created, BEFORE streaming it.

      `load()` sets this ref too, but it races: this effect streams as soon as
      the view mounts, and a `permissionRequest` frame arriving first would be
      stored with no conversation and could never be answered — the decision
      route requires one. The composer already knew the id; carrying it is
      cheaper and more certain than re-deriving it (TASK-350 review).
    */
    conversationRef.current = pendingReply.conversationId;
    /*
      The shell only mints a `pendingReply` AFTER its own POST resolved, so
      anything it attached is already committed into that turn and these ids
      can never be re-sent — but the NAMES still have to be drawn, which is why
      the list is carried across rather than emptied here. `send` below is what
      makes the ids unusable for a resend; see `sent`.
    */
    setSent({
      text: pendingReply.text,
      attachments: pendingReply.attachments,
      resendable: false,
    });
    onPendingReplyConsumed?.();
    void streamFrom(pendingReply.reqId);
  }, [pendingReply, streamFrom, onPendingReplyConsumed]);

  const send = useCallback(
    async (text: string, attachments?: readonly SendableAttachment[]) => {
      const files = attachments ?? [];
      setSent({ text, attachments: files, resendable: true });
      setTurnError(null);
      try {
        const { conversationId, reqId } = await workspaceApi.sendMessage({
          agentId,
          conversationId: conversationRef.current,
          text,
          ...(files.length > 0
            ? { attachmentIds: files.map((a) => a.attachmentId) }
            : {}),
        });
        /*
          The POST landed, so every id it carried has been committed into that
          turn and its temp record is gone. The ids must not be offered for a
          second send — but the FILES must stay on screen, because the composer
          has already cleared its chips and this bubble is now the only place
          the person can see what they sent (TASK-424). The record stays; only
          the right to spend it again goes.
        */
        setSent({ text, attachments: files, resendable: false });
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
        setTurnError({ kind, sentence: null });
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
            {/*
              THIS PANE'S `h1` (TASK-446, review follow-up). This branch
              replaces the WHOLE pane — header, agent name and Back button
              included — so without it a reader whose agent will not load gets
              a surface with no page title at all: the exact gap this card
              closes for the happy path, left open on the state where someone
              is most likely to be hunting for their bearings. It is the same
              call `WorkspaceShell` already makes on its board-read failure,
              where the sentence IS the heading.

              NOT `AlertTitle`: that primitive hardcodes an `h5`, which would
              make this pane's only heading a level-5 one and skip four levels
              to get there. A `<span>` swapped for an `<h1>` under preflight is
              the same pixels.
            */}
            <h1>{LOAD_COPY[loadError]}</h1>
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
    /*
      NO HEADING HERE, DELIBERATELY (TASK-446, review follow-up). The other two
      states both carry an `h1`; this one is a single word on an otherwise empty
      pane that resolves into one of them. Heading navigation exists to move
      around a structure, and there is nothing here to move around — an `h1`
      reading "Loading…" would be a landmark for a page that does not exist yet,
      and it would be replaced a moment later by a heading naming something
      else. What this state actually owes a screen reader is a live region
      announcing that the wait ended, which is a different piece of work from
      an outline.
    */
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
    /*
      TASK-424 — the person's file goes into the bubble with their words.

      `path: null` is the honest shape here and not a placeholder: the durable
      workspace path is minted by `attachments:commit` on the server, so in
      this window there is nothing to build a download URL from. The chip falls
      back to naming the file, and the picture arrives with the re-read on
      `done`. What must never happen — and is what this card is about — is the
      message rendering as if no file had been sent at all.
    */
    liveThread.push({
      kind: 'user',
      id: 'pending-user',
      text: sent.text,
      ...(sent.attachments.length > 0
        ? {
            attachments: sent.attachments.map((a) => ({
              path: null,
              displayName: a.displayName,
              mediaType: a.mediaType,
            })),
          }
        : {}),
    });
  }
  /*
    The in-flight reply. `livePanel` is built by the SAME `shapeSteps` the
    server calls on reload (TASK-352), so the step labels a reader sees while
    the turn runs are the ones still there after they refresh.

    The status line is the pre-content branch and nothing else: it renders only
    when the turn has produced neither text nor a step, which is what keeps a
    phase label from appearing after content has started.
  */
  const livePanel = shapeSteps(liveCalls);
  const hasLiveContent = streamed.length > 0 || livePanel !== null;
  if (streaming || hasLiveContent) {
    if (hasLiveContent) {
      liveThread.push(
        livePanel === null
          ? { kind: 'agent', id: 'pending-agent', text: streamed, at: '' }
          : {
              kind: 'steps',
              id: 'pending-agent',
              text: streamed,
              at: '',
              stepsLabel: livePanel.label,
              steps: livePanel.steps,
            },
      );
    } else {
      liveThread.push({
        kind: 'status',
        id: 'pending-status',
        text: phase === 'sandbox-starting' ? 'Getting set up…' : 'Thinking…',
      });
    }
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
    /*
      THE `Tabs` ROOT SPANS THE WHOLE PANE (TASK-437), header and body together,
      rather than wrapping the strip of triggers alone.

      It has to: `TabsContent` finds its tab through React context, so a root
      that closes at the bottom of the `<header>` can have no panels under it —
      which is precisely the bug this card fixes. `Tabs` renders a plain `div`,
      so it takes over the outer element's classes and adds no node.
    */
    <Tabs
      value={tab}
      onValueChange={(v) => onTab(v as AgentTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="border-b border-border px-6 pt-4">
        {/*
          `flex-wrap` + `min-w-0`, not `truncate`. A long agent name in a narrow
          header used to push the state label off the right edge — the label
          that says whether the thing is working or stopped, which is the one
          word on this row nobody can afford to lose. Wrapping keeps both whole;
          clamping would trade a lost label for clipped text, and TASK-436 is
          separately chasing clamped text that has no `title` to recover it.
        */}
        <div className="flex flex-wrap items-center gap-3">
          {/*
            DELIBERATELY NOT `md:`-GATED, unlike `WorkspaceHeader`'s wrap. That
            one is gated because its desktop layout was fine and only the phone
            needed changing. This row was never fine: with no wrap and no
            `min-w-0`, an agent name long enough to fill the pane pushed the
            state label out and `main`'s `overflow-hidden` clipped it — at ANY
            width, desktop included. Wrapping fixes that everywhere, so gating
            it would mean deliberately keeping the clipped version on desktop.
            The cost is that a very long name now takes two lines there instead
            of losing its label; that is the trade, taken knowingly.
          */}
          {/*
            The door to the roster from inside a thread (TASK-404). Below `md`
            the sidebar is off-canvas and this pane owns the whole screen, so
            without this the only way to another agent is Back to Today — which
            throws away where you were reading.
          */}
          {compact && onOpenNav && (
            <Button
              variant="ghost"
              size="icon"
              /* Same one-frame cover as the shell's own trigger — see there. */
              className="md:hidden"
              onClick={onOpenNav}
              aria-label="Open navigation"
            >
              <Menu size={16} />
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ChevronLeft size={16} />
          </Button>
          <AgentTile agent={agent} size={30} />
          <div className="flex min-w-0 items-center gap-2.5">
            {/*
              THE PAGE'S ONE `h1` (TASK-446). The agent is the object you
              navigated to, so its name is the page title — the same call
              `WorkspaceHeader` makes for Today and Activity, which is why the
              typography here is already that header's (`text-[15px]
              font-medium`). Nothing else on the agent route renders an `h1`:
              the shell hands the whole `main` to this component on
              `route.kind === 'agent'` and does not draw its own header, and
              `WorkspaceShell`'s only other `h1` is the full-screen
              board-read-failure pane, which replaces this one rather than
              sitting beside it.

              Preflight strips the browser's heading size/weight/margin, so
              the rendered row is unchanged.
            */}
            <h1 className="text-[15px] font-medium">{agent.name}</h1>
            <AgentStateLabel agent={agent} />
          </div>
          {/*
            The only way to the rail below `md`, where it is no longer a column
            on the page. Chat tab only, because that is the only tab that
            renders a rail at all — a button that opens a panel the current tab
            does not have is worse than no button.
          */}
          {compact && tab === 'chat' && (
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              onClick={() => setRailOpen(true)}
              aria-label="Agent details"
            >
              <PanelRight size={16} />
            </Button>
          )}
        </div>

        {/*
          The four triggers are ~309px of intrinsic width and they do not
          shrink, so on a narrow header the last of them is simply unreachable
          — the bug the TASK-356 walk measured. The negative margin cancels
          the header's `px-6` so the rail scrolls edge to edge rather than
          inside a 24px inset, and the padding puts the inset back on the
          content; without the pair, the first and last tab sit flush against
          the viewport when scrolled.

          Scrollbar hidden both ways because Firefox honours only the first
          and WebKit/Blink only the second. This is a strip of four words that
          fits on any real desktop — a permanent horizontal bar under it would
          be visible chrome bought for a case that mostly does not happen.

          `mt-3` moved here off the `Tabs` root when that root grew to span the
          whole pane (TASK-437) — it was always spacing the STRIP off the title
          row, and on the root it would now be spacing the pane off its header.
        */}
        <div className="-mx-6 mt-3 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* `w-max` so the list keeps its intrinsic width and overflows into
              the scroller above, instead of shrinking to fit and clipping. */}
          <TabsList className="h-auto w-max bg-transparent p-0">
            {WORKSPACE_AGENT_TABS.map((v) => (
              <TabsTrigger
                key={v}
                value={v}
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-3 pt-0 text-[13px] text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none [&:not(:first-child)]:ml-6"
              >
                {TAB_LABELS[v]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/*
          THE OPEN TAB'S PANEL (TASK-437). This element used to be a bare `div`,
          which is why the four triggers advertised `aria-controls` ids that
          resolved to nothing: `TabsTrigger` emits `aria-controls` whether or not
          a matching `TabsContent` exists, so the strip claimed a tab/panel
          relationship the DOM did not keep. It is the same container it always
          was — `TabsContent` renders a `div` — now carrying `role="tabpanel"`,
          the id the open trigger points at, `aria-labelledby` back to that
          trigger, and `tabIndex={0}` so Tab out of the strip lands in here.

          `forceMount` is NOT load-bearing on this one, and saying so is worth a
          line: `value={tab}` means this panel's tab is open by definition, so
          Radix would mount it anyway. It is here to keep all four panels one
          shape — the three below, where `forceMount` is the entire point. If
          that uniformity ever stops earning its keep, this is the prop to drop.

          `mt-0` cancels the `mt-2` shadcn's `TabsContent` ships. This panel butts
          straight up against the header, as the `div` it replaces did.
        */}
        <TabsContent
          value={tab}
          forceMount
          className="mt-0 flex min-w-0 flex-1 flex-col"
        >
          {/*
            THE OPEN PANEL'S HEADING (TASK-446) — the `h2` between the page's
            `h1` (the agent's name, above) and the `SectionLabel` `h3`s that
            Memory, Files and the rail draw inside it.

            `sr-only` BECAUSE THE TAB STRIP ALREADY SAYS IT. A second copy of
            "Conversation" in 15px type under a tab that is already highlighted
            would be visual noise; the word is missing only from the
            ACCESSIBILITY tree, so the fix belongs in `className`, not in the
            element. (The same call `SheetTitle` makes for the rail sheet below
            — sr-only, present, real.) The honest alternative would be a `div`
            with `role="heading" aria-level="2"`, which is the same element
            with worse support and no reason.

            ONE heading, not four: only the open panel is mounted, so the
            outline names where the reader actually is rather than listing
            three regions that are not on screen.
          */}
          <h2 className="sr-only">{TAB_LABELS[tab]}</h2>
          {tab === 'chat' && (
            <>
              {past && (
                <div className="flex items-center gap-2.5 border-b border-border bg-muted px-6 py-2.5">
                  <Archive size={13} className="text-muted-foreground" />
                  <span
                    className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground"
                    title={`${past.title} · ${relativeDay(past.lastActivityAt)} · read-only`}
                  >
                    {past.title} · {relativeDay(past.lastActivityAt)} · read-only
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

                  The transport's sentence stays, on its own line, because
                  every producer of it is authored copy and one of them
                  (`ERROR_LABELS` + the TASK-160 `detail`) carries the only
                  actionable specifics the reader gets. What this card took off
                  the screen is the raw REASON CODE that used to arrive with it
                  — `workspace-api.ts` maps that to a label now — and the
                  request path and status on the other two alerts.
                */
                <div className="px-6 pt-4">
                  <Alert variant={readAlertVariant(turnError.kind)}>
                    <AlertDescription className="flex flex-col items-start gap-2">
                      <span>{TURN_COPY[turnError.kind]}</span>
                      {/*
                        UNTRUSTED PLAIN TEXT, deliberately rendered as a text
                        node and never as markup — the contract in
                        `server/types.ts` says the host bounds and sanitizes
                        this, and React escapes it here regardless. It may
                        carry a newline (`label\ndetail`), hence
                        `whitespace-pre-line`.
                      */}
                      {turnError.sentence !== null && (
                        <span className="whitespace-pre-line text-muted-foreground">
                          {turnError.sentence}
                        </span>
                      )}
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
                        {sent !== null && turnError.kind === 'failed' && (
                          <Button
                            size="sm"
                            /*
                              THE FILE GOES BACK WITH THE WORDS. `sent` holds
                              the ids only while they are still unspent (see
                              its declaration), so this re-sends the whole
                              message after a failed POST and just the text
                              after a failed stream — where the file already
                              reached the conversation and re-naming it would
                              only earn an `attachment-not-found`.
                            */
                            onClick={() =>
                              void send(
                                sent.text,
                                sent.resendable ? sent.attachments : undefined,
                              )
                            }
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
                /*
                  Whose conversation the thread on screen belongs to, so a
                  person's own attachments can be downloaded from it
                  (TASK-424). Read from the SAME detail the thread came from —
                  the excerpt's id when an excerpt is open, the current one
                  otherwise — because a file path scoped to one conversation
                  answers 404 under another, and handing the wrong id here
                  would turn a working thumbnail into a broken image.
                */
                conversationId={
                  past ? (pastDetail?.conversationId ?? null) : detail.conversationId
                }
                decisions={decisions}
                readOnly={past !== null}
                busy={streaming}
                onSend={(text, attachments) => void send(text, attachments)}
                onApprove={onApprove}
                onDismiss={onDismiss}
                onUndo={onUndo}
                {...(busyIds !== undefined ? { busyIds } : {})}
                {...(notices !== undefined ? { notices } : {})}
                approvalRead={approvalRead}
                onRetryApprovals={retryApprovals}
                grants={threadGrants}
                onGrantResolved={onGrantResolved}
                onGranted={onGranted}
                /*
                  WHICH conversation that `thread` is (TASK-418). This panel
                  swaps it under a component that is mounted once and un-keyed,
                  so without this the scroller keeps the previous conversation's
                  pixel offset and the excerpt opens at an arbitrary point. The
                  agent id is in it because the panel outlives an agent switch
                  too.
                */
                conversationKey={
                  past ? `past:${agent.id}:${past.id}` : `live:${agent.id}`
                }
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
              memory={detail.memory}
              agentName={agent.name}
              /*
                The "Try again" behind a FAILED memory read. `onChanged` re-pulls
                the detail response, which is where both halves of the tab come
                from, so the button can actually clear what put it on screen.
                The tab shows it for `failed` only — see `RulesWithoutEditor`.
              */
              onRetry={onChanged}
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
        </TabsContent>

        {/*
          THE THREE CLOSED PANELS (TASK-437) — empty on purpose, and present on
          purpose.

          `TabsTrigger` sets `aria-controls` on all four tabs unconditionally,
          but a `TabsContent` renders NOTHING while its tab is closed. So fitting
          the open tab with a panel and stopping there would still leave three
          ids pointing at nowhere — a fix that looks complete and is three
          quarters of the way there. These keep every `aria-controls` resolvable.

          They hold no children, so opening this pane does not mount
          `ActivityFeed`, `AgentFiles` and `AgentMemory` side by side or fire
          their reads. An empty `div` is what a closed panel costs.

          `hidden` WITHOUT a display class, deliberately. Tailwind preflight
          (3.4.19) hides them with
          `[hidden]:where(:not([hidden="until-found"])) { display: none }` — and
          `:where()` contributes NOTHING to specificity, so that rule is (0,1,0),
          exactly a utility like `flex`. Ties go to source order and the
          utilities come last, so `class="flex" hidden` renders VISIBLE. The open
          panel above needs its `flex`; these must not have one.

          And the `hidden` has to be ours. Radix computes `hidden: !present`,
          which is `false` for a force-mounted panel however its tab is set —
          then spreads our props over it. Without this attribute the three
          closed panels would be present AND shown.
        */}
        {WORKSPACE_AGENT_TABS.filter((v) => v !== tab).map((v) => (
          <TabsContent key={v} value={v} forceMount hidden className="mt-0" />
        ))}

        {/*
          Above `md` the rail is a column. Below it the rail is a `Sheet` and
          there is no column — see `AgentRail`'s own note for the 532px of
          chrome that forced the split, and `use-compact.ts` for why the branch
          is in JS rather than a `md:` class.
        */}
        {tab === 'chat' &&
          (compact ? (
            <Sheet open={railOpen} onOpenChange={setRailOpen}>
              {/*
                Radix warns when a dialog has no description; say that is
                deliberate rather than inventing one. The title is `sr-only`
                because the panel's contents announce themselves — but shadcn
                requires one to exist, and a dialog with no accessible name is
                unusable with a screen reader regardless.
              */}
              <SheetContent
                side="right"
                aria-describedby={undefined}
                className="w-[85vw] max-w-sm overflow-y-auto"
              >
                <SheetTitle className="sr-only">Agent details</SheetTitle>
                <AgentRailContent
                  detail={detail}
                  openPastId={pastId}
                  /*
                    CLOSE ON PICK, same rule the nav sheet follows. Opening a
                    past conversation swaps the thread BEHIND this panel; left
                    open, the sheet covers the only thing that changed and the
                    tap reads as having done nothing. The desktop rail is a
                    column with the thread beside it, so it has nothing to
                    close and keeps the bare setter.

                    WHAT CLOSING COSTS, stated plainly: `AgentRailContent` owns
                    the notice a revoke leaves behind ("Revoked…", "already
                    gone", "we couldn't take that back"), so unmounting it
                    drops that line. This is the SAME loss as crossing `md`
                    mid-revoke, but it is reachable by one ordinary tap rather
                    than by resizing during a sub-second POST — so it is the
                    common path, not the rare one, and the review note that
                    called this rare was counting only the resize.

                    Still not worth hoisting the notice into `AgentView`: the
                    revoke itself always lands server-side, and reopening the
                    rail re-reads the list, so what is lost is an
                    acknowledgement of something the next read already shows.
                    Hoisting would put rail state in the pane that mounts the
                    rail, which is how the two shapes start disagreeing — the
                    exact thing extracting `AgentRailContent` avoided.
                  */
                  onOpenPast={(id) => {
                    setPastId(id);
                    setRailOpen(false);
                  }}
                />
              </SheetContent>
            </Sheet>
          ) : (
            <AgentRail
              detail={detail}
              openPastId={pastId}
              onOpenPast={setPastId}
            />
          ))}
      </div>
    </Tabs>
  );
}
