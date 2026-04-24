import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '../plugin.js';
import type {
  SessionClaimWorkInput,
  SessionClaimWorkOutput,
  SessionCreateInput,
  SessionCreateOutput,
  SessionQueueWorkInput,
  SessionQueueWorkOutput,
  SessionResolveTokenInput,
  SessionResolveTokenOutput,
  SessionTerminateInput,
  SessionTerminateOutput,
} from '../types.js';

describe('@ax/session-inmemory plugin', () => {
  it('registers all five service hooks on the bus', async () => {
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    expect(h.bus.hasService('session:create')).toBe(true);
    expect(h.bus.hasService('session:resolve-token')).toBe(true);
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
        entry: { type: 'user-message', payload: { role: 'user', content: 'hello' } },
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
    expect(before).toEqual({ sessionId: 's-term', workspaceRoot: '/tmp/ws' });

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
          entry: { type: 'user-message', payload: { role: 'user', content: 'x' } },
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
});
