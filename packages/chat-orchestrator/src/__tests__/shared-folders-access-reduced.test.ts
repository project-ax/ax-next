import { describe, it, expect } from 'vitest';
import {
  HookBus, PluginError, makeAgentContext, createLogger,
  type AgentContext, type AgentOutcome, type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// W2 (shared folders) + W3a (projects) — on a fresh spawn the orchestrator
// reads the chat's project (`conversations:get-metadata`), resolves it
// (`projects:resolve`), passes the project's folder to `sandbox:open-session`,
// and remembers it per session. `shared-folders:access-reduced` (a revoke,
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

type ResolveImpl = (
  ctx: AgentContext,
  input: { projectId: string; agentId: string },
) => Promise<unknown> | unknown;

async function setup(opts: {
  /**
   * W3a — the chat's project folder. Set → `conversations:get-metadata` reports
   * `projectId: 'prj-1'` and `projects:resolve` answers with this folder.
   * Absent → the chat is in no project.
   */
  folderId?: string;
  /** Overrides the metadata's `projectId` (wins over `folderId`'s default). */
  projectId?: string | null;
  /** Overrides `projects:resolve`. */
  resolve?: ResolveImpl;
  /**
   * W3e — folder per project for the default `projects:resolve`, so a chat can
   * be moved between projects mid-test (`setChatProject`).
   */
  projectFolders?: Record<string, string>;
  /** `projects:resolve` is not registered at all. */
  noResolveService?: boolean;
  /** `conversations:get-metadata` throws. */
  metadataThrows?: boolean;
  /** `conversations:get-metadata` is not registered at all. */
  noMetadataService?: boolean;
  /** The turn's ctx has no conversationId. */
  noConversationId?: boolean;
  /** An optional augment provider that records the ctx it was called with. */
  captureProviderCtx?: AgentContext[];
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
  const metadataCalls: Array<Record<string, unknown>> = [];
  const resolveCalls: Array<{ input: Record<string, unknown>; userId: string }> = [];
  const turnErrors: Array<Record<string, unknown>> = [];
  // W3e — mutable: `setChatProject` moves the chat, as conversations:set-project would.
  let projectId: string | null =
    opts.projectId !== undefined ? opts.projectId : opts.folderId !== undefined ? 'prj-1' : null;

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
        activeSessionId: conv.activeSessionId, activeReqId: null, projectId,
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
  if (opts.noMetadataService !== true) {
    services['conversations:get-metadata'] = async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      metadataCalls.push(i);
      if (opts.metadataThrows === true) {
        throw new PluginError({ code: 'not-found', plugin: 'stub-conversations', message: 'gone' });
      }
      return {
        conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent',
        runnerType: null, runnerSessionId: null, workspaceRef: null, title: null,
        lastActivityAt: null, createdAt: '2026-10-16T00:00:00.000Z', origin: 'web',
        activeSessionId: conv.activeSessionId, projectId,
      };
    };
  }
  if (opts.noResolveService !== true) {
    services['projects:resolve'] = async (c, input: unknown) => {
      const i = input as { projectId: string; agentId: string };
      resolveCalls.push({ input: i, userId: c.userId });
      if (opts.resolve !== undefined) return opts.resolve(c, i);
      const moved = opts.projectFolders?.[i.projectId];
      if (moved !== undefined) {
        return { projectId: i.projectId, name: 'Moved', description: '', folderId: moved, readOnly: false };
      }
      if (opts.folderId === undefined) {
        throw new PluginError({ code: 'not-found', plugin: 'stub-projects', message: 'no project' });
      }
      return {
        projectId: i.projectId, name: 'Q4 launch', description: '',
        folderId: opts.folderId, readOnly: false,
      };
    };
  }
  if (opts.captureProviderCtx !== undefined) {
    const sink = opts.captureProviderCtx;
    services['system-prompt:augment:optional:test-projects'] = async (c) => {
      sink.push(c);
      return {};
    };
  }

  const plugin = createChatOrchestratorPlugin({
    runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 5_000,
    keepAlive: true, idleWindowMs: opts.idleWindowMs ?? 60_000, idleGraceMs: opts.idleGraceMs ?? 5,
  });
  const h = await createTestHarness({ services, plugins: [plugin] });
  h.bus.subscribe('chat:turn-error', 'test-capture', async (_c, payload) => {
    turnErrors.push(payload as Record<string, unknown>);
    return undefined;
  });

  const mkCtx = (sessionId: string, reqId: string) =>
    makeAgentContext({
      sessionId, agentId: 'test-agent', userId: 'test-user',
      ...(opts.noConversationId === true ? {} : { conversationId: 'conv-1' }),
      reqId,
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
    openInputs, queued, terminated, proxyCloses, logs, metadataCalls, resolveCalls, turnErrors,
    setChatProject: (p: string | null) => { projectId = p; },
    cleanup: () => { for (const hk of handles) hk.forceExit(); },
  };
}

describe('W3a: the chat\'s project picks the folder sandbox:open-session mounts', () => {
  it('a project chat passes exactly the project\'s folder', async () => {
    const t = await setup({ folderId: 'sf_a' });
    await t.turn('s-1', 'req-1');
    expect(t.openInputs[0]!.sharedFolderIds).toEqual(['sf_a']);
    expect(t.metadataCalls).toEqual([{ conversationId: 'conv-1', userId: 'test-user' }]);
    // The actor is the person on the context; the agent is the resolved one.
    expect(t.resolveCalls).toEqual([
      { input: { projectId: 'prj-1', agentId: 'test-agent' }, userId: 'test-user' },
    ]);
    t.cleanup();
  });

  it('a chat outside a project passes no folders and never calls projects:resolve', async () => {
    const t = await setup();
    await t.turn('s-1', 'req-1');
    expect('sharedFolderIds' in t.openInputs[0]!).toBe(false);
    expect(t.metadataCalls).toHaveLength(1);
    expect(t.resolveCalls).toHaveLength(0);
    t.cleanup();
  });

  it('no conversationId → no lookup at all, no folders', async () => {
    const t = await setup({ noConversationId: true });
    await t.turn('s-1', 'req-1');
    expect(t.metadataCalls).toHaveLength(0);
    expect(t.resolveCalls).toHaveLength(0);
    expect('sharedFolderIds' in t.openInputs[0]!).toBe(false);
    t.cleanup();
  });

  it('without @ax/conversations loaded the chat runs with no project', async () => {
    const t = await setup({ noMetadataService: true });
    const out = await t.turn('s-1', 'req-1');
    expect(out.kind).not.toBe('terminated');
    expect(t.opens).toBe(1);
    expect('sharedFolderIds' in t.openInputs[0]!).toBe(false);
    expect(t.resolveCalls).toHaveLength(0);
    t.cleanup();
  });

  it('a projects:resolve failure ends the turn project-unavailable and opens no sandbox', async () => {
    const t = await setup({
      projectId: 'prj-gone',
      resolve: () => { throw new PluginError({ code: 'forbidden', plugin: 'stub-projects', message: 'no' }); },
    });
    const out = await t.turn('s-1', 'req-1');
    expect(out).toMatchObject({ kind: 'terminated', reason: 'project-unavailable' });
    expect(t.opens).toBe(0);
    expect(t.turnErrors).toEqual([expect.objectContaining({ reason: 'project-unavailable' })]);
    t.cleanup();
  });

  it('a projectId with no projects:resolve service fails closed', async () => {
    const t = await setup({ projectId: 'prj-1', noResolveService: true });
    const out = await t.turn('s-1', 'req-1');
    expect(out).toMatchObject({ kind: 'terminated', reason: 'project-unavailable' });
    expect(t.opens).toBe(0);
    expect(t.turnErrors).toEqual([expect.objectContaining({ reason: 'project-unavailable' })]);
    t.cleanup();
  });

  it('a failed metadata read fails closed, with its own reason (not project-unavailable)', async () => {
    // The project can't be known without the read, so the turn still stops —
    // but the chat may have no project at all, so it must not say it lost one.
    const t = await setup({ metadataThrows: true });
    const out = await t.turn('s-1', 'req-1');
    expect(out).toMatchObject({ kind: 'terminated', reason: 'conversation-unavailable' });
    expect(t.turnErrors).toEqual([expect.objectContaining({ reason: 'conversation-unavailable' })]);
    expect(t.opens).toBe(0);
    expect(t.resolveCalls).toHaveLength(0);
    t.cleanup();
  });

  it('an ill-formed folderId from projects:resolve fails closed', async () => {
    const t = await setup({
      projectId: 'prj-1',
      resolve: (_c, i) => ({ projectId: i.projectId, name: 'x', description: '', folderId: '../etc', readOnly: false }),
    });
    const out = await t.turn('s-1', 'req-1');
    expect(out).toMatchObject({ kind: 'terminated', reason: 'project-unavailable' });
    expect(t.opens).toBe(0);
    t.cleanup();
  });

  it('a project-unavailable turn assembles no prompt augment', async () => {
    const seen: AgentContext[] = [];
    const t = await setup({ projectId: 'prj-1', noResolveService: true, captureProviderCtx: seen });
    await t.turn('s-1', 'req-1');
    expect(seen).toHaveLength(0);
    t.cleanup();
  });

  it('prompt providers see ctx.projectId on a project chat', async () => {
    const seen: AgentContext[] = [];
    const t = await setup({ folderId: 'sf_a', captureProviderCtx: seen });
    await t.turn('s-1', 'req-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.projectId).toBe('prj-1');
    expect(seen[0]!.conversationId).toBe('conv-1');
    t.cleanup();
  });

  it('prompt providers see no projectId outside a project', async () => {
    const seen: AgentContext[] = [];
    const t = await setup({ captureProviderCtx: seen });
    await t.turn('s-1', 'req-1');
    expect(seen).toHaveLength(1);
    expect('projectId' in seen[0]!).toBe(false);
    t.cleanup();
  });

  it('manifest: projects:resolve is optional; get-metadata stays undeclared', async () => {
    const t = await setup();
    expect(t.plugin.manifest.optionalCalls?.map((o) => o.hook)).toContain('projects:resolve');
    // `conversations:get-metadata` follows the hasService convention.
    expect(t.plugin.manifest.calls).not.toContain('conversations:get-metadata');
    expect(t.plugin.manifest.calls).not.toContain('projects:resolve');
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
    const t = await setup({ folderId: 'sf_a' });
    await t.turn('s-1', 'req-1');
    expect(t.proxyCloses).not.toContain('s-1');

    await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
    await t.settle();

    expect(t.cancels('s-1')).toHaveLength(1);
    expect(t.handles[0]!.state.kills).toBeGreaterThanOrEqual(1);
    expect(t.proxyCloses).toContain('s-1');
    expect(t.logs.find((l) => l.msg === 'shared_folder_access_reduced_sessions_retired'))
      .toMatchObject({ folderId: 'sf_a', marked: 1, reaped: 1, projectIds: ['prj-1'] });

    await t.turn('s-2', 'req-2');
    expect(t.opens).toBe(2);
    expect(t.userMessages('s-1')).toHaveLength(1);
    t.cleanup();
  });

  it('closes an idle session\'s proxy even if the runner does not exit', async () => {
    const t = await setup({
      folderId: 'sf_a', runnerExitsOnKill: false, idleGraceMs: 60_000,
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
      folderId: 'sf_a', runnerExitsOnKill: false, idleGraceMs: 60_000,
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
      folderId: 'sf_a', runnerExitsOnKill: false, idleGraceMs: 60_000,
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
      folderId: 'sf_a',
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
    const t = await setup({ folderId: 'sf_a' });
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
    const t = await setup({ folderId: 'sf_b' });
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
      folderId: 'sf_a', runnerExitsOnKill: false, idleGraceMs: 60_000,
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

  it('a failed open forgets the folders it recorded', async () => {
    const t = await setup({
      folderId: 'sf_a',
      duringOpen: async () => { throw new Error('open boom'); },
    });
    const out = await t.turn('s-1', 'req-1');
    expect(out).toMatchObject({ kind: 'terminated', reason: 'sandbox-open-failed' });
    expect(t.openInputs[0]!.sharedFolderIds).toEqual(['sf_a']);
    await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
    await t.settle();
    expect(t.logs.some((l) => l.msg === 'shared_folder_access_reduced_sessions_retired')).toBe(false);
    t.cleanup();
  });

  it('ignores a malformed payload', async () => {
    const t = await setup({ folderId: 'sf_a' });
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

describe('W3e: a chat moved between projects retires its live session at the next turn', () => {
  const respawns = (logs: Array<Record<string, unknown>>) =>
    logs.filter((l) => l.msg === 'stale_session_respawn');

  it('no project → P: retired with project-changed; the next spawn mounts P\'s folder', async () => {
    const t = await setup({ projectFolders: { 'prj-p': 'sf_p' } });
    await t.turn('s-1', 'req-1');
    expect('sharedFolderIds' in t.openInputs[0]!).toBe(false);

    t.setChatProject('prj-p');
    await t.turn('s-2', 'req-2');
    expect(respawns(t.logs)).toEqual([
      expect.objectContaining({ sessionId: 's-1', reason: 'project-changed' }),
    ]);
    expect(t.terminated).toContain('s-1');
    expect(t.proxyCloses).toContain('s-1');
    expect(t.opens).toBe(2);
    expect(t.openInputs[1]!.sharedFolderIds).toEqual(['sf_p']);
    expect(t.userMessages('s-1')).toHaveLength(1);
    t.cleanup();
  });

  it('P → none: retired with project-changed; the next spawn mounts no folder', async () => {
    const t = await setup({ folderId: 'sf_a' });
    await t.turn('s-1', 'req-1');
    expect(t.openInputs[0]!.sharedFolderIds).toEqual(['sf_a']);

    t.setChatProject(null);
    await t.turn('s-2', 'req-2');
    expect(respawns(t.logs)).toEqual([
      expect.objectContaining({ sessionId: 's-1', reason: 'project-changed' }),
    ]);
    expect(t.opens).toBe(2);
    expect('sharedFolderIds' in t.openInputs[1]!).toBe(false);
    t.cleanup();
  });

  it('P → Q: retired with project-changed; the next spawn mounts Q\'s folder', async () => {
    const t = await setup({ folderId: 'sf_a', projectFolders: { 'prj-q': 'sf_q' } });
    await t.turn('s-1', 'req-1');
    expect(t.openInputs[0]!.sharedFolderIds).toEqual(['sf_a']);

    t.setChatProject('prj-q');
    await t.turn('s-2', 'req-2');
    expect(respawns(t.logs)).toEqual([
      expect.objectContaining({ sessionId: 's-1', reason: 'project-changed' }),
    ]);
    expect(t.opens).toBe(2);
    expect(t.openInputs[1]!.sharedFolderIds).toEqual(['sf_q']);
    t.cleanup();
  });

  it('an unchanged project keeps the session (P and none)', async () => {
    for (const opts of [{ folderId: 'sf_a' }, {}]) {
      const t = await setup(opts);
      await t.turn('s-1', 'req-1');
      await t.turn('s-2', 'req-2');
      expect(respawns(t.logs)).toEqual([]);
      expect(t.opens).toBe(1);
      expect(t.userMessages('s-1')).toHaveLength(2);
      t.cleanup();
    }
  });

  it('a session retired for project-changed is forgotten: a later reduction of the old folder marks nothing', async () => {
    const t = await setup({ folderId: 'sf_a' });
    await t.turn('s-1', 'req-1');
    t.setChatProject(null);
    await t.turn('s-2', 'req-2');
    await t.reduce({ folderId: 'sf_a', agentIds: ['test-agent'] });
    await t.settle();
    expect(t.logs.some((l) => l.msg === 'shared_folder_access_reduced_sessions_retired')).toBe(false);
    t.cleanup();
  });
});
