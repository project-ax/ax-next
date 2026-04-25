import type { Plugin } from '@ax/core';

// ---------------------------------------------------------------------------
// Dev-mode agents stub
//
// Week 9.5's chat-orchestrator hard-depends on `agents:resolve` — every chat
// goes through the ACL gate. The full @ax/agents plugin requires
// database-postgres and the multi-tenant preset (Task 16); the local CLI
// runs against sqlite.
//
// This plugin provides a single permissive answer: "yes, the resolved
// agent is the default dev agent, and its config is the system prompt /
// allowed tools / model the CLI was told to use." It exists so the local
// dev loop works the same way the production loop does (orchestrator →
// agents:resolve → sandbox:open-session) without forcing every dev to
// stand up postgres + admin endpoints.
//
// Limitations called out so a reader doesn't think this is the production
// answer:
//   * No ACL gate — every userId+agentId pair is accepted.
//   * No persistence — the agent config is config-time, not row-time.
//   * No multi-agent — there is exactly one agent in dev mode.
//
// The presence of this plugin is the OBSERVABLE signal that we're in dev
// mode; production presets register the real @ax/agents plugin and the
// kernel's "exactly one impl per service hook" rule rejects loading both
// at once. So rolling from dev to prod is "swap the registration"; you
// can't accidentally end up with two.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/cli/dev-agents-stub';

export interface DevAgentsStubConfig {
  /**
   * Default agent id reported by the stub. ChatContext's agentId flows
   * through `chat:run` as-is; the stub echoes it back so reqId-based logs
   * stay consistent with whatever the caller passed.
   */
  defaultAgentId?: string;
  /**
   * System prompt the runner sees via `session:get-config`. Empty string
   * is allowed but discouraged — the LLM behaves better with explicit
   * instructions even in dev.
   */
  systemPrompt?: string;
  /**
   * Allow-list of tool names the runner advertises. Defaults to a wildcard-
   * equivalent empty array which the dispatcher (Task 7) interprets as
   * "all native tools, no MCP filter."
   */
  allowedTools?: readonly string[];
  /**
   * MCP config ids — empty by default; in dev MCP runs without scoping.
   */
  mcpConfigIds?: readonly string[];
  /**
   * LLM model id. Defaults to claude-sonnet-4-7 to match the rest of the
   * dev defaults; pass the same value the LLM plugin was configured with.
   */
  model?: string;
}

export function createDevAgentsStubPlugin(
  cfg: DevAgentsStubConfig = {},
): Plugin {
  const defaultAgentId = cfg.defaultAgentId ?? 'dev';
  // Non-empty default so the session-store's validateOwner (which requires
  // a non-empty string) accepts the stub's payload. Production agents have
  // their own non-empty prompt; dev users override via cfg.systemPrompt.
  const systemPrompt = cfg.systemPrompt ?? 'You are a helpful assistant.';
  const allowedTools = [...(cfg.allowedTools ?? [])];
  const mcpConfigIds = [...(cfg.mcpConfigIds ?? [])];
  const model = cfg.model ?? 'claude-sonnet-4-7';

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['agents:resolve'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService(
        'agents:resolve',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const agentId = (input as { agentId?: string }).agentId ?? defaultAgentId;
          const userId = (input as { userId?: string }).userId ?? 'dev';
          return {
            agent: {
              id: agentId,
              ownerId: userId,
              ownerType: 'user' as const,
              visibility: 'personal' as const,
              displayName: 'Dev agent',
              systemPrompt,
              allowedTools,
              mcpConfigIds,
              model,
              workspaceRef: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        },
      );
    },
  };
}
