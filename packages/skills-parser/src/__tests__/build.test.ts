import { describe, it, expect } from 'vitest';
import { buildSkillManifestYaml } from '../build.js';
import { parseSkillManifest } from '../manifest.js';

describe('buildSkillManifestYaml', () => {
  it('emits allowedHosts but NOT credentials/mcpServers when only allowedHosts granted', () => {
    const yaml = buildSkillManifestYaml({
      id: 'my-skill',
      description: 'Does something useful.',
      version: 2,
      capabilities: {
        allowedHosts: ['api.foo.com'],
        credentials: [],
        mcpServers: [],
      },
    });

    expect(yaml).toContain('allowedHosts');
    expect(yaml).toContain('api.foo.com');
    expect(yaml).not.toContain('credentials:');
    expect(yaml).not.toContain('mcpServers:');
  });

  it('round-trips: parseSkillManifest(buildSkillManifestYaml(...)) returns ok:true with same id/description/capabilities', () => {
    const input = {
      id: 'my-skill',
      description: 'Does something useful.',
      version: 2,
      capabilities: {
        allowedHosts: ['api.foo.com'],
        credentials: [{ slot: 'MY_KEY', kind: 'api-key' as const }],
        mcpServers: [],
      },
    };

    const yaml = buildSkillManifestYaml(input);
    const result = parseSkillManifest(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(input.id);
    expect(result.value.description).toBe(input.description);
    expect(result.value.version).toBe(input.version);
    expect(result.value.capabilities.allowedHosts).toEqual(['api.foo.com']);
    expect(result.value.capabilities.credentials).toEqual([
      { slot: 'MY_KEY', kind: 'api-key' },
    ]);
    expect(result.value.capabilities.mcpServers).toEqual([]);
  });

  it('emits no capabilities: key when all capability arrays are empty', () => {
    const yaml = buildSkillManifestYaml({
      id: 'simple-skill',
      description: 'A skill with no capabilities.',
      version: 0,
      capabilities: {
        allowedHosts: [],
        credentials: [],
        mcpServers: [],
      },
    });

    expect(yaml).not.toContain('capabilities:');
    expect(yaml).toContain('name: simple-skill');
    expect(yaml).toContain('description:');

    // Should still round-trip cleanly.
    const result = parseSkillManifest(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('simple-skill');
    expect(result.value.capabilities.allowedHosts).toEqual([]);
    expect(result.value.capabilities.credentials).toEqual([]);
    expect(result.value.capabilities.mcpServers).toEqual([]);
  });

  it('round-trips version field correctly', () => {
    const yaml = buildSkillManifestYaml({
      id: 'versioned',
      description: 'Has a version.',
      version: 5,
      capabilities: { allowedHosts: [], credentials: [], mcpServers: [] },
    });
    const result = parseSkillManifest(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(5);
  });
});
