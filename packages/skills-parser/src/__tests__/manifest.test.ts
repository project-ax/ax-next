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

  it('does not catastrophically backtrack on pathological allowedHosts input (js/polynomial-redos guard)', () => {
    // The pre-parse wildcard detector runs on UNTRUSTED self-authored
    // frontmatter. A polynomial regex here is a host-side DoS: a crafted
    // draft could hang the projection. Feed inputs that maximised the old
    // regex's backtracking (many leading newlines; a near-miss flow seq with
    // no closing ] and no '*'; a near-miss block list) and assert each
    // returns quickly. A polynomial regex would take many seconds here; the
    // linear one is sub-millisecond. 2s is a generous non-flaky ceiling.
    const cases = [
      '\n'.repeat(40000) + 'allowedHosts: x',
      'name: x\ndescription: x\ncapabilities:\n  allowedHosts: [' + 'a'.repeat(40000),
      'name: x\ndescription: x\ncapabilities:\n  allowedHosts:\n' +
        '    - '.concat('a'.repeat(40000)),
    ];
    for (const evil of cases) {
      const start = Date.now();
      const r = parseSkillManifest(evil);
      // Any verdict is fine — the point is it RETURNS, fast, without hanging.
      expect(typeof r.ok).toBe('boolean');
      expect(Date.now() - start).toBeLessThan(2000);
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

  // TASK-79 (SECURITY): capability keys MUST live under the `capabilities:`
  // mapping. A manifest that declares them at the TOP LEVEL (the shape the old
  // skill_propose docs wrongly told the model to write) must be REJECTED, not
  // silently parsed to zero caps — silently dropping them is the capability-loss
  // bypass (a cap-bearing skill would otherwise materialize as a zero-cap ACTIVE
  // skill with no approval card). Each misplaced key fails with invalid-manifest.
  it.each([
    [
      'allowedHosts',
      'name: linear\ndescription: Work with Linear.\nversion: 1\nallowedHosts:\n  - api.linear.app\n',
    ],
    [
      'credentials',
      'name: linear\ndescription: Work with Linear.\nversion: 1\ncredentials:\n  - slot: LINEAR_API_KEY\n    kind: api-key\n',
    ],
    [
      'mcpServers',
      'name: linear\ndescription: Work with Linear.\nversion: 1\nmcpServers:\n  - name: linear\n    transport: http\n    url: https://api.linear.app\n',
    ],
    [
      'packages',
      'name: tool\ndescription: A tool.\nversion: 1\npackages:\n  npm:\n    - left-pad\n',
    ],
  ])(
    'rejects a top-level "%s" capability key (must be nested under capabilities:)',
    (key, yaml) => {
      const r = parseSkillManifest(yaml);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('invalid-manifest');
      expect(r.message).toContain(key);
      expect(r.message).toContain('capabilities');
    },
  );

  it('rejects a top-level capability key even when a capabilities: block is also present', () => {
    // The author nested credentials correctly but left allowedHosts at the top
    // level — the stray top-level key is still a hard reject (no partial silent drop).
    const r = parseSkillManifest(
      'name: linear\ndescription: Work with Linear.\nversion: 1\nallowedHosts:\n  - api.linear.app\ncapabilities:\n  credentials:\n    - slot: LINEAR_API_KEY\n      kind: api-key\n',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-manifest');
  });

  it('parses the documented skill_propose frontmatter contract end-to-end (TASK-79 round-trip)', () => {
    // The exact canonical shape the skill_propose tool description now documents:
    // `name` (not id), integer `version`, capability keys nested under
    // `capabilities:`. Proves docs ↔ parser agree on ONE contract.
    const documented = `name: linear
description: Work with Linear issues.
version: 1
capabilities:
  allowedHosts:
    - api.linear.app
  credentials:
    - slot: LINEAR_API_KEY
      kind: api-key
`;
    const r = parseSkillManifest(documented);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('linear'); // parser maps `name` → id
    expect(r.value.version).toBe(1);
    expect(r.value.capabilities.allowedHosts).toEqual(['api.linear.app']);
    expect(r.value.capabilities.credentials).toEqual([
      { slot: 'LINEAR_API_KEY', kind: 'api-key' },
    ]);
  });

  it('still accepts capabilities correctly nested under capabilities: (no false positive)', () => {
    const r = parseSkillManifest(
      'name: linear\ndescription: Work with Linear.\nversion: 1\ncapabilities:\n  allowedHosts:\n    - api.linear.app\n  credentials:\n    - slot: LINEAR_API_KEY\n      kind: api-key\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.capabilities.allowedHosts).toEqual(['api.linear.app']);
    expect(r.value.capabilities.credentials).toEqual([
      { slot: 'LINEAR_API_KEY', kind: 'api-key' },
    ]);
  });

  // ---- connectors[] soft-dependency reference list (TASK-92) --------------
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

    it('parses connectors ALONGSIDE an authoritative capabilities block (additive — capabilities untouched)', () => {
      const r = parseSkillManifest(
        'name: x\ndescription: x\nconnectors:\n  - salesforce\ncapabilities:\n  allowedHosts:\n    - api.github.com\n  credentials:\n    - slot: GITHUB_TOKEN\n      kind: api-key',
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.connectors).toEqual(['salesforce']);
      // capabilities stay authoritative — the connectors list does not touch them.
      expect(r.value.capabilities.allowedHosts).toEqual(['api.github.com']);
      expect(r.value.capabilities.credentials).toEqual([
        { slot: 'GITHUB_TOKEN', kind: 'api-key' },
      ]);
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

    it('rejects connectors nested under capabilities: (it is a top-level field, not a capability)', () => {
      const r = parseSkillManifest(
        'name: x\ndescription: x\ncapabilities:\n  connectors:\n    - salesforce',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid-connector');
    });
  });
});
