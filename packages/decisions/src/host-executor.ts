/**
 * Can the HOST make this recorded call, and through what? (TASK-1046)
 *
 * One answer, asked by every site that needs it: the approve route (park or
 * claim?), the replay itself (what to call), and the sweep's delivery fallback
 * (take the flight first?). Three sites that each spelled the question their
 * own way is how a connector call could be routed to the host by one of them
 * and parked by another.
 *
 *   * A connector toolKey, `mcp.<toolNamespace>.<tool>`, can be made by the
 *     host ONLY through `@ax/mcp-client`'s `connectors:call-tool`, which
 *     re-derives the decision owner's access to that connector and sends one
 *     guarded `tools/call`. Never through a `tool:execute:<key>`, even if one
 *     exists: every `tool:execute:*` hook is reachable from the sandbox via
 *     `tool.execute-host`, so routing a credentialed connector call through
 *     one would hand a compromised runner a host-side path to third-party
 *     servers that skips the approval gate.
 *   * And only when it was held during a TASK RUN (review F1): the row's
 *     stored attendance is not `attended`. A connector call held in a chat
 *     stays the agent's, even after its session ended, exactly as before
 *     TASK-1046. The host making it would never reach the agent: its next turn
 *     in that thread re-issues the call, meets the gate with the yes already
 *     spent, and the person gets a second card for a call that already went
 *     out. Parked, the agent's own re-issued call cashes the yes once. This is
 *     the STORED attendance (the channel that opened the conversation), not a
 *     live session read, so the approve route and the delivery fallback give
 *     the same answer for the same row.
 *   * Anything else needs its own `tool:execute:<name>`. That name is built
 *     from `call.name`, which is model-authored: the documented
 *     dynamic-service-hook exception (`replay.ts` says why it is safe —
 *     `hasService` is an exact-match lookup, so a hostile name can only miss).
 *
 * Null means the host cannot make the call at all, and the approval parks for
 * the agent (`approved-pending-agent`).
 *
 * The `connectors:call-tool` contract is RE-DECLARED here, never imported
 * (invariant 2): the hook name, the closed outcome codes, and a local schema
 * that mirrors the producer's own strict `returns` schema. Anything outside it
 * is an answer this package cannot read, and `connector-replay.ts` records that
 * as "we cannot tell", never as a report.
 */
import type { HookBus } from '@ax/core';
import { z } from 'zod';
import { parseConnectorToolKey } from './tool-label.js';
import type { Decision } from './types.js';

/** @ax/mcp-client's service: the host makes one approved connector call. */
export const CONNECTOR_CALL_TOOL_HOOK = 'connectors:call-tool';

/** Definite: nothing completed, or the service said the call failed. */
export type ConnectorCallFailedReason =
  | 'invalid-call'
  | 'not-connected'
  | 'needs-auth'
  | 'unavailable'
  | 'unreachable'
  | 'rejected';

/** The call went out and no reliable answer came back: it may have happened. */
export type ConnectorCallUnknownReason = 'timeout' | 'interrupted';

export type ConnectorCallOutcome =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; reason: ConnectorCallFailedReason }
  | { outcome: 'unknown'; reason: ConnectorCallUnknownReason };

/**
 * `connectors:call-tool` input, as this package sends it. `userId`/`agentId`
 * are the DECISION's owner and agent, and the caller's ctx names the same
 * pair. `input` is the recorded call's arguments, verbatim and uncopied; the
 * hook itself refuses anything but a plain object as `invalid-call`.
 */
export interface ConnectorCallToolInput {
  userId: string;
  agentId: string;
  toolKey: string;
  input: unknown;
}

const FAILED_REASONS = [
  'invalid-call',
  'not-connected',
  'needs-auth',
  'unavailable',
  'unreachable',
  'rejected',
] as const satisfies readonly ConnectorCallFailedReason[];

const UNKNOWN_REASONS = [
  'timeout',
  'interrupted',
] as const satisfies readonly ConnectorCallUnknownReason[];

/** The closed answer. Each arm is strict: no field that could carry a server's text. */
export const ConnectorCallOutcomeSchema: z.ZodType<ConnectorCallOutcome> = z.discriminatedUnion(
  'outcome',
  [
    z.object({ outcome: z.literal('succeeded') }).strict(),
    z.object({ outcome: z.literal('failed'), reason: z.enum(FAILED_REASONS) }).strict(),
    z.object({ outcome: z.literal('unknown'), reason: z.enum(UNKNOWN_REASONS) }).strict(),
  ],
);

export type HostExecutor = { kind: 'tool'; hook: string } | { kind: 'connector' };

/**
 * A connector toolKey (parseConnectorToolKey !== null) is host-executable ONLY
 * via the connector hook — never via a `tool:execute:<key>` even if one exists
 * — and only for a decision held during a task run (`attendance` is not
 * `attended`, review F1). Anything else needs `tool:execute:<name>`, whatever
 * its attendance. Null means the host cannot run it.
 *
 * Asked about the DECISION, not a bare tool name, so the one rule covers all
 * three sites: they hand in the same row and cannot answer differently.
 */
export function hostExecutorFor(
  bus: Pick<HookBus, 'hasService'>,
  decision: Pick<Decision, 'call' | 'attendance'>,
): HostExecutor | null {
  const toolName = decision.call.name;
  if (parseConnectorToolKey(toolName) !== null) {
    if (decision.attendance === 'attended') return null;
    return bus.hasService(CONNECTOR_CALL_TOOL_HOOK) ? { kind: 'connector' } : null;
  }
  const hook = `tool:execute:${toolName}`;
  return bus.hasService(hook) ? { kind: 'tool', hook } : null;
}

/** What an approval says about itself that the approve route's question reads. */
export interface ApprovalView {
  /** `decisions:approve`'s `requestShownInFull`. Read as `=== true` only. */
  requestShownInFull?: unknown;
}

/**
 * The approve route's question (review F2): may the host make this call on
 * THIS yes? `hostExecutorFor`, plus one rule for a connector call: the host
 * sends its recorded input verbatim, so the person must have been shown the
 * whole request. The card cuts a long one short, and a yes to its beginning is
 * not a yes to the rest. Only an explicit `true` passes; anything else parks
 * the call for the agent, so the failure mode is a call that waits, never a
 * write nobody read.
 *
 * Asked only where the yes is given. The two later sites need no flag: a row
 * the route parked is never replayed (no sweep picks up a parked row), a row it
 * claimed or deferred for the host already passed this check, and the delivery
 * fallback only ever sees attended rows, which have no connector executor.
 */
export function hostExecutorForApproval(
  bus: Pick<HookBus, 'hasService'>,
  decision: Pick<Decision, 'call' | 'attendance'>,
  approval: ApprovalView,
): HostExecutor | null {
  const executor = hostExecutorFor(bus, decision);
  if (executor?.kind === 'connector' && approval.requestShownInFull !== true) return null;
  return executor;
}
