// ---------------------------------------------------------------------------
// PostToolUse → event.tool-post-call IPC adapter.
//
// Wraps our fire-and-forget post-call event into claude-agent-sdk's hook
// callback shape. Registered by the runner in `hooks.PostToolUse` so the
// host observes every completed tool invocation (audit log, chat
// orchestrator, transcript rendering — all downstream of this signal).
//
// Key properties:
//   * Fire-and-forget: we `void` the event promise. A dropped event
//     must NEVER stall the SDK's turn loop — dropped audit events are
//     recoverable; hung turns are not.
//   * Narrow on hook_event_name: matchers usually filter these, but the
//     defensive narrow keeps a mis-wired hook from spraying bad payloads.
//   * Disabled tool names don't emit. We don't want the host's subscriber
//     chain acting on tool activity that shouldn't have been possible in
//     the first place — the belt-and-braces mirror of can-use-tool.ts.
// ---------------------------------------------------------------------------

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { IpcClient } from '@ax/agent-runner-core';
import { classifySdkToolName } from './tool-names.js';

export interface CreatePostToolUseHookOptions {
  client: IpcClient;
}

export function createPostToolUseHook(
  opts: CreatePostToolUseHookOptions,
): HookCallback {
  return async (input, toolUseID) => {
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

    // Fire-and-forget. Failures here must not stall the runner's turn loop;
    // dropping an audit event is recoverable, a hung turn is not.
    void opts.client
      .event('event.tool-post-call', {
        call: {
          id: toolUseID ?? '',
          name: klass.axName,
          input: input.tool_input,
        },
        output: input.tool_response,
      })
      .catch(() => {
        /* swallow — fire-and-forget */
      });

    return {};
  };
}
