import { describe, it, expect } from 'vitest';
import {
  SessionCreateOutputSchema,
  SessionResolveTokenOutputSchema,
  SessionGetConfigOutputSchema,
  SessionQueueWorkOutputSchema,
  SessionClaimWorkOutputSchema,
  SessionTerminateOutputSchema,
  SessionIsAliveOutputSchema,
  type SessionCreateOutput,
  type SessionResolveTokenOutput,
  type SessionGetConfigOutput,
  type SessionClaimWorkOutput,
} from '../plugin.js';

// Drift guards — see @ax/session-inmemory's return-schemas.test.ts. These hand-
// mirror the structurally-identical session-postgres copies of the hook output
// interfaces; the two backends MUST agree on the bus contract.
describe('session-postgres return schemas', () => {
  it('SessionCreateOutputSchema round-trips and rejects junk', () => {
    const full: SessionCreateOutput = { sessionId: 's1', token: 't1' };
    expect(SessionCreateOutputSchema.parse(full)).toEqual(full);
    expect(SessionCreateOutputSchema.safeParse({ sessionId: 's1' }).success).toBe(false);
  });

  it('SessionResolveTokenOutputSchema round-trips populated + null', () => {
    const full: SessionResolveTokenOutput = {
      sessionId: 's1',
      workspaceRoot: '/w',
      userId: 'u1',
      agentId: 'a1',
      conversationId: 'c1',
      // TASK-181 — host-derived origin must round-trip (schema can't strip it).
      source: 'routine',
    };
    expect(SessionResolveTokenOutputSchema.parse(full)).toEqual(full);
    expect(SessionResolveTokenOutputSchema.parse(null)).toBeNull();
  });

  it('SessionGetConfigOutputSchema round-trips a populated value', () => {
    const full: SessionGetConfigOutput = {
      userId: 'u1',
      agentId: 'a1',
      agentConfig: {
        displayName: 'Test Agent',
        systemPromptAugment: 'p',
        allowedTools: ['bash'],
        mcpConfigIds: ['m1'],
        model: 'claude',
      },
      conversationId: 'c1',
    };
    expect(SessionGetConfigOutputSchema.parse(full)).toEqual(full);
  });

  it('SessionQueueWorkOutputSchema validates cursor', () => {
    expect(SessionQueueWorkOutputSchema.parse({ cursor: 3 })).toEqual({ cursor: 3 });
    expect(SessionQueueWorkOutputSchema.safeParse({ cursor: 'x' }).success).toBe(false);
  });

  it('SessionClaimWorkOutputSchema round-trips all three variants', () => {
    const um: SessionClaimWorkOutput = {
      type: 'user-message',
      payload: { role: 'user', content: 'hi', contentBlocks: [{ x: 1 }], turnId: 'T1' },
      reqId: 'r1',
      cursor: 5,
    };
    expect(SessionClaimWorkOutputSchema.parse(um)).toEqual(um);
    expect(SessionClaimWorkOutputSchema.parse({ type: 'cancel', cursor: 6 })).toEqual({
      type: 'cancel',
      cursor: 6,
    });
    expect(SessionClaimWorkOutputSchema.parse({ type: 'timeout', cursor: 7 })).toEqual({
      type: 'timeout',
      cursor: 7,
    });
  });

  it('SessionTerminateOutputSchema accepts {} and rejects extra keys', () => {
    expect(SessionTerminateOutputSchema.parse({})).toEqual({});
    expect(SessionTerminateOutputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('SessionIsAliveOutputSchema validates alive boolean', () => {
    expect(SessionIsAliveOutputSchema.parse({ alive: false })).toEqual({ alive: false });
    expect(SessionIsAliveOutputSchema.safeParse({ alive: 'no' }).success).toBe(false);
  });
});
