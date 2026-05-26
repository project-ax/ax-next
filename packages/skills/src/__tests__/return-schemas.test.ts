import { describe, it, expect } from 'vitest';
import {
  SkillsCheckForUpdatesOutputSchema,
  SkillsDeleteOutputSchema,
  SkillsGetOutputSchema,
  SkillsListDefaultsOutputSchema,
  SkillsListOutputSchema,
  SkillsResolveOutputSchema,
  SkillsUpsertOutputSchema,
  SkillsAttachForUserOutputSchema,
  SkillsListUserAttachmentsOutputSchema,
  SkillsSearchCatalogOutputSchema,
  type ResolvedSkill,
  type SkillCapabilities,
  type SkillDetail,
  type SkillSummary,
  type SkillsCheckForUpdatesOutput,
  type SkillsDeleteOutput,
  type SkillsListDefaultsOutput,
  type SkillsListOutput,
  type SkillsResolveOutput,
  type SkillsUpsertOutput,
  type SkillsAttachForUserOutput,
  type SkillsListUserAttachmentsOutput,
  type SkillsSearchCatalogOutput,
} from '../types.js';

// ARCH-13 drift guard for the `skills:*` returns schemas. A fully-populated
// interface-typed value must round-trip through `.parse` without losing a
// field (a stripped field diverges under `toEqual`; a new required interface
// field fails to compile here).

const capabilities: SkillCapabilities = {
  allowedHosts: ['api.github.com'],
  credentials: [{ slot: 'token', kind: 'api-key', description: 'GitHub PAT' }],
  mcpServers: [
    {
      name: 'gh',
      transport: 'http',
      command: 'mcp-gh',
      args: ['--stdio'],
      env: { GH_DEBUG: '1' },
      url: 'https://mcp.example.com',
      allowedHosts: ['mcp.example.com'],
      credentials: [{ slot: 'token', kind: 'api-key' }],
    },
  ],
  packages: { npm: ['@scope/pkg'], pypi: ['somepy'] },
};

const summary: SkillSummary = {
  id: 'github',
  description: 'GitHub helper',
  version: 3,
  capabilities,
  defaultAttached: false,
  sourceUrl: 'https://example.com/github.md',
  updatedAt: '2026-01-01T00:00:00.000Z',
  scope: 'user',
  ownerUserId: 'u1',
};

const detail: SkillDetail = {
  ...summary,
  bodyMd: '# GitHub',
  manifestYaml: 'id: github',
  files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
};

const resolved: ResolvedSkill = {
  id: 'github',
  capabilities,
  bodyMd: '# GitHub',
  manifestYaml: 'id: github',
  files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
};

describe('skills return schemas', () => {
  it('skills:list round-trips a fully-populated SkillsListOutput', () => {
    const full: SkillsListOutput = { skills: [summary] };
    expect(SkillsListOutputSchema.parse(full)).toEqual(full);
  });

  it('skills:get round-trips a fully-populated SkillDetail', () => {
    const full: SkillDetail = detail;
    expect(SkillsGetOutputSchema.parse(full)).toEqual(full);
  });

  it('skills:upsert round-trips a fully-populated SkillsUpsertOutput', () => {
    const full: SkillsUpsertOutput = { skillId: 'github', created: true };
    expect(SkillsUpsertOutputSchema.parse(full)).toEqual(full);
  });

  it('skills:delete round-trips the empty output', () => {
    const full: SkillsDeleteOutput = {};
    expect(SkillsDeleteOutputSchema.parse(full)).toEqual(full);
  });

  it('skills:delete rejects a non-empty object (strict)', () => {
    expect(SkillsDeleteOutputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('skills:resolve round-trips a fully-populated SkillsResolveOutput', () => {
    const full: SkillsResolveOutput = { skills: [resolved] };
    expect(SkillsResolveOutputSchema.parse(full)).toEqual(full);
  });

  it('skills:list-defaults round-trips a fully-populated SkillsListDefaultsOutput', () => {
    const full: SkillsListDefaultsOutput = { skills: [resolved] };
    expect(SkillsListDefaultsOutputSchema.parse(full)).toEqual(full);
  });

  it('skills:check-for-updates round-trips with all optional fields present', () => {
    const full: SkillsCheckForUpdatesOutput = {
      available: true,
      currentVersion: 2,
      latestVersion: 3,
      latestSkillMd: '# newer',
    };
    expect(SkillsCheckForUpdatesOutputSchema.parse(full)).toEqual(full);
  });

  it('skills:check-for-updates round-trips with optionals omitted', () => {
    const full: SkillsCheckForUpdatesOutput = { available: false, currentVersion: 5 };
    expect(SkillsCheckForUpdatesOutputSchema.parse(full)).toEqual(full);
  });

  it('rejects a non-array allowedHosts in capabilities', () => {
    expect(
      SkillsListOutputSchema.safeParse({
        skills: [{ ...summary, capabilities: { ...capabilities, allowedHosts: 'nope' } }],
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid scope', () => {
    expect(
      SkillsListOutputSchema.safeParse({ skills: [{ ...summary, scope: 'team' }] }).success,
    ).toBe(false);
  });

  it('SkillsAttachForUserOutputSchema round-trips a fully-populated value', () => {
    const v: SkillsAttachForUserOutput = { created: true };
    expect(SkillsAttachForUserOutputSchema.parse(v)).toEqual(v);
  });

  it('SkillsListUserAttachmentsOutputSchema round-trips a fully-populated value', () => {
    const v: SkillsListUserAttachmentsOutput = {
      attachments: [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref' } }],
    };
    expect(SkillsListUserAttachmentsOutputSchema.parse(v)).toEqual(v);
  });

  it('SkillsListUserAttachmentsOutputSchema round-trips empty attachments', () => {
    const v: SkillsListUserAttachmentsOutput = { attachments: [] };
    expect(SkillsListUserAttachmentsOutputSchema.parse(v)).toEqual(v);
  });

  it('SkillsSearchCatalogOutputSchema round-trips a fully-populated candidate list', () => {
    const v: SkillsSearchCatalogOutput = {
      skills: [
        { id: 'linear', description: 'd', tier: 'bounded', hosts: ['api.linear.app'], slots: ['api_key'] },
        { id: 'notes', description: 'n', tier: 'inert', hosts: [], slots: [] },
      ],
    };
    expect(SkillsSearchCatalogOutputSchema.parse(v)).toEqual(v);
  });

  it('SkillsSearchCatalogOutputSchema rejects an unknown tier', () => {
    expect(
      SkillsSearchCatalogOutputSchema.safeParse({
        skills: [{ id: 'x', description: 'd', tier: 'omnipotent', hosts: [], slots: [] }],
      }).success,
    ).toBe(false);
  });
});
