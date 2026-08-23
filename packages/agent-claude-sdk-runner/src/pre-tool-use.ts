// SDK adapter over the runner-agnostic ToolPolicy in @ax/agent-runner-core.
// Responsibilities kept here are exactly the SDK-shaped ones: classifying the
// SDK's tool name, short-circuiting disabled built-ins, and mapping a
// PreToolVerdict onto `hookSpecificOutput`.
//
// Why `PreToolUse` and not `canUseTool`: `canUseTool` only fires for tools
// the CLI decides need a permission prompt. Built-ins the CLI considers
// benign (e.g. `Bash echo hi` under permissionMode 'default') never reach
// canUseTool — they'd run with no host visibility at all, breaking the
// invariant that every tool invocation crosses `tool:pre-call`. `PreToolUse`
// ALWAYS fires, once per invocation, before the tool runs, so we use it as
// the authoritative pre-call gate; the existing canUseTool adapter stays in
// place as a belt-and-suspenders allow-path for tools the SDK routes there
// directly (third-party MCP, etc.).
//
// The policy itself (re-root + `tool.pre-call` adjudication) now lives in
// `@ax/agent-runner-core`'s `tool-policy.ts`, shared with other runners.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import {
  createToolPolicy,
  type CreateToolPolicyOptions,
  type HoldLatch,
} from '@ax/agent-runner-core';
import { classifySdkToolName } from './tool-names.js';

export type CreatePreToolUseHookOptions = CreateToolPolicyOptions & {
  /**
   * Tripped on a hold. Optional here because the SDK's own `continue:false` is
   * what actually stops the loop — unlike the aisdk runner, where `stopWhen`
   * reads the latch and it is load-bearing. `main.ts` reads it at the turn
   * boundary so a held turn is distinguishable from a finished one.
   */
  holdLatch?: HoldLatch;
  /**
   * Called with the SDK's tool-call id when a call is held, so `main.ts` can
   * recognise that call's tool_result later in the turn and publish the
   * human's line instead of the model's hold note (which the CLI hands back
   * flagged `is_error`, making a waiting call look like a failed one).
   *
   * Separate from `holdLatch` because they answer different questions: the
   * latch records WHICH decision stopped the turn, this records WHICH CALL the
   * person is being asked about. Fired only when the SDK gave us a real
   * `toolUseID` — see the comment below on `''` vs `undefined`.
   */
  onHold?: (toolCallId: string) => void;
};

export function createPreToolUseHook(
  opts: CreatePreToolUseHookOptions,
): HookCallback {
  const policy = createToolPolicy(opts);

  return async (input, toolUseID, _options) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }

    const klass = classifySdkToolName(input.tool_name);
    if (klass.kind === 'disabled') {
      // Defence in depth, not the enforcement path. `main.ts` passes these
      // four names as `disallowedTools`, which the SDK documents as removing
      // them from the model's context entirely (sdk.d.ts:1185-1189) — so the
      // model cannot emit a call for one and this branch does not run in a
      // healthy session. It is here for the session where that list has
      // regressed or the SDK's semantics have moved, and it fails closed.
      //
      // The reason is per-tool (`DISABLED_BUILTIN_REASONS`) rather than one
      // flat string. If this branch ever DOES fire, its reason travels the
      // same route as any other deny — the SDK turns `permissionDecisionReason`
      // into an `is_error` tool_result that is persisted and rendered in the
      // web transcript (TASK-239) — so it names which of four things was
      // refused, and what to do instead, in plain language.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: klass.reason,
        },
      };
    }

    // Pass toolUseID straight through — do NOT coerce to '' here. The
    // policy's `toolUseId ?? idGen()` only generates a fresh id for
    // `undefined`; coercing to '' would make it fire on an empty-string id
    // too, which the original (pre-split) hook never did (it forwarded the
    // literal '' as the call id via `toolUseID ?? idGen()`).
    const verdict = await policy.preToolUse(
      klass.axName,
      input.tool_input,
      toolUseID,
    );

    if (verdict.decision === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      };
    }

    if (verdict.decision === 'hold') {
      opts.holdLatch?.trip(verdict.decisionId);
      // Only a REAL id. Same care as the `toolUseId ?? idGen()` note above:
      // the policy may have minted a synthetic id for the pre-call payload,
      // but the SDK will stamp its own id on the tool_result, so a synthetic
      // one would never match — and '' would key the registry on a value a
      // later result could collide with.
      if (typeof toolUseID === 'string' && toolUseID !== '') {
        opts.onHold?.(toolUseID);
      }
      // `continue: false` is the SDK's clean stop (SyncHookJSONOutput,
      // sdk.d.ts:5192) — the loop ends here rather than handing the model a
      // denial to improvise around. We ALSO emit permissionDecision:'deny' so
      // the tool provably does not run in any SDK version where `continue` is
      // honoured late; the two together are belt and braces, not redundancy.
      return {
        continue: false,
        stopReason: verdict.note,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.note,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        ...(verdict.updatedInput !== undefined
          ? { updatedInput: verdict.updatedInput }
          : {}),
      },
    };
  };
}
