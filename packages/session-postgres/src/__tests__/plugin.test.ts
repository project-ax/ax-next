import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness } from '@ax/test-harness';
import { PluginError } from '@ax/core';
import {
  createSessionPostgresPlugin,
  type SessionClaimWorkInput,
  type SessionClaimWorkOutput,
  type SessionCreateInput,
  type SessionCreateOutput,
  type SessionGetConfigInput,
  type SessionGetConfigOutput,
  type SessionQueueWorkInput,
  type SessionQueueWorkOutput,
  type SessionResolveTokenInput,
  type SessionResolveTokenOutput,
  type SessionTerminateInput,
  type SessionTerminateOutput,
} from '../plugin.js';
import type { AgentConfig } from '../store.js';

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

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: Awaited<ReturnType<typeof createTestHarness>>[] = [];

async function makeHarness() {
  const plugin = createSessionPostgresPlugin({ connectionString });
  const h = await createTestHarness({ plugins: [plugin] });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  // Drain plugins (LISTEN client + pool) before clearing tables and
  // moving on. Without this the next test sees rows leftover from this
  // one's INSERTs. The harness drives Plugin.shutdown for us; onError is
  // a no-op sink because tests deliberately exercise teardown edge cases
  // and we don't want stderr noise.
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Clean state between tests by dropping the per-plugin tables. The
  // next test's plugin re-creates them via runSessionMigration.
  // We open a one-shot client for the cleanup since the plugin's pool
  // is already drained.
  const pg = await import('pg');
  const cleanupClient = new pg.default.Client({ connectionString });
  await cleanupClient.connect();
  try {
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v2_session_agent');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_inbox');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_sessions');
  } finally {
    await cleanupClient.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

describe('@ax/session-postgres plugin', () => {
  it('registers all six service hooks on the bus', async () => {
    const h = await makeHarness();
    expect(h.bus.hasService('session:create')).toBe(true);
    expect(h.bus.hasService('session:resolve-token')).toBe(true);
    expect(h.bus.hasService('session:get-config')).toBe(true);
    expect(h.bus.hasService('session:queue-work')).toBe(true);
    expect(h.bus.hasService('session:claim-work')).toBe(true);
    expect(h.bus.hasService('session:terminate')).toBe(true);
  });

  it('session:create mints a base64url token; duplicate sessionId throws PluginError', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    const created = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-1', workspaceRoot: '/tmp/ws' },
    );
    expect(created.sessionId).toBe('s-1');
    expect(created.token).toMatch(TOKEN_RE);

    let caught: unknown;
    try {
      await h.bus.call<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        ctx,
        { sessionId: 's-1', workspaceRoot: '/tmp/ws-2' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('duplicate-session');
  });

  it('session:resolve-token returns sessionId+workspaceRoot for valid token; null for unknown', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-rt', workspaceRoot: '/tmp/ws' },
    );
    const ok = await h.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
      'session:resolve-token',
      ctx,
      { token },
    );
    expect(ok).toEqual({
      sessionId: 's-rt',
      workspaceRoot: '/tmp/ws',
      userId: null,
      agentId: null,
    });

    const miss = await h.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
      'session:resolve-token',
      ctx,
      { token: 'definitely-not-a-real-token-1234567890123456789' },
    );
    expect(miss).toBeNull();
  });

  it('session:resolve-token returns null after terminate (terminated session is observably gone)', async () => {
    const h = await makeHarness();
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

    await h.bus.call<SessionTerminateInput, SessionTerminateOutput>(
      'session:terminate',
      ctx,
      { sessionId: 's-term' },
    );

    const after = await h.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
      'session:resolve-token',
      ctx,
      { token },
    );
    expect(after).toBeNull();
  });

  it('session:queue-work increments cursor and persists; claim-work delivers in order', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-q', workspaceRoot: '/tmp/ws' },
    );
    const q0 = await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
      'session:queue-work',
      ctx,
      {
        sessionId: 's-q',
        entry: {
          type: 'user-message',
          payload: { role: 'user', content: 'a' },
          reqId: 'r-a',
        },
      },
    );
    expect(q0.cursor).toBe(0);

    const q1 = await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
      'session:queue-work',
      ctx,
      {
        sessionId: 's-q',
        entry: {
          type: 'user-message',
          payload: { role: 'user', content: 'b' },
          reqId: 'r-b',
        },
      },
    );
    expect(q1.cursor).toBe(1);

    const c0 = await h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      ctx,
      { sessionId: 's-q', cursor: 0, timeoutMs: 500 },
    );
    expect(c0).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'a' },
      reqId: 'r-a',
      cursor: 1,
    });
    const c1 = await h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      ctx,
      { sessionId: 's-q', cursor: 1, timeoutMs: 500 },
    );
    expect(c1).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'b' },
      reqId: 'r-b',
      cursor: 2,
    });
  });

  it('session:queue-work on unknown session throws PluginError code unknown-session', async () => {
    const h = await makeHarness();
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

  it('session:claim-work on unknown session throws PluginError code unknown-session', async () => {
    const h = await makeHarness();
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

  it('session:claim-work blocks then times out with echo cursor when no entry arrives', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-to', workspaceRoot: '/tmp/ws' },
    );
    const start = Date.now();
    const result = await h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      ctx,
      { sessionId: 's-to', cursor: 0, timeoutMs: 200 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150); // jitter
    expect(result).toEqual({ type: 'timeout', cursor: 0 });
  });

  it('session:claim-work wakes via LISTEN/NOTIFY when queue-work fires (single instance)', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-wake', workspaceRoot: '/tmp/ws' },
    );
    const claimP = h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      ctx,
      { sessionId: 's-wake', cursor: 0, timeoutMs: 5000 },
    );
    // Give the LISTEN time to install before queueing.
    await new Promise((r) => setTimeout(r, 100));
    await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
      'session:queue-work',
      ctx,
      {
        sessionId: 's-wake',
        entry: {
          type: 'user-message',
          payload: { role: 'user', content: 'hi' },
          reqId: 'r-wake',
        },
      },
    );
    const start = Date.now();
    const result = await claimP;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(result).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'hi' },
      reqId: 'r-wake',
      cursor: 1,
    });
  });

  it('session:terminate is idempotent (calling twice does not throw)', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-idem', workspaceRoot: '/tmp/ws' },
    );
    await h.bus.call<SessionTerminateInput, SessionTerminateOutput>(
      'session:terminate',
      ctx,
      { sessionId: 's-idem' },
    );
    await h.bus.call<SessionTerminateInput, SessionTerminateOutput>(
      'session:terminate',
      ctx,
      { sessionId: 's-idem' },
    );
    // And terminate on an unknown session is a no-op too:
    await h.bus.call<SessionTerminateInput, SessionTerminateOutput>(
      'session:terminate',
      ctx,
      { sessionId: 'never-existed' },
    );
  });

  it('session:terminate during a blocked claim resolves the claim as timeout', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-term-claim', workspaceRoot: '/tmp/ws' },
    );
    const claimP = h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      ctx,
      { sessionId: 's-term-claim', cursor: 0, timeoutMs: 5000 },
    );
    // Let the claim install its LISTEN.
    await new Promise((r) => setTimeout(r, 100));
    await h.bus.call<SessionTerminateInput, SessionTerminateOutput>(
      'session:terminate',
      ctx,
      { sessionId: 's-term-claim' },
    );
    const start = Date.now();
    const result = await claimP;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // not waiting the full 5s
    expect(result).toEqual({ type: 'timeout', cursor: 0 });
  });

  it('cross-instance: claim on instance A wakes via NOTIFY when queue-work fires on instance B', async () => {
    const a = await makeHarness();
    const b = await makeHarness();
    const ctxA = a.ctx();
    const ctxB = b.ctx();

    // Both instances see the same session because they share a database.
    // session:create on instance A; instance B sees it via the same row.
    await a.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctxA,
      { sessionId: 's-cross', workspaceRoot: '/tmp/ws' },
    );

    const claimP = a.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      ctxA,
      { sessionId: 's-cross', cursor: 0, timeoutMs: 5000 },
    );
    // Give A's LISTEN time to install.
    await new Promise((r) => setTimeout(r, 100));

    // Queue on B.
    await b.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
      'session:queue-work',
      ctxB,
      {
        sessionId: 's-cross',
        entry: {
          type: 'user-message',
          payload: { role: 'user', content: 'from-B' },
          reqId: 'r-cross',
        },
      },
    );

    const start = Date.now();
    const result = await claimP;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(result).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'from-B' },
      reqId: 'r-cross',
      cursor: 1,
    });
  });

  // ---------------------------------------------------------------------
  // Week 9.5 — owner field on session:create + session:get-config
  // ---------------------------------------------------------------------

  it('session:create with owner round-trips userId/agentId via resolve-token', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-own', workspaceRoot: '/tmp/ws', owner: OWNER },
    );
    const resolved = await h.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
      'session:resolve-token',
      ctx,
      { token },
    );
    expect(resolved).toEqual({
      sessionId: 's-own',
      workspaceRoot: '/tmp/ws',
      userId: 'u-1',
      agentId: 'a-1',
    });
  });

  it('session:get-config returns the full owner+agentConfig when ctx.sessionId is owned', async () => {
    const h = await makeHarness();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      h.ctx(),
      { sessionId: 's-cfg', workspaceRoot: '/tmp/ws', owner: OWNER },
    );
    const result = await h.bus.call<SessionGetConfigInput, SessionGetConfigOutput>(
      'session:get-config',
      h.ctx({ sessionId: 's-cfg' }),
      {},
    );
    expect(result).toEqual({
      userId: 'u-1',
      agentId: 'a-1',
      agentConfig: OWNER.agentConfig,
      conversationId: null,
    });
  });

  it('session:get-config returns conversationId when owner carries one (Task 15)', async () => {
    const h = await makeHarness();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      h.ctx(),
      {
        sessionId: 's-conv',
        workspaceRoot: '/tmp/ws',
        owner: { ...OWNER, conversationId: 'cnv_test_1' },
      },
    );
    const result = await h.bus.call<SessionGetConfigInput, SessionGetConfigOutput>(
      'session:get-config',
      h.ctx({ sessionId: 's-conv' }),
      {},
    );
    expect(result.conversationId).toBe('cnv_test_1');
  });

  it('session:create rejects an empty-string owner.conversationId', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        h.ctx(),
        {
          sessionId: 's-bad-cid',
          workspaceRoot: '/tmp/ws',
          owner: { ...OWNER, conversationId: '' as unknown as string | null },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('session:get-config rejects with owner-missing when the session has no v2 row (pre-9.5)', async () => {
    const h = await makeHarness();
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
    const h = await makeHarness();
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

  it('session:create with a half-set owner is rejected as invalid-payload', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        h.ctx(),
        {
          sessionId: 's-half',
          workspaceRoot: '/tmp/ws',
          owner: { userId: 'u-1', agentConfig: OWNER.agentConfig } as never,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('session:create with owner is atomic — duplicate sessionId leaves no v2 row', async () => {
    const h = await makeHarness();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      h.ctx(),
      { sessionId: 's-atomic', workspaceRoot: '/tmp/ws', owner: OWNER },
    );
    let caught: unknown;
    try {
      await h.bus.call<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        h.ctx(),
        {
          sessionId: 's-atomic',
          workspaceRoot: '/tmp/ws',
          owner: { ...OWNER, agentId: 'a-different' },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('duplicate-session');
    // The v2 row must still match the FIRST insert — the failed second
    // insert was a transaction that rolled back.
    const cfg = await h.bus.call<SessionGetConfigInput, SessionGetConfigOutput>(
      'session:get-config',
      h.ctx({ sessionId: 's-atomic' }),
      {},
    );
    expect(cfg.agentId).toBe('a-1');
  });

  it('queue-work rejects a user-message with a role outside user|assistant|system', async () => {
    const h = await makeHarness();
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
    // reqId. Validator runs at queue-work; the row must never make it
    // into the inbox table without a reqId.
    const h = await makeHarness();
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-noreq-pg', workspaceRoot: '/tmp/ws' },
    );
    let caught: unknown;
    try {
      await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        {
          sessionId: 's-noreq-pg',
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
