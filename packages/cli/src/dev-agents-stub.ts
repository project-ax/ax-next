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
   * Default agent id reported by the stub. AgentContext's agentId flows
   * through `agent:invoke` as-is; the stub echoes it back so reqId-based logs
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
  /**
   * Phase 2 — egress allowlist for the per-session credential-proxy.
   * Defaults to ['api.anthropic.com'] so the SDK runner can reach
   * Anthropic. Dev users opting into more (third-party MCP servers,
   * canary tools) extend this list explicitly.
   */
  allowedHosts?: readonly string[];
  /**
   * Phase 2 — credential refs the proxy resolves at session open.
   * Defaults to a single ANTHROPIC_API_KEY entry pointing at the
   * `anthropic-api` credential id; users seed it with
   * `ax-next credentials set anthropic-api` before the canary works.
   *
   * Phase 3 — to drive the OAuth rotation path, override with:
   *
   *   requiredCredentials: {
   *     CLAUDE_CODE_OAUTH_TOKEN: {
   *       ref: 'anthropic-personal',
   *       kind: 'anthropic-oauth',
   *     },
   *   }
   *
   * The orchestrator inspects `kind`; any non-`api-key` value flips the
   * session into per-turn rotation mode (proxy:rotate-session at
   * chat:turn-end). Seed the credential first via:
   *   `ax-next credentials login anthropic`.
   */
  requiredCredentials?: Readonly<Record<string, { ref: string; kind: string }>>;
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
  const model = cfg.model ?? 'claude-sonnet-4-6';
  // Phase 2 defaults — every CLI canary needs to reach api.anthropic.com
  // and inject ANTHROPIC_API_KEY from the local credentials store.
  const allowedHosts = [...(cfg.allowedHosts ?? ['api.anthropic.com'])];
  const requiredCredentials: Record<string, { ref: string; kind: string }> = {
    ...(cfg.requiredCredentials ?? {
      ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' },
    }),
  };

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
              allowedHosts: [...allowedHosts],
              requiredCredentials: { ...requiredCredentials },
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        },
      );
    },
  };
}
