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
    'surface handles it.',
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
      try {
        await bus.call('skills:get', toolCtx, { skillId, scope: 'global' });
      } catch (err) {
        if (err instanceof PluginError && err.code === 'skill-not-found') {
          return { status: 'not-found', skillId };
        }
        throw err;
      }

      // HALF-WIRED (TASK-34): the catalog skill exists. Nothing yet consumes
      // this to surface an approval card (TASK-35) or to pause -> re-spawn ->
      // resume and install via the per-user attach layer (TASK-36, using
      // TASK-33's skills:attach-for-user). We return a structured ack only.
      return { status: 'requested', skillId };
    },
    { timeoutMs: 30_000 },
  );
}
