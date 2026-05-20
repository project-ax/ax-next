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
});
