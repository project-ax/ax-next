/**
 * Agent-workspace — the shapes the `/api/workspace/*` routes speak.
 *
 * These started life in `mock/` next to the clickable prototype. They now sit
 * in `src/lib/` because they are the real wire contract: `routes-workspace.ts`
 * produces them and the workspace components consume them.
 *
 * One shape is load-bearing and deliberately mirrors an existing contract:
 *
 *   - `Attendance` is the axis the whole design turns on. `tool.pre-call` has a
 *     10s ceiling (`@ax/ipc-protocol` IPC_TIMEOUTS_MS) and converts timeouts to
 *     `deny`, so a human can never be waited for inside it. Instead the host
 *     returns `hold` immediately in BOTH cases and the difference shows up one
 *     level up: an attended conversation parks on `session.next-message` and the
 *     agent executes the tool itself when the decision arrives; an unattended one
 *     ends the turn and the host replays the recorded call later.
 *
 * `Decision` is a PROJECTION of the row `@ax/decisions` owns, not a copy of it.
 * The projection is the point — see the interface below for what is dropped and
 * why. It is mirrored here rather than imported because plugins talk through
 * the hook bus, never through each other's modules (invariant 2).
 */

/**
 * Where the conversation that produced this decision is being watched, which
 * determines the park budget and therefore the execution path on approval.
 *
 *   - `attended`   — a live channel with a human expected to answer inside the
 *                    keepalive budget (web thread; Slack, with a longer budget).
 *                    The agent is still warm: it executes the call itself.
 *   - `unattended` — routine tick or webhook. Turn already ended, sandbox
 *                    reaped. The host replays the recorded call.
 *
 * An attended decision DEGRADES to unattended when the reaper gives up. That is
 * the same row either way, which is why the Today queue needs no special case
 * for "the user walked away mid-approval".
 */
export type Attendance = 'attended' | 'unattended';

export type DecisionKind = 'action' | 'grant';

/**
 * Which side runs the call once a human says yes — a consequence of
 * `Attendance`, not an independent choice.
 */
export type ExecutionPath = 'agent-executes' | 'host-replays';

/**
 * `stale` is not a failure — it is the freshness guard doing its job. The world
 * moved between hold-time and approval, so the decision RE-OPENS with what
 * changed instead of executing something the human would not have approved had
 * they seen the current state. Silent staleness is the failure mode that would
 * destroy trust in the whole surface.
 */
export type DecisionStatus =
  | 'pending'
  | 'executed'
  | 'approved-pending-agent'
  | 'dismissed'
  | 'stale'
  | 'expired'
  | 'failed';

/**
 * The two statuses that are still a QUESTION. Everything else is a receipt.
 *
 * Exported because three things have to agree on which rows are still open —
 * the queue's headline count, the queue's row list, and the sidebar's pending
 * badge — and three copies of a status list is how they stop agreeing.
 */
export const OPEN_DECISION_STATUSES: readonly DecisionStatus[] = [
  'pending',
  'stale',
];

/** True while a decision is still waiting on a human. */
export function isOpenDecision(d: { status: DecisionStatus }): boolean {
  return OPEN_DECISION_STATUSES.includes(d.status);
}

/**
 * Captured WITH the decision at hold-time. `value` is opaque to the UI — the
 * tool that produced the call decides what "unchanged" means (a thread's head
 * message id, a calendar slot etag, a document revision). `label` is the only
 * part a human reads, and the ONLY part a renderer may print: `kind` and
 * `value` are tokens, and nothing here parses one.
 *
 * `label` IS NULLABLE, and the guard is why (AW-7). The "checked against…"
 * clause describes hold-time; the instant the guard trips, that sentence is
 * false, so `@ax/decisions` strips it as it moves the row to `stale`. Repeating
 * it under an alert saying the world moved would be worse than silence (design
 * §3.4). A renderer therefore has to handle `label === null` — it is not a
 * defensive branch, it is the stale row's normal shape.
 *
 * Mirrors `packages/decisions/src/types.ts`. A divergence between the two is a
 * bug in one of them, not a variation.
 */
export interface FreshnessPredicate {
  kind: string;
  value: string;
  label: string | null;
}

/**
 * One decision, as the BROWSER sees it.
 *
 * This is a PROJECTION of `@ax/decisions`' `Decision`, and the difference is
 * deliberate — capability minimisation applies to a wire shape exactly as it
 * applies to a filesystem path (invariant 5). What the plugin stores and what a
 * renderer needs are not the same set, so the route hands over the second one:
 *
 *   - `call` is DROPPED, `input` and all. It is MODEL-AUTHORED, it is the one
 *     field on the row nothing here renders, and shipping it would put raw
 *     model output on a trust surface for no reader's benefit (design H6). The
 *     WYSIWYG promise is kept by `preview`, which is host-authored. The SSE
 *     frame drops it for the same reason, and a test asserts both.
 *   - `ownerUserId` is DROPPED: it is always the caller, so it says nothing,
 *     and a user id on a page is one more identifier to leak.
 *   - `callFingerprint` / `ruleId` / `consumedAt` / `replayClaimedAt` /
 *     `replayedAt` / `replayError` are DROPPED: host bookkeeping. What a reader
 *     needs out of them is whether this can still be taken back, and that is
 *     `undoable` below — one derived boolean instead of four raw fields a
 *     client would have to re-derive it from, which is how a second copy of the
 *     decision machine gets built by accident (invariant 4).
 *
 * Everything kept is either something a renderer puts on screen or something it
 * has to branch on.
 */
export interface Decision {
  id: string;
  agentId: string;
  conversationId: string;
  kind: DecisionKind;
  attendance: Attendance;
  status: DecisionStatus;
  /**
   * Whether the rule that held this call said approving it cannot be taken
   * back. Captured at hold time. An irreversible call is DEFERRED by the undo
   * window rather than run immediately, so the grace period sits before the
   * outward action instead of pretending to reverse one.
   */
  irreversible: boolean;
  /** null when the action has nothing meaningful to re-check. */
  freshness: FreshnessPredicate | null;
  /** One line, the queue row. */
  summary: string;
  /** The paragraph shown when the row is expanded. */
  detail: string;
  /** The quoted artifact — the actual email body, the actual invite. */
  preview: { meta: string; body: string } | null;
  primaryLabel: string;
  secondaryLabel: string;
  ghostLabel: string;
  /**
   * Authored outcome strings. Deliberately BOTH stored rather than derived:
   * the prototype this came from built the dismissed line by regexing the
   * approved one, which produced "You took over from Inbox — sent your reply"
   * for a reply that was never sent. Never derive a factual claim by string
   * surgery.
   */
  approvedText: string;
  dismissedText: string;
  createdAt: string;
  expiresAt: string;
  /** ISO, set when the decision left `pending`. Drives the undo window. */
  resolvedAt: string | null;
  /** Set only when the freshness guard fails. Human-readable. */
  staleReason: string | null;
  /**
   * ISO instant an approved action will ACTUALLY happen, when it has not
   * happened yet. Non-null only for an `irreversible` call whose execution the
   * host deferred until the undo window closes.
   *
   * This is what stops the row claiming an outcome it has not observed (design
   * H1): for those ten seconds the status reads `executed` because the
   * AUTHORISATION is final, but nothing has gone out, and the row says so.
   *
   * Named for what it means to a reader, not for the host mechanism behind it:
   * `replayDueAt` is the plugin's word for its own replay queue, and a replay
   * queue is not a thing a browser knows about (invariant 1).
   */
  pendingUntil: string | null;
  /**
   * Can this still be taken back? SERVER-DERIVED, and the only reason the raw
   * bookkeeping fields above are not on the wire.
   *
   * False the moment the call has actually been made — either the agent
   * re-issued it and the gate let it through, or the host performed it. Undo
   * cannot un-send an email, so once something has gone out the affordance is
   * not shown at all. A button that cannot do the thing it names is the worst
   * control this surface could ship.
   *
   * It does NOT include the time window: that is `UNDO_WINDOW_MS` measured
   * from `resolvedAt`, and the client counts it down itself so the button
   * disappears on a clock rather than on the next poll.
   */
  undoable: boolean;
}

/**
 * `working` and `resting` are the only two the host can derive today (a live
 * session on one of the agent's conversations, or not). `waiting` arrives with
 * the `hold` verdict (AW-2) and `stopped` with the halted-agent state (AW-11);
 * both stay in the union so the renderers that already handle them keep
 * compiling, and neither is ever produced by `/api/workspace/state` yet.
 */
export type AgentRunState = 'working' | 'waiting' | 'resting' | 'stopped';

export interface WorkspaceAgent {
  id: string;
  /** The agent's `displayName`. */
  name: string;
  state: AgentRunState;
  /**
   * What it is doing right now, in plain words — `null` until the activity
   * line has a real producer (design §4.2, AW-8/AW-14). A null renders as the
   * state word alone; it is never filled with a placeholder phrase, because a
   * placeholder is indistinguishable from a claim.
   */
  now: string | null;
  /**
   * A real counter from the loop, or null. Deliberately NOT a percentage and
   * NOT an ETA: an agent cannot know how long it has left, and one wrong
   * "~2 min left" costs more trust than the widget could ever earn. Always
   * null until a tool reports one (AW-8).
   */
  counter: { done: number; total: number; unit: string } | null;
  /** ISO. The UI renders elapsed time from this instead of guessing remaining. */
  startedAt: string | null;
  /** Why it stopped. Only set when `state === 'stopped'`. */
  stoppedReason: string | null;
}

/**
 * One row of "What it may do alone".
 *
 * GENERATED from policy, never authored. `source` names the rule that produced
 * the sentence so drift between the enforced policy and the sentence a human
 * reads is visible rather than silent — a UI that overstates or understates
 * blast radius is the worst bug this surface can ship. `source: null` renders
 * as an explicit "not yet described" row instead of being quietly omitted.
 */
export interface PermissionRow {
  verdict: 'allow' | 'hold' | 'deny';
  sentence: string;
  source: string | null;
}

export type ActivityKind =
  | 'done'
  | 'held'
  | 'approved'
  | 'dismissed'
  | 'working'
  | 'stopped';

/**
 * One row of the single event feed (design §7).
 *
 * There is deliberately no `day` and no `time`. The prototype carried both as
 * SERVER-COMPUTED display strings — "Today", "4:12 PM" — which are only right
 * for a reader sitting in the server's timezone. Everyone else got a row
 * confidently filed under the wrong day. The row now carries the instant and
 * nothing else; the CLIENT buckets by its own local date and formats its own
 * clock. A display string is a rendering decision, and rendering decisions do
 * not belong on the wire.
 *
 * `id` is a composite of the things that identify the event on any backend
 * (agent, routine path, instant). It is NOT the fire's row id: that is a
 * `BIGSERIAL`, i.e. storage vocabulary, and it never crosses this wire.
 */
export interface ActivityEvent {
  id: string;
  agentId: string;
  /** ISO instant. The client buckets by LOCAL date — see above. */
  at: string;
  text: string;
  kind: ActivityKind;
  /**
   * The second line: the real error on a `stopped` row, `null` otherwise.
   * Carried separately from `text` so a failure keeps the same scannable
   * subject line as a success, and so nothing has to be assembled by string
   * surgery to say what went wrong.
   */
  detail: string | null;
  tag: string | null;
  /** Links a receipt back to the decision that produced it. */
  decisionId: string | null;
}

export type ThreadMessage =
  | { kind: 'agent'; id: string; text: string; time: string }
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'steps';
      id: string;
      text: string;
      time: string;
      stepsLabel: string;
      steps: string[];
    }
  | { kind: 'approval'; id: string; decisionId: string }
  | { kind: 'status'; id: string; text: string }
  /** The compaction summarize rung, surfaced. */
  /**
   * Compaction's summarize rung, surfaced. NOTHING PRODUCES THIS TODAY: the
   * rung-3 summarizer rewrites the transcript rather than recording how many
   * turns it swallowed, so the host has no count to report and the route never
   * emits a fold. The renderer is kept because the variant is real and the
   * moment compaction records a count this is where it lands — but until then
   * the honest number of folded turns is "unknown", not zero, which is why the
   * prototype's `0 messages folded` marker was deleted rather than defaulted.
   *
   * `approval` NOW HAS A PRODUCER (AW-11): `GET /api/workspace/agents/:id`
   * appends one message per still-open decision on the conversation it read,
   * so the in-thread card is the same row the Today queue shows rather than a
   * second copy of it. `status` (AW-8) is still waiting for one.
   */
  | { kind: 'fold'; id: string; text: string };

/**
 * Memory is split because two different writers own it. Collapsing them into
 * one editor invites a human to hand-write something the agent's rollup later
 * eats.
 *
 *   - `rules`   — the human's, verbatim, always injected, safe to hand-edit.
 *   - `learned` — the agent's, subject to rollup and GC. Read-only on this
 *                 surface, and the UI says why: it is folded and dropped over
 *                 time, so anything that needs to stick belongs in `rules`.
 */
export interface MemoryDoc {
  name: string;
  scope: 'rules' | 'learned';
  body: string;
}

/**
 * One row in the Files tab's list.
 *
 * What the prototype's `WorkspaceFile` had and this does not: `meta`
 * ("2 KB · yesterday"), `title` (a heading distinct from the filename), and
 * `blocks` — a hand-shaped `['p' | 'h' | 'mono', string]` document. All four
 * were fixture conveniences with nothing behind them. The workspace listing
 * reports paths and only paths: no size, no timestamp, no separate title. A
 * `meta` line assembled from nothing would be the same class of lie as the
 * `folded: 0` that used to sit on `PastConversation`.
 *
 * The two fields are NOT the same field twice:
 *   - `path` is the key the client sends back to open the file. Raw, opaque,
 *     never rendered.
 *   - `name` is the label, fenced server-side. A filename is agent-authored
 *     text and a file list is the classic Trojan-source surface.
 */
export interface WorkspaceFileSummary {
  path: string;
  name: string;
}

/** One file's text, as the server is willing to show it. */
export interface WorkspaceFileBody {
  path: string;
  name: string;
  /** `null` when there is no text to show — see `clipped`. */
  body: string | null;
  /**
   * Why `body` is missing or short. `null` means the body is the whole file,
   * and that is a promise the tab repeats to the reader.
   */
  clipped: 'binary' | 'too-large' | null;
}

/**
 * One row in the rail's "Previous conversations" list — a pointer, not a copy.
 *
 * There is deliberately no `msgs` and no `folded`:
 *
 *   - the transcript is fetched on demand, by re-reading
 *     `GET /api/workspace/agents/:agentId?conversationId=<id>`. Carrying it
 *     inline meant every roster response shipped every past transcript, and
 *     the field that actually shipped was `[]` — an empty array renders as
 *     "this conversation had nothing in it", which is a claim, not an absence.
 *   - `folded` (turns compaction summarised away before this excerpt) had no
 *     producer at all. The rung-3 summarizer REWRITES the transcript rather
 *     than recording how many turns it swallowed, so every row read `0` and
 *     the UI printed "0 messages folded" over a real conversation. It comes
 *     back if and when compaction records that count on the conversation row.
 */
export interface PastConversation {
  id: string;
  title: string;
  meta: string;
}

/**
 * How long an approve/dismiss can be taken back — the SURFACE's half of it:
 * how long the undo affordance stays on screen, counted from the server's
 * `resolvedAt`.
 *
 * `@ax/decisions` owns the ENFORCING twin, and the two numbers agreeing is not
 * what makes this correct. The server refuses a late undo whatever this
 * constant says, and it also tells us up front whether a given row can be taken
 * back at all (`Decision.undoable`). This value only decides when the button
 * stops being offered — if it ever drifted, the failure is a button that lingers
 * a second too long and is politely refused, not an undo that silently does
 * nothing.
 */
export const UNDO_WINDOW_MS = 10_000;
