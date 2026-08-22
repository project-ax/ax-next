/**
 * @ax/decisions — the Decision row.
 *
 * One row, three renderers (the in-thread card, the Today queue, and later
 * Slack's interactive message). There is no separate "live approval" concept —
 * an approval abandoned by its agent is the same row as any other, which is
 * what lets `decisions:approve` re-route it to the host replay on the spot.
 *
 * It does NOT, however, degrade into the queue for free, and this file used to
 * claim it did. The row cannot tell you the agent left; only a live read can.
 * So approve-time asks (TASK-277) — see `Attendance` below.
 *
 * These shapes mirror `packages/channel-web/mock/workspace-types.ts`, which was
 * drawn against what the host would persist. A divergence between the two is a
 * bug in one of them, not a variation.
 *
 * ONE DIVERGENCE IS DELIBERATE AND RECORDED HERE. AW-5 adds
 * `'approved-pending-agent'` to `DecisionStatus` and three fields to
 * `Decision`; the prototype's copy does not have them. The prototype's mock
 * machine cannot produce that status, and its renderers key on
 * `executed | dismissed`, so adding the value there would widen a union that
 * nothing narrows — a resolved decision would render as still-actionable.
 * AW-11 (TASK-234) replaces the mock with these types outright and reconciles
 * the renderers in the same change. Until then this comment is the record.
 */
import type { ToolCall } from '@ax/core';
import { z } from 'zod';

export type { ToolCall };

/**
 * Which CHANNEL opened the conversation that produced this decision. Captured
 * at hold time and never revisited.
 *
 *   - `attended`   — a live channel (today: web) with a human expected to
 *                    answer inside the keepalive budget, so an agent MAY still
 *                    be warm when they do.
 *   - `unattended` — routine tick or webhook. Nothing was ever waiting on the
 *                    answer; the host replays the recorded call (AW-5).
 *
 * IT DOES NOT PICK THE EXECUTION PATH ON ITS OWN, and reading it as though it
 * did is the bug TASK-277 fixed. `attended` says an agent COULD be there and
 * goes on saying it for the life of the row — a web conversation is still
 * `attended` hours after its runner was reaped. Whether one IS there is a
 * question only the present can answer, so `decisions:approve` re-reads the
 * conversation's live session at approve time and routes on both together. A
 * decision held on a web thread the person came back to a day later is
 * `attended` and runs host-side.
 *
 * Deliberately NOT `web`/`routine`: a Slack channel plugin would add a
 * *channel*, not a new attendance value.
 */
export type Attendance = 'attended' | 'unattended';

export type DecisionKind = 'action' | 'grant';

/**
 * Which side runs the call once a human says yes. Decided at approve time from
 * `Attendance` AND a live session read, never from the stored field alone.
 */
export type ExecutionPath = 'agent-executes' | 'host-replays';

/**
 * `stale` is not a failure — it is the freshness guard doing its job. The world
 * moved between hold-time and approval, so the decision RE-OPENS carrying what
 * changed instead of executing something the human would not have approved had
 * they seen the current state.
 *
 * `executed` means "a human approved this and the authorisation stands". On the
 * unattended path AW-5's host replay has actually run the call; on the attended
 * path the authorisation is consumed at the pre-call gate by the still-warm
 * agent re-issuing its call.
 *
 * `approved-pending-agent` is the honest answer for a call the host physically
 * CANNOT make: `tool.execute-host` dispatches to `tool:execute:<name>`, and a
 * tool whose descriptor says `executesIn: 'sandbox'` has no such hook and no
 * sandbox to run in once the turn ended. The approval is real and stands at the
 * gate — the agent performs it the next time it runs. It is deliberately NOT
 * `executed`, because `executed` is a claim that the thing happened (design
 * H1), and the receipt reads "Approved — it will do this the next time it
 * runs", never "Sent".
 *
 * `failed` means the host tried the replay and the tool threw. Nothing was
 * completed, the standing authorisation is gone, and the agent must raise the
 * call again rather than silently inheriting a yes for an action that did not
 * happen.
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
 * The two statuses that carry a standing authorisation the pre-call gate will
 * honour. Exported because the partial unique index, `takeApproval` and the
 * undo path all have to agree on this set, and three copies of a list is how
 * they stop agreeing.
 */
export const AUTHORISING_STATUSES: readonly DecisionStatus[] = [
  'executed',
  'approved-pending-agent',
];

/**
 * Captured WITH the decision at hold-time. `value` is OPAQUE — the tool that
 * produced the call decides what "unchanged" means (a thread's head message id,
 * a calendar slot etag, a document revision) and the UI never parses it.
 * `label` is the only part a human reads.
 *
 * `value` is opaque to everything EXCEPT the tool that wrote it, and that is
 * load-bearing: `tool-freshness:check:<tool>` is handed the predicate and
 * nothing else, so a producer that needs to know WHAT to re-read encodes it in
 * its own token. The host never parses one.
 *
 * `label` IS NULLABLE, and that is the freshness guard's own doing (AW-7). The
 * "checked against…" clause describes hold-time; the instant the guard trips,
 * that sentence is FALSE. Repeating it under an alert saying the world moved is
 * worse than silence, so a stale row drops the clause rather than showing it
 * stale (design §3.4). A producer with nothing legible to say may also send
 * null — the predicate still guards, it just has no sentence.
 *
 * AW-7 adds the first two producers: `request_capability` (@ax/skill-broker)
 * and `connector_propose` (@ax/tool-connector-propose). Every other tool
 * produces no predicate and its decisions are unguarded — correct for a call
 * with nothing meaningful to re-check, and the open question this task carries
 * forward for the rest of the catalog.
 */
export interface FreshnessPredicate {
  kind: string;
  value: string;
  label: string | null;
}

export interface Decision {
  id: string;
  agentId: string;
  /** Who may see and resolve it. */
  ownerUserId: string;
  conversationId: string;
  kind: DecisionKind;
  attendance: Attendance;
  status: DecisionStatus;
  /**
   * The recorded call, verbatim — `{ id, name, input }`. Replayed byte for byte
   * on approval, which is what lets the approval card claim to be WYSIWYG.
   *
   * `input` is MODEL-AUTHORED and therefore untrusted. It is stored, and it is
   * never interpolated into any of the prose fields below. See the PR's
   * prompt-injection note.
   */
  call: ToolCall;
  /** Canonical-JSON sha256 of `{name, input}`. The idempotency key. */
  callFingerprint: string;
  /** Which policy rule held it, when a rule did. */
  ruleId: string | null;
  /**
   * Whether the rule that held this call said approving it cannot be taken
   * back. CAPTURED AT HOLD TIME, not re-read at approval time: the policy that
   * governs an approval is the policy that was in force when the human was
   * asked, and re-evaluating would second-guess a decision they already made.
   *
   * When true, the host replay is deferred by `UNDO_WINDOW_MS` so the undo
   * window is a real grace period BEFORE the outward action — otherwise "undo"
   * is a button that cannot undo anything (design H1). Undo does not un-send an
   * email; it only cancels a send that has not happened yet.
   */
  irreversible: boolean;
  freshness: FreshnessPredicate | null;
  /** One line, the queue row. HOST-AUTHORED. */
  summary: string;
  /** The paragraph shown when the row is expanded. HOST-AUTHORED. */
  detail: string;
  /**
   * The quoted artifact — the actual email body, the actual invite. Always
   * `null` in AW-4: a preview synthesised out of model output would put
   * untrusted prose on a trust surface, and no tool supplies an authored one
   * yet.
   */
  preview: { meta: string; body: string } | null;
  primaryLabel: string;
  secondaryLabel: string;
  ghostLabel: string;
  /**
   * Authored outcome strings. Deliberately BOTH stored rather than derived:
   * the design this came from built the dismissed line by regexing the
   * approved one and shipped "You took over from Inbox — sent your reply to
   * Priya" for a reply that was never sent (design H1).
   */
  approvedText: string;
  dismissedText: string;
  createdAt: string;
  expiresAt: string;
  /** ISO, set when the decision left `pending`. Drives the undo window. */
  resolvedAt: string | null;
  /** Set only when the freshness guard trips. Human-readable prose. */
  staleReason: string | null;
  /**
   * Set when an approved decision's authorisation has been taken up — the
   * agent re-issued its held call and the gate let it through exactly once.
   * The partial unique index keys on this: `status IN
   * ('executed','approved-pending-agent') AND consumed_at IS NULL` is "one
   * standing authorisation per (agent, call)".
   */
  consumedAt: string | null;
  /**
   * When a DEFERRED host replay becomes due — `resolvedAt + UNDO_WINDOW_MS` for
   * an irreversible call. Null means there is nothing waiting to run: either
   * the replay already happened, or this decision never had one.
   *
   * The sweep claims a due row by setting this back to null in the same
   * conditional UPDATE that returns it, so two replicas cannot both replay.
   */
  replayDueAt: string | null;
  /**
   * When the host TOOK OWNERSHIP of the replay — set the instant it commits to
   * making the call, and never cleared.
   *
   * This is the in-flight marker, and it closes the window between "the host
   * decided to run this" and "the host finished running it". Without it, an
   * agent that happened to re-issue the byte-identical call during those few
   * hundred milliseconds would consume the standing authorisation and run the
   * call as well: one approval, two executions. `takeApproval` and `restore`
   * both refuse a row that carries it.
   *
   * It is also what makes the deferred sweep one-shot across replicas: the
   * claim sets this and clears `replayDueAt` in a single statement, so a second
   * sweep — in this process or another host — matches nothing.
   */
  replayClaimedAt: string | null;
  /**
   * When the HOST actually performed the call, if it did.
   *
   * This is not decoration — it is the second half of "one approval, one
   * execution". `consumedAt` records the AGENT taking the authorisation up;
   * this records the HOST doing so. Both take the row out of the partial unique
   * index, out of `takeApproval`, and out of `restore`, because once the call
   * has been made there is no standing authorisation left to honour, nothing
   * for a later identical agent call to cash in, and nothing an undo can take
   * back.
   */
  replayedAt: string | null;
  /**
   * The host executor's failure detail, sanitised. Kept for the audit trail
   * ONLY — the receipt a human reads is always the authored failure line, never
   * this string, because a host tool's message can quote model-authored input
   * back at us.
   */
  replayError: string | null;
}

export type ActivityKind =
  | 'done'
  | 'held'
  | 'approved'
  | 'dismissed'
  | 'working'
  | 'stopped';

/**
 * A receipt. `at` is an ISO instant — the prototype's `day`/`time` pair was a
 * display concern and now belongs to AW-10's renderer, which buckets by date in
 * the reader's own timezone rather than being handed "Today" by a server that
 * does not know where the reader is.
 */
export interface ActivityEvent {
  id: string;
  agentId: string;
  at: string;
  text: string;
  kind: ActivityKind;
  tag: string | null;
  /** Links a receipt back to the decision that produced it. */
  decisionId: string | null;
}

// ---------------------------------------------------------------------------
// Hook I/O
// ---------------------------------------------------------------------------

export interface DecisionsListInput {
  userId: string;
  agentId?: string | undefined;
  /**
   * Exact status filter. Omitted means "everything still actionable by a
   * human" — `pending` and `stale`, the two statuses the machine calls open.
   */
  status?: DecisionStatus | undefined;
}

export interface DecisionsListOutput {
  decisions: Decision[];
}

export interface DecisionsGetInput {
  decisionId: string;
  userId: string;
}

export interface DecisionsGetOutput {
  decision: Decision | null;
}

export interface DecisionsApproveInput {
  decisionId: string;
  userId: string;
}

export interface DecisionsApproveOutput {
  decision: Decision | null;
  /**
   * Whether the HOST ran the call as part of this approval. `false` on the
   * attended path, where the warm agent runs its own call; `false` for a
   * sandbox-only tool the host cannot replay; `false` for an irreversible call
   * whose replay is deferred until the undo window closes. It is only ever
   * `true` when a host executor actually returned.
   */
  executed: boolean;
  /**
   * Which side runs it. `'agent-executes'` on the attended path,
   * `'host-replays'` when the host ran it or is about to. Null when nothing
   * runs at all — a sandbox-only tool the host cannot replay, an expired row, a
   * stale row, or a click on something already resolved.
   */
  path: ExecutionPath | null;
  /**
   * The host executor's failure detail when the replay threw, sanitised. NOT a
   * receipt: a renderer shows the authored failure line and this decision's id,
   * never this string. Null on every other path.
   */
  error: string | null;
  /**
   * ISO instant a DEFERRED replay will run, for an irreversible call. Non-null
   * only on that path, and it is exactly when the undo window closes — the
   * grace period is the reason the deferral exists.
   */
  pendingUntil: string | null;
}

/**
 * What a resolved decision says happened — DERIVED from the row on every read,
 * never stored and never fired. See `receipts.ts` for why that is the whole
 * design rather than an implementation detail.
 *
 * There is no `retracted` outcome and there is nothing to remove. An undone
 * decision is `pending` again, and a `pending` row has no receipt.
 *
 * `receipt` is HOST-AUTHORED prose, chosen per outcome. It is never derived
 * from another outcome's string and never contains `call.input`.
 *
 * A FAILED replay gets one too. An action that did not happen must leave a
 * trace saying so; the alternative is silence, which a reader correctly
 * interprets as "nothing was approved" (design H1).
 */
export type DecisionReceiptOutcome = 'executed' | 'failed' | 'pending-agent';

export interface DecisionReceipt {
  decisionId: string;
  agentId: string;
  outcome: DecisionReceiptOutcome;
  receipt: string;
  /**
   * ISO instant — the moment the person answered (`resolvedAt`). It orders the
   * feed, cuts the page, and prints on the row; see `receiptFor`.
   */
  at: string;
  /**
   * The host executor's failure detail, sanitised, on a `failed` receipt only.
   * AUDIT TRAIL beside the receipt, never the receipt itself — a host tool's
   * message can quote model-authored input back at us.
   */
  error: string | null;
}

/**
 * `decisions:recent-receipts-for-agent` — one agent's receipts, newest first.
 *
 * Shaped to page identically to `routines:recent-fires-for-agent`, because the
 * Activity feed merges the two into one collection and two sources that
 * paginate differently cannot be merged without dropping rows.
 *
 * `before` is an ISO instant and EXCLUSIVE, matching the cursor the feed hands
 * its client. It is an instant rather than a row id on purpose: a row id is
 * storage vocabulary, and no alternate backend could reproduce one.
 *
 * `userId` is a SCOPE, not a hint. A team agent can carry decisions belonging
 * to several people, so reaching the agent is not the same as being entitled to
 * read its queue — the same rule `decisions:list` and `decisions:get` already
 * enforce.
 */
export interface DecisionsRecentReceiptsInput {
  userId: string;
  agentId: string;
  /** Page size. Clamped by the plugin; the caller asks, we decide. */
  limit?: number | undefined;
  /** ISO instant. Strictly older than this. */
  before?: string | undefined;
}

export interface DecisionsRecentReceiptsOutput {
  receipts: DecisionReceipt[];
}

/** Input to the `decisions:sweep` maintenance hook. */
export interface DecisionsSweepInput {
  /** Cap on due replays claimed in one pass. Defaults to a small batch. */
  limit?: number | undefined;
}

export interface DecisionsSweepOutput {
  /** Open decisions moved to `expired`. */
  expired: number;
  /**
   * Deferred replays claimed and SETTLED in this pass — attempted and recorded,
   * whichever way they went. A replay that failed still counts here, because
   * the number answers "did the sweep do its job", not "did the tools succeed";
   * the per-decision outcome is on the row, and the receipt is read back off
   * the row (`decisions:recent-receipts-for-agent`).
   */
  replayed: number;
}

export interface DecisionsDismissInput {
  decisionId: string;
  userId: string;
}

export interface DecisionsDismissOutput {
  decision: Decision | null;
}

export interface DecisionsUndoInput {
  decisionId: string;
  userId: string;
}

export interface DecisionsUndoOutput {
  decision: Decision | null;
  undone: boolean;
}

/**
 * Fired when a call is held. Consumed by channel-web's SSE (AW-11) to push an
 * in-thread card.
 *
 * Deliberately does NOT carry `call.input`: a subscriber that rendered raw
 * model output would put untrusted text on a trust surface. It carries
 * `summary` so a renderer never has to key off `call.name` — which would break
 * the day a connector-backed tool is renamed upstream.
 */
export interface DecisionRaisedPayload {
  decisionId: string;
  agentId: string;
  conversationId: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// `returns` schemas
//
// A `z.object` STRIPS keys it does not declare, so every field of `Decision`
// has to appear here or it vanishes silently on the way out of the bus. The
// canary asserts the key set to catch exactly that drift.
// ---------------------------------------------------------------------------

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const FreshnessPredicateSchema = z.object({
  kind: z.string(),
  value: z.string(),
  // Nullable since AW-7 — a stale row drops its "checked against…" clause. A
  // `z.object` STRIPS what it does not declare, so this half of the shape
  // change matters as much as the interface's: a non-nullable schema here
  // would make every stale decision fail validation on its way out of the bus.
  label: z.string().nullable(),
});

export const DecisionStatusSchema = z.enum([
  'pending',
  'executed',
  'approved-pending-agent',
  'dismissed',
  'stale',
  'expired',
  'failed',
]);

export const DecisionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  ownerUserId: z.string(),
  conversationId: z.string(),
  kind: z.enum(['action', 'grant']),
  attendance: z.enum(['attended', 'unattended']),
  status: DecisionStatusSchema,
  call: ToolCallSchema,
  callFingerprint: z.string(),
  ruleId: z.string().nullable(),
  irreversible: z.boolean(),
  freshness: FreshnessPredicateSchema.nullable(),
  summary: z.string(),
  detail: z.string(),
  preview: z.object({ meta: z.string(), body: z.string() }).nullable(),
  primaryLabel: z.string(),
  secondaryLabel: z.string(),
  ghostLabel: z.string(),
  approvedText: z.string(),
  dismissedText: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  staleReason: z.string().nullable(),
  consumedAt: z.string().nullable(),
  replayDueAt: z.string().nullable(),
  replayClaimedAt: z.string().nullable(),
  replayedAt: z.string().nullable(),
  replayError: z.string().nullable(),
}) as unknown as z.ZodType<Decision>;

export const DecisionsListOutputSchema = z.object({
  decisions: z.array(DecisionSchema),
}) as unknown as z.ZodType<DecisionsListOutput>;

export const DecisionReceiptSchema = z.object({
  decisionId: z.string(),
  agentId: z.string(),
  outcome: z.enum(['executed', 'failed', 'pending-agent']),
  receipt: z.string(),
  at: z.string(),
  error: z.string().nullable(),
}) as unknown as z.ZodType<DecisionReceipt>;

export const DecisionsRecentReceiptsOutputSchema = z.object({
  receipts: z.array(DecisionReceiptSchema),
}) as unknown as z.ZodType<DecisionsRecentReceiptsOutput>;

export const DecisionsGetOutputSchema = z.object({
  decision: DecisionSchema.nullable(),
}) as unknown as z.ZodType<DecisionsGetOutput>;

export const DecisionsApproveOutputSchema = z.object({
  decision: DecisionSchema.nullable(),
  executed: z.boolean(),
  path: z.enum(['agent-executes', 'host-replays']).nullable(),
  error: z.string().nullable(),
  pendingUntil: z.string().nullable(),
}) as unknown as z.ZodType<DecisionsApproveOutput>;

export const DecisionsSweepOutputSchema = z.object({
  expired: z.number(),
  replayed: z.number(),
}) as unknown as z.ZodType<DecisionsSweepOutput>;

export const DecisionsDismissOutputSchema = z.object({
  decision: DecisionSchema.nullable(),
}) as unknown as z.ZodType<DecisionsDismissOutput>;

export const DecisionsUndoOutputSchema = z.object({
  decision: DecisionSchema.nullable(),
  undone: z.boolean(),
}) as unknown as z.ZodType<DecisionsUndoOutput>;
