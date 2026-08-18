// Runner-agnostic tool policy. Re-roots governed paths, then adjudicates the
// call against the host's `tool.pre-call` hook. The SDK's PreToolUse hook and
// the aisdk runner's per-tool `execute` wrapper are both thin adapters over
// this — one policy, two runners (see the 2026-08-18 design, §2 and §3).
//
// Fail-closed: an IPC failure denies, so a racing disconnection cannot
// bypass host subscribers.
import { randomUUID } from 'node:crypto';
import {
  ToolPreCallResponseSchema,
  type IpcClient,
  type ToolPreCallResponse,
} from '@ax/ipc-protocol';
import { resolveGovernedPaths } from './governed-paths.js';

export type PreToolVerdict =
  | { decision: 'deny'; reason: string }
  | { decision: 'allow'; updatedInput?: Record<string, unknown> };

export interface ToolPolicy {
  preToolUse(
    axToolName: string,
    toolInput: unknown,
    toolUseId: string | undefined,
  ): Promise<PreToolVerdict>;
}

export interface CreateToolPolicyOptions {
  client: IpcClient;
  /** The governed root (`/agent`) re-rooting targets. Never cwd. */
  workspaceRoot: string;
  /** Widen from the `.ax/uploads/` safety-net to the full validator policy. */
  broaden?: boolean;
  recognizedRoots?: readonly string[];
  idGen?: () => string;
}

export function createToolPolicy(opts: CreateToolPolicyOptions): ToolPolicy {
  const idGen = opts.idGen ?? ((): string => randomUUID());
  const broaden = opts.broaden ?? false;
  const recognizedRoots = opts.recognizedRoots ?? [];

  return {
    async preToolUse(axToolName, toolInput, toolUseId) {
      const resolved = resolveGovernedPaths(toolInput, opts.workspaceRoot, {
        broaden,
        recognizedRoots,
      });

      let parsed: ToolPreCallResponse;
      try {
        const raw = await opts.client.call('tool.pre-call', {
          call: {
            id: toolUseId ?? idGen(),
            name: axToolName,
            input: resolved.input,
          },
        });
        parsed = ToolPreCallResponseSchema.parse(raw) as ToolPreCallResponse;
      } catch (err) {
        return {
          decision: 'deny',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      if (parsed.verdict === 'reject') {
        return { decision: 'deny', reason: parsed.reason };
      }

      const hostModified =
        parsed.modifiedCall?.input !== undefined &&
        parsed.modifiedCall.input !== null &&
        typeof parsed.modifiedCall.input === 'object';
      if (hostModified) {
        return {
          decision: 'allow',
          updatedInput: parsed.modifiedCall!.input as Record<string, unknown>,
        };
      }
      if (resolved.changed) {
        return { decision: 'allow', updatedInput: resolved.input };
      }
      return { decision: 'allow' };
    },
  };
}
