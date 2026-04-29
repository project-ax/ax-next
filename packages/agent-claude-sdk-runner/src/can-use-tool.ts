// ---------------------------------------------------------------------------
// canUseTool → belt-and-suspenders allow-path.
//
// Previously this hook drove `tool.pre-call` — the architecture doc called
// it the primary bridge. In practice, `canUseTool` only fires when the
// CLI's own permission system decides a tool needs a prompt, and built-ins
// like `Bash echo hi` (under permissionMode 'default') are pre-approved
// internally and never reach here. That left the host blind to those
// invocations.
//
// As of Week 6.5d Task 14 the pre-call IPC forwarding moved into the
// PreToolUse hook, which the SDK fires for EVERY tool use. This callback
// is kept as a belt-and-suspenders allow-path so the SDK's permission
// machinery remains satisfied when it DOES route through canUseTool
// (e.g. third-party MCP tools) — the host has already seen and
// adjudicated the call via PreToolUse at that point, so canUseTool only
// needs to translate the SDK's permission-request envelope into an
// `{behavior:'allow'}` reply.
//
// Two fast-paths:
//   * `disabled` names — the SDK's `disallowedTools` should already have
//     filtered these out; we refuse anyway as defense in depth.
//   * Everything else allows. PreToolUse is the authoritative gate; if it
//     denied, the SDK will never reach canUseTool.
// ---------------------------------------------------------------------------

import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { IpcClient } from '@ax/ipc-protocol';
import { classifySdkToolName } from './tool-names.js';

export interface CreateCanUseToolOptions {
  client: IpcClient;
}

export function createCanUseTool(_opts: CreateCanUseToolOptions): CanUseTool {
  return async (toolName, input, _options) => {
    const klass = classifySdkToolName(toolName);

    // Exhaustive classifier switch (defense in depth). Default to deny so a
    // future classifier variant that forgets to add a case here fails
    // closed rather than silently allowing the call.
    switch (klass.kind) {
      case 'disabled':
        return { behavior: 'deny', message: 'tool disabled by policy' };
      case 'builtin':
      case 'mcp-host':
        // Allow pass-through. The host-side `tool:pre-call` subscriber
        // chain already ran inside the PreToolUse hook (see
        // pre-tool-use.ts); if it rejected, the SDK would never route the
        // call here. We echo the input unchanged because PreToolUse
        // already forwarded any `modifiedCall.input` to the SDK.
        return { behavior: 'allow', updatedInput: input };
      default: {
        const _exhaustive: never = klass;
        void _exhaustive;
        return { behavior: 'deny', message: 'unclassified tool' };
      }
    }
  };
}
