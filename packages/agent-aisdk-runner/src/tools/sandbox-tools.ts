// ---------------------------------------------------------------------------
// Sandbox tools: `ai@7` `Tool` entries for every catalog descriptor whose
// `executesIn` is `'sandbox'`. The counterpart to
// `packages/agent-claude-sdk-runner/src/sandbox-mcp-server.ts`, minus the MCP
// wrapping (I₄) — see `host-tools.ts`'s file-level comment for why that
// wrapping has no counterpart on this runner.
//
// Dispatch is fundamentally different from `host-tools.ts`: in-process via
// the runner's `LocalDispatcher` (a name → executor map registered at
// startup) rather than an IPC round trip. Keeping the two dispatch paths in
// separate files makes "where does this tool actually run" one grep away.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { jsonSchema, tool, type JSONSchema7, type Tool } from 'ai';
import type { ToolDescriptor } from '@ax/ipc-protocol';
import type { LocalDispatcher, ToolPolicy } from '@ax/agent-runner-core';
import { wrapWithPolicy } from './policy-wrap.js';

export interface BuildSandboxToolsOptions {
  policy: ToolPolicy;
  dispatcher: LocalDispatcher;
  /** Full tool catalog from `tool.list`. We filter to executesIn:'sandbox'. */
  tools: ToolDescriptor[];
  /** Test seam: override the per-call id generator. */
  idGen?: () => string;
}

/**
 * Render a tool output as the string `ai@7`'s `execute` must return. String
 * outputs pass through verbatim; anything else is JSON-stringified.
 * `JSON.stringify(undefined) === undefined`, so a `undefined` executor
 * result (or anything else `JSON.stringify` collapses to `undefined` —
 * functions, symbols) is coerced with `String()` so we never hand back a
 * non-string, which `ai@7`'s tool-result shape requires.
 */
function renderOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  const json = JSON.stringify(output);
  return json ?? String(output);
}

/**
 * Build the `ai@7` tool entries for every sandbox-executed tool in the
 * catalog, keyed by tool name. Every `execute` is policy-wrapped
 * (`wrapWithPolicy`) with `isBuiltin: false` — catalog tools are never
 * builtins, even one that happens to share a name with a builtin (I₁).
 */
export function buildSandboxTools(
  opts: BuildSandboxToolsOptions,
): Record<string, Tool> {
  const { policy, dispatcher, tools, idGen = () => randomUUID() } = opts;
  const sandboxTools = tools.filter((t) => t.executesIn === 'sandbox');

  const entries: Record<string, Tool> = {};
  for (const descriptor of sandboxTools) {
    entries[descriptor.name] = tool({
      description: descriptor.description ?? '',
      inputSchema: jsonSchema(descriptor.inputSchema as JSONSchema7),
      execute: wrapWithPolicy(
        { policy, name: descriptor.name, isBuiltin: false },
        async (input) => {
          // A dispatcher failure (unregistered tool, or the executor
          // itself throwing) propagates as a throw — `LocalDispatcher.
          // execute` already wraps it with the tool name via `cause`. We
          // let it through unmodified rather than catching it here: this
          // is the same "let it throw" contract host-tools.ts follows for
          // IPC failures (constraint 5 of the port brief) — `wrapWithPolicy`
          // fires the post-call audit event before re-throwing.
          const out = await dispatcher.execute({
            id: idGen(),
            name: descriptor.name,
            input,
          });
          return renderOutput(out);
        },
      ),
    });
  }
  return entries;
}
