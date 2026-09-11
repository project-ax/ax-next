/**
 * tool-step-status — what one tool call is actually doing, in one place.
 *
 * `ToolUse.tsx` has classified tool calls this way for a while, privately. The
 * collapsed chain-of-thought header needs the same answer (TASK-335 / audit A3:
 * a FAILED step still summarized as "Ran a command"), and the one thing we must
 * not do is work it out a second time — two components disagreeing about
 * whether a step failed is a worse bug than the one being fixed, and the
 * ordering below is load-bearing rather than obvious.
 *
 * So the logic moved here and `ToolUse` reads it from here. Invariant 4: one
 * source of truth per concept.
 *
 * The ordering, which is the part that matters:
 *
 *   running → held → failed → done
 *
 * `held` deliberately sits ABOVE `failed` (TASK-260's floor). A tool call
 * waiting on a person has not run and has not failed; the runners publish held
 * results with `is_error` omitted, but a stale or foreign row carrying both
 * must still read as waiting. Calling a pending decision a failure tells the
 * reader the thing is over when it is in fact waiting on them.
 */
import { isToolHeld } from './tool-held';

export type ToolStepStatus = 'running' | 'waiting' | 'failed' | 'done';

/**
 * The shape we need off a tool-call part. Kept structural rather than importing
 * assistant-ui's `ToolCallMessagePartProps`, because the chain-of-thought header
 * reads raw parts off the message store by index and never sees the props type.
 */
export interface ToolStepLike {
  // `| undefined` on each is deliberate: the repo runs with
  // `exactOptionalPropertyTypes`, and assistant-ui's part type declares these as
  // present-but-possibly-undefined rather than optional. Without it a real
  // `ToolCallMessagePart` does not satisfy this interface at all.
  toolCallId?: string | undefined;
  isError?: boolean | undefined;
  status?: { type?: string | undefined } | undefined;
}

/** Classify one tool call. See the ordering note above before reordering it. */
export function toolStepStatus(p: ToolStepLike): ToolStepStatus {
  if (p.status?.type === 'running') return 'running';
  if (p.toolCallId !== undefined && isToolHeld(p.toolCallId)) return 'waiting';
  if (p.isError === true || p.status?.type === 'incomplete') return 'failed';
  return 'done';
}
