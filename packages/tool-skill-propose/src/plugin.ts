import {
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';
import { SKILL_PROPOSE_DESCRIPTOR } from './descriptor.js';

const PLUGIN_NAME = '@ax/tool-skill-propose';

/**
 * TASK-74 (out-of-git Part D / §D1) — host-side plugin that adds the
 * `skill_propose` descriptor to the tool catalog. The executor that runs the
 * tool's actual work lives sandbox-side in `@ax/agent-claude-sdk-runner` (mirror
 * of `artifact_publish`): only the sandbox process can read the draft dir
 * `<root>/.skill-draft/**` at call time (durable mount when wired, else ephemeral).
 *
 * This plugin therefore does NOT register `tool:execute:skill_propose`. Tool
 * dispatch for sandbox-executed tools happens inside the runner through its
 * local-dispatcher; the executor then forwards the validated bundle to the host
 * over the `skill.propose` IPC action.
 */
export function createToolSkillProposePlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['tool:register'],
      subscribes: [],
    },
    async init({ bus }) {
      // tool:register doesn't read ctx fields (pure registry write), but
      // bus.call still needs an AgentContext envelope. Synthesize a minimal one
      // — same pattern as @ax/tool-artifact-publish.
      const ctx: AgentContext = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });
      await bus.call<ToolDescriptor, { ok: true }>(
        'tool:register',
        ctx,
        SKILL_PROPOSE_DESCRIPTOR,
      );
    },
  };
}
