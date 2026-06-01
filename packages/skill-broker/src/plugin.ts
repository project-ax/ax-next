import type { Plugin } from '@ax/core';
import { registerSearchCatalog } from './tools/search-catalog.js';
import { registerRequestCapability } from './tools/request-capability.js';

const PLUGIN_NAME = '@ax/skill-broker';
const PLUGIN_VERSION = '0.0.0';

/**
 * @ax/skill-broker construction config. Currently empty — agent-authored
 * skills are now discovered via the read-only host projection
 * (`agents:resolve-authored-skills`, unioned by the orchestrator), so there
 * is no open-mode install tool to gate.
 */
export type SkillBrokerConfig = Record<string, never>;

/**
 * @ax/skill-broker — the model-brokered surfacing spine (JIT, design §6A,
 * §11 component #1). Registers always-on host tools the agent calls to match
 * intent against the capability catalog. Built on the generic host-tool
 * surface (tool:register + tool:execute:${name}), like @ax/web-tools — NOT an
 * MCP server.
 */
export function createSkillBrokerPlugin(_config: SkillBrokerConfig = {}): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: ['tool:execute:search_catalog', 'tool:execute:request_capability'],
      // Hard deps → init-ordering edges: the dispatcher (tool:register) and the
      // catalog owner (skills:search-catalog / skills:get) must init first.
      calls: ['tool:register', 'skills:search-catalog', 'skills:get'],
      // request_capability does a metadata-only vault lookup (credentials:list,
      // user scope) so the approval card can offer "use your existing key" for an
      // account-tagged slot (JIT P2). hasService-guarded + best-effort, so a
      // credential-less preset degrades to always-prompt — optional, not a hard
      // boot dep.
      optionalCalls: [
        {
          hook: 'credentials:list',
          degradation:
            'the approval card cannot offer "use your existing key"; every credential slot is always prompted',
        },
        // Cold-start admit-queue trigger (TASK-53, design §13): on a search/request
        // MISS the broker files a "a user needed X" request for the admin to source.
        // hasService-guarded + best-effort, so a catalog-less/queue-less preset just
        // returns the miss to the model — optional, not a hard boot dep.
        {
          hook: 'catalog:submit',
          degradation:
            'an unmet-capability need is not filed to the admin admit queue; the miss is still returned to the model as not-found/empty',
        },
        // TASK-111 — when a requested catalog skill references connectors[], the
        // broker resolves each via connectors:resolve and folds its reach into the
        // approval card. hasService-guarded + best-effort, so a preset without
        // @ax/connectors degrades to the skill's own capability block on the card.
        {
          hook: 'connectors:resolve',
          degradation:
            "the approval card shows only the skill's own capability block; a referenced connector's hosts/keys are not folded in",
        },
      ],
      subscribes: [],
    },
    async init({ bus }) {
      await registerSearchCatalog(bus);
      await registerRequestCapability(bus);
    },
  };
}
