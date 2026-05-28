import { PluginError, type Plugin, type ToolDescriptor } from '@ax/core';
import { z, type ZodType } from 'zod';
import { ToolCatalog } from './catalog.js';
import { filterByAgentScope, type AgentToolScope } from './scope.js';

const PLUGIN_NAME = '@ax/tool-dispatcher';

// ---------------------------------------------------------------------------
// Runtime `returns` contracts for the dispatcher's two data hooks (ARCH-13).
//
// `tool:list` is the single source of truth for the agent runtime's catalog
// (I4), so a malformed descriptor flowing out would mis-shape what the model
// can call. The descriptor schema mirrors @ax/core's `ToolDescriptor` interface
// (and stays in lockstep with @ax/ipc-protocol's `ToolDescriptorSchema`, the
// cross-boundary wire shape — see the note on `ToolDescriptor` in core/types).
// `inputSchema` stays an opaque JSON-Schema record (no zod-version coupling).
// The dynamic `tool:execute:${name}` hooks return `{ output: unknown }` and are
// deliberately left unvalidated — the payload is opaque tool output.
// ---------------------------------------------------------------------------
// NOTE: this is a return-validation schema for the `tool:list` SERVICE hook,
// and it must stay field-compatible with the `ToolDescriptor` type in
// `@ax/core` and the wire `ToolDescriptorSchema` in `@ax/ipc-protocol`. A
// `z.object` strips keys it doesn't declare, so any ToolDescriptor field
// omitted here is silently dropped from `tool:list` output BEFORE it reaches
// the IPC wire — which is exactly how `flushWorkspaceBeforeCall` got dropped
// (BUG-W2: the runner never saw the flag, so the pre-call workspace flush
// never fired). When you add a ToolDescriptor field, add it in all three
// places.
const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()),
  executesIn: z.union([z.literal('sandbox'), z.literal('host')]),
  flushWorkspaceBeforeCall: z.boolean().optional(),
});

export const ToolRegisterOutputSchema = z.object({
  ok: z.literal(true),
}) as unknown as ZodType<{ ok: true }>;

export const ToolListOutputSchema = z.object({
  tools: z.array(ToolDescriptorSchema),
}) as unknown as ZodType<{ tools: ToolDescriptor[] }>;

/**
 * Tool dispatcher — owns the single source of truth for the tool catalog
 * (invariant I4). Tool-provider plugins declare their tools by calling
 * `tool:register` during their own `init()`. The agent runtime reads the
 * catalog via `tool:list` (which seals it on first call, so all
 * registrations must complete before any list query).
 *
 * The dispatcher does NOT execute tools. After 6.5a the shape is:
 *  - `executesIn: 'sandbox'` tools are dispatched inside the sandbox by
 *    `@ax/agent-claude-sdk-runner`'s local dispatcher.
 *  - `executesIn: 'host'` tools (none in 6.5a) round-trip through the
 *    `tool.execute-host` IPC action and land on whichever plugin
 *    registered `tool:execute:${name}` on the host.
 *
 * So there is no `tool:execute` umbrella anymore — the Week 4-6 fan-out
 * service has been retired along with its caller.
 *
 * Week 9.5: when `session:get-config` is registered (multi-tenant
 * configurations), `tool:list` filters its output by the calling
 * session's frozen `agentConfig.allowedTools` + `mcpConfigIds`. The
 * catalog itself stays global; the filter is applied at the boundary so
 * `mcp-client` and tool plugins remain tenant-blind. System / boot-time
 * contexts (no `session:get-config` registered, or the call rejects with
 * `unknown-session` / `owner-missing`) get the unfiltered list — by
 * design, since those callers have no agent identity to scope against.
 */
// Reasons we treat as "no agent on this ctx" and pass the unfiltered
// catalog through. Anything else (network errors, type errors, schema
// drift) bubbles as a real failure — silently passing through on those
// would be a security regression.
const PASS_THROUGH_REJECT_CODES = new Set(['unknown-session', 'owner-missing']);

interface SessionGetConfigOutput {
  userId: string;
  agentId: string;
  agentConfig: {
    systemPrompt: string;
    allowedTools: string[];
    mcpConfigIds: string[];
    model: string;
  };
}

export function createToolDispatcherPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['tool:register', 'tool:list'],
      // Week 9.5: tool:list looks up the calling session's frozen
      // agent config (`session:get-config`) to scope the returned
      // catalog. The dependency is intentionally NOT listed in `calls`
      // because it is SOFT — when session:get-config isn't registered
      // (test harness, boot-time, single-tenant preset), the filter is
      // bypassed and the full catalog is returned. Listing it under
      // `calls` would force every preset that wires the dispatcher to
      // also wire session-postgres, breaking the host-tool test harness
      // and any future single-tenant configurations.
      //
      // Soft-dependency lookup uses bus.hasService at call time; see
      // the tool:list handler below for the contract and graceful-
      // fallback semantics.
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      const catalog = new ToolCatalog();

      bus.registerService<ToolDescriptor, { ok: true }>(
        'tool:register',
        PLUGIN_NAME,
        async (_ctx, input) => {
          catalog.register(input);
          return { ok: true };
        },
        { returns: ToolRegisterOutputSchema },
      );

      bus.registerService<Record<string, never>, { tools: ToolDescriptor[] }>(
        'tool:list',
        PLUGIN_NAME,
        async (ctx) => {
          const all = catalog.list();
          // Soft dependency: if no plugin registered session:get-config
          // (boot-time, tests, single-tenant preset), pass everything
          // through. The agent runtime in those contexts has no per-
          // agent allow-list to consult anyway.
          if (!bus.hasService('session:get-config')) {
            return { tools: all };
          }
          let cfg: SessionGetConfigOutput;
          try {
            cfg = await bus.call<Record<string, never>, SessionGetConfigOutput>(
              'session:get-config',
              ctx,
              {},
            );
          } catch (err) {
            // owner-missing / unknown-session — pre-9.5 sessions or
            // contexts without an authenticated agent. Pass through.
            if (
              err instanceof PluginError &&
              PASS_THROUGH_REJECT_CODES.has(err.code)
            ) {
              return { tools: all };
            }
            // Any other failure is a real bug; let it surface.
            throw err;
          }
          const scope: AgentToolScope = {
            allowedTools: cfg.agentConfig.allowedTools,
            mcpConfigIds: cfg.agentConfig.mcpConfigIds,
          };
          return { tools: filterByAgentScope(all, scope) };
        },
        { returns: ToolListOutputSchema },
      );
    },
  };
}
