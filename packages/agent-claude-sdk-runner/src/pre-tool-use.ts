// ---------------------------------------------------------------------------
// PreToolUse → tool.pre-call IPC adapter.
//
// Why this exists instead of forwarding `canUseTool` → `tool.pre-call` (the
// Task-7 design): `canUseTool` only fires for tools the CLI decides need a
// permission prompt. Built-ins the CLI considers benign (e.g. `Bash echo hi`
// under permissionMode 'default') never reach canUseTool — they run with no
// host visibility at all, which breaks the invariant that every tool
// invocation crosses `tool:pre-call`.
//
// `PreToolUse` is the SDK hook that ALWAYS fires, once per tool invocation,
// before the tool runs. We use it as the authoritative pre-call signal and
// translate the host's verdict into `hookSpecificOutput.permissionDecision`
// so the SDK treats the tool as pre-approved (or pre-denied) and skips
// canUseTool. The existing canUseTool adapter stays in place as a
// belt-and-suspenders allow-path for tools the SDK routes there directly
// (third-party MCP, etc.) — but the host sees them via PreToolUse first, so
// the pre-call event is single-fire.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { IpcClient } from '@ax/agent-runner-core';
import {
  ToolPreCallResponseSchema,
  type ToolPreCallResponse,
} from '@ax/ipc-protocol';
import { classifySdkToolName } from './tool-names.js';

export interface CreatePreToolUseHookOptions {
  client: IpcClient;
  /** Test seam: override the per-call id generator. Defaults to randomUUID. */
  idGen?: () => string;
}

export function createPreToolUseHook(
  opts: CreatePreToolUseHookOptions,
): HookCallback {
  const idGen = opts.idGen ?? ((): string => randomUUID());

  return async (input, toolUseID) => {
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

    let parsed: ToolPreCallResponse;
    try {
      const raw = await opts.client.call('tool.pre-call', {
        call: {
          id: toolUseID ?? idGen(),
          name: klass.axName,
          input: input.tool_input,
        },
      });
      parsed = ToolPreCallResponseSchema.parse(raw) as ToolPreCallResponse;
    } catch (err) {
      // IPC failure: fall back to deny so subscribers can't be bypassed by a
      // racing disconnection. The SDK surfaces this as a turn error.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            err instanceof Error ? err.message : String(err),
        },
      };
    }

    if (parsed.verdict === 'reject') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: parsed.reason,
        },
      };
    }

    // Allow — optionally forward a modified input back to the SDK.
    const out: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse';
        permissionDecision: 'allow';
        updatedInput?: Record<string, unknown>;
      };
    } = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
    if (
      parsed.modifiedCall?.input !== undefined &&
      parsed.modifiedCall.input !== null &&
      typeof parsed.modifiedCall.input === 'object'
    ) {
      out.hookSpecificOutput.updatedInput = parsed.modifiedCall.input as Record<
        string,
        unknown
      >;
    }
    return out;
  };
}
