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
      // TASK-181 — a routine-originated session round-trips its origin so the
      // schema can't silently strip it (which would re-break the happy-path guard).
      source: 'routine',
      // TASK-1091 — audience must round-trip too: a stripped audience makes a
      // shared session's IPC-rebuilt ctx look private.
      audience: 'private',
    };
    expect(SessionResolveTokenOutputSchema.parse(full)).toEqual(full);
    expect(SessionResolveTokenOutputSchema.parse(null)).toBeNull();
    // nullable owner fields are allowed (pre-9.5 sessions); source null = user.
    expect(
      SessionResolveTokenOutputSchema.safeParse({
        sessionId: 's1',
        workspaceRoot: '/w',
        userId: null,
        agentId: null,
        conversationId: null,
        source: null,
        audience: null,
      }).success,
    ).toBe(true);
  });

  it('SessionResolveTokenOutputSchema round-trips source "external" and audience "shared" (TASK-1091)', () => {
    const full: SessionResolveTokenOutput = {
      sessionId: 's1',
      workspaceRoot: '/w',
      userId: 'u1',
      agentId: 'a1',
      conversationId: 'c1',
      source: 'external',
      audience: 'shared',
    };
    expect(SessionResolveTokenOutputSchema.parse(full)).toEqual(full);
    // audience is REQUIRED on the reply (null when unset), so a resolver that
    // forgot it fails loudly at the bus instead of reading as private.
    const { audience: _audience, ...withoutAudience } = full as Exclude<
      SessionResolveTokenOutput,
      null
    >;
    expect(SessionResolveTokenOutputSchema.safeParse(withoutAudience).success).toBe(false);
    expect(
      SessionResolveTokenOutputSchema.safeParse({ ...full, audience: 'public' }).success,
    ).toBe(false);
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
        runner: 'claude-sdk',
      },
      conversationId: 'c1',
    };
    expect(SessionGetConfigOutputSchema.parse(full)).toEqual(full);
    expect(SessionGetConfigOutputSchema.safeParse({ userId: 'u1' }).success).toBe(false);
  });

  it('SessionGetConfigOutputSchema preserves disallowedTools when present', () => {
    const full: SessionGetConfigOutput = {
      userId: 'u1',
      agentId: 'a1',
      agentConfig: {
        displayName: 'Test Agent',
        systemPromptAugment: 'p',
        allowedTools: [],
        disallowedTools: ['Bash'],
        mcpConfigIds: [],
        model: 'claude',
        runner: 'claude-sdk',
      },
      conversationId: 'c1',
    };
    const out = SessionGetConfigOutputSchema.parse(full);
    expect(out.agentConfig.disallowedTools).toEqual(['Bash']);
  });

  it('identity survives the session:get-config returns schema', () => {
    const identity = {
      identity: 'I am Test Agent.',
      soul: 'Calm.',
      instructions: 'Reply in English.',
      bootstrapMode: false,
    };
    const full: SessionGetConfigOutput = {
      userId: 'u1',
      agentId: 'a1',
      agentConfig: {
        displayName: 'Test Agent',
        systemPromptAugment: 'p',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude',
        runner: 'claude-sdk',
        identity,
      },
      conversationId: 'c1',
    };
    const out = SessionGetConfigOutputSchema.parse(full);
    expect(out.agentConfig.identity).toEqual(identity);
  });

  it('SessionGetConfigOutputSchema preserves systemPromptBootstrapAugment when present', () => {
    const full: SessionGetConfigOutput = {
      userId: 'u1',
      agentId: 'a1',
      agentConfig: {
        displayName: 'Test Agent',
        systemPromptAugment: 'p',
        systemPromptBootstrapAugment: 'rules-content',
        allowedTools: ['bash'],
        mcpConfigIds: ['m1'],
        model: 'claude',
        runner: 'claude-sdk',
      },
      conversationId: 'c1',
    };
    const out = SessionGetConfigOutputSchema.parse(full);
    expect(out.agentConfig.systemPromptBootstrapAugment).toBe('rules-content');
  });

  it('SessionGetConfigOutputSchema leaves systemPromptBootstrapAugment absent when omitted', () => {
    const full: SessionGetConfigOutput = {
      userId: 'u1',
      agentId: 'a1',
      agentConfig: {
        displayName: 'Test Agent',
        systemPromptAugment: 'p',
        allowedTools: ['bash'],
        mcpConfigIds: ['m1'],
        model: 'claude',
        runner: 'claude-sdk',
      },
      conversationId: 'c1',
    };
    const out = SessionGetConfigOutputSchema.parse(full);
    expect('systemPromptBootstrapAugment' in out.agentConfig).toBe(false);
  });

  it('SessionQueueWorkOutputSchema validates cursor', () => {
    expect(SessionQueueWorkOutputSchema.parse({ cursor: 3 })).toEqual({ cursor: 3 });
    expect(SessionQueueWorkOutputSchema.safeParse({ cursor: 'x' }).success).toBe(false);
  });

  it('SessionClaimWorkOutputSchema round-trips all five variants', () => {
    const um: SessionClaimWorkOutput = {
      type: 'user-message',
      payload: { role: 'user', content: 'hi', contentBlocks: [{ x: 1 }], turnId: 'T1' },
      reqId: 'r1',
      cursor: 5,
    };
    expect(SessionClaimWorkOutputSchema.parse(um)).toEqual(um);

    const cancel: SessionClaimWorkOutput = { type: 'cancel', cursor: 6 };
    expect(SessionClaimWorkOutputSchema.parse(cancel)).toEqual(cancel);

    // TASK-688. The `returns` contract the bus validates `session:claim-work`
    // against: a discriminated union REFUSES an undeclared discriminator, so an
    // interrupt missing here would fail at the hook boundary (never reaching the
    // runner) instead of being delivered.
    const interrupt: SessionClaimWorkOutput = { type: 'interrupt', cursor: 12 };
    expect(SessionClaimWorkOutputSchema.parse(interrupt)).toEqual(interrupt);

    const timeout: SessionClaimWorkOutput = { type: 'timeout', cursor: 7 };
    expect(SessionClaimWorkOutputSchema.parse(timeout)).toEqual(timeout);

    // AW-6's fourth variant. A `z.discriminatedUnion` REFUSES an undeclared
    // discriminator outright (it does not strip like a `z.object`), so a
    // variant missing from this schema is a hard hook-boundary failure, not a
    // silently-dropped field.
    const resolved: SessionClaimWorkOutput = {
      type: 'decision-resolved',
      decisionId: 'dec_1',
      outcome: 'approved',
      note: 'They said yes.',
      cursor: 8,
    };
    expect(SessionClaimWorkOutputSchema.parse(resolved)).toEqual(resolved);

    // TASK-278: the continuation correlation rides the same arm, optional.
    const resolvedCont: SessionClaimWorkOutput = {
      type: 'decision-resolved',
      decisionId: 'dec_1',
      outcome: 'approved',
      note: 'They said yes.',
      reqId: 'req-continuation-1',
      cursor: 9,
    };
    expect(SessionClaimWorkOutputSchema.parse(resolvedCont)).toEqual(resolvedCont);
    expect(
      SessionClaimWorkOutputSchema.safeParse({ ...resolvedCont, reqId: '' }).success,
    ).toBe(false);

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
