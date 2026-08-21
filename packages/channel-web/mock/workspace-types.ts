/**
 * Agent-workspace prototype — shared types.
 *
 * PROTOTYPE. These shapes are the point of the exercise: they are drawn to
 * match what the host will actually persist once the approvals substrate
 * lands, so wiring the real backend is a matter of deleting `mock/workspace.ts`
 * and pointing `src/lib/workspace-api.ts` at real routes — not rewriting the UI.
 *
 * Two shapes are load-bearing and deliberately mirror existing contracts:
 *
 *   - `ToolCall` is `ToolCallSchema` from `@ax/ipc-protocol` ({ id, name, input }).
 *     A held decision stores the call VERBATIM so approving it can replay the
 *     exact call through `tool.execute-host` rather than re-running the model.
 *     That is what makes an approval card WYSIWYG by construction.
 *
 *   - `Attendance` is the axis the whole design turns on. `tool.pre-call` has a
 *     10s ceiling (`@ax/ipc-protocol` IPC_TIMEOUTS_MS) and converts timeouts to
 *     `deny`, so a human can never be waited for inside it. Instead the host
 *     returns `hold` immediately in BOTH cases and the difference shows up one
 *     level up: an attended conversation parks on `session.next-message` and the
 *     agent executes the tool itself when the decision arrives; an unattended one
 *     ends the turn and the host replays the recorded call later.
 *
 * Types live in `mock/` because that is the established direction in this
 * package (`src/lib/agent-store.ts` already imports `Agent` from `mock/agents`).
 * When the real substrate ships they move to a plugin package.
 */

/** Mirrors `ToolCallSchema` in `@ax/ipc-protocol`. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

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
  | 'dismissed'
  | 'stale'
  | 'expired'
  | 'failed';

/**
 * Captured WITH the decision at hold-time. `value` is opaque to the UI — the
 * tool that produced the call decides what "unchanged" means (a thread's head
 * message id, a calendar slot etag, a document revision). `label` is the only
 * part a human reads.
 */
export interface FreshnessPredicate {
  kind: string;
  value: string;
  label: string;
}

export interface Decision {
  id: string;
  agentId: string;
  conversationId: string;
  kind: DecisionKind;
  attendance: Attendance;
  status: DecisionStatus;
  /** The recorded call, replayed verbatim on approval. */
  call: ToolCall;
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
}

export type AgentRunState = 'working' | 'waiting' | 'resting' | 'stopped';

/** The channel that opened the conversation — the prior for `Attendance`. */
export type AgentChannel = 'web' | 'slack' | 'routine';

export interface WorkspaceAgent {
  id: string;
  name: string;
  role: string;
  /** Lucide icon name, resolved by the client. */
  icon: string;
  state: AgentRunState;
  channel: AgentChannel;
  /** What it is doing right now, in plain words. */
  now: string;
  /**
   * A real counter from the loop, or null. Deliberately NOT a percentage and
   * NOT an ETA: an agent cannot know how long it has left, and one wrong
   * "~2 min left" costs more trust than the widget could ever earn.
   */
  counter: { done: number; total: number; unit: string } | null;
  /** ISO. The UI renders elapsed time from this instead of guessing remaining. */
  startedAt: string | null;
  /** Why it stopped. Only set when `state === 'stopped'`. */
  stoppedReason: string | null;
  paused: boolean;
  footer: string;
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

export interface ActivityEvent {
  id: string;
  agentId: string;
  /** Bucket label — the mock keeps these coarse ("Today", "Yesterday"). */
  day: string;
  text: string;
  time: string;
  kind: ActivityKind;
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
  | { kind: 'fold'; id: string; text: string };

/**
 * Memory is split because two different writers own it. Collapsing them into
 * one editor invites a human to hand-write something the agent's rollup later
 * eats.
 *
 *   - `rules`   — the human's, verbatim, always injected, safe to hand-edit.
 *   - `learned` — the agent's, subject to rollup and GC. Editable, but the UI
 *                 says so.
 */
export interface MemoryDoc {
  name: string;
  scope: 'rules' | 'learned';
  body: string;
}

export interface WorkspaceFile {
  name: string;
  meta: string;
  title: string;
  blocks: Array<['p' | 'h' | 'mono', string]>;
}

export interface PastConversation {
  id: string;
  title: string;
  meta: string;
  /** Turns folded into memory by compaction before this excerpt. */
  folded: number;
  msgs: ThreadMessage[];
}

/** Which fixture the mock server is currently serving. */
export type DemoScenario = 'attended' | 'unattended' | 'incident';
