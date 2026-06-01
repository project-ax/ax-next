import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type Plugin,
  type ToolCall,
  type ToolDescriptor,
} from '@ax/core';
import { CONNECTOR_PROPOSE_DESCRIPTOR, CONNECTOR_PROPOSE_TOOL_NAME } from './descriptor.js';

const PLUGIN_NAME = '@ax/tool-connector-propose';
const EXECUTE_HOOK = `tool:execute:${CONNECTOR_PROPOSE_TOOL_NAME}` as const;

// Re-validated independently at this trust boundary (I2/I5): the tool never
// trusts the model's connectorId/keyMode shape before handing the draft to the
// `connectors:install-authored` hook, which re-validates authoritatively. This is
// a coarse shape gate (a recoverable author error the model can fix), mirroring
// request_capability's SKILL_ID_RE check — NOT the full grammar (the hook owns
// that). The grammar mirror is loose-but-present so a blank/missing id fails here
// with a clear message instead of a generic hook reject.
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const KEY_MODES = new Set(['personal', 'workspace']);

// The mechanism-agnostic flat draft args the model proposes. Backing-mechanism
// vocabulary (transport/command/url) stays INSIDE each mcpServers spec — never a
// first-class field (design boundary review). Forwarded as-is to the hook, which
// assembles + validates the canonical Capabilities.
interface ConnectorProposeInput {
  connectorId: string;
  name: string;
  hosts: string[];
  slots: unknown[];
  packages?: unknown;
  mcpServers?: unknown[];
  usageNote?: string;
  keyMode: string;
}

interface ConnectorProposeOutput {
  connectorId: string;
  status: 'pending';
}

// Structural-validation PluginError codes the connectors:install-authored hook
// throws for a malformed draft are all `invalid-*` (invalid-payload from the
// connector-id / name / slot / keyMode validators). These are RECOVERABLE author
// errors — surface a fixed, model-actionable message so the agent re-drafts. We
// never echo the plugin-supplied message (I9: plugin codes/messages are
// forgeable and could carry host-side detail).
function isStructuralRejectCode(code: string): boolean {
  return code.startsWith('invalid-');
}

function rejectInput(message: string): never {
  throw new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    hookName: EXECUTE_HOOK,
    message,
  });
}

/**
 * Light shape gate over the untrusted model input. Pulls the (already host-
 * trusted) scope from ctx; the model never supplies (owner, agent). Returns the
 * normalized draft to forward. Deep validation (host grammar, slot shape,
 * capability assembly) is the HOOK's job — this only catches obviously-missing
 * fields so the model gets a clear error instead of a generic hook reject.
 */
function normalizeInput(raw: unknown): ConnectorProposeInput {
  const input = (raw ?? {}) as Record<string, unknown>;

  const connectorId = typeof input.connectorId === 'string' ? input.connectorId.trim() : '';
  if (connectorId.length === 0 || !CONNECTOR_ID_RE.test(connectorId)) {
    rejectInput(
      'connector_propose requires a lowercase "connectorId" matching /^[a-z0-9][a-z0-9_-]*/',
    );
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) {
    rejectInput('connector_propose requires a non-empty "name"');
  }

  const keyMode = typeof input.keyMode === 'string' ? input.keyMode.trim() : '';
  if (!KEY_MODES.has(keyMode)) {
    rejectInput('connector_propose requires "keyMode" to be "personal" or "workspace"');
  }

  // hosts / slots / packages / mcpServers / usageNote are optional + forwarded
  // as-is for the hook to validate. Coerce only the obvious container shapes so a
  // missing field becomes an empty default rather than a type error downstream.
  const hosts = Array.isArray(input.hosts) ? (input.hosts as string[]) : [];
  const slots = Array.isArray(input.slots) ? (input.slots as unknown[]) : [];

  const out: ConnectorProposeInput = { connectorId, name, hosts, slots, keyMode };
  if (input.packages !== undefined) out.packages = input.packages;
  if (Array.isArray(input.mcpServers)) out.mcpServers = input.mcpServers as unknown[];
  if (typeof input.usageNote === 'string') out.usageNote = input.usageNote;
  return out;
}

/**
 * TASK-95 (connectors-first-class, design Phase 2) — host-side plugin that adds
 * the `connector_propose` tool. Unlike `@ax/tool-skill-propose` (which registers
 * only a descriptor; a sandbox executor reads the draft dir), the connector
 * tool's args are pure structured JSON, so the executor runs HOST-side — mirror
 * of `@ax/skill-broker`'s `request_capability`. It reads the (user, agent) scope
 * from the trusted tool ctx (the IPC server stamped it from the runner's bound
 * session) and calls the `connectors:install-authored` hook (TASK-94), which
 * persists a PENDING draft (zero reach) until a human approves the orchestrator's
 * one approval card.
 *
 * I2: no @ax/connectors import — the hook is reached only over the bus. The
 * `connectors:install-authored` dep is a HARD call (the tool is pointless without
 * it); the preset only loads this plugin where @ax/connectors is loaded (k8s).
 */
export function createToolConnectorProposePlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [EXECUTE_HOOK],
      // Hard deps → init-ordering edges: the tool dispatcher (tool:register) and
      // the connectors store (connectors:install-authored) must init first.
      calls: ['tool:register', 'connectors:install-authored'],
      subscribes: [],
    },
    async init({ bus }) {
      // tool:register doesn't read ctx fields (pure registry write), but bus.call
      // still needs an AgentContext envelope — synthesize a minimal one (same
      // pattern as @ax/tool-skill-propose / @ax/skill-broker).
      const initCtx: AgentContext = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });
      await bus.call<ToolDescriptor, { ok: true }>(
        'tool:register',
        initCtx,
        CONNECTOR_PROPOSE_DESCRIPTOR,
      );

      bus.registerService<{ input?: unknown } & Partial<ToolCall>, ConnectorProposeOutput>(
        EXECUTE_HOOK,
        PLUGIN_NAME,
        async (toolCtx, call) => {
          // An unbound session carries the IPC server's placeholder owner
          // (`ipc-server`, stamped when the bearer token resolved to no
          // user+agent — canary / pre-bind). It must NOT be able to author a
          // connector into the placeholder namespace; reject cleanly, exactly as
          // the skill.propose IPC handler does for the same case. Checked BEFORE
          // input normalization so a malformed draft on an unbound session still
          // fails on the scope, not a field error.
          if (toolCtx.userId === 'ipc-server' || toolCtx.agentId === 'ipc-server') {
            rejectInput('connector_propose: session is not bound to a user+agent');
          }

          const draft = normalizeInput(call?.input);

          // Scope is host-derived (toolCtx), NEVER from the model input: a runner
          // can't author a connector into a foreign agent's namespace. Same
          // posture as request_capability (reads toolCtx.userId) + the
          // skill.propose IPC handler (derives owner/agent from the session row).
          try {
            const out = await bus.call<
              {
                ownerUserId: string;
                agentId: string;
                connectorId: string;
                name: string;
                hosts: string[];
                slots: unknown[];
                packages?: unknown;
                mcpServers?: unknown[];
                usageNote?: string;
                keyMode: string;
              },
              ConnectorProposeOutput
            >('connectors:install-authored', toolCtx, {
              ownerUserId: toolCtx.userId,
              agentId: toolCtx.agentId,
              connectorId: draft.connectorId,
              name: draft.name,
              hosts: draft.hosts,
              slots: draft.slots,
              ...(draft.packages !== undefined ? { packages: draft.packages } : {}),
              ...(draft.mcpServers !== undefined ? { mcpServers: draft.mcpServers } : {}),
              ...(draft.usageNote !== undefined ? { usageNote: draft.usageNote } : {}),
              keyMode: draft.keyMode,
            });
            return { connectorId: out.connectorId, status: out.status };
          } catch (err) {
            // Recoverable structural author error → a fixed, model-safe message
            // (no plugin-message echo, I9) so the agent re-drafts. Other codes
            // (auth/forbidden/internal) propagate unchanged for the host-tool
            // dispatcher to redact via mapPluginError.
            if (err instanceof PluginError && isStructuralRejectCode(err.code)) {
              rejectInput('the connector draft is invalid — fix the fields and propose again');
            }
            throw err;
          }
        },
        { timeoutMs: 30_000 },
      );
    },
  };
}
