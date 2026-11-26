/**
 * TASK-1225 — after a services restart, the OLD runner gets nothing more.
 *
 * A real @ax/chat-orchestrator swaps the sandbox; a real @ax/session-inmemory
 * holds both sessions' inboxes and tokens. A message routed into the old
 * sandbox while the restarting segment ran is moved to the new one, behind the
 * host note. The old inbox keeps its copy, so the old runner must be cut off
 * twice over: its token no longer authenticates, and a claim that got past
 * auth before the terminate is not handed that copy (it would answer the same
 * message a second time, from a sandbox the person no longer sees).
 */
import { describe, expect, it } from 'vitest';
import {
  createLogger,
  makeAgentContext,
  PluginError,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
// Test-only cross-plugin imports (eslint allowlists `src/__tests__/**`): the
// swap is the orchestrator's and the claim and the revocation are the session
// store's, so this needs the real ones.
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  SessionClaimWorkInput,
  SessionClaimWorkOutput,
  SessionCreateInput,
  SessionCreateOutput,
  SessionResolveTokenInput,
  SessionResolveTokenOutput,
} from '@ax/session-inmemory';
import { fireEventTurnEnd } from '../handlers/event-turn-end.js';

const DIGEST = '@sha256:' + 'a'.repeat(64);
const AGENT = {
  id: 'agent-1', ownerId: 'user-1', ownerType: 'user' as const, visibility: 'personal' as const,
  displayName: 'Fern', allowedTools: ['file.read'], mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7', runner: 'claude-sdk',
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup() {
  const row = { activeSessionId: null as string | null, activeReqId: null as string | null, serviceSet: null as string | null };
  // Sandboxes opened, in order, each with the token its runner would hold.
  const opens: string[] = [];
  const tokens = new Map<string, string>();

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...AGENT } }),
    'connectors:list-effective': async () => ({
      connectors: [{
        summary: { id: 'e2e' }, source: 'attached',
        capabilities: {
          allowedHosts: [], credentials: [], mcpServers: [], servicesMode: 'on-demand',
          services: [{ name: 'mongo', image: 'mongo' + DIGEST, ports: [27017], env: {}, writablePaths: [] }],
        },
      }],
    }),
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      if (i.userId !== AGENT.ownerId) throw new PluginError({ code: 'not-found', plugin: 'test', message: 'nf' });
      return { conversation: { conversationId: i.conversationId, userId: i.userId, agentId: AGENT.id, ...row } };
    },
    'conversations:bind-session': async (_c, input: unknown) => {
      const i = input as { sessionId: string; reqId: string; expectedSessionId?: string | null };
      // @ax/conversations' compare-and-set (TASK-1226).
      if (i.expectedSessionId !== undefined && row.activeSessionId !== i.expectedSessionId) {
        throw new PluginError({ code: 'conflict', plugin: 'test', message: 'moved on' });
      }
      row.activeSessionId = i.sessionId;
      row.activeReqId = i.reqId;
      return undefined;
    },
    'conversations:set-service-set': async (_c, input: unknown) => {
      row.serviceSet = (input as { serviceSet: string | null }).serviceSet;
      return { ok: true };
    },
    // Like a sandbox provider: the session (and its runner's token) is minted
    // as the sandbox opens.
    'sandbox:open-session': async (c, input: unknown) => {
      const sessionId = (input as { sessionId: string }).sessionId;
      const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
        'session:create', c, { sessionId, workspaceRoot: '/tmp/ax-restart-old-runner' },
      );
      tokens.set(sessionId, token);
      opens.push(sessionId);
      let exit!: () => void;
      const exited = new Promise<{ code: number | null; signal: null }>((r) => { exit = () => r({ code: 0, signal: null }); });
      return { runnerEndpoint: 'unix:///tmp/x.sock', handle: { kill: async () => exit(), exited } };
    },
    'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {}, proxyAuthToken: 'a'.repeat(32) }),
    'proxy:close-session': async () => ({}),
  };
  const h = await createTestHarness({
    services,
    plugins: [
      createSessionInmemoryPlugin(),
      createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' }, chatTimeoutMs: 60_000,
        keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
        onDemandServices: { enabled: true },
      }),
    ],
  });
  // @ax/conversations: a terminated session's binding is cleared.
  h.bus.subscribe<{ sessionId?: string }>('session:terminate', 'test/conversations', async (_c, p) => {
    if (p.sessionId !== undefined && row.activeSessionId === p.sessionId) {
      row.activeSessionId = null;
      row.activeReqId = null;
    }
    return undefined;
  });

  const ipcCtx = (sessionId: string) =>
    makeAgentContext({
      sessionId, agentId: AGENT.id, userId: AGENT.ownerId, conversationId: 'conv-1', reqId: 'ipc-fresh',
      logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }),
    });
  const turnEnd = (sessionId: string, reqId: string, role: 'tool' | 'assistant') =>
    fireEventTurnEnd(ipcCtx(sessionId), h.bus, { reason: 'user-message-wait', role, reqId });
  const invoke = (reqId: string) =>
    h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      makeAgentContext({
        sessionId: 's-1', agentId: AGENT.id, userId: AGENT.ownerId, conversationId: 'conv-1', reqId,
        logger: createLogger({ reqId, writer: () => undefined }),
      }),
      { message: { role: 'user', content: 'run the e2e tests' } },
    );
  /** One `session.next-message` poll that doesn't wait: what a runner at `cursor` would get now. */
  const claimNow = (sessionId: string, cursor: number) =>
    h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work', ipcCtx(sessionId), { sessionId, cursor, timeoutMs: 0 },
    );
  async function waitForEntry(sessionId: string, cursor: number, what: string): Promise<SessionClaimWorkOutput> {
    for (let i = 0; i < 200; i++) {
      const r = await claimNow(sessionId, cursor);
      if (r.type !== 'timeout') return r;
      await flush();
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  return { h, row, opens, tokens, ipcCtx, turnEnd, invoke, claimNow, waitForEntry };
}

describe('a services restart cuts the old runner off (TASK-1225)', () => {
  it('after a services restart the old session can neither authenticate nor claim the moved message', async () => {
    const t = await setup();
    const p1 = t.invoke('req-1');
    await waitFor(() => t.opens.length === 1, 'the first sandbox');
    expect(await t.waitForEntry('s-1', 0, 'the first message')).toMatchObject({ type: 'user-message', reqId: 'req-1' });
    const accepted = await t.h.bus.call<unknown, { ok: boolean }>(
      'tool:execute:restart_with_services', t.ipcCtx('s-1'), { id: 'c1', name: 'restart_with_services', input: { set: 'e2e' } },
    );
    expect(accepted.ok).toBe(true);

    // A second message arrives while the segment runs: routed into s-1, where
    // the old runner could claim it right now.
    const p2 = t.invoke('req-2');
    expect(await t.waitForEntry('s-1', 1, 'the second message on s-1')).toMatchObject({
      type: 'user-message', reqId: 'req-2',
    });

    // The segment ends (not folded), and the swap moves req-2 behind the note.
    await t.turnEnd('s-1', 'req-1', 'tool');
    await t.turnEnd('s-1', 'req-1', 'assistant');
    await waitFor(() => t.opens.length === 2, 'the new sandbox');
    const fresh = t.opens[1]!;
    expect(await t.waitForEntry(fresh, 1, 'the moved message')).toMatchObject({ type: 'user-message', reqId: 'req-2' });
    expect(await t.claimNow(fresh, 0)).toMatchObject({ type: 'host-note', reqId: 'req-1' });

    // The old runner: a new poll is refused at auth, and a poll that got past
    // auth before the terminate gets no entry, not the moved message's copy.
    const resolved = await t.h.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
      'session:resolve-token', t.ipcCtx('s-1'), { token: t.tokens.get('s-1')! },
    );
    expect(resolved).toBeNull();
    expect(await t.claimNow('s-1', 1)).toEqual({ type: 'timeout', cursor: 1 });

    // Both requests finish in the new sandbox.
    await t.turnEnd(fresh, 'req-1', 'assistant');
    await t.turnEnd(fresh, 'req-2', 'assistant');
    expect(await p1).toEqual({ kind: 'complete', messages: [] });
    expect(await p2).toEqual({ kind: 'complete', messages: [] });
  });
});
