import { describe, it, expect } from 'vitest';
import { parseSkillManifest } from '../manifest.js';

// A skill manifest carries NO capability block (TASK-100). The canonical shape
// is name + description + version (+ optional sourceUrl + connectors[]).
const SAMPLE_OK = `name: github
description: Know-how for driving the GitHub connector.
version: 1
connectors:
  - github
`;

describe('parseSkillManifest', () => {
  it('accepts a well-formed (cap-free) manifest', () => {
    const r = parseSkillManifest(SAMPLE_OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('github');
    expect(r.value.description).toMatch(/GitHub/);
    expect(r.value.version).toBe(1);
    expect(r.value.connectors).toEqual(['github']);
    // `capabilities` is no longer a field on the parsed manifest.
    expect('capabilities' in r.value).toBe(false);
  });

  it('defaults version to 0 when absent', () => {
    const r = parseSkillManifest(`name: x\ndescription: x desc`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.version).toBe(0);
  });

  it('rejects name not matching kebab-case-ish regex', () => {
    for (const bad of ['GitHub', '_github', '0github', 'a'.repeat(65)]) {
      const r = parseSkillManifest(`name: ${bad}\ndescription: x`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-name');
    }
  });

  it('rejects description over 240 chars', () => {
    const r = parseSkillManifest(`name: ok\ndescription: ${'x'.repeat(241)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-description');
  });

  it('rejects inline secret fields at top level', () => {
    for (const key of ['apiKey', 'token', 'password', 'secret']) {
      // A bare top-level secret key (not a forbidden-cap key) trips the
      // inline-secret scan. Use a key NOT in the forbidden-cap set so we test the
      // secret scan, not the cap-block reject.
      const r = parseSkillManifest(`name: x\ndescription: x\nfoo:\n  ${key}: hunter2`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('inline-secret-forbidden');
    }
  });

  it('rejects malformed YAML (loud, not silent)', () => {
    const r = parseSkillManifest(`name: x\n  description: bad indent`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-yaml');
  });

  it('accepts top-level https sourceUrl', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: https://example.com/skill.md');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sourceUrl).toBe('https://example.com/skill.md');
  });

  it('omits sourceUrl when absent', () => {
    const r = parseSkillManifest('name: x\ndescription: x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sourceUrl).toBeUndefined();
  });

  it('rejects http:// sourceUrl', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: http://example.com/skill.md');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
  });

  it('rejects file:// sourceUrl', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: file:///etc/passwd');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
  });

  it('rejects IPv4-literal sourceUrl', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: https://10.0.0.1/skill.md');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
  });

  it('rejects bare-host sourceUrl', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: https://localhost/skill.md');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
  });

  it('rejects malformed sourceUrl', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: ":::not a url"');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
  });

  it('rejects non-string sourceUrl', () => {
    const r = parseSkillManifest('name: x\ndescription: x\nsourceUrl: 42');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-manifest');
  });

  it('terminates and does not stack-overflow on a cyclic-anchor YAML manifest', () => {
    // js-yaml load() can produce cyclic object graphs from YAML aliases
    // (e.g. `caps: &a {x: *a}` → {caps:{x:<circular>}}). findSecretKey
    // must NOT recurse infinitely — the WeakSet visited guard must stop it.
    const cyclicYaml = 'name: x\ndescription: y\nfoo: &a\n  nested: *a\n';
    expect(() => parseSkillManifest(cyclicYaml)).not.toThrow();
  });

  // ---- TASK-100: the capability block is FORBIDDEN -----------------------
  describe('capability block is forbidden (TASK-100, hard reject)', () => {
    it('hard-rejects a nested capabilities: block (REJECT, not ignore-with-warning)', () => {
      const r = parseSkillManifest(
        'name: github\ndescription: x\nversion: 1\ncapabilities:\n  allowedHosts:\n    - api.github.com\n  credentials:\n    - slot: GITHUB_TOKEN\n      kind: api-key\n',
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('capability-block-forbidden');
      expect(r.message).toContain('connectors');
    });

    it('hard-rejects an empty capabilities: block (the key alone is forbidden)', () => {
      const r = parseSkillManifest('name: x\ndescription: x\ncapabilities: {}');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('capability-block-forbidden');
    });

    it.each([
      ['allowedHosts', 'name: x\ndescription: x\nallowedHosts:\n  - api.linear.app\n'],
      ['credentials', 'name: x\ndescription: x\ncredentials:\n  - slot: LINEAR_API_KEY\n    kind: api-key\n'],
      ['mcpServers', 'name: x\ndescription: x\nmcpServers:\n  - name: linear\n    transport: http\n    url: https://api.linear.app\n'],
      ['packages', 'name: x\ndescription: x\npackages:\n  npm:\n    - left-pad\n'],
    ])('hard-rejects a top-level "%s" capability key', (key, yaml) => {
      const r = parseSkillManifest(yaml);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('capability-block-forbidden');
      expect(r.message).toContain(key);
    });

    it('rejects capabilities even when alongside a valid connectors list', () => {
      const r = parseSkillManifest(
        'name: x\ndescription: x\nconnectors:\n  - github\ncapabilities:\n  allowedHosts:\n    - api.github.com\n',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('capability-block-forbidden');
    });
  });

  // ---- connectors[] soft-dependency reference list ----------------------
  describe('connectors[] reference list', () => {
    it('defaults connectors to [] when absent (pre-connector skill loads unchanged)', () => {
      const r = parseSkillManifest('name: x\ndescription: x desc');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.connectors).toEqual([]);
    });

    it('parses a non-empty connectors list, preserving order', () => {
      const r = parseSkillManifest(
        'name: x\ndescription: x\nconnectors:\n  - salesforce\n  - google-drive\n  - gitlab_ce',
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.connectors).toEqual(['salesforce', 'google-drive', 'gitlab_ce']);
    });

    it('rejects connectors that is not an array', () => {
      const r = parseSkillManifest('name: x\ndescription: x\nconnectors: salesforce');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-connector');
    });

    it('rejects a non-string connector entry', () => {
      const r = parseSkillManifest('name: x\ndescription: x\nconnectors:\n  - 42');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-connector');
    });

    it('rejects a connector id not matching the slug grammar', () => {
      for (const bad of ['Salesforce', '-leading', '_leading', 'has space', 'has/slash', 'has:colon']) {
        const r = parseSkillManifest(`name: x\ndescription: x\nconnectors: [${JSON.stringify(bad)}]`);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('invalid-connector');
      }
    });

    it('rejects an over-long connector id (> 128 chars)', () => {
      const r = parseSkillManifest(`name: x\ndescription: x\nconnectors: [${'a'.repeat(129)}]`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-connector');
    });

    it('rejects more than 64 connector ids (count DoS bound)', () => {
      const many = Array.from({ length: 65 }, (_, i) => `c${i}`).join(', ');
      const r = parseSkillManifest(`name: x\ndescription: x\nconnectors: [${many}]`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-connector');
    });
  });
});
