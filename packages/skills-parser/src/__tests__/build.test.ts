import { describe, it, expect } from 'vitest';
import { buildSkillManifestYaml } from '../build.js';
import { parseSkillManifest } from '../manifest.js';

describe('buildSkillManifestYaml', () => {
  it('never emits a capabilities: key (skills carry no capability block — TASK-100)', () => {
    const yaml = buildSkillManifestYaml({
      id: 'my-skill',
      description: 'Does something useful.',
      version: 2,
    });
    expect(yaml).not.toContain('capabilities');
    expect(yaml).not.toContain('allowedHosts');
    expect(yaml).not.toContain('credentials');
    expect(yaml).not.toContain('mcpServers');
    expect(yaml).not.toContain('packages');
  });

  it('round-trips: parseSkillManifest(buildSkillManifestYaml(...)) returns ok:true with same id/description/version', () => {
    const input = {
      id: 'my-skill',
      description: 'Does something useful.',
      version: 2,
    };
    const yaml = buildSkillManifestYaml(input);
    const result = parseSkillManifest(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(input.id);
    expect(result.value.description).toBe(input.description);
    expect(result.value.version).toBe(input.version);
    expect(result.value.connectors).toEqual([]);
  });

  it('emits the bare name/description/version manifest', () => {
    const yaml = buildSkillManifestYaml({
      id: 'simple-skill',
      description: 'A skill with no connectors.',
      version: 0,
    });
    expect(yaml).toContain('name: simple-skill');
    expect(yaml).toContain('description:');
    const result = parseSkillManifest(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('simple-skill');
  });

  it('round-trips version field correctly', () => {
    const yaml = buildSkillManifestYaml({ id: 'versioned', description: 'Has a version.', version: 5 });
    const result = parseSkillManifest(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(5);
  });

  it('round-trips a non-empty connectors[] reference list', () => {
    const yaml = buildSkillManifestYaml({
      id: 'demo', description: 'd', version: 1,
      connectors: ['salesforce', 'google-drive'],
    });
    const parsed = parseSkillManifest(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.connectors).toEqual(['salesforce', 'google-drive']);
  });

  it('omits connectors entirely when none are declared (absent ≡ [] on parse)', () => {
    const yaml = buildSkillManifestYaml({ id: 'demo', description: 'd', version: 1 });
    expect(yaml).not.toContain('connectors');
    const parsed = parseSkillManifest(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.connectors).toEqual([]);
  });
});
