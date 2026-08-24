import type { Plugin } from '@ax/core';
import { registerSearchCatalog } from './tools/search-catalog.js';
import { registerRequestCapability } from './tools/request-capability.js';
import {
  registerCapabilityFreshness,
  CAPABILITY_CAPTURE_HOOK,
  CAPABILITY_CHECK_HOOK,
} from './tools/capability-freshness.js';

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
      registers: [
        'tool:execute:search_catalog',
        'tool:execute:request_capability',
        // AW-7's freshness pair for `request_capability`. Unlike the CONSUMER
        // side in @ax/decisions — where the hook name is built from a recorded
        // call and no manifest can name it — a PRODUCER's two hook names are
        // fixed strings, so they are declared here like any other service. That
        // is also what makes the kernel's duplicate-service check able to catch
        // two plugins claiming the same tool's guard.
        CAPABILITY_CAPTURE_HOOK,
        CAPABILITY_CHECK_HOOK,
      ],
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
        // approval card. TASK-262 — the same resolve also folds that reach into
        // request_capability's freshness digest, so a connector re-pointed under a
        // stable id re-opens the decision. Both sites are hasService-guarded, so a
        // preset without @ax/connectors still boots.
        //
        // TASK-262 corrected this note: it used to promise the card fell back to
        // "the skill's own capability block". TASK-100 DELETED that block — a
        // skill's reach is now entirely its connectors' — so with no resolve hook
        // there is nothing left to gate and the card is skipped outright.
        {
          hook: 'connectors:resolve',
          degradation:
            'a requested skill surfaces no approval card at all (since TASK-100 a skill has no capability block of its own, so all of its reach is its connectors\'), and request_capability\'s freshness predicate covers the catalog entry alone — it still trips on an edited entry, but not on a connector re-pointed under a stable id',
        },
      ],
      subscribes: [],
    },
    async init({ bus }) {
      await registerSearchCatalog(bus);
      await registerRequestCapability(bus);
      // AW-7 — `request_capability` is held by the AW-3 rule table, replayed
      // host-side on approval, and therefore approvable hours after the human
      // was asked. This is the half that re-reads the catalog entry — and
      // (TASK-262) what its connectors reach — before the replay happens.
      registerCapabilityFreshness(bus);
    },
  };
}
