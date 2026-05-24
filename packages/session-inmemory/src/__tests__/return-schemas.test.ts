import { describe, it, expect } from 'vitest';
import {
  SessionCreateOutputSchema,
  SessionResolveTokenOutputSchema,
  SessionGetConfigOutputSchema,
  SessionQueueWorkOutputSchema,
  SessionClaimWorkOutputSchema,
  SessionTerminateOutputSchema,
  SessionIsAliveOutputSchema,
} from '../types.js';
import type {
  SessionCreateOutput,
  SessionResolveTokenOutput,
  SessionGetConfigOutput,
  SessionClaimWorkOutput,
} from '../types.js';

// Drift guards: each fully-populated interface value must round-trip through
// its schema without losing fields. A new required interface field fails at
// compile time (the `: Type` annotation); a new optional one fails at runtime
// (the schema strips it, diverging the deep-equal).
describe('session return schemas', () => {
  it('SessionCreateOutputSchema round-trips and rejects junk', () => {
    const full: SessionCreateOutput = { sessionId: 's1', token: 't1' };
    expect(SessionCreateOutputSchema.parse(full)).toEqual(full);
    expect(SessionCreateOutputSchema.safeParse({ sessionId: 's1' }).success).toBe(false);
  });

  it('SessionResolveTokenOutputSchema round-trips a populated value and accepts null', () => {
    const full: SessionResolveTokenOutput = {
      sessionId: 's1',
      workspaceRoot: '/w',
      userId: 'u1',
      agentId: 'a1',
      conversationId: 'c1',
    };
    expect(SessionResolveTokenOutputSchema.parse(full)).toEqual(full);
    expect(SessionResolveTokenOutputSchema.parse(null)).toBeNull();
    // nullable owner fields are allowed (pre-9.5 sessions)
    expect(
      SessionResolveTokenOutputSchema.safeParse({
        sessionId: 's1',
        workspaceRoot: '/w',
        userId: null,
        agentId: null,
        conversationId: null,
      }).success,
    ).toBe(true);
  });

  it('SessionGetConfigOutputSchema round-trips a populated value', () => {
    const full: SessionGetConfigOutput = {
      userId: 'u1',
      agentId: 'a1',
      agentConfig: {
        systemPrompt: 'p',
        allowedTools: ['bash'],
        mcpConfigIds: ['m1'],
        model: 'claude',
      },
      conversationId: 'c1',
    };
    expect(SessionGetConfigOutputSchema.parse(full)).toEqual(full);
    expect(SessionGetConfigOutputSchema.safeParse({ userId: 'u1' }).success).toBe(false);
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

    const cancel: SessionClaimWorkOutput = { type: 'cancel', cursor: 6 };
    expect(SessionClaimWorkOutputSchema.parse(cancel)).toEqual(cancel);

    const timeout: SessionClaimWorkOutput = { type: 'timeout', cursor: 7 };
    expect(SessionClaimWorkOutputSchema.parse(timeout)).toEqual(timeout);

    expect(SessionClaimWorkOutputSchema.safeParse({ type: 'bogus', cursor: 1 }).success).toBe(
      false,
    );
  });

  it('SessionTerminateOutputSchema accepts {} and rejects extra keys', () => {
    expect(SessionTerminateOutputSchema.parse({})).toEqual({});
    expect(SessionTerminateOutputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('SessionIsAliveOutputSchema validates alive boolean', () => {
    expect(SessionIsAliveOutputSchema.parse({ alive: true })).toEqual({ alive: true });
    expect(SessionIsAliveOutputSchema.safeParse({ alive: 'yes' }).success).toBe(false);
  });
});
