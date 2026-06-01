import { describe, it, expect } from 'vitest';
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
//
// TASK-100 — the SKILL manifest no longer carries a capability block, but the
// `Capabilities` shape is the SHARED contract @ax/connectors references (without
// a cross-plugin import, invariant #2). So these types MUST stay exported from
// @ax/skills-parser even though the parser no longer produces them.

describe('neutral Capabilities export (shared with @ax/connectors)', () => {
  it('exports a Capabilities type interchangeable with SkillCapabilities', () => {
    const neutral: Capabilities = {
      allowedHosts: ['api.example.com'],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    };
    // Both names + both directions must be assignable (same structural type).
    const legacy: SkillCapabilities = neutral;
    const backToNeutral: Capabilities = legacy;

    expect(backToNeutral.allowedHosts).toEqual(['api.example.com']);
    expect(backToNeutral.credentials).toEqual([]);
    expect(backToNeutral.mcpServers).toEqual([]);
    expect(backToNeutral.packages).toEqual({ npm: [], pypi: [] });
  });

  it('exports the neutral sub-types used by the Capabilities shape', () => {
    // Each sub-type must remain on the public surface so the connector object
    // can reference the same shape without a cross-plugin import.
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
