import type { Plugin } from '@ax/core';
import { registerSearchCatalog } from './tools/search-catalog.js';
import { registerRequestCapability } from './tools/request-capability.js';

const PLUGIN_NAME = '@ax/skill-broker';
const PLUGIN_VERSION = '0.0.0';

/**
 * @ax/skill-broker — the model-brokered surfacing spine (JIT, design §6A,
 * §11 component #1). Registers always-on host tools the agent calls to match
 * intent against the capability catalog. Built on the generic host-tool
 * surface (tool:register + tool:execute:${name}), like @ax/web-tools — NOT an
 * MCP server.
 */
export function createSkillBrokerPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: ['tool:execute:search_catalog', 'tool:execute:request_capability'],
      // Hard deps → init-ordering edges: the dispatcher (tool:register) and the
      // catalog owner (skills:search-catalog / skills:get) must init first.
      calls: ['tool:register', 'skills:search-catalog', 'skills:get'],
      subscribes: [],
    },
    async init({ bus }) {
      await registerSearchCatalog(bus);
      await registerRequestCapability(bus);
    },
  };
}
