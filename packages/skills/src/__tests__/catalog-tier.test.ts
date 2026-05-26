import { describe, it, expect } from 'vitest';
import type { SkillCapabilities } from '@ax/skills-parser';
import { classifyTier } from '../catalog-tier.js';

const base: SkillCapabilities = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

describe('classifyTier', () => {
  it('inert when no egress, credentials, or packages', () => {
    expect(classifyTier(base)).toBe('inert');
  });

  it('bounded for an allowlisted host (CLI hitting a SaaS API)', () => {
    expect(classifyTier({ ...base, allowedHosts: ['api.linear.app'] })).toBe('bounded');
  });

  it('bounded for an http MCP server', () => {
    expect(
      classifyTier({
        ...base,
        mcpServers: [
          { name: 'x', transport: 'http', url: 'https://h/mcp', allowedHosts: ['h'], credentials: [] },
        ],
      }),
    ).toBe('bounded');
  });

  it('bounded for a credential slot with no declared packages', () => {
    expect(classifyTier({ ...base, credentials: [{ slot: 'api_key', kind: 'api-key' }] })).toBe(
      'bounded',
    );
  });

  it('registry when npm packages are declared', () => {
    expect(classifyTier({ ...base, packages: { npm: ['some-pkg'], pypi: [] } })).toBe('registry');
  });

  it('registry when pypi packages are declared', () => {
    expect(classifyTier({ ...base, packages: { npm: [], pypi: ['some-pkg'] } })).toBe('registry');
  });

  it('registry wins even when hosts are also declared', () => {
    expect(
      classifyTier({ ...base, allowedHosts: ['h'], packages: { npm: ['p'], pypi: [] } }),
    ).toBe('registry');
  });
});
