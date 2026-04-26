import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '../plugin.js';
import type {
  AgentConfig,
  SessionClaimWorkInput,
  SessionClaimWorkOutput,
  SessionCreateInput,
  SessionCreateOutput,
  SessionGetConfigInput,
  SessionGetConfigOutput,
  SessionQueueWorkInput,
  SessionQueueWorkOutput,
  SessionResolveTokenInput,
  SessionResolveTokenOutput,
  SessionTerminateInput,
  SessionTerminateOutput,
} from '../types.js';

const OWNER: { userId: string; agentId: string; agentConfig: AgentConfig } = {
  userId: 'u-1',
  agentId: 'a-1',
  agentConfig: {
    systemPrompt: 'be helpful',
    allowedTools: ['file.read'],
    mcpConfigIds: [],
    model: 'claude-sonnet-4-7',
  },
};

describe('@ax/session-inmemory plugin', () => {
  it('registers all six service hooks on the bus', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    expect(h.bus.hasService('session:create')).toBe(true);
    expect(h.bus.hasService('session:resolve-token')).toBe(true);
    expect(h.bus.hasService('session:get-config')).toBe(true);
    expect(h.bus.hasService('session:queue-work')).toBe(true);
    expect(h.bus.hasService('session:claim-work')).toBe(true);
    expect(h.bus.hasService('session:terminate')).toBe(true);
  });

  it('end-to-end: create -> queue-work -> claim-work round-trips a user-message', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();

    const created = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-rt', workspaceRoot: '/tmp/ws' },
    );
    expect(created.sessionId).toBe('s-rt');
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const queued = await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
      'session:queue-work',
      ctx,
      {
        sessionId: 's-rt',
        entry: {
          type: 'user-message',
          payload: { role: 'user', content: 'hello' },
          reqId: 'r-1',
        },
      },
    );
    expect(queued.cursor).toBe(0);

    const claimed = await h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      ctx,
      { sessionId: 's-rt', cursor: 0, timeoutMs: 500 },
    );
    expect(claimed).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'hello' },
      reqId: 'r-1',
      cursor: 1,
    });
  });

  it("resolve-token returns null after session:terminate", async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();

    const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-term', workspaceRoot: '/tmp/ws' },
    );
    const before = await h.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
      'session:resolve-token',
      ctx,
      { token },
    );
    expect(before).toEqual({
      sessionId: 's-term',
      workspaceRoot: '/tmp/ws',
      userId: null,
      agentId: null,
    });

    const termResult = await h.bus.call<SessionTerminateInput, SessionTerminateOutput>(
      'session:terminate',
      ctx,
      { sessionId: 's-term' },
    );
    expect(termResult).toEqual({});

    const after = await h.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
      'session:resolve-token',
      ctx,
      { token },
    );
    expect(after).toBeNull();
  });

  it('queue-work on unknown session throws PluginError code unknown-session', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        {
          sessionId: 'never-created',
          entry: {
            type: 'user-message',
            payload: { role: 'user', content: 'x' },
            reqId: 'r-x',
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('unknown-session');
  });

  it('claim-work on unknown session throws PluginError code unknown-session', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
        'session:claim-work',
        ctx,
        { sessionId: 'never-created', cursor: 0, timeoutMs: 100 },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('unknown-session');
  });

  it('terminate-then-create with the same sessionId is clean: queue/claim work normally', async () => {
    // Regression: earlier impl lazy-wrote a terminated marker in the inbox
    // on `terminate(unknown)`, which poisoned a subsequent `create` with the
    // same sessionId — the fresh session's first `claim` short-circuited to
    // `timeout` because the stale inbox flag was still set.
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();

    await h.bus.call<SessionTerminateInput, SessionTerminateOutput>(
      'session:terminate',
      ctx,
      { sessionId: 's-reuse' },
    );

    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-reuse', workspaceRoot: '/tmp/ws' },
    );

    await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
      'session:queue-work',
      ctx,
      {
        sessionId: 's-reuse',
        entry: {
          type: 'user-message',
          payload: { role: 'user', content: 'hi' },
          reqId: 'r-reuse',
        },
      },
    );

    const claimed = await h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      ctx,
      { sessionId: 's-reuse', cursor: 0, timeoutMs: 500 },
    );
    expect(claimed).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'hi' },
      reqId: 'r-reuse',
      cursor: 1,
    });
  });

  // ---------------------------------------------------------------------
  // Week 9.5 — owner field on session:create + session:get-config
  // ---------------------------------------------------------------------

  it('session:create with owner round-trips userId/agentId via resolve-token', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();
    const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-own', workspaceRoot: '/tmp/ws', owner: OWNER },
    );
    const resolved = await h.bus.call<
      SessionResolveTokenInput,
      SessionResolveTokenOutput
    >('session:resolve-token', ctx, { token });
    expect(resolved).toEqual({
      sessionId: 's-own',
      workspaceRoot: '/tmp/ws',
      userId: 'u-1',
      agentId: 'a-1',
    });
  });

  it('session:get-config returns the owner+agentConfig when ctx.sessionId is owned', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      h.ctx(),
      { sessionId: 's-cfg', workspaceRoot: '/tmp/ws', owner: OWNER },
    );
    const ctxForGet = h.ctx({ sessionId: 's-cfg' });
    const result = await h.bus.call<SessionGetConfigInput, SessionGetConfigOutput>(
      'session:get-config',
      ctxForGet,
      {},
    );
    expect(result).toEqual({
      userId: 'u-1',
      agentId: 'a-1',
      agentConfig: OWNER.agentConfig,
    });
  });

  it('session:get-config rejects with owner-missing when the session has no owner (pre-9.5 record)', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      h.ctx(),
      { sessionId: 's-legacy', workspaceRoot: '/tmp/ws' },
    );
    let caught: unknown;
    try {
      await h.bus.call<SessionGetConfigInput, SessionGetConfigOutput>(
        'session:get-config',
        h.ctx({ sessionId: 's-legacy' }),
        {},
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('owner-missing');
  });

  it('session:get-config rejects with unknown-session when ctx.sessionId is unknown', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    let caught: unknown;
    try {
      await h.bus.call<SessionGetConfigInput, SessionGetConfigOutput>(
        'session:get-config',
        h.ctx({ sessionId: 'never-existed' }),
        {},
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('unknown-session');
  });

  it('session:create rejects a half-set owner (must include userId AND agentId AND agentConfig)', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    let caught: unknown;
    try {
      await h.bus.call<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        h.ctx(),
        {
          sessionId: 's-half',
          workspaceRoot: '/tmp/ws',
          // Missing agentId on purpose — should fail loudly. I10: a session
          // cannot be "kind of" owned.
          owner: { userId: 'u-1', agentConfig: OWNER.agentConfig } as never,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('queue-work rejects a user-message with a role outside user|assistant|system', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-role', workspaceRoot: '/tmp/ws' },
    );
    let caught: unknown;
    try {
      await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        {
          sessionId: 's-role',
          // Intentionally invalid role to exercise the runtime enum guard.
          entry: {
            type: 'user-message',
            payload: { role: 'admin' as 'user', content: 'hi' },
            reqId: 'r-bad-role',
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('queue-work rejects a user-message with a missing reqId (J9)', async () => {
    // J9: every server-delivered user message MUST carry the host-minted
    // reqId so the runner can stamp event.stream-chunk emissions with it.
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-noreq', workspaceRoot: '/tmp/ws' },
    );
    let caught: unknown;
    try {
      await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        {
          sessionId: 's-noreq',
          // Intentionally missing reqId — the validator must reject this.
          entry: {
            type: 'user-message',
            payload: { role: 'user', content: 'hi' },
          } as unknown as SessionQueueWorkInput['entry'],
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });
});
