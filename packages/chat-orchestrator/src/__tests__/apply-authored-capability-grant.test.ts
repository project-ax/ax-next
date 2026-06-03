import { describe, it, expect } from 'vitest';
import { makeAgentContext, createLogger, type ServiceHandler } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// TASK-100 — a skill declares no capabilities (its reach is the connectors it
// references), so "approving" an authored skill no longer writes per-skill
// approved-caps rows or live-widens egress: it simply flips the pending draft to
// active (so its instruction body materializes next spawn) and retires the warm
// session so the next turn cold-spawns with it. The cap-write / proposalDelta /
// shown-intersection machinery is gone (a connector's reach is approved via the
// connector grant path).

interface Trace {
  setRows: Array<{ skillId: string; kind: string; value: string }>;
  terminate: string[];
  addHost: Array<{ sessionId: string; host: string }>;
  activate: Array<{ ownerUserId: string; agentId: string; skillId: string }>;
}

function buildMocks(opts: {
  draft: { id: string } | null;
  activeSessionId: string | null;
  liveSessions: Set<string>;
  resolveThrows?: boolean;
}): { trace: Trace; services: Record<string, ServiceHandler> } {
  const trace: Trace = { setRows: [], terminate: [], addHost: [], activate: [] };
  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({
      agent: {
        id: 'agent-1', ownerId: 'user-1', ownerType: 'user', visibility: 'personal',
        displayName: 'A', allowedTools: [], mcpConfigIds: [],
        model: 'claude-sonnet-4-7', workspaceRef: null,
      },
    }),
    'agents:resolve-authored-skills': async () => {
      if (opts.resolveThrows === true) {
        throw new Error('workspace:read connection reset');
      }
      return {
        skills: opts.draft === null ? [] : [{
          id: opts.draft.id, description: 'd', connectors: [],
          bodyMd: '', manifestYaml: '', files: [], status: 'pending' as const,
        }],
      };
    },
    'skills:approved-caps-set': async (_c, input: unknown) => {
      const i = input as { skillId: string; kind: string; value: string };
      trace.setRows.push({ skillId: i.skillId, kind: i.kind, value: i.value });
      return { created: true };
    },
    'skills:authored-activate': async (_c, input: unknown) => {
      const i = input as { ownerUserId: string; agentId: string; skillId: string };
      trace.activate.push({ ownerUserId: i.ownerUserId, agentId: i.agentId, skillId: i.skillId });
      return { activated: true };
    },
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      return { conversation: { conversationId: i.conversationId, userId: i.userId, agentId: 'agent-1', activeSessionId: opts.activeSessionId, activeReqId: null } };
    },
    'session:is-alive': async (_c, input: unknown) => ({ alive: opts.liveSessions.has((input as { sessionId: string }).sessionId) }),
    'session:terminate': async (_c, input: unknown) => { trace.terminate.push((input as { sessionId: string }).sessionId); return {}; },
    'proxy:add-host': async (_c, input: unknown) => { const i = input as { sessionId: string; host: string }; trace.addHost.push(i); return { added: true, agentId: 'agent-1' }; },
    'session:queue-work': async () => ({ cursor: 0 }),
    'sandbox:open-session': async () => ({ runnerEndpoint: 'unix:///tmp/x.sock', handle: { kill: async () => undefined, exited: new Promise(() => undefined) } }),
  };
  return { trace, services };
}

function ctx() {
  return makeAgentContext({
    sessionId: 's', agentId: 'agent-1', userId: 'user-1', conversationId: 'cnv-1',
    logger: createLogger({ reqId: 'authgrant', writer: () => undefined }),
  });
}

async function harnessFor(mocks: ReturnType<typeof buildMocks>) {
  return createTestHarness({
    services: mocks.services,
    plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', oneShot: true })],
  });
}

describe('agent:apply-authored-capability-grant (TASK-100 — activate-only)', () => {
  it('a draft → flips pending→active, writes NO cap rows, retires the warm session', async () => {
    const mocks = buildMocks({
      draft: { id: 'linear' },
      activeSessionId: 'sess-1',
      liveSessions: new Set(['sess-1']),
    });
    const h = await harnessFor(mocks);
    try {
      const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
        conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
      });
      expect(out).toEqual({ applied: true, respawned: true });
      // No per-skill cap rows written; the skill is just activated.
      expect(mocks.trace.setRows).toEqual([]);
      expect(mocks.trace.activate).toEqual([
        { ownerUserId: 'user-1', agentId: 'agent-1', skillId: 'linear' },
      ]);
      // The warm session was retired so the next turn cold-spawns with the skill.
      expect(mocks.trace.terminate).toEqual(['sess-1']);
      // Never live-widens (a skill has no egress of its own).
      expect(mocks.trace.addHost).toEqual([]);
    } finally {
      await h.close({ onError: () => {} });
    }
  });

  it('a draft with NO warm session → activates, reports respawned:false', async () => {
    const mocks = buildMocks({
      draft: { id: 'linear' },
      activeSessionId: null,
      liveSessions: new Set(),
    });
    const h = await harnessFor(mocks);
    try {
      const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
        conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
      });
      expect(out).toEqual({ applied: true, respawned: false });
      expect(mocks.trace.activate).toHaveLength(1);
      expect(mocks.trace.terminate).toEqual([]);
    } finally {
      await h.close({ onError: () => {} });
    }
  });

  it('early approval with NO conversationId → activates, retires nothing', async () => {
    const mocks = buildMocks({
      draft: { id: 'tool' },
      activeSessionId: null,
      liveSessions: new Set(),
    });
    const h = await harnessFor(mocks);
    try {
      const noConvCtx = makeAgentContext({
        sessionId: 's', agentId: 'agent-1', userId: 'user-1',
        logger: createLogger({ reqId: 'authgrant', writer: () => undefined }),
      });
      const out = await h.bus.call('agent:apply-authored-capability-grant', noConvCtx, {
        userId: 'user-1', agentId: 'agent-1', skillId: 'tool',
      });
      expect(out).toEqual({ applied: true, respawned: false });
      expect(mocks.trace.activate).toHaveLength(1);
      expect(mocks.trace.terminate).toEqual([]);
      expect(mocks.trace.setRows).toEqual([]);
    } finally {
      await h.close({ onError: () => {} });
    }
  });

  it('a non-draft skillId returns not-authored and writes/activates nothing', async () => {
    const mocks = buildMocks({
      draft: null,
      activeSessionId: 'sess-1',
      liveSessions: new Set(['sess-1']),
    });
    const h = await harnessFor(mocks);
    try {
      const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
        conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'not-a-draft',
      });
      expect(out).toEqual({ applied: false, reason: 'not-authored' });
      expect(mocks.trace.activate).toEqual([]);
      expect(mocks.trace.terminate).toEqual([]);
    } finally {
      await h.close({ onError: () => {} });
    }
  });

  it('a resolve-authored-skills throw → returns not-authored, activates nothing (catalog path stays available)', async () => {
    const mocks = buildMocks({
      draft: { id: 'linear' },
      activeSessionId: 'sess-1',
      liveSessions: new Set(['sess-1']),
      resolveThrows: true,
    });
    const h = await harnessFor(mocks);
    try {
      const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
        conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
      });
      expect(out).toEqual({ applied: false, reason: 'not-authored' });
      expect(mocks.trace.activate).toEqual([]);
    } finally {
      await h.close({ onError: () => {} });
    }
  });
});
