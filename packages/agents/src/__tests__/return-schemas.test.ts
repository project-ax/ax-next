import { describe, it, expect } from 'vitest';
import { ResolveOutputSchema, type Agent, type ResolveOutput } from '../types.js';

describe('agents return schemas', () => {
  const agent: Agent = {
    id: 'ag1',
    ownerId: 'u1',
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'Helper',
    allowedTools: ['bash', 'web-search'],
    mcpConfigIds: ['m1'],
    model: 'anthropic/claude-sonnet-4-6',
    runner: 'claude-sdk',
    workspaceRef: 'v123',
    skillAttachments: [{ skillId: 's1', credentialBindings: { slotA: 'ref1' } }],
    connectorAttachments: ['salesforce', 'gh'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  it('accepts a fully-populated agent', () => {
    expect(ResolveOutputSchema.safeParse({ agent }).success).toBe(true);
  });

  it('requires connectorAttachments on the resolve output (TASK-107)', () => {
    const { connectorAttachments: _omit, ...withoutConnectors } = agent;
    expect(
      ResolveOutputSchema.safeParse({ agent: withoutConnectors }).success,
    ).toBe(false);
    expect(
      ResolveOutputSchema.safeParse({
        agent: { ...agent, connectorAttachments: 'gh' },
      }).success,
    ).toBe(false);
  });

  // PR 2 — `AgentSchema` is the `returns` schema on `agents:resolve` and zod
  // object schemas STRIP undeclared keys. If `runner` were missing here the
  // field would vanish silently between the store and the orchestrator.
  it('requires runner on the resolve output and does not strip it', () => {
    const { runner: _omit, ...withoutRunner } = agent;
    expect(ResolveOutputSchema.safeParse({ agent: withoutRunner }).success).toBe(
      false,
    );
    expect(
      ResolveOutputSchema.safeParse({ agent: { ...agent, runner: 'nope' } })
        .success,
    ).toBe(false);
    const parsed = ResolveOutputSchema.parse({ agent }) as { agent: Agent };
    expect(parsed.agent.runner).toBe('claude-sdk');
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
