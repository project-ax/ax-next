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
import { buildEgressBlockNote } from './egress-note.js';

export type PreToolVerdict =
  | { decision: 'deny'; reason: string }
  | { decision: 'allow'; updatedInput?: Record<string, unknown> }
  // The host recorded this call and a human must see it. NOT a deny: the
  // runner must surface `note` and end the turn, never retry or improvise a
  // different route to the same effect.
  | { decision: 'hold'; decisionId: string; note: string };

export interface ToolPolicy {
  preToolUse(
    axToolName: string,
    toolInput: unknown,
    toolUseId: string | undefined,
  ): Promise<PreToolVerdict>;
  postToolUse(
    axToolName: string,
    toolUseId: string | undefined,
    toolInput: unknown,
    toolOutput: unknown,
    isBuiltinTool: boolean,
  ): Promise<{ note?: string }>;
}

export interface CreateToolPolicyOptions {
  client: IpcClient;
  /** The governed root (`/agent`) re-rooting targets. Never cwd. */
  workspaceRoot: string;
  /** Widen from the `.ax/uploads/` safety-net to the full validator policy. */
  broaden?: boolean;
  recognizedRoots?: readonly string[];
  idGen?: () => string;
  /** Drain the hosts this session was allowlist-blocked on since the last call. */
  drainEgressBlocks?: () => Promise<string[]>;
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

      if (parsed.verdict === 'hold') {
        return {
          decision: 'hold',
          decisionId: parsed.decisionId,
          note: parsed.note,
        };
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

    async postToolUse(axToolName, toolUseId, toolInput, toolOutput, isBuiltinTool) {
      // Fire-and-forget. Failures here must not stall the turn loop; dropping
      // an audit event is recoverable, a hung turn is not.
      // The original (pre-split) hook did `toolUseID ?? ''` — no id generation
      // on the post-call path, unlike preToolUse's `?? idGen()`. Preserve that
      // coercion here so the wire payload is unchanged.
      void opts.client
        .event('event.tool-post-call', {
          call: { id: toolUseId ?? '', name: axToolName, input: toolInput },
          output: toolOutput,
        })
        .catch(() => {
          /* swallow — fire-and-forget */
        });

      // Bash is the one tool through which the agent initiates sandbox egress
      // (npx / curl / git / pip), so we drain its blocks right after it runs.
      // The proxy denies the CONNECT before the command returns, so by here
      // the block is already buffered. Gate on builtin-AND-Bash, not name
      // alone: classifySdkToolName strips the `mcp__<server>__` prefix before
      // this policy ever sees the name, so an MCP tool literally named `Bash`
      // would otherwise reach this drain too.
      if (
        opts.drainEgressBlocks === undefined ||
        !isBuiltinTool ||
        axToolName !== 'Bash'
      ) {
        return {};
      }
      let hosts: string[] = [];
      try {
        hosts = await opts.drainEgressBlocks();
      } catch {
        // A best-effort note must never break the turn loop — degrade to silent.
        hosts = [];
      }
      return hosts.length > 0 ? { note: buildEgressBlockNote(hosts) } : {};
    },
  };
}
