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

import type { DenyCause, HoldLatch, ToolPolicy } from '@ax/agent-runner-core';

/**
 * Marker set on every wrapped `execute`. `assertAllToolsWrapped` (and the test
 * that enumerates the built tool set) reads it, so a tool added later on a
 * bypass path fails a test instead of silently skipping the gate.
 *
 * A module-local symbol would be defeated by two copies of this module in one
 * process; `Symbol.for` is registry-global, so the check holds regardless.
 */
export const POLICY_WRAPPED = Symbol.for('ax.aisdk.tool.policyWrapped');

/**
 * Marker set on every wrapped `execute` to the shared `HoldLatch` instance it
 * was built with. On this runner a tool's `execute` cannot stop the turn by
 * itself — `stopWhen` reads the latch instead — so every wrapped tool MUST
 * share the SAME latch instance. A tool wired with its own (or no) latch
 * would hold without ever stopping the turn, a silent-failure shape this
 * repo has been bitten by before. A test proves identity across the whole
 * built tool set by reading this symbol off each `execute`.
 */
export const HOLD_LATCH = Symbol.for('ax.aisdk.tool.holdLatch');

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
  /**
   * The one latch shared by every wrapped tool in the turn. Required (not
   * optional) — unlike the claude-sdk adapter, where the SDK's own
   * `continue:false` stops the loop and the latch is just bookkeeping, on
   * this runner `stopWhen` is what stops the loop, and it reads THIS latch.
   * Omitting it, or passing a tool its own private latch, would let a hold
   * return text but never end the turn — required makes tsc catch a missing
   * wire at every call site instead of that shipping silently.
   */
  holdLatch: HoldLatch;
}

/** The `execute` shape `ai@7`'s `tool()` accepts, narrowed to what we produce. */
export type WrappedExecute = ((
  input: unknown,
  options: { toolCallId: string; abortSignal?: AbortSignal },
) => Promise<string>) & { [POLICY_WRAPPED]?: true; [HOLD_LATCH]?: HoldLatch };

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
      // as an error: the model is meant to read this and act on it — by trying
      // a permitted approach when a rule blocked the call, or by retrying when
      // the gate simply could not be reached. `verdict.cause` is what tells the
      // two apart; see `denialText`.
      return denialText(verdict.reason, verdict.cause);
    }

    if (verdict.decision === 'hold') {
      opts.holdLatch.trip(verdict.decisionId);
      // Same shape as a denial — text, not a throw — for the same reason
      // (choice 1 above). The difference is the latch: `stopWhen` reads it and
      // ends the turn after THIS step, so the model never gets another step to
      // try a different route to the same effect. It also never gets a step to
      // narrate the hold, which is deliberate — the note lands in the
      // transcript as this tool's result, and the durable thing the user acts
      // on is the Decision row, not a sentence the model chose to write.
      return holdText(verdict.note);
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
  execute[HOLD_LATCH] = opts.holdLatch;
  return execute;
}

/**
 * The denial text handed back to the model. Prefixed so a reader of the
 * transcript can tell a policy denial from a tool's own "permission denied"
 * output, and phrased as an instruction because that is what makes models
 * switch approach rather than retry verbatim.
 *
 * It branches on `cause` because the two situations warrant OPPOSITE advice,
 * and only one of them is a policy decision at all. Telling the model
 * "retrying the same call will be denied again" after the gate timed out is a
 * claim we cannot back: no rule blocked anything, the host blipped, and a
 * retry probably WOULD succeed. The model then relays that invented certainty
 * to the person as "I'm not allowed to do that", and the real cause is gone.
 */
export function denialText(reason: string, cause: DenyCause): string {
  if (cause === 'unavailable') {
    return (
      `Tool call not run: ${reason}\n\n` +
      'No rule blocked this. The check itself did not complete, so nothing was ' +
      'decided about this call — it may well succeed if you try it again ' +
      'shortly. If it keeps failing, tell the user the approval check needs ' +
      'looking at, then stop.'
    );
  }
  return (
    `Tool call denied by policy: ${reason}\n\n` +
    'This is a policy decision, not a transient failure — retrying the same ' +
    'call will be denied again. Adjust your approach.'
  );
}

/**
 * What the model reads on a hold. Deliberately instructive: `deny` invites a
 * workaround, and "not yet" must not read as "not this way".
 */
export function holdText(note: string): string {
  return [
    note,
    '',
    'This action was recorded and is waiting for the person you are working for.',
    'Do not retry it and do not achieve the same effect another way.',
    'Tell them what you were about to do, then stop.',
  ].join('\n');
}

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Merge the tool groups into the one object `ToolLoopAgent` receives, refusing
 * to let a later group SHADOW an earlier one.
 *
 * The SDK runner cannot have this problem: it exposes catalog tools through two
 * in-process MCP servers, so the SDK renames them `mcp__<server>__<tool>` and a
 * catalog tool can never occupy the name `Bash`. This runner drops the shims
 * (design §3), so every name lives in ONE flat namespace and a plain object
 * spread would resolve a collision silently, in favour of whichever group was
 * spread last. A host tool named `Read` would then quietly replace the
 * in-sandbox `Read` — same name, same schema shape, completely different
 * machine doing the reading. Nothing would fail; the file operations would just
 * happen somewhere else.
 *
 * Not reachable from untrusted input today: `@ax/mcp-client` namespaces every
 * third-party tool as `mcp.<serverId>.<tool>` (see its `tool-names.ts`), so a
 * malicious MCP server cannot claim `Bash`. The exposure is a FIRST-PARTY
 * registration mistake — which is exactly the kind of thing that should fail at
 * boot with the offending name in the message rather than change where the
 * agent's file writes land.
 */
export function mergeToolSets(
  groups: ReadonlyArray<{ label: string; tools: Record<string, unknown> }>,
): Record<string, never> {
  const merged: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const group of groups) {
    for (const [name, impl] of Object.entries(group.tools)) {
      const previous = owner.get(name);
      if (previous !== undefined) {
        throw new Error(
          `agent-aisdk-runner: tool name '${name}' is claimed by both ` +
            `${previous} and ${group.label}. This runner has ONE flat tool ` +
            `namespace (no mcp__ prefixes), so the collision would silently ` +
            `route calls to whichever was registered last. Rename one.`,
        );
      }
      owner.set(name, group.label);
      merged[name] = impl;
    }
  }
  return merged as Record<string, never>;
}

/**
 * Every entry of a `ToolSet` must carry a policy-wrapped `execute`, and — when
 * `expectedLatch` is given — every one of them must carry THAT latch, by
 * identity. Called on the fully-assembled tool set at loop construction, so
 * both a tool registered on a bypass path and a tool holding its own private
 * latch are BOOT failures, not silent holes in the gate.
 *
 * The latch check earns its place because the failure it catches is invisible
 * at runtime: `stopWhen` reads exactly one latch, so a tool wired to a
 * different one would hold — refusing to run, returning the hold text — and
 * the turn would carry right on to the next step. Nothing throws, nothing
 * logs, and the whole point of the verdict is lost.
 */
export function assertAllToolsWrapped(
  tools: Record<string, { execute?: unknown }>,
  expectedLatch?: HoldLatch,
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
  if (expectedLatch === undefined) return;
  const strayLatch = Object.entries(tools)
    .filter(([, t]) => (t.execute as WrappedExecute)[HOLD_LATCH] !== expectedLatch)
    .map(([name]) => name);
  if (strayLatch.length > 0) {
    throw new Error(
      `agent-aisdk-runner: tool(s) wired with a different hold latch than the loop's: ${strayLatch.join(', ')}. ` +
        'stopWhen reads ONE latch — a tool holding on its own would refuse the call and let the turn continue anyway.',
    );
  }
}
