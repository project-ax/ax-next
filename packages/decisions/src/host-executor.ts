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
 * via the connector hook — never via a `tool:execute:<key>` even if one exists.
 * Anything else needs `tool:execute:<name>`. Null means the host cannot run it.
 */
export function hostExecutorFor(
  bus: Pick<HookBus, 'hasService'>,
  toolName: string,
): HostExecutor | null {
  if (parseConnectorToolKey(toolName) !== null) {
    return bus.hasService(CONNECTOR_CALL_TOOL_HOOK) ? { kind: 'connector' } : null;
  }
  const hook = `tool:execute:${toolName}`;
  return bus.hasService(hook) ? { kind: 'tool', hook } : null;
}
