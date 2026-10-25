import { describe, it, expect } from 'vitest';
import {
  SKILL_PROPOSE_CAPABILITY_LIMITS,
  SkillProposeRequestSchema,
  SkillProposeResponseSchema,
  IPC_TIMEOUTS_MS,
} from '../index.js';

const emptyCaps = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

const validReq = {
  manifestYaml: 'id: commit-style\ndescription: how we write commits\nversion: 1',
  bodyMd: '# Commit style\n\nUse imperative mood.',
  files: [],
  capabilityProposal: emptyCaps,
  origin: 'authored' as const,
};

describe('TASK-74 skill.propose IPC schemas', () => {
  describe('SkillProposeRequestSchema', () => {
    it('accepts a zero-capability authored proposal', () => {
      expect(SkillProposeRequestSchema.safeParse(validReq).success).toBe(true);
    });

    it('accepts a proposal with hosts + a credential slot', () => {
      const r = SkillProposeRequestSchema.safeParse({
        ...validReq,
        capabilityProposal: {
          ...emptyCaps,
          allowedHosts: ['api.linear.app'],
          credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
        },
      });
      expect(r.success).toBe(true);
    });

    it('accepts an http MCP server in the capability proposal and rejects a stdio one', () => {
      const withMcp = (mcp: Record<string, unknown>) =>
        SkillProposeRequestSchema.safeParse({
          ...validReq,
          capabilityProposal: { ...emptyCaps, mcpServers: [mcp] },
        });
      const http = { name: 'srv', transport: 'http', url: 'https://mcp.example.com', allowedHosts: [], credentials: [] };
      const stdio = { name: 'srv', transport: 'stdio', command: 'npx', allowedHosts: [], credentials: [] };
      expect(withMcp(http).success).toBe(true);
      expect(withMcp(stdio).success).toBe(false);
    });

    it('accepts up to 16 extra files', () => {
      const files = Array.from({ length: 16 }, (_, i) => ({
        path: `scripts/f${i}.py`,
        contents: 'print(1)',
      }));
      expect(SkillProposeRequestSchema.safeParse({ ...validReq, files }).success).toBe(true);
    });

    it('rejects more than 16 extra files (coarse wire wall)', () => {
      const files = Array.from({ length: 17 }, (_, i) => ({
        path: `scripts/f${i}.py`,
        contents: 'x',
      }));
      expect(SkillProposeRequestSchema.safeParse({ ...validReq, files }).success).toBe(false);
    });

    it('rejects an empty manifestYaml', () => {
      expect(SkillProposeRequestSchema.safeParse({ ...validReq, manifestYaml: '' }).success).toBe(
        false,
      );
    });

    it("rejects an origin other than 'authored' (the runner cannot claim imported/attached)", () => {
      expect(
        SkillProposeRequestSchema.safeParse({ ...validReq, origin: 'imported' }).success,
      ).toBe(false);
      expect(
        SkillProposeRequestSchema.safeParse({ ...validReq, origin: 'attached' }).success,
      ).toBe(false);
    });

    it('is strict — rejects a foreign-scope field (no conversationId/agentId on the wire)', () => {
      expect(
        SkillProposeRequestSchema.safeParse({ ...validReq, conversationId: 'c1' }).success,
      ).toBe(false);
      expect(
        SkillProposeRequestSchema.safeParse({ ...validReq, agentId: 'a1' }).success,
      ).toBe(false);
    });

    it('is strict — rejects backend-vocabulary leakage (no bundleSha256/oid on the wire)', () => {
      expect(
        SkillProposeRequestSchema.safeParse({ ...validReq, bundleSha256: 'a'.repeat(64) }).success,
      ).toBe(false);
    });
  });

  describe('SkillProposeResponseSchema', () => {
    it('accepts each gate status', () => {
      for (const status of ['active', 'pending', 'quarantined'] as const) {
        expect(SkillProposeResponseSchema.safeParse({ skillId: 'commit-style', status }).success).toBe(
          true,
        );
      }
    });

    it('accepts a reason on a quarantine', () => {
      expect(
        SkillProposeResponseSchema.safeParse({
          skillId: 's',
          status: 'quarantined',
          reason: 'contains a credential exfiltration pattern',
        }).success,
      ).toBe(true);
    });

    it('rejects an unknown status', () => {
      expect(SkillProposeResponseSchema.safeParse({ skillId: 's', status: 'live' }).success).toBe(
        false,
      );
    });
  });

  it('IPC_TIMEOUTS_MS registers skill.propose', () => {
    expect(IPC_TIMEOUTS_MS['skill.propose']).toBe(30_000);
  });
});

describe('capabilityProposal list limits (TASK-945)', () => {
  // Junk elements (`0`) would each fail on their own, so a result holding ONLY
  // the size issue shows the list was refused before any element was parsed.
  function expectOnlySizeIssue(
    r: { success: boolean; error?: { issues: unknown[] } },
    path: (string | number)[],
    maximum: number,
  ): void {
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([expect.objectContaining({ code: 'too_big', type: 'array', path, maximum })]);
  }

  const L = SKILL_PROPOSE_CAPABILITY_LIMITS;
  const mcp = { name: 'srv', transport: 'http', url: 'https://mcp.example.com', allowedHosts: [], credentials: [] };
  const slot = { slot: 'API_KEY', kind: 'api-key' };

  type Case = [
    label: string,
    path: (string | number)[],
    limit: number,
    valid: unknown,
    build: (items: unknown[]) => unknown,
  ];
  const CASES: Case[] = [
    [
      'allowedHosts',
      ['capabilityProposal', 'allowedHosts'],
      L.allowedHosts,
      'api.example.com',
      (items) => ({ ...emptyCaps, allowedHosts: items }),
    ],
    [
      'credentials',
      ['capabilityProposal', 'credentials'],
      L.credentials,
      slot,
      (items) => ({ ...emptyCaps, credentials: items }),
    ],
    [
      'mcpServers',
      ['capabilityProposal', 'mcpServers'],
      L.mcpServers,
      mcp,
      (items) => ({ ...emptyCaps, mcpServers: items }),
    ],
    [
      "an MCP server's allowedHosts",
      ['capabilityProposal', 'mcpServers', 0, 'allowedHosts'],
      L.allowedHosts,
      'mcp.example.com',
      (items) => ({ ...emptyCaps, mcpServers: [{ ...mcp, allowedHosts: items }] }),
    ],
    [
      "an MCP server's credentials",
      ['capabilityProposal', 'mcpServers', 0, 'credentials'],
      L.credentials,
      slot,
      (items) => ({ ...emptyCaps, mcpServers: [{ ...mcp, credentials: items }] }),
    ],
    [
      'packages.npm',
      ['capabilityProposal', 'packages', 'npm'],
      L.packages,
      'left-pad',
      (items) => ({ ...emptyCaps, packages: { npm: items, pypi: [] } }),
    ],
    [
      'packages.pypi',
      ['capabilityProposal', 'packages', 'pypi'],
      L.packages,
      'requests',
      (items) => ({ ...emptyCaps, packages: { npm: [], pypi: items } }),
    ],
  ];

  it.each(CASES)('%s: takes the limit', (_label, _path, limit, valid, build) => {
    const items = Array.from({ length: limit }, () => valid);
    const r = SkillProposeRequestSchema.safeParse({ ...validReq, capabilityProposal: build(items) });
    expect(r.success).toBe(true);
  });

  // The request object is `.strict()`; the result must still hold exactly one
  // issue.
  it.each(CASES)('%s: one over fails with only the size issue', (_label, path, limit, _valid, build) => {
    const junk = Array.from({ length: limit + 1 }, () => 0);
    const r = SkillProposeRequestSchema.safeParse({ ...validReq, capabilityProposal: build(junk) });
    expectOnlySizeIssue(r, path, limit);
  });
});
