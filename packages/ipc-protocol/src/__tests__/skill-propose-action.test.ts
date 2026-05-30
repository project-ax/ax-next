import { describe, it, expect } from 'vitest';
import {
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
