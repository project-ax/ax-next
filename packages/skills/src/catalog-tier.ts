import type { SkillCapabilities } from '@ax/skills-parser';

/**
 * Supply-chain risk tier for a catalog skill (design §3). Derived from a
 * skill's declared capabilities — NOT a stored column — so there is one
 * source of truth and no migration. The fault line is provenance: does the
 * skill download unreviewed code from a public registry?
 *
 *  - 'registry' — declares npm/pypi packages (npx/uvx/pip download at runtime)
 *  - 'bounded'  — fixed/reviewed egress: http MCP, an allowlisted host, or a key
 *  - 'inert'    — instruction-only
 */
export type SkillTier = 'inert' | 'bounded' | 'registry';

export function classifyTier(capabilities: SkillCapabilities): SkillTier {
  const { allowedHosts, credentials, mcpServers, packages } = capabilities;
  if (packages.npm.length > 0 || packages.pypi.length > 0) return 'registry';
  if (mcpServers.length > 0 || allowedHosts.length > 0 || credentials.length > 0) return 'bounded';
  return 'inert';
}
