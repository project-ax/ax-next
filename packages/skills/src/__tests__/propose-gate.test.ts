import { describe, it, expect } from 'vitest';
import { classifyProposal, hasAnyCapability } from '../propose-gate.js';
import type { SkillCapabilities } from '@ax/skills-parser';

const empty: SkillCapabilities = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

describe('hasAnyCapability', () => {
  it('false for zero-capability', () => {
    expect(hasAnyCapability(empty)).toBe(false);
  });
  it('true for hosts / credentials / mcp / packages', () => {
    expect(hasAnyCapability({ ...empty, allowedHosts: ['api.linear.app'] })).toBe(true);
    expect(
      hasAnyCapability({ ...empty, credentials: [{ slot: 'K', kind: 'api-key' }] }),
    ).toBe(true);
    expect(
      hasAnyCapability({
        ...empty,
        mcpServers: [
          { name: 'm', transport: 'http', allowedHosts: [], credentials: [], url: 'x' },
        ],
      }),
    ).toBe(true);
    expect(hasAnyCapability({ ...empty, packages: { npm: ['x'], pypi: [] } })).toBe(true);
    expect(hasAnyCapability({ ...empty, packages: { npm: [], pypi: ['y'] } })).toBe(true);
  });
});

describe('classifyProposal — the hybrid materialization gate (design §D3)', () => {
  it('FREE: clean + authored + zero-cap → active', () => {
    expect(
      classifyProposal({ origin: 'authored', capabilityProposal: empty, scanClean: true }),
    ).toBe('active');
  });

  it('GATED: any capability → pending (even authored + clean)', () => {
    expect(
      classifyProposal({
        origin: 'authored',
        capabilityProposal: { ...empty, allowedHosts: ['api.linear.app'] },
        scanClean: true,
      }),
    ).toBe('pending');
    expect(
      classifyProposal({
        origin: 'authored',
        capabilityProposal: { ...empty, credentials: [{ slot: 'K', kind: 'api-key' }] },
        scanClean: true,
      }),
    ).toBe('pending');
  });

  it('GATED: non-authored origin → pending even at zero-cap (provenance gate)', () => {
    expect(
      classifyProposal({ origin: 'imported', capabilityProposal: empty, scanClean: true }),
    ).toBe('pending');
    expect(
      classifyProposal({ origin: 'attached', capabilityProposal: empty, scanClean: true }),
    ).toBe('pending');
  });

  it('QUARANTINE: a scan hit quarantines regardless of provenance/caps', () => {
    expect(
      classifyProposal({ origin: 'authored', capabilityProposal: empty, scanClean: false }),
    ).toBe('quarantined');
    expect(
      classifyProposal({
        origin: 'authored',
        capabilityProposal: { ...empty, allowedHosts: ['x'] },
        scanClean: false,
      }),
    ).toBe('quarantined');
  });
});
