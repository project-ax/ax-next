import { describe, it, expect } from 'vitest';
import {
  AgentIdentityRecordSchema,
  IdentityCompleteBootstrapOutputSchema,
  IdentityGetOutputSchema,
  IdentitySetOutputSchema,
  ResolveOutputSchema,
  type Agent,
  type AgentIdentityRecord,
  type IdentityCompleteBootstrapOutput,
  type IdentitySetOutput,
  type ResolveOutput,
} from '../types.js';

// TASK-989 — the three identity hooks' `returns` contracts.
describe('identity return schemas', () => {
  const record: AgentIdentityRecord = {
    identity: 'I am Pip',
    soul: 'Kind',
    instructions: 'Be brief.',
    bootstrap: 'pending',
    revision: 3,
  };

  it('a record round-trips without losing a field', () => {
    expect(AgentIdentityRecordSchema.parse(record)).toEqual(record);
    expect(IdentityGetOutputSchema.parse(record)).toEqual(record);
  });

  it.each([
    ['a fractional revision', { ...record, revision: 1.5 }],
    ['a negative revision', { ...record, revision: -1 }],
    ['a string revision', { ...record, revision: '3' }],
    ['an unknown bootstrap state', { ...record, bootstrap: 'weird' }],
    ['a missing section', { identity: 'x', soul: 'y', bootstrap: 'none', revision: 0 }],
    ['a non-string section', { ...record, soul: null }],
  ])('a record with %s fails', (_label, value) => {
    expect(AgentIdentityRecordSchema.safeParse(value).success).toBe(false);
    expect(IdentityGetOutputSchema.safeParse(value).success).toBe(false);
  });

  it.each<[string, IdentitySetOutput]>([
    ['saved', { outcome: 'saved', record }],
    ['unchanged', { outcome: 'unchanged', record }],
    ['conflict', { outcome: 'conflict', record }],
    ['refused too-long', { outcome: 'refused', section: 'instructions', code: 'too-long', reason: 'r' }],
    ['refused content', { outcome: 'refused', section: 'soul', code: 'content', reason: 'r' }],
    ['refused scan-unavailable', { outcome: 'refused', section: 'identity', code: 'scan-unavailable', reason: 'r' }],
  ])('set output %s parses unchanged', (_label, value) => {
    expect(IdentitySetOutputSchema.parse(value)).toEqual(value);
  });

  it.each([
    ['a saved outcome with a fractional revision', { outcome: 'saved', record: { ...record, revision: 1.5 } }],
    ['an unknown outcome', { outcome: 'maybe', record }],
    ['a refusal naming an unknown section', { outcome: 'refused', section: 'bootstrap', code: 'content', reason: 'r' }],
    ['a refusal with an unknown code', { outcome: 'refused', section: 'soul', code: 'nope', reason: 'r' }],
    ['a refusal without a reason', { outcome: 'refused', section: 'soul', code: 'content' }],
    ['a saved outcome without a record', { outcome: 'saved' }],
  ])('set output with %s fails', (_label, value) => {
    expect(IdentitySetOutputSchema.safeParse(value).success).toBe(false);
  });

  it.each<IdentityCompleteBootstrapOutput['outcome']>([
    'completed',
    'already-done',
    'not-pending',
    'needs-identity-and-soul',
  ])('complete-bootstrap output %s parses unchanged', (outcome) => {
    const value: IdentityCompleteBootstrapOutput = { outcome, record };
    expect(IdentityCompleteBootstrapOutputSchema.parse(value)).toEqual(value);
  });

  it('complete-bootstrap output rejects an unknown outcome or a bad record', () => {
    expect(IdentityCompleteBootstrapOutputSchema.safeParse({ outcome: 'done', record }).success).toBe(false);
    expect(
      IdentityCompleteBootstrapOutputSchema.safeParse({ outcome: 'completed', record: { ...record, revision: 1.5 } })
        .success,
    ).toBe(false);
  });
});

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
    connectorExclusions: ['notion'],
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

  it('requires connectorExclusions on the resolve output and does not strip it (TASK-739)', () => {
    const { connectorExclusions: _omit, ...without } = agent;
    expect(ResolveOutputSchema.safeParse({ agent: without }).success).toBe(false);
    const parsed = ResolveOutputSchema.parse({ agent }) as { agent: Agent };
    expect(parsed.agent.connectorExclusions).toEqual(['notion']);
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
  // `requestedModel` marks an agent whose model the admin removed (the lazy swap
  // in agents:resolve). The schema strips undeclared keys, so it must be declared.
  it('keeps requestedModel when present and stays valid without it', () => {
    const parsed = ResolveOutputSchema.parse({
      agent: { ...agent, requestedModel: 'openrouter/moonshotai/kimi-k3' },
    }) as { agent: Agent };
    expect(parsed.agent.requestedModel).toBe('openrouter/moonshotai/kimi-k3');
    expect(ResolveOutputSchema.safeParse({ agent }).success).toBe(true);
    expect(ResolveOutputSchema.safeParse({ agent: { ...agent, requestedModel: 7 } }).success).toBe(false);
  });

});
