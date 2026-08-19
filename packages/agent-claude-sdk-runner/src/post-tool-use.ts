// ---------------------------------------------------------------------------
// PostToolUse → event.tool-post-call IPC adapter.
//
// SDK adapter over `ToolPolicy.postToolUse` in @ax/agent-runner-core. Keeps
// only the SDK-shaped parts here: event-name narrowing, tool-name
// classification, and mapping a note onto `hookSpecificOutput.additionalContext`.
// The fire-and-forget audit event and the Bash egress-block drain both live in
// the shared policy now — see tool-policy.ts's `postToolUse`.
//
// Phase 3 simplification: this hook USED to also drive workspace-diff
// observation (record file-mutating SDK tool outputs into a per-turn
// diff accumulator, drained at turn end). That's gone — the runner now
// detects workspace changes via `git status` against /agent at turn
// end (`commitTurnAndBundle` in main.ts). git status catches ALL
// writes regardless of tool, including the Bash deletes and MCP writes
// the legacy observer missed. PostToolUse only emits the audit event
// now; nothing else.
//
// Key properties:
//   * Fire-and-forget: the policy `void`s the event promise. A dropped
//     event must NEVER stall the SDK's turn loop — dropped audit events
//     are recoverable; hung turns are not.
//   * Narrow on hook_event_name: matchers usually filter these, but the
//     defensive narrow keeps a mis-wired hook from spraying bad payloads.
//   * Disabled tool names don't emit. We don't want the host's subscriber
//     chain acting on tool activity that shouldn't have been possible in
//     the first place — the belt-and-braces mirror of can-use-tool.ts.
// ---------------------------------------------------------------------------

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createToolPolicy, type CreateToolPolicyOptions } from '@ax/agent-runner-core';
import { classifySdkToolName } from './tool-names.js';

export type CreatePostToolUseHookOptions = CreateToolPolicyOptions;

// Re-exported for callers (and tests) that import the note builder from this
// module's original location. The implementation now lives in
// @ax/agent-runner-core, shared with other runners.
export { buildEgressBlockNote } from '@ax/agent-runner-core';

export function createPostToolUseHook(
  opts: CreatePostToolUseHookOptions,
): HookCallback {
  const policy = createToolPolicy(opts);

  // The SDK's HookCallback is 3-ary `(input, toolUseID, { signal })`; declare
  // the (unused) third param so the real call shape is honest — matches the
  // sibling pre-tool-use hook and keeps callers from looking like they pass a
  // superfluous argument (CodeQL).
  return async (input, toolUseID, _options) => {
    // Defensive narrow — SDK matchers should route only PostToolUse here,
    // but we don't want a misconfigured hook map to leak a different
    // payload shape onto the wire.
    if (input.hook_event_name !== 'PostToolUse') {
      return {};
    }

    const klass = classifySdkToolName(input.tool_name);
    if (klass.kind === 'disabled') {
      return {};
    }

    const { note } = await policy.postToolUse(
      klass.axName,
      toolUseID,
      input.tool_input,
      input.tool_response,
      klass.kind === 'builtin',
    );

    return note === undefined
      ? {}
      : {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: note,
          },
        };
  };
}
