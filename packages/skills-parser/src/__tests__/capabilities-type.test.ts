import { describe, it, expect } from 'vitest';
import { parseSkillManifest } from '../manifest.js';
import type {
  Capabilities,
  SkillCapabilities,
  CapabilitySlot,
  McpServerSpec,
  PackagesSpec,
} from '../index.js';

// These are type-only exports; the real enforcement is `tsc` (pnpm build).
// This suite is a compile-time guard expressed as a runtime test: if the
// neutral `Capabilities` alias is dropped, or it stops being structurally
// identical to `SkillCapabilities`, this file fails to type-check and the
// build goes red. The runtime assertions just keep vitest happy.

describe('neutral Capabilities export', () => {
  it('exports a Capabilities type interchangeable with SkillCapabilities', () => {
    const r = parseSkillManifest(
      ['name: cap-skill', 'description: A skill', 'capabilities:', '  allowedHosts: [api.example.com]'].join('\n'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The parser produces the canonical shape. It must satisfy BOTH the
    // neutral name and the back-compat alias — and they must be assignable
    // to each other in both directions (same structural type, not a subtype).
    const neutral: Capabilities = r.value.capabilities;
    const legacy: SkillCapabilities = neutral;
    const backToNeutral: Capabilities = legacy;

    expect(backToNeutral.allowedHosts).toEqual(['api.example.com']);
    expect(backToNeutral.credentials).toEqual([]);
    expect(backToNeutral.mcpServers).toEqual([]);
    expect(backToNeutral.packages).toEqual({ npm: [], pypi: [] });
  });

  it('exports the neutral sub-types used by the Capabilities shape', () => {
    // Each sub-type must remain on the public surface so a future connector
    // object can reference the same shape without a cross-plugin import.
    const slot: CapabilitySlot = { slot: 'API_KEY', kind: 'api-key' };
    const mcp: McpServerSpec = {
      name: 'srv',
      transport: 'stdio',
      allowedHosts: [],
      credentials: [slot],
    };
    const pkgs: PackagesSpec = { npm: [], pypi: [] };
    const caps: Capabilities = {
      allowedHosts: [],
      credentials: [slot],
      mcpServers: [mcp],
      packages: pkgs,
    };

    expect(caps.credentials[0]?.slot).toBe('API_KEY');
    expect(caps.mcpServers[0]?.name).toBe('srv');
    expect(caps.packages.npm).toEqual([]);
  });
});
