import { describe, it, expect } from 'vitest';
import { rewriteManifestDroppingCaps } from '../cap-migration.js';
import { parseSkillManifest } from '@ax/skills-parser';

// TASK-100 — the pure rewrite half of the cap→connector data migration. The
// DB-walking half (migrateSkillCapabilitiesToConnectors) is exercised against a
// real postgres testcontainer in the plugin/store suites; here we pin the pure
// transform: a legacy capabilities block is stripped, a connector reference is
// added, and the result round-trips through the (cap-free) parser.

describe('rewriteManifestDroppingCaps', () => {
  it('strips a legacy capabilities block and references a connector named after the skill', () => {
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

    // The connector carries the lifted reach.
    expect(r.connectorId).toBe('github');
    expect(r.capabilities?.allowedHosts).toEqual(['api.github.com']);
    expect(r.capabilities?.credentials[0]?.slot).toBe('GITHUB_TOKEN');
    expect(r.capabilities?.packages.npm).toEqual(['@github/cli']);

    // The rewritten manifest is cap-free and references the connector.
    expect(r.manifestYaml).not.toContain('capabilities');
    expect(r.manifestYaml).not.toContain('allowedHosts');
    const parsed = parseSkillManifest(r.manifestYaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.id).toBe('github');
    expect(parsed.value.version).toBe(2);
    expect(parsed.value.connectors).toEqual(['github']);
  });

  it('is idempotent: a cap-free manifest is left alone (returns null)', () => {
    const capFree = 'name: notes\ndescription: Note-taking know-how.\nversion: 1\nconnectors:\n  - notion\n';
    expect(rewriteManifestDroppingCaps(capFree)).toBeNull();
    // And it still parses cleanly (the guard for "already migrated").
    const parsed = parseSkillManifest(capFree);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.connectors).toEqual(['notion']);
  });

  it('strips an EMPTY capabilities block without adding a connector (no reach to lift)', () => {
    const legacy = 'name: inert\ndescription: Instruction-only.\nversion: 0\ncapabilities: {}\n';
    const r = rewriteManifestDroppingCaps(legacy);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.connectorId).toBeNull(); // no reach → no connector
    expect(r.manifestYaml).not.toContain('capabilities');
    const parsed = parseSkillManifest(r.manifestYaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.connectors).toEqual([]);
  });

  it('merges the migrated connector with any pre-existing connectors[] (deduped)', () => {
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
    expect(parsed.value.connectors).toEqual(['existing-connector', 'linear']);
  });
});
