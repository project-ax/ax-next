// ---------------------------------------------------------------------------
// canUseTool → tool.pre-call IPC adapter.
//
// Bridges claude-agent-sdk's `CanUseTool` callback to our host's
// `tool.pre-call` action. Every tool invocation the SDK is about to make
// passes through here; we forward it to the host's subscriber chain
// (permission check, arg rewriting, audit log) and translate the host's
// verdict back into what the SDK expects.
//
// Two fast-paths bypass IPC entirely:
//   * `disabled` names — the SDK's `disallowedTools` should already have
//     filtered these out; we refuse anyway as defense in depth. The host
//     never hears about them.
//
// Everything else becomes a `tool.pre-call` call. Errors from the IPC
// client propagate; the SDK surfaces them as a turn failure, which is
// the correct behavior — a host that can't answer pre-call has no way
// to adjudicate the tool call at all.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { IpcClient } from '@ax/agent-runner-core';
import {
  ToolPreCallResponseSchema,
  type ToolPreCallResponse,
} from '@ax/ipc-protocol';
import { classifySdkToolName } from './tool-names.js';

export interface CreateCanUseToolOptions {
  client: IpcClient;
  /** Test seam: override the per-call id generator. Defaults to `randomUUID`. */
  idGen?: () => string;
}

export function createCanUseTool(opts: CreateCanUseToolOptions): CanUseTool {
  const idGen = opts.idGen ?? ((): string => randomUUID());

  return async (toolName, input) => {
    const klass = classifySdkToolName(toolName);

    if (klass.kind === 'disabled') {
      return { behavior: 'deny', message: 'tool disabled by policy' };
    }

    const id = idGen();
    const raw = await opts.client.call('tool.pre-call', {
      call: { id, name: klass.axName, input },
    });

    // The IpcClient already Zod-parses the response against
    // ToolPreCallResponseSchema. We re-assert the narrowed type here for
    // TypeScript's benefit — safeParse on the known-good value is cheap
    // and keeps this file from depending on how the client validates.
    const parsed = ToolPreCallResponseSchema.parse(raw) as ToolPreCallResponse;

    if (parsed.verdict === 'allow') {
      const maybeInput = parsed.modifiedCall?.input;
      return {
        behavior: 'allow',
        updatedInput:
          maybeInput !== undefined
            ? (maybeInput as Record<string, unknown>)
            : input,
      };
    }

    // verdict === 'reject'
    return { behavior: 'deny', message: parsed.reason };
  };
}
