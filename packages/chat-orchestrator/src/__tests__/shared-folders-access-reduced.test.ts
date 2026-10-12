import { describe, it, expect } from 'vitest';
import {
  HookBus, makeAgentContext, createLogger,
  type AgentContext, type AgentOutcome, type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// W2 (shared folders) — the orchestrator asks `sharedFolderIdsFor` which
// shared folders a session should mount, passes them to `sandbox:open-session`,
// and remembers them per session. `shared-folders:access-reduced` (a revoke,
// a downgrade, a delete) then follows the TASK-833/877 connector-delete
// precedent: an idle session holding that folder is reaped at once (proxy
// session closed first), a session mid-turn is reaped when the turn ends, and a
// marked session that a message beats the reaper to is retired at routing.

const TEST_AGENT = {
  id: 'test-agent', ownerId: 'test-user', ownerType: 'user' as const,
  visibility: 'personal' as const, displayName: 'Test',
  allowedTools: ['file.read'], mcpConfigIds: [], model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk', workspaceRef: null,
};

function makeHandle() {
  let resolveExit!: () => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveExit = () => res({ code: 0, signal: null });
  });
  const state = { kills: 0 };
  return {
    state,
    handle: {
      kill: async () => { state.kills += 1; resolveExit(); },
      exited,
    },
    forceExit: () => resolveExit(),
  };
}

function fireTurnEnd(bus: HookBus, sessionId: string, reqId: string) {
  setImmediate(() => {
    void bus.fire('chat:turn-end',
      makeAgentContext({ sessionId, agentId: 'a', userId: 'u', reqId: 'ipc-fresh',
        logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }) }),
      { reason: 'user-message-wait', reqId });
  });
}

type FolderSource = (
  ctx: AgentContext,
  input: { agentId: string; conversationId?: string },
) => Promise<readonly string[]> | readonly string[];

async function setup(opts: {
  sharedFolderIdsFor?: FolderSource;
  runnerExitsOnKill?: boolean;
  idleWindowMs?: number;
  idleGraceMs?: number;
  /** Runs inside the fake `sandbox:open-session`, before it returns. */
  duringOpen?: (fire: (payload: unknown) => Promise<void>) => Promise<void>;
} = {}) {
  const conv = { activeSessionId: null as string | null };
  const live = new Set<string>();
  const handles = [makeHandle(), makeHandle(), makeHandle()];
  if (opts.runnerExitsOnKill === false) {
    for (const hk of handles) {
      hk.handle.kill = async () => { hk.state.kills += 1; };
    }
  }
  let opens = 0;
  const openInputs: Array<Record<string, unknown>> = [];
  const queued: Array<{ sessionId: string; type: string }> = [];
  const terminated: string[] = [];
  const proxyCloses: string[] = [];
  const logs: Array<Record<string, unknown>> = [];

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
    'session:queue-work': async (_c, input: unknown) => {
      const i = input as { sessionId: string; entry: { type: string } };
      queued.push({ sessionId: i.sessionId, type: i.entry.type });
      return { cursor: 0 };
    },
    'session:terminate': async (_c, input: unknown) => {
      const sid = (input as { sessionId: string }).sessionId;
      terminated.push(sid);
      live.delete(sid);
      return {};
    },
    'session:is-alive': async (_c, input: unknown) => ({
      alive: live.has((input as { sessionId: string }).sessionId),
    }),
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      return { conversation: {
        conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent',
        activeSessionId: conv.activeSessionId, activeReqId: null,
      } };
    },
    'conversations:bind-session': async (_c, input: unknown) => {
      const i = input as { sessionId: string };
      conv.activeSessionId = i.sessionId;
      live.add(i.sessionId);
      return undefined;
    },
    'sandbox:open-session': async (_c, input: unknown) => {
      openInputs.push(input as Record<string, unknown>);
      if (opts.duringOpen !== undefined) await opts.duringOpen((payload) => reduce(payload));
      const hk = handles[opens]!;
      opens += 1;
      return { runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle };
    },
    'proxy:open-session': async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32),
    }),
    'proxy:close-session': async (_c, input: unknown) => {
      proxyCloses.push((input as { sessionId: string }).sessionId);
      return {};
    },
  };

  const plugin = createChatOrchestratorPlugin({
    runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
    keepAlive: true, idleWindowMs: opts.idleWindowMs ?? 60_000, idleGraceMs: opts.idleGraceMs ?? 5,
    ...(opts.sharedFolderIdsFor !== undefined ? { sharedFolderIdsFor: opts.sharedFolderIdsFor } : {}),
  });
  const h = await createTestHarness({ services, plugins: [plugin] });

  const mkCtx = (sessionId: string, reqId: string) =>
    makeAgentContext({
      sessionId, agentId: 'test-agent', userId: 'test-user',
      conversationId: 'conv-1', reqId,
      logger: createLogger({
        reqId,
        writer: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); },
      }),
    });

  const turn = async (sessionId: string, reqId: string, beforeTurnEnd?: () => Promise<void>) => {
    if (beforeTurnEnd === undefined) {
      fireTurnEnd(h.bus, sessionId, reqId);
    } else {
      setImmediate(() => {
        void beforeTurnEnd().then(() => fireTurnEnd(h.bus, sessionId, reqId));
      });
    }
    return h.bus.call<unknown, AgentOutcome>('agent:invoke', mkCtx(sessionId, reqId),
      { message: { role: 'user', content: 'hi' } });
  };

  async function reduce(payload: unknown): Promise<void> {
    await h.bus.fire('shared-folders:access-reduced', mkCtx('admin-revoke', 'req-revoke'), payload);
  }

  const settle = () => new Promise((r) => setTimeout(r, 50));
  const cancels = (sid: string) => queued.filter((q) => q.sessionId === sid && q.type === 'cancel');
  const userMessages = (sid: string) =>
    queued.filter((q) => q.sessionId === sid && q.type === 'user-message');

  return {
    plugin, h, handles, turn, reduce, settle, cancels, userMessages,
    get opens() { return opens; },
    openInputs, queued, terminated, proxyCloses, logs,
    cleanup: () => { for (const hk of handles) hk.forceExit(); },
  };
}

const withFolders = (ids: readonly string[]): FolderSource => () => ids;

describe('W2: sharedFolderIdsFor reaches sandbox:open-session', () => {
  it('passes the folder ids the source returns', async () => {
    const seen: Array<{ agentId: string; conversationId?: string }> = [];
    const t = await setup({
      sharedFolderIdsFor: (_ctx, input) => { seen.push(input); return ['sf_a']; },
    });
    await t.turn('s-1', 'req-1');
    expect(t.openInputs[0]!.sharedFolderIds).toEqual(['sf_a']);
    expect(seen).toEqual([{ agentId: 'test-agent', conversationId: 'conv-1' }]);
    t.cleanup();
  });

  it('without the option the field is absent', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    expect('sharedFolderIds' in t.openInputs[0]!).toBe(false);
    t.cleanup();
  });

  it('an empty list sends no field', async () => {
    const t = await setup({ sharedFolderIdsFor: withFolders([]) });
    await t.turn('s-1', 'req-1');
    expect('sharedFolderIds' in t.openInputs[0]!).toBe(false);
    t.cleanup();
  });

  it('drops invalid ids, dedupes, and caps at 16', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `sf_n${i}`);
    const t = await setup({
      sharedFolderIdsFor: withFolders(['sf_a', '../etc', 'sf_a', 'sf_b/c', '', ...many]),
    });
    await t.turn('s-1', 'req-1');
    const ids = t.openInputs[0]!.sharedFolderIds as string[];
    expect(ids).toEqual(['sf_a', ...many.slice(0, 15)]);
    expect(t.logs.some((l) => l.msg === 'shared_folder_ids_dropped')).toBe(true);
    t.cleanup();
  });

  it('only invalid ids → no field', async () => {
    const t = await setup({ sharedFolderIdsFor: withFolders(['nope', '..']) });
    await t.turn('s-1', 'req-1');
    expect('sharedFolderIds' in t.openInputs[0]!).toBe(false);
    t.cleanup();
  });

  it('a throwing source fails the session open (fail closed)', async () => {
    const t = await setup({
      sharedFolderIdsFor: async () => { throw new Error('boom'); },
    });
    const out = await t.turn('s-1', 'req-1');
    expect(out).toMatchObject({ kind: 'terminated', reason: 'sandbox-open-failed' });
    expect(t.opens).toBe(0);
    expect(t.logs.some((l) => l.msg === 'shared_folder_ids_for_failed')).toBe(true);
    t.cleanup();
  });
});

describe('W2: shared-folders:access-reduced retires sessions holding the folder', () => {
  it('the manifest subscribes to the event', async () => {
    const t = await setup();
    expect(t.plugin.manifest.subscribes).toContain('shared-folders:access-reduced');
    t.cleanup();
  });

  it('reaps an IDLE session that requested the folder at once, and the next turn spawns fresh', async () => {
    const t = await setup({ sharedFolderIdsFor: withFolders(['sf_a']) });
    await t.turn('s-1', 'req-1');
    expect(t.proxyCloses).not.toContain('s-1');

    await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
    await t.settle();

    expect(t.cancels('s-1')).toHaveLength(1);
    expect(t.handles[0]!.state.kills).toBeGreaterThanOrEqual(1);
    expect(t.proxyCloses).toContain('s-1');
    expect(t.logs.find((l) => l.msg === 'shared_folder_access_reduced_sessions_retired'))
      .toMatchObject({ folderId: 'sf_a', marked: 1, reaped: 1 });

    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(2);
    expect(t.userMessages('s-1')).toHaveLength(1);
    t.cleanup();
  });

  it('closes an idle session\'s proxy even if the runner does not exit', async () => {
    const t = await setup({
      sharedFolderIdsFor: withFolders(['sf_a']), runnerExitsOnKill: false, idleGraceMs: 60_000,
    });
    await t.turn('s-1', 'req-1');
    await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
    await t.settle();
    expect(t.cancels('s-1')).toHaveLength(1);
    expect(t.handles[0]!.state.kills).toBe(0);
    expect(t.proxyCloses).toContain('s-1');
    t.cleanup();
  });

  it('a session mid-turn keeps its proxy until the turn ends, then is reaped', async () => {
    const t = await setup({
      sharedFolderIdsFor: withFolders(['sf_a']), runnerExitsOnKill: false, idleGraceMs: 60_000,
    });
    let closedMidTurn: boolean | undefined;
    let cancelledMidTurn: number | undefined;
    await t.turn('s-1', 'req-1', async () => {
      await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
      await t.settle();
      closedMidTurn = t.proxyCloses.includes('s-1');
      cancelledMidTurn = t.cancels('s-1').length;
    });
    await t.settle();
    expect(closedMidTurn).toBe(false);
    expect(cancelledMidTurn).toBe(0);
    // Not the ordinary 60s idle-out: the reap ran right after the turn.
    expect(t.cancels('s-1')).toHaveLength(1);
    expect(t.proxyCloses).toContain('s-1');
    t.cleanup();
  });

  it('a reduction that lands WHILE the session is opening still reaps it at turn end', async () => {
    // The resolver authorized the mount inside sandbox:open-session; a revoke
    // that commits before the open returns must not be missed.
    const t = await setup({
      sharedFolderIdsFor: withFolders(['sf_a']), runnerExitsOnKill: false, idleGraceMs: 60_000,
      duringOpen: async (fire) => { await fire({ folderId: 'sf_a', agentIds: ['test-agent'] }); },
    });
    await t.turn('s-1', 'req-1');
    await t.settle();
    expect(t.cancels('s-1')).toHaveLength(1);
    expect(t.proxyCloses).toContain('s-1');
    t.cleanup();
  });

  it('a session already in its grace window has its proxy closed', async () => {
    const t = await setup({
      sharedFolderIdsFor: withFolders(['sf_a']),
      runnerExitsOnKill: false, idleWindowMs: 5, idleGraceMs: 60_000,
    });
    await t.turn('s-1', 'req-1');
    await t.settle();
    expect(t.cancels('s-1')).toHaveLength(1);
    expect(t.proxyCloses).not.toContain('s-1');

    await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
    await t.settle();
    expect(t.proxyCloses).toContain('s-1');
    t.cleanup();
  });

  it('leaves a session of another agent untouched', async () => {
    const t = await setup({ sharedFolderIdsFor: withFolders(['sf_a']) });
    await t.turn('s-1', 'req-1');
    await t.reduce({ folderId: 'sf_a', agentIds: ['other-agent'] });
    await t.settle();
    expect(t.cancels('s-1')).toHaveLength(0);
    expect(t.proxyCloses).not.toContain('s-1');
    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(1);
    t.cleanup();
  });

  it('leaves a session that did not request the folder untouched', async () => {
    const t = await setup({ sharedFolderIdsFor: withFolders(['sf_b']) });
    await t.turn('s-1', 'req-1');
    await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
    await t.settle();
    expect(t.cancels('s-1')).toHaveLength(0);
    expect(t.proxyCloses).not.toContain('s-1');
    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(1);
    t.cleanup();
  });

  it('a marked session a message reaches before it exits is retired at routing', async () => {
    // The runner ignores the cancel and the grace kill is far off, so the
    // session is still warm + alive when the next message arrives.
    const t = await setup({
      sharedFolderIdsFor: withFolders(['sf_a']), runnerExitsOnKill: false, idleGraceMs: 60_000,
    });
    await t.turn('s-1', 'req-1');
    await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
    await t.settle();

    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(2);
    expect(t.terminated).toContain('s-1');
    expect(t.userMessages('s-1')).toHaveLength(1);
    expect(t.logs.find((l) => l.msg === 'stale_session_respawn'))
      .toMatchObject({ sessionId: 's-1', reason: 'shared-folder-access-reduced' });
    t.cleanup();
  });

  it('ignores a malformed payload', async () => {
    const t = await setup({ sharedFolderIdsFor: withFolders(['sf_a']) });
    await t.turn('s-1', 'req-1');
    for (const bad of [
      null, 'sf_a', {}, { folderId: 'sf_a' }, { folderId: 'sf_a', agentIds: 'test-agent' },
      { folderId: 42, agentIds: ['test-agent'] }, { folderId: '../x', agentIds: ['test-agent'] },
    ]) {
      await t.reduce(bad);
    }
    await t.settle();
    expect(t.cancels('s-1')).toHaveLength(0);
    expect(t.proxyCloses).not.toContain('s-1');
    expect(t.logs.some((l) => l.msg === 'shared_folder_access_reduced_malformed')).toBe(true);
    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(1);
    t.cleanup();
  });
});
