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
//   * `disabled` names — defence in depth, and nothing more than that.
//     `main.ts` passes those four names as `disallowedTools`, which the SDK
//     documents as removing them from the model's context so they "cannot be
//     used" (sdk.d.ts:3209-3212). The model therefore never emits a call for
//     one and this case does not run in a healthy session; it is the
//     fail-closed floor for a regressed disallow list or changed SDK
//     semantics. The deny message is the per-tool sentence from
//     `DISABLED_BUILTIN_REASONS` so a refusal that DOES happen says which of
//     the four fired rather than one undifferentiated string.
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
        return { behavior: 'deny', message: klass.reason };
      case 'builtin':
      case 'mcp-host':
      case 'mcp-sandbox':
        // Allow pass-through. The host-side `tool:pre-call` subscriber
        // chain already ran inside the PreToolUse hook (see
        // pre-tool-use.ts); if it rejected, the SDK would never route the
        // call here. We echo the input unchanged because PreToolUse
        // already forwarded any `modifiedCall.input` to the SDK.
        // Sandbox-executed tools (Phase 2 artifact_publish) follow the
        // same allow-and-let-PreToolUse-decide pattern; the dispatch path
        // differs (in-process via local-dispatcher) but the gating posture
        // is identical.
        return { behavior: 'allow', updatedInput: input };
      default: {
        // Unreachable, and the compiler is what proves it: the three cases
        // above exhaust `SdkToolClass`, so `klass` is narrowed to `never` here
        // and this assignment stops compiling the moment a variant is added
        // without a case. That build error is the actual safety mechanism.
        // The deny below is only the fail-closed floor for a `never` that was
        // hand-waved past the compiler (a cast, a ts-expect-error); no
        // production path reaches it, so its wording is not a message anyone
        // is expected to read.
        const _exhaustive: never = klass;
        void _exhaustive;
        return { behavior: 'deny', message: 'tool could not be classified' };
      }
    }
  };
}
