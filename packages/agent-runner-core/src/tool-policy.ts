// Runner-agnostic tool policy. Re-roots governed paths, then adjudicates the
// call against the host's `tool.pre-call` hook. The SDK's PreToolUse hook and
// the aisdk runner's per-tool `execute` wrapper are both thin adapters over
// this — one policy, two runners (see the 2026-08-18 design, §2 and §3).
//
// Fail-closed: an IPC failure denies, so a racing disconnection cannot
// bypass host subscribers. A fail-closed deny is tagged `cause:'unavailable'`
// so the adapters can say the gate broke instead of claiming a rule blocked
// the call — see `DenyCause`.
import { randomUUID } from 'node:crypto';
import {
  ToolPreCallResponseSchema,
  type IpcClient,
  type ToolPreCallResponse,
} from '@ax/ipc-protocol';
import { resolveGovernedPaths } from './governed-paths.js';
import { buildEgressBlockNote } from './egress-note.js';

/**
 * WHY a call was denied — and therefore what, if anything, we are entitled to
 * tell the model about retrying it.
 *
 * `policy`      — a host subscriber adjudicated this call and said no. A retry
 *                 of the same call reaches the same subscriber and gets the
 *                 same answer, so "retrying will be denied again" is something
 *                 we actually know.
 * `unavailable` — the gate never adjudicated anything. The `tool.pre-call` IPC
 *                 timed out, was refused, or came back unparseable, and we
 *                 failed closed. NOTHING was decided about this call, so any
 *                 claim about what a retry would do is invented.
 *
 * Required rather than optional-with-a-default on purpose: a default would let
 * a deny path added later omit the field and silently inherit the `policy`
 * prose, which is exactly the defect this discriminator exists to prevent.
 */
export type DenyCause = 'policy' | 'unavailable';

/**
 * What the model — and, through the tool result, the person — is told when the
 * pre-call gate could not be reached.
 *
 * It deliberately carries no internal detail. The raw `Error.message` on this
 * path is whatever the IPC client happened to produce (`timeout`,
 * `connect failed: ECONNREFUSED`, a Zod dump, a Node errno), and all of it
 * used to land verbatim in the model's context AND in the durable transcript a
 * non-technical person can open. A message shaped by an internal error is not
 * a message we authored, so we do not ship it as one. The operator gets the
 * real error through `warn` instead.
 *
 * Modelled on `GATE_FAILURE_SENTENCE` in `@ax/decisions` (the host-side twin of
 * this situation), and deliberately a copy rather than an import: this package
 * is runner-side and does not depend on that host plugin.
 */
const GATE_UNREACHABLE_REASON = 'the approval check could not be reached';

export type PreToolVerdict =
  | { decision: 'deny'; reason: string; cause: DenyCause }
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
  /**
   * Where an operator hears about a failure the model is deliberately NOT told
   * the details of. Defaults to stderr, which is the pod log (the
   * `materialize-uploads.ts` convention). Before this existed the fail-closed
   * error was logged nowhere at all — it lived only in the model's context
   * window, and stripping it from there would have destroyed it outright.
   */
  warn?: (msg: string) => void;
}

export function createToolPolicy(opts: CreateToolPolicyOptions): ToolPolicy {
  const idGen = opts.idGen ?? ((): string => randomUUID());
  const broaden = opts.broaden ?? false;
  const recognizedRoots = opts.recognizedRoots ?? [];
  const warn =
    opts.warn ??
    ((m: string): void => {
      process.stderr.write(m + '\n');
    });

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
        // Defence in depth — and the narrowing from `call()`'s `unknown`. The
        // real IpcClient already validated this body against the SAME schema
        // (`RESPONSE_SCHEMAS['tool.pre-call']` → `parseSuccessBody`, see
        // ipc-protocol/src/ipc-client.ts) before `call()` returned, so on the
        // production wire this cannot throw. It stays INSIDE the try on
        // purpose: a client that does not validate (a test double, a future
        // transport) must still fail CLOSED here rather than reject out of
        // `preToolUse` — the claude-sdk adapter's hook has no catch of its own,
        // and a throw escaping it is a fail-OPEN risk. `warn` below is what
        // keeps a schema drift audible instead of a mystery denial.
        parsed = ToolPreCallResponseSchema.parse(raw) as ToolPreCallResponse;
      } catch (err) {
        // Fail closed, and be honest about what happened. The gate did not
        // adjudicate this call — it never ran — so the verdict says
        // `unavailable`, and the two runner adapters use that to avoid telling
        // the model a retry is pointless when we have no idea whether it is.
        warn(
          `runner: tool.pre-call failed for '${axToolName}'; failing closed: ` +
            (err instanceof Error ? (err.stack ?? String(err)) : String(err)),
        );
        return {
          decision: 'deny',
          reason: GATE_UNREACHABLE_REASON,
          cause: 'unavailable',
        };
      }

      if (parsed.verdict === 'reject') {
        return { decision: 'deny', reason: parsed.reason, cause: 'policy' };
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
