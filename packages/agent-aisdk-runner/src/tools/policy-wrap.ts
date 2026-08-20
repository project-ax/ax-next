// ---------------------------------------------------------------------------
// The permission choke point.
//
// Every tool this runner registers — the six built-ins, every host tool from
// the `tool.list` catalog, every sandbox-executed tool, and `Skill` — runs its
// `execute` through this wrapper. Nothing else may call an executor directly.
//
// The claude-sdk runner gets the same guarantee from the SDK's `PreToolUse` /
// `PostToolUse` hooks. Here we own every `execute`, so the wrapper IS the gate.
// Both sides are thin adapters over the ONE policy in `@ax/agent-runner-core`
// (`createToolPolicy`) — that is what makes "one security policy, two runners"
// true rather than aspirational (design §2/§3).
//
// Two deliberate choices, both load-bearing:
//
//   1. A VETO RETURNS AS A TOOL RESULT, NEVER A THROW. Throwing would mark the
//      call failed and (in the SDK's own error channel) hand the model an
//      `error-text` result; returning the denial reason as ordinary text keeps
//      the agent working and lets it adapt on the next call. Every model in the
//      design's fidelity matrix read a denial reason and complied. It is also
//      what the existing egress-block remediation notes already assume.
//
//   2. AN EXECUTOR ERROR DOES throw. That is a different event from a veto: the
//      tool was permitted and then failed. `ai@7` converts a thrown executor
//      error into a `tool-error` stream part plus an `error-text` tool result
//      and CONTINUES the loop (verified against ai@7.0.70), so the turn is not
//      aborted — the model just sees a failed tool instead of a denied one, and
//      the host sees `is_error` on the persisted tool_result block. We still
//      fire `postToolUse` first so the audit event records the failed call.
// ---------------------------------------------------------------------------

import type { ToolPolicy } from '@ax/agent-runner-core';

/**
 * Marker set on every wrapped `execute`. `assertAllToolsWrapped` (and the test
 * that enumerates the built tool set) reads it, so a tool added later on a
 * bypass path fails a test instead of silently skipping the gate.
 *
 * A module-local symbol would be defeated by two copies of this module in one
 * process; `Symbol.for` is registry-global, so the check holds regardless.
 */
export const POLICY_WRAPPED = Symbol.for('ax.aisdk.tool.policyWrapped');

/** What a tool implementation actually does, once the policy has allowed it. */
export type ToolRunner = (
  /** The re-rooted input — `verdict.updatedInput` when the policy rewrote it. */
  input: Record<string, unknown>,
  ctx: { toolCallId: string; abortSignal?: AbortSignal | undefined },
) => Promise<string>;

export interface WrapWithPolicyOptions {
  policy: ToolPolicy;
  /**
   * The ax-native tool name host subscribers registered — `Bash`, `Read`, a
   * catalog tool's `name`, `Skill`. No `mcp__…` prefixes exist on this runner,
   * so unlike the SDK adapter there is nothing to strip.
   */
  name: string;
  /**
   * True for the tools we implement in-sandbox (the six built-ins + `Skill`),
   * false for catalog tools. Drives the policy's Bash egress-block drain, which
   * is gated on builtin-AND-Bash so a catalog tool that happens to be named
   * `Bash` can't reach it.
   */
  isBuiltin: boolean;
}

/** The `execute` shape `ai@7`'s `tool()` accepts, narrowed to what we produce. */
export type WrappedExecute = ((
  input: unknown,
  options: { toolCallId: string; abortSignal?: AbortSignal },
) => Promise<string>) & { [POLICY_WRAPPED]?: true };

export function wrapWithPolicy(
  opts: WrapWithPolicyOptions,
  run: ToolRunner,
): WrappedExecute {
  const execute: WrappedExecute = async (input, options) => {
    const verdict = await opts.policy.preToolUse(
      opts.name,
      input,
      options.toolCallId,
    );

    if (verdict.decision === 'deny') {
      // Choice 1 above. Deliberately NOT a throw, and deliberately not marked
      // as an error: the model is meant to read this, adapt, and try a
      // permitted approach on the next call.
      return denialText(verdict.reason);
    }

    // The policy re-roots governed paths (`.ax/**`, `.claude/**`) onto the
    // validated tier and lets host subscribers rewrite the call. The executor
    // MUST see that rewritten input — running the raw input would let a
    // mis-rooted `.ax/uploads/...` write land outside the governed tree.
    const effectiveInput =
      verdict.updatedInput ?? (asRecord(input));

    let output: string;
    let failure: unknown;
    try {
      output = await run(effectiveInput, {
        toolCallId: options.toolCallId,
        abortSignal: options.abortSignal,
      });
    } catch (err) {
      failure = err;
      output = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }

    // Fires for a failed executor too — dropping the audit event for exactly
    // the calls that went wrong would be the worst possible gap.
    const { note } = await opts.policy.postToolUse(
      opts.name,
      options.toolCallId,
      effectiveInput,
      output,
      opts.isBuiltin,
    );

    if (failure !== undefined) {
      // Choice 2 above: re-throw so the SDK marks the result as an error.
      throw failure instanceof Error ? failure : new Error(String(failure));
    }

    return note === undefined ? output : `${output}\n\n${note}`;
  };

  execute[POLICY_WRAPPED] = true;
  return execute;
}

/**
 * The denial text handed back to the model. Prefixed so a reader of the
 * transcript can tell a policy denial from a tool's own "permission denied"
 * output, and phrased as an instruction because that is what makes models
 * switch approach rather than retry verbatim.
 */
export function denialText(reason: string): string {
  return `Tool call denied by policy: ${reason}\n\nThis is a policy decision, not a transient failure — retrying the same call will be denied again. Adjust your approach.`;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Every entry of a `ToolSet` must carry a policy-wrapped `execute`. Called on
 * the fully-assembled tool set at loop construction, so a tool registered on a
 * bypass path is a BOOT failure, not a silent hole in the gate.
 */
export function assertAllToolsWrapped(
  tools: Record<string, { execute?: unknown }>,
): void {
  const unwrapped = Object.entries(tools)
    .filter(([, t]) => {
      const ex = t.execute as WrappedExecute | undefined;
      return typeof ex !== 'function' || ex[POLICY_WRAPPED] !== true;
    })
    .map(([name]) => name);
  if (unwrapped.length > 0) {
    throw new Error(
      `agent-aisdk-runner: tool(s) registered without the policy wrapper: ${unwrapped.join(', ')}. ` +
        'Every tool must go through wrapWithPolicy — it is the only pre-call gate on this runner.',
    );
  }
}
