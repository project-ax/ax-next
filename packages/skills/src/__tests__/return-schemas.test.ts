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
  CatalogSubmitOutputSchema,
  CatalogListRequestsOutputSchema,
  CatalogAdmitOutputSchema,
  SkillsApprovedCapsListOutputSchema,
  SkillsApprovedCapsSetOutputSchema,
  SkillsApprovedCapsRevokeOutputSchema,
  SkillsProposeOutputSchema,
  SkillsListAuthoredOutputSchema,
  SkillsAdoptAuthoredOutputSchema,
  type SkillsProposeOutput,
  type SkillsListAuthoredOutput,
  type SkillsAdoptAuthoredOutput,
  type ResolvedSkill,
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
  type SkillsApprovedCapsListOutput,
  type SkillsApprovedCapsSetOutput,
  type SkillsApprovedCapsRevokeOutput,
} from '../types.js';

// ARCH-13 drift guard for the `skills:*` returns schemas. A fully-populated
// interface-typed value must round-trip through `.parse` without losing a
// field (a stripped field diverges under `toEqual`; a new required interface
// field fails to compile here).

// TASK-100 — a skill carries no capability block; its only declared reach is the
// connectors it references.

const summary: SkillSummary = {
  id: 'github',
  description: 'GitHub helper',
  version: 3,
  connectors: ['github-connector', 'gitlab_ce'],
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
  connectors: ['github-connector'],
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

  // TASK-100 — the skill capability block (and its credential `account` tag) was
  // removed from the skill hook surface; the credential account tag now lives on
  // the connector, validated by @ax/connectors' own schemas. So the old
  // "SkillsGetOutputSchema preserves the credential account tag" test is gone.

  // TASK-92 — the connectors[] soft-dependency reference list must survive the
  // return-validation strip (the hook-bus strips keys absent from the schema),
  // so skills:get / skills:list / skills:resolve preserve it for downstream
  // consumers. A schema that forgot the new field would silently drop it; these
  // assert it round-trips on both the summary (get/list) and resolved surfaces.
  it('SkillsGetOutputSchema preserves the connectors reference list', () => {
    const parsed = SkillsGetOutputSchema.parse(detail) as SkillDetail;
    expect(parsed.connectors).toEqual(['github-connector', 'gitlab_ce']);
  });

  it('SkillsResolveOutputSchema preserves the connectors reference list', () => {
    const out = SkillsResolveOutputSchema.parse({ skills: [resolved] }) as SkillsResolveOutput;
    expect(out.skills[0]!.connectors).toEqual(['github-connector']);
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

  it('strips a stray capabilities field from a skill summary (no longer in the schema)', () => {
    // TASK-100 — the schema has no `capabilities` key, so the hook-bus strips it.
    const withStray = { ...summary, capabilities: { allowedHosts: ['x'] } };
    const parsed = SkillsListOutputSchema.parse({ skills: [withStray] }) as SkillsListOutput;
    expect('capabilities' in parsed.skills[0]!).toBe(false);
    expect(parsed.skills[0]!.connectors).toEqual(['github-connector', 'gitlab_ce']);
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

  it('CatalogSubmitOutputSchema parses + strips', () => {
    const parsed = CatalogSubmitOutputSchema.parse({
      requestId: 'r1',
      created: true,
      status: 'pending',
      extra: 'drop me',
    });
    expect(parsed).toEqual({ requestId: 'r1', created: true, status: 'pending' });
  });

  it('CatalogListRequestsOutputSchema parses a request with files but NO tree sha', () => {
    const parsed = CatalogListRequestsOutputSchema.parse({
      requests: [
        {
          requestId: 'r1',
          kind: 'share',
          skillId: 'linear',
          requestedByUserId: 'alice',
          sourceOwnerUserId: 'alice',
          status: 'pending',
          description: 'd',
          createdAt: '2026-05-26T00:00:00.000Z',
          manifestYaml: 'name: linear\n',
          bodyMd: '# l\n',
          files: [{ path: 'scripts/a.py', contents: 'print(1)' }],
          bundle_tree_sha: 'LEAK', // must be stripped — storage detail
        },
      ],
    });
    expect(parsed.requests[0]).not.toHaveProperty('bundle_tree_sha');
    expect(parsed.requests[0]?.files).toEqual([{ path: 'scripts/a.py', contents: 'print(1)' }]);
  });

  it('CatalogAdmitOutputSchema parses + strips', () => {
    const parsed = CatalogAdmitOutputSchema.parse({ skillId: 'linear', admitted: true, x: 1 });
    expect(parsed).toEqual({ skillId: 'linear', admitted: true });
  });

  it('SkillsApprovedCapsListOutputSchema round-trips a fully-populated value', () => {
    const v: SkillsApprovedCapsListOutput = {
      capabilities: [
        { kind: 'host', value: 'api.github.com' },
        { kind: 'slot', value: 'GITHUB_TOKEN' },
        { kind: 'npm', value: '@scope/pkg' },
        { kind: 'pypi', value: 'requests' },
        { kind: 'mcp', value: 'gh-mcp' },
      ],
    };
    expect(SkillsApprovedCapsListOutputSchema.parse(v)).toEqual(v);
  });

  it('SkillsApprovedCapsListOutputSchema round-trips an empty capabilities list', () => {
    const v: SkillsApprovedCapsListOutput = { capabilities: [] };
    expect(SkillsApprovedCapsListOutputSchema.parse(v)).toEqual(v);
  });

  it('SkillsApprovedCapsListOutputSchema rejects an unknown cap kind', () => {
    expect(
      SkillsApprovedCapsListOutputSchema.safeParse({
        capabilities: [{ kind: 'unknown', value: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('skills:approved-caps-set output round-trips', () => {
    const v: SkillsApprovedCapsSetOutput = { created: true };
    expect(SkillsApprovedCapsSetOutputSchema.parse(v)).toEqual(v);
  });
  it('skills:approved-caps-revoke output round-trips', () => {
    const v: SkillsApprovedCapsRevokeOutput = { cleared: false };
    expect(SkillsApprovedCapsRevokeOutputSchema.parse(v)).toEqual(v);
  });

  it('skills:propose output round-trips (with reason)', () => {
    const v: SkillsProposeOutput = { skillId: 'linear', status: 'quarantined', reason: 'flagged' };
    expect(SkillsProposeOutputSchema.parse(v)).toEqual(v);
  });
  it('skills:propose output round-trips (active, no reason)', () => {
    const v: SkillsProposeOutput = { skillId: 'commit-style', status: 'active' };
    expect(SkillsProposeOutputSchema.parse(v)).toEqual(v);
  });
  it('skills:list-authored output round-trips a fully-populated projection', () => {
    const v: SkillsListAuthoredOutput = {
      skills: [
        {
          skillId: 'linear',
          description: 'd',
          manifestYaml: 'name: linear',
          bodyMd: '# body',
          files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
          status: 'pending',
          reason: undefined,
        },
      ],
    };
    // `reason: undefined` is stripped by the schema; compare against the
    // expected shape without it.
    expect(SkillsListAuthoredOutputSchema.parse(v)).toEqual({
      skills: [
        {
          skillId: 'linear',
          description: 'd',
          manifestYaml: 'name: linear',
          bodyMd: '# body',
          files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
          status: 'pending',
        },
      ],
    });
  });

  it('skills:adopt-authored output round-trips + strips (TASK-134)', () => {
    const v: SkillsAdoptAuthoredOutput = { skillId: 'drafted', created: true, adopted: true };
    expect(SkillsAdoptAuthoredOutputSchema.parse(v)).toEqual(v);
    // A stray field is stripped (storage details never leak the wire surface).
    const parsed = SkillsAdoptAuthoredOutputSchema.parse({
      ...v,
      bundle_tree_sha: 'LEAK',
    });
    expect(parsed).not.toHaveProperty('bundle_tree_sha');
  });
});
