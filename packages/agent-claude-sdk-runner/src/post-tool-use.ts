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
import type { DiffAccumulator, IpcClient } from '@ax/agent-runner-core';
import { classifySdkToolName } from './tool-names.js';
import { observePostToolUse, type ObserveOptions } from './workspace-diff.js';

export interface CreatePostToolUseHookOptions {
  client: IpcClient;
  /**
   * Per-turn diff accumulator (Task 7c). When set, the hook reads the
   * resulting file bytes for known file-mutating SDK tools (`Write`,
   * `Edit`, `MultiEdit`) and records them. The runner drains the
   * accumulator on `result` (turn end) and ships one `workspace.commit-
   * notify`. Optional so existing tests that don't care about workspace
   * commits keep working.
   */
  diffs?: DiffAccumulator;
  workspaceRoot?: string;
  /** Test seam forwarded to observePostToolUse for stubbing fs. */
  observeFs?: ObserveOptions['fs'];
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

    // Workspace-diff observation. We AWAIT this (unlike the fire-and-forget
    // event below) so the accumulator is populated before the SDK emits the
    // next message. The runner needs the diff settled before it sees the
    // turn-end `result` and flushes commit-notify. Errors are swallowed
    // inside `observePostToolUse` — best-effort; never blocks the turn.
    if (
      opts.diffs !== undefined &&
      opts.workspaceRoot !== undefined &&
      typeof input.tool_name === 'string'
    ) {
      try {
        await observePostToolUse(input.tool_name, input.tool_input, {
          workspaceRoot: opts.workspaceRoot,
          diffs: opts.diffs,
          ...(opts.observeFs !== undefined ? { fs: opts.observeFs } : {}),
        });
      } catch {
        /* observer failure must not break the turn */
      }
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
