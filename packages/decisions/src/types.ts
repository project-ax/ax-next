/**
 * @ax/decisions — the Decision row.
 *
 * One row, three renderers (the in-thread card, the Today queue, and later
 * Slack's interactive message). There is no separate "live approval" concept;
 * that is what makes an abandoned attended approval degrade into the queue for
 * free (design §3.3).
 *
 * These shapes mirror `packages/channel-web/mock/workspace-types.ts`, which was
 * drawn against what the host would persist. A divergence between the two is a
 * bug in one of them, not a variation.
 */
import type { ToolCall } from '@ax/core';
import { z } from 'zod';

export type { ToolCall };

/**
 * Where the conversation that produced this decision is being watched, which
 * decides the execution path on approval (design §3.3).
 *
 *   - `attended`   — a live channel with a human expected to answer inside the
 *                    keepalive budget. The agent is still warm and re-issues
 *                    its own call.
 *   - `unattended` — routine tick or webhook. The turn ended; the host replays
 *                    the recorded call (AW-5).
 *
 * Deliberately NOT `web`/`routine`: a Slack channel plugin would add a
 * *channel*, not a new attendance value.
 */
export type Attendance = 'attended' | 'unattended';

export type DecisionKind = 'action' | 'grant';

/** Which side runs the call once a human says yes — a consequence of `Attendance`. */
export type ExecutionPath = 'agent-executes' | 'host-replays';

/**
 * `stale` is not a failure — it is the freshness guard doing its job. The world
 * moved between hold-time and approval, so the decision RE-OPENS carrying what
 * changed instead of executing something the human would not have approved had
 * they seen the current state.
 *
 * `executed` means "a human approved this and the authorisation stands". In
 * AW-4 nothing runs yet: the authorisation is consumed at the pre-call gate by
 * the still-warm agent re-issuing its call. AW-5 adds the host replay.
 */
export type DecisionStatus =
  | 'pending'
  | 'executed'
  | 'dismissed'
  | 'stale'
  | 'expired'
  | 'failed';

/**
 * Captured WITH the decision at hold-time. `value` is OPAQUE — the tool that
 * produced the call decides what "unchanged" means (a thread's head message id,
 * a calendar slot etag, a document revision) and the UI never parses it.
 * `label` is the only part a human reads.
 *
 * Always `null` in AW-4: no tool produces one yet. AW-7 adds the producers.
 */
export interface FreshnessPredicate {
  kind: string;
  value: string;
  label: string;
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
   * The partial unique index keys on this: `status='executed' AND
   * consumed_at IS NULL` is "one standing authorisation per (agent, call)".
   */
  consumedAt: string | null;
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
   * Whether the HOST ran the call as part of this approval. Always `false` in
   * AW-4 — and still `false` on the attended path afterwards, where the warm
   * agent runs its own call. AW-5 flips it for the host-replay path.
   */
  executed: boolean;
  /** Which side ran it. Non-null only when something actually ran (AW-5). */
  path: ExecutionPath | null;
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
  label: z.string(),
});

export const DecisionStatusSchema = z.enum([
  'pending',
  'executed',
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
}) as unknown as z.ZodType<Decision>;

export const DecisionsListOutputSchema = z.object({
  decisions: z.array(DecisionSchema),
}) as unknown as z.ZodType<DecisionsListOutput>;

export const DecisionsGetOutputSchema = z.object({
  decision: DecisionSchema.nullable(),
}) as unknown as z.ZodType<DecisionsGetOutput>;

export const DecisionsApproveOutputSchema = z.object({
  decision: DecisionSchema.nullable(),
  executed: z.boolean(),
  path: z.enum(['agent-executes', 'host-replays']).nullable(),
}) as unknown as z.ZodType<DecisionsApproveOutput>;

export const DecisionsDismissOutputSchema = z.object({
  decision: DecisionSchema.nullable(),
}) as unknown as z.ZodType<DecisionsDismissOutput>;

export const DecisionsUndoOutputSchema = z.object({
  decision: DecisionSchema.nullable(),
  undone: z.boolean(),
}) as unknown as z.ZodType<DecisionsUndoOutput>;
