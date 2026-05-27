import type { Plugin } from '@ax/core';
import { registerSearchCatalog } from './tools/search-catalog.js';
import { registerRequestCapability } from './tools/request-capability.js';
import { registerInstallAuthoredSkill } from './tools/install-authored-skill.js';

const PLUGIN_NAME = '@ax/skill-broker';
const PLUGIN_VERSION = '0.0.0';

/**
 * @ax/skill-broker construction config.
 */
export interface SkillBrokerConfig {
  /**
   * Open mode (JIT design decision #5, §10). When `true`, the deployment
   * permits the agent to author + install user-scoped skills on the fly
   * (gated by the same host/credential approval card). OFF by default —
   * agent-authoring is opt-in per deployment.
   *
   * Plumbed from the `allow_user_installed_skills` deployment flag
   * (TASK-38). HALF-WIRED in TASK-38: the broker stores + exposes this but
   * nothing reads it to change behavior yet. TASK-39 (open-mode agent-
   * authored skills, flow C) closes the window by registering the gated
   * authoring tool that reads it.
   */
  allowUserInstalledSkills?: boolean;
}

/**
 * The broker plugin, widened with the resolved open-mode gate so the preset
 * wiring test (and TASK-39's authoring path) can read the effective value
 * without calling `init()`. Read-only — config is fixed at construction.
 */
export interface SkillBrokerPlugin extends Plugin {
  readonly allowUserInstalledSkills: boolean;
}

/**
 * @ax/skill-broker — the model-brokered surfacing spine (JIT, design §6A,
 * §11 component #1). Registers always-on host tools the agent calls to match
 * intent against the capability catalog. Built on the generic host-tool
 * surface (tool:register + tool:execute:${name}), like @ax/web-tools — NOT an
 * MCP server.
 */
export function createSkillBrokerPlugin(
  config: SkillBrokerConfig = {},
): SkillBrokerPlugin {
  const allowUserInstalledSkills = config.allowUserInstalledSkills ?? false;
  return {
    allowUserInstalledSkills,
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [
        'tool:execute:search_catalog',
        'tool:execute:request_capability',
        // Open mode (TASK-39): the gated authoring tool exists ONLY when the
        // deployment enabled allow_user_installed_skills. Conditional
        // registration closes TASK-38's "same tools in both modes" pin.
        ...(allowUserInstalledSkills
          ? (['tool:execute:install_authored_skill'] as const)
          : []),
      ],
      // Hard deps → init-ordering edges: the dispatcher (tool:register) and the
      // catalog owner (skills:search-catalog / skills:get) must init first.
      calls: ['tool:register', 'skills:search-catalog', 'skills:get'],
      // request_capability does a metadata-only vault lookup (credentials:list,
      // user scope) so the approval card can offer "use your existing key" for an
      // account-tagged slot (JIT P2). hasService-guarded + best-effort, so a
      // credential-less preset degrades to always-prompt — optional, not a hard
      // boot dep. The authoring tool calls agents:install-authored-skill — only
      // in open mode, also hasService-guarded + surfaces a tool error if absent.
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
        ...(allowUserInstalledSkills
          ? [
              {
                hook: 'agents:install-authored-skill',
                degradation:
                  'open-mode authoring is unavailable; the agent cannot install user-scoped skills',
              },
            ]
          : []),
      ],
      subscribes: [],
    },
    async init({ bus }) {
      await registerSearchCatalog(bus);
      await registerRequestCapability(bus);
      if (allowUserInstalledSkills) {
        await registerInstallAuthoredSkill(bus);
      }
    },
  };
}
