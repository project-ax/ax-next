import { describe, it, expect } from 'vitest';
import { rewriteManifestDroppingCaps } from '../cap-migration.js';
import { parseSkillManifest } from '@ax/skills-parser';

// The pure rewrite half of the legacy capability strip. The DB-walking half is
// in cap-migration-db.test.ts. A legacy capabilities block is stripped (no
// connector reference is added) and the result round-trips through the parser.

describe('rewriteManifestDroppingCaps', () => {
  it('strips a legacy capabilities block and invents no connector reference', () => {
    const legacy = [
      'name: github',
      'description: GitHub helper.',
      'version: 2',
      'capabilities:',
      '  allowedHosts:',
      '    - api.github.com',
      '  credentials:',
      '    - slot: GITHUB_TOKEN',
      '      kind: api-key',
      '  packages:',
      '    npm:',
      '      - "@github/cli"',
    ].join('\n');

    const r = rewriteManifestDroppingCaps(legacy);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.hadReach).toBe(true);
    expect(r.manifestYaml).not.toContain('capabilities');
    expect(r.manifestYaml).not.toContain('allowedHosts');
    const parsed = parseSkillManifest(r.manifestYaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.id).toBe('github');
    expect(parsed.value.version).toBe(2);
    expect(parsed.value.connectors).toEqual([]);
  });

  it('is idempotent: a cap-free manifest is left alone (returns null)', () => {
    const capFree = 'name: notes\ndescription: Note-taking know-how.\nversion: 1\nconnectors:\n  - notion\n';
    expect(rewriteManifestDroppingCaps(capFree)).toBeNull();
    const parsed = parseSkillManifest(capFree);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.connectors).toEqual(['notion']);
  });

  it('strips an EMPTY capabilities block (no reach to drop)', () => {
    const legacy = 'name: inert\ndescription: Instruction-only.\nversion: 0\ncapabilities: {}\n';
    const r = rewriteManifestDroppingCaps(legacy);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.hadReach).toBe(false);
    expect(r.manifestYaml).not.toContain('capabilities');
    const parsed = parseSkillManifest(r.manifestYaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.connectors).toEqual([]);
  });

  it('keeps pre-existing connectors[] untouched', () => {
    const legacy = [
      'name: linear',
      'description: Linear helper.',
      'version: 1',
      'connectors:',
      '  - existing-connector',
      'capabilities:',
      '  allowedHosts:',
      '    - api.linear.app',
    ].join('\n');
    const r = rewriteManifestDroppingCaps(legacy);
    expect(r).not.toBeNull();
    if (r === null) return;
    const parsed = parseSkillManifest(r.manifestYaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.connectors).toEqual(['existing-connector']);
  });
});
