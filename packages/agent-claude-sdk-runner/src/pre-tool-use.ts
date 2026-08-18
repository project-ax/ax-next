// SDK adapter over the runner-agnostic ToolPolicy in @ax/agent-runner-core.
// Responsibilities kept here are exactly the SDK-shaped ones: classifying the
// SDK's tool name, short-circuiting disabled built-ins, and mapping a
// PreToolVerdict onto `hookSpecificOutput`.
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

    const verdict = await policy.preToolUse(
      klass.axName,
      input.tool_input,
      toolUseID ?? '',
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
