import { describe, it, expect } from 'vitest';
import { ResolveOutputSchema, type Agent, type ResolveOutput } from '../types.js';

describe('agents return schemas', () => {
  const agent: Agent = {
    id: 'ag1',
    ownerId: 'u1',
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'Helper',
    systemPrompt: 'be helpful',
    allowedTools: ['bash', 'web-search'],
    mcpConfigIds: ['m1'],
    model: 'claude',
    workspaceRef: 'v123',
    skillAttachments: [{ skillId: 's1', credentialBindings: { slotA: 'ref1' } }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  it('accepts a fully-populated agent', () => {
    expect(ResolveOutputSchema.safeParse({ agent }).success).toBe(true);
  });

  it('accepts a null workspaceRef and empty skillAttachments', () => {
    expect(
      ResolveOutputSchema.safeParse({
        agent: { ...agent, workspaceRef: null, skillAttachments: [] },
      }).success,
    ).toBe(true);
  });

  it('rejects a missing agent', () => {
    expect(ResolveOutputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-array allowedTools', () => {
    expect(
      ResolveOutputSchema.safeParse({ agent: { ...agent, allowedTools: 'bash' } }).success,
    ).toBe(false);
  });

  it('rejects an invalid visibility', () => {
    expect(
      ResolveOutputSchema.safeParse({ agent: { ...agent, visibility: 'public' } }).success,
    ).toBe(false);
  });

  it('rejects a string createdAt (handler returns a Date)', () => {
    expect(
      ResolveOutputSchema.safeParse({ agent: { ...agent, createdAt: '2026-01-01' } }).success,
    ).toBe(false);
  });

  // Drift guard: a fully-populated interface value must round-trip without
  // losing fields. A Date round-trips identity; toEqual compares value.
  it('round-trips a fully-populated ResolveOutput without stripping fields', () => {
    const full: ResolveOutput = { agent };
    expect(ResolveOutputSchema.parse(full)).toEqual(full);
  });
});
