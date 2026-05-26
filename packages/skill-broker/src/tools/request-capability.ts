import { makeAgentContext, PluginError, type HookBus, type ToolDescriptor } from '@ax/core';

const PLUGIN_NAME = '@ax/skill-broker';
// Re-validated independently at this trust boundary (I2/I5) — the broker never
// trusts the model's skillId shape before handing it to skills:get.
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const REQUEST_CAPABILITY_DESCRIPTOR: ToolDescriptor = {
  name: 'request_capability',
  description:
    'Request that a catalog skill be connected for the user. Pass a skill id from ' +
    'search_catalog results. The user will be asked to approve the hosts it reaches and ' +
    'enter any required keys. Do not narrate this step or restate any keys — the approval ' +
    'surface handles it. Once the user approves, the conversation will continue ' +
    'automatically; do not ask the user to repeat their request.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The catalog skill id to request, taken from search_catalog results.',
      },
    },
    required: ['skillId'],
  },
};

interface RequestCapabilityResult {
  status: 'requested' | 'not-found';
  skillId: string;
}

// Mirrors the subset of @ax/skills' SkillDetail the broker reads. Re-declared
// locally — the broker reaches the catalog only through the bus (I2). Kept
// structurally in sync with SkillDetail.capabilities by the broker tests.
interface CatalogSkillDetail {
  id: string;
  description: string;
  capabilities: {
    allowedHosts: string[];
    credentials: { slot: string; kind: 'api-key' }[];
  };
}

// The bundled approval card payload (design §11.3, decision #6). Carries only
// public manifest data — never a secret (the card's key field posts straight to
// the host credential store, §10). The matching SSE-frame + render side
// re-declares this shape in @ax/channel-web (I2 — no shared import).
//
// `kind: 'skill'` discriminates this from the reactive egress-wall's
// `kind: 'host'` variant (TASK-37, fired by @ax/chat-orchestrator). The
// `chat:permission-request` payload is a union on `kind`; this producer always
// fires the skill variant.
interface PermissionRequestEvent {
  kind: 'skill';
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
}

export async function registerRequestCapability(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', initCtx, REQUEST_CAPABILITY_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, RequestCapabilityResult>(
    'tool:execute:request_capability',
    PLUGIN_NAME,
    async (toolCtx, call) => {
      const input = (call?.input ?? {}) as { skillId?: unknown };
      const skillId = typeof input.skillId === 'string' ? input.skillId.trim() : '';
      if (skillId.length === 0 || !SKILL_ID_RE.test(skillId)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:request_capability',
          message: 'request_capability requires a valid catalog "skillId"',
        });
      }

      // Validate the id resolves in the GLOBAL catalog. skills:get throws
      // skill-not-found when absent — translate to a structured result the
      // model can act on rather than surfacing a tool error.
      let detail: CatalogSkillDetail;
      try {
        detail = await bus.call<{ skillId: string; scope: 'global' }, CatalogSkillDetail>(
          'skills:get',
          toolCtx,
          { skillId, scope: 'global' },
        );
      } catch (err) {
        if (err instanceof PluginError && err.code === 'skill-not-found') {
          return { status: 'not-found', skillId };
        }
        throw err;
      }

      // Surface the ONE bundled approval card (design §11.3, decision #6) — the
      // open-mode security boundary. Public manifest data only: hostnames + slot
      // NAMES (never values). request_capability still returns the minimum to the
      // model (it must NOT narrate hosts/keys; §7). Match key is the conversation
      // (toolCtx carries the real conversationId; the runner-driven IPC ctx has a
      // fresh reqId — see ipc-server/listener.ts). Firing a subscriber hook needs
      // no manifest declaration (the orchestrator fires chat:turn-error undeclared).
      //
      // HALF-WIRED (TASK-35): the card surfaces + collects the user's key into
      // their credential store, but does NOT yet widen the host allowlist
      // (TASK-37 proxy:add-host), attach the skill, or pause -> re-spawn ->
      // resume the turn (TASK-36, using TASK-33's skills:attach-for-user).
      const card: PermissionRequestEvent = {
        kind: 'skill',
        skillId,
        description: detail.description,
        hosts: detail.capabilities.allowedHosts,
        slots: detail.capabilities.credentials.map((c) => ({
          slot: c.slot,
          kind: 'api-key' as const,
        })),
      };
      await bus.fire('chat:permission-request', toolCtx, card);

      return { status: 'requested', skillId };
    },
    { timeoutMs: 30_000 },
  );
}
