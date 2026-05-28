import { makeAgentContext, PluginError, type HookBus, type ToolDescriptor } from '@ax/core';

const PLUGIN_NAME = '@ax/skill-broker';

// Re-validated independently at this trust boundary (I2/I5) — never trust the
// model's id/host/slot shapes. skills:upsert's parseSkillManifest is the
// downstream authority (invalid-host / invalid-slot); these are an early,
// friendly tool-level filter that MATCHES that authority's grammar so a slot
// the model proposes isn't quietly dropped here and then rejected there.
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?$/i;
// SCREAMING_SNAKE, matching parseSkillManifest's `capabilities.credentials`
// slot grammar (/^[A-Z][A-Z0-9_]{0,63}$/). A lowercase slot the upsert would
// reject is filtered out here so the agent gets a clean card, not an upsert
// error referencing a slot it never sees.
const SLOT_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Package name regexes — copied verbatim from skills-parser/src/manifest.ts
// (parsePackagesCapability). That function is the downstream AUTHORITY; this
// is the early trust-boundary filter that must MATCH it so a name the model
// proposes isn't silently dropped here and then rejected there.
//   npm: optional @scope/ prefix, lowercase only (PEP 503 does NOT apply here).
//   pypi: PEP 503-ish — MIXED case allowed, NO scope/slash.
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PACKAGE_NAME_LEN_MAX = 214; // npm hard limit; generous for pypi
const PACKAGES_PER_ECOSYSTEM_MAX = 32;

export const INSTALL_AUTHORED_SKILL_DESCRIPTOR: ToolDescriptor = {
  name: 'install_authored_skill',
  description:
    'Install a skill you authored in this workspace so the user can approve and use it. ' +
    'First write the skill to .ax/skills/<id>/SKILL.md (plus any helper files under that ' +
    'directory), then call this with that id and the hosts + credential slot NAMES the skill ' +
    'needs (slot names are SCREAMING_SNAKE, e.g. API_KEY). The user is shown one approval card ' +
    'listing exactly those hosts/keys before anything runs — do not narrate this step or ' +
    'restate any keys. Once the user approves, the conversation continues automatically; do ' +
    'not ask the user to repeat their request. ' +
    'If the skill installs npm or PyPI packages at runtime (via npx/uvx/pip), declare them ' +
    'here in the packages argument (npm and/or pypi arrays) — never in the SKILL.md frontmatter. ' +
    'The user sees and approves all declared registry egress on the same card.',
  executesIn: 'host',
  // The host handler reads the just-authored `.ax/skills/<id>/` bundle from the
  // workspace. Under runner-owned sessions the host only sees the committed +
  // pushed workspace mirror, which lags the runner's live tree until a
  // turn-boundary commit — and the agent writes the SKILL.md and calls this
  // tool in the SAME turn. Without a flush the host would read a stale mirror
  // and fail with `authored-skill-not-found` (BUG-W2). The runner flushes its
  // live tree before forwarding this call so the host reads the fresh bundle.
  flushWorkspaceBeforeCall: true,
  inputSchema: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: 'The id you used under .ax/skills/<id>/.' },
      hosts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Hostnames the skill must reach, e.g. api.example.com. May be empty.',
      },
      slots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Credential slot names the skill needs, e.g. API_KEY. May be empty.',
      },
      packages: {
        type: 'object',
        description:
          'Package ecosystems the skill installs at runtime. Declared here so the user approves registry egress. Never put this in SKILL.md frontmatter.',
        properties: {
          npm: {
            type: 'array',
            items: { type: 'string' },
            description: 'npm package names the skill installs via npx. May be empty.',
          },
          pypi: {
            type: 'array',
            items: { type: 'string' },
            description: 'PyPI package names the skill installs via uvx or pip. May be empty.',
          },
        },
      },
    },
    required: ['skillId'],
  },
};

// The bundled approval card payload (design §11.3) with the open-mode banner
// flag. Public manifest data only — never a secret. Re-declared (I2) on the
// channel-web server + client; kept in sync by the canary + card tests.
interface PermissionRequestEvent {
  // `kind: 'skill'` discriminates this from the reactive egress-wall's
  // `kind: 'host'` variant (TASK-37). The chat:permission-request payload is a
  // union on `kind`; this producer always fires the skill variant.
  kind: 'skill';
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
  packages: { npm: string[]; pypi: string[] };
  /** TASK-39: "⚠ This is a new skill your assistant just wrote." */
  authored: true;
}

interface InstallAuthoredSkillResult {
  status: 'requested';
  skillId: string;
}

export async function registerInstallAuthoredSkill(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', initCtx, INSTALL_AUTHORED_SKILL_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, InstallAuthoredSkillResult>(
    'tool:execute:install_authored_skill',
    PLUGIN_NAME,
    async (toolCtx, call) => {
      const input = (call?.input ?? {}) as {
        skillId?: unknown;
        hosts?: unknown;
        slots?: unknown;
        packages?: unknown;
      };
      const skillId = typeof input.skillId === 'string' ? input.skillId.trim() : '';
      if (skillId.length === 0 || !SKILL_ID_RE.test(skillId)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:install_authored_skill',
          message: 'install_authored_skill requires a valid "skillId"',
        });
      }
      const hosts = Array.isArray(input.hosts)
        ? input.hosts.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h))
        : [];
      const slots = Array.isArray(input.slots)
        ? input.slots.filter((s): s is string => typeof s === 'string' && SLOT_RE.test(s))
        : [];
      const pkgIn = (input.packages ?? {}) as { npm?: unknown; pypi?: unknown };
      const npm = (
        Array.isArray(pkgIn.npm)
          ? pkgIn.npm.filter(
              (p): p is string =>
                typeof p === 'string' &&
                p.length > 0 &&
                p.length <= PACKAGE_NAME_LEN_MAX &&
                NPM_NAME_RE.test(p),
            )
          : []
      ).slice(0, PACKAGES_PER_ECOSYSTEM_MAX);
      const pypi = (
        Array.isArray(pkgIn.pypi)
          ? pkgIn.pypi.filter(
              (p): p is string =>
                typeof p === 'string' &&
                p.length > 0 &&
                p.length <= PACKAGE_NAME_LEN_MAX &&
                PYPI_NAME_RE.test(p),
            )
          : []
      ).slice(0, PACKAGES_PER_ECOSYSTEM_MAX);
      const packages = { npm, pypi };

      // Open-mode authoring requires @ax/agents (gated soft dep). Clear tool
      // error (not a boot crash) on a hypothetical agents-less open-mode preset.
      if (!bus.hasService('agents:install-authored-skill')) {
        throw new PluginError({
          code: 'authoring-unavailable',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:install_authored_skill',
          message: 'open-mode authoring is not available in this deployment',
        });
      }

      // Promote the workspace draft → a user-scoped skill carrying the
      // REQUESTED capabilities; @ax/agents reads .ax/skills/<id>/, upserts to
      // the user store with files[], and retires the draft. Returns the card
      // payload (description from the authored manifest). PluginErrors
      // (invalid-host / invalid-slot / authored-skill-not-found / invalid-
      // bundle-file) propagate to the model as a structured tool error.
      const out = await bus.call<
        { agentId: string; skillId: string; hosts: string[]; slots: string[]; packages: { npm: string[]; pypi: string[] } },
        { description: string; hosts: string[]; slots: { slot: string; kind: 'api-key' }[]; packages: { npm: string[]; pypi: string[] } }
      >('agents:install-authored-skill', toolCtx, {
        agentId: toolCtx.agentId,
        skillId,
        hosts,
        slots,
        packages,
      });

      // Surface the ONE bundled approval card with the open-mode banner
      // (design §6C/§10). The user approves hosts + enters keys — the backstop.
      const card: PermissionRequestEvent = {
        kind: 'skill',
        skillId,
        description: out.description,
        hosts: out.hosts,
        slots: out.slots,
        // Guard a pre-Task-2 backend that returns no packages (shape violation).
        packages: out.packages ?? { npm: [], pypi: [] },
        authored: true,
      };
      await bus.fire('chat:permission-request', toolCtx, card);

      return { status: 'requested', skillId };
    },
    { timeoutMs: 30_000 },
  );
}
