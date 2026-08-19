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
import { createToolPolicy, type CreateToolPolicyOptions } from '@ax/agent-runner-core';
import { classifySdkToolName } from './tool-names.js';

export type CreatePreToolUseHookOptions = CreateToolPolicyOptions;

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
      // Belt-and-braces: disallowedTools should already block these.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'tool disabled by policy',
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
