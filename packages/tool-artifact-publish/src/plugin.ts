import {
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';
import { ARTIFACT_PUBLISH_DESCRIPTOR } from './descriptor.js';

const PLUGIN_NAME = '@ax/tool-artifact-publish';

/**
 * Phase 2 — host-side plugin that adds the `artifact_publish` descriptor
 * to the tool catalog. The executor that runs the tool's actual work
 * lives sandbox-side in `@ax/agent-claude-sdk-runner` (D1): only the
 * sandbox process has filesystem access to /agent at call time.
 *
 * This plugin therefore does NOT register `tool:execute:artifact_publish`.
 * Tool dispatch for sandbox-executed tools happens inside the runner
 * through its local-dispatcher; no IPC round-trip.
 */
export function createToolArtifactPublishPlugin(): Plugin {
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
      // bus.call still needs an AgentContext envelope. Synthesize a
      // minimal one — same pattern as test-host-tool.ts.
      const ctx: AgentContext = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });
      await bus.call<ToolDescriptor, { ok: true }>(
        'tool:register',
        ctx,
        ARTIFACT_PUBLISH_DESCRIPTOR,
      );
    },
  };
}
