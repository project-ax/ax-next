import { describe, it, expect } from 'vitest';
import { parseSkillManifest } from '../manifest.js';

const SAMPLE_OK = `name: github
description: Access the GitHub REST API with a personal access token.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
      description: GitHub PAT.
`;

describe('parseSkillManifest', () => {
  it('accepts a well-formed manifest', () => {
    const r = parseSkillManifest(SAMPLE_OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('github');
    expect(r.value.description).toMatch(/GitHub/);
    expect(r.value.version).toBe(1);
    expect(r.value.capabilities.allowedHosts).toEqual(['api.github.com']);
    expect(r.value.capabilities.credentials).toEqual([
      { slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'GitHub PAT.' },
    ]);
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

  it('rejects allowedHosts with scheme / path / wildcard / IP literal', () => {
    for (const bad of [
      'https://api.github.com',
      'api.github.com/foo',
      '*.github.com',
      '192.168.1.1',
    ]) {
      const r = parseSkillManifest(
        `name: x\ndescription: x\ncapabilities:\n  allowedHosts: [${bad}]\n  credentials: []`,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-host');
    }
  });

  it('deduplicates allowedHosts', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  allowedHosts: [a.example.com, a.example.com]\n  credentials: []`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.capabilities.allowedHosts).toEqual(['a.example.com']);
  });

  it('rejects slot name that is not SCREAMING_SNAKE_CASE', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: github_token\n      kind: api-key`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-slot');
  });

  it('rejects duplicate slot names within a manifest', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: A\n      kind: api-key\n    - slot: A\n      kind: api-key`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('duplicate-slot');
  });

  it('rejects unknown kind enum value', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: A\n      kind: oauth`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-kind');
  });

  it('rejects inline secret fields at top level', () => {
    for (const key of ['apiKey', 'token', 'password', 'secret']) {
      const r = parseSkillManifest(`name: x\ndescription: x\n${key}: hunter2`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('inline-secret-forbidden');
    }
  });

  it('rejects inline secret fields nested inside capabilities', () => {
    const r = parseSkillManifest(
      `name: x\ndescription: x\ncapabilities:\n  apiKey: hunter2\n  credentials: []`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('inline-secret-forbidden');
  });

  it('no longer reserves capability-deferred for mcpServers', () => {
    const yaml = `name: x\ndescription: x\ncapabilities:\n  mcpServers:\n    - name: x\n      transport: stdio\n      command: npx`;
    const r = parseSkillManifest(yaml);
    expect(r.ok).toBe(true);
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
    //
    // We construct the cyclic object directly (YAML is just the vehicle) and
    // verify parseSkillManifest returns without throwing a RangeError.
    //
    // The YAML below uses an anchor that references itself: js-yaml produces a
    // real cyclic object graph for it.
    // Note: js-yaml wraps the cycle in a mapping, so the top-level name/description
    // fields are separate. We give valid name+description so the test reaches
    // findSecretKey (the inline-secret scan, step 3) before bailing.
    const cyclicYaml = 'name: x\ndescription: y\ncaps: &a\n  nested: *a\n';
    // This must complete without throwing RangeError (stack overflow).
    // The result is `ok:false` (invalid-manifest / missing required field or
    // unknown shape) or `ok:true` — either is fine; what matters is termination.
    expect(() => parseSkillManifest(cyclicYaml)).not.toThrow();
  });

  // JIT P2/P7.2, decision #13 — optional `account` service tag on a credential slot.
  it('parses an optional account tag on a credential slot', () => {
    const r = parseSkillManifest(
      [
        'name: linear',
        'description: Linear issues',
        'capabilities:',
        '  credentials:',
        '    - slot: LINEAR_TOKEN',
        '      kind: api-key',
        '      account: linear',
      ].join('\n'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.capabilities.credentials).toEqual([
      { slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' },
    ]);
  });

  it('omits account when absent (back-compat: today’s shape unchanged)', () => {
    const r = parseSkillManifest(
      'name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: API_KEY\n      kind: api-key',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.capabilities.credentials[0]).toEqual({ slot: 'API_KEY', kind: 'api-key' });
    expect('account' in r.value.capabilities.credentials[0]!).toBe(false);
  });

  it.each([['Linear'], ['lin:ear'], ['linear_app'], ['-linear'], ['']])(
    'rejects an invalid account value %j with invalid-account',
    (bad) => {
      const r = parseSkillManifest(
        `name: x\ndescription: x\ncapabilities:\n  credentials:\n    - slot: API_KEY\n      kind: api-key\n      account: ${JSON.stringify(bad)}`,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-account');
    },
  );
});
