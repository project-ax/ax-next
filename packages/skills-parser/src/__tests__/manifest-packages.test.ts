import { describe, it, expect } from 'vitest';
import { parseSkillManifest } from '../manifest.js';

function manifest(capabilitiesYaml: string): string {
  return [
    'name: pkg-skill',
    'description: A skill that needs a CLI',
    'capabilities:',
    capabilitiesYaml,
  ].join('\n');
}

describe('capabilities.packages', () => {
  it('parses npm and pypi name-only lists', () => {
    const r = parseSkillManifest(manifest('  packages:\n    npm: ["@linear/cli"]\n    pypi: ["some-tool"]'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.capabilities.packages.npm).toEqual(['@linear/cli']);
      expect(r.value.capabilities.packages.pypi).toEqual(['some-tool']);
    }
  });

  it('defaults packages to empty arrays when omitted', () => {
    const r = parseSkillManifest(manifest('  allowedHosts: [api.linear.app]'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.capabilities.packages).toEqual({ npm: [], pypi: [] });
  });

  it('rejects packages.go with unsupported-package-ecosystem', () => {
    const r = parseSkillManifest(manifest('  packages:\n    go: ["github.com/x/y"]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unsupported-package-ecosystem');
  });

  it('rejects an unknown ecosystem key', () => {
    const r = parseSkillManifest(manifest('  packages:\n    cargo: ["serde"]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unsupported-package-ecosystem');
  });

  it('rejects a malformed npm name with invalid-package', () => {
    const r = parseSkillManifest(manifest('  packages:\n    npm: ["bad name; rm -rf /"]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-package');
  });

  it('rejects a non-array ecosystem value', () => {
    const r = parseSkillManifest(manifest('  packages:\n    npm: "@linear/cli"'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-package');
  });

  it('rejects more than the per-ecosystem cap', () => {
    const many = Array.from({ length: 33 }, (_, i) => `pkg-${i}`);
    const r = parseSkillManifest(manifest(`  packages:\n    npm: ${JSON.stringify(many)}`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-package');
  });

  it('accepts a valid scoped npm name and a dotted pypi name', () => {
    const r = parseSkillManifest(manifest('  packages:\n    npm: ["@scope/tool-1"]\n    pypi: ["ruamel.yaml"]'));
    expect(r.ok).toBe(true);
  });
});
