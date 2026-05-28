import { dump as yamlDump } from 'js-yaml';
import type { SkillCapabilities } from './capabilities.js';

/**
 * Serialize a skill manifest (the YAML that goes BETWEEN the --- fences).
 * Inverse of parseSkillManifest for the fields a promote flow controls.
 *
 * Only emits a `capabilities:` block when there is at least one host,
 * credential, MCP server, or package ecosystem — a no-capability skill has
 * no `capabilities:` key at all, which matches what the parser produces on
 * round-trip.
 */
export function buildSkillManifestYaml(input: {
  id: string;
  description: string;
  version: number;
  capabilities: SkillCapabilities;
}): string {
  const doc: Record<string, unknown> = {
    name: input.id,
    description: input.description,
    version: input.version,
  };
  const c = input.capabilities;
  const pkgs = c.packages ?? { npm: [], pypi: [] };
  const hasPackages = (pkgs.npm ?? []).length > 0 || (pkgs.pypi ?? []).length > 0;
  const hasCaps =
    c.allowedHosts.length > 0 ||
    c.credentials.length > 0 ||
    (c.mcpServers ?? []).length > 0 ||
    hasPackages;
  if (hasCaps) {
    doc.capabilities = {
      ...(c.allowedHosts.length > 0 ? { allowedHosts: c.allowedHosts } : {}),
      ...(c.credentials.length > 0 ? { credentials: c.credentials } : {}),
      ...((c.mcpServers ?? []).length > 0 ? { mcpServers: c.mcpServers } : {}),
      ...(hasPackages
        ? { packages: {
              ...((pkgs.npm ?? []).length > 0 ? { npm: pkgs.npm } : {}),
              ...((pkgs.pypi ?? []).length > 0 ? { pypi: pkgs.pypi } : {}),
            } }
        : {}),
    };
  }
  return yamlDump(doc, { noRefs: true });
}
