import { describe, it, expect } from 'vitest';
import { makeAgentContext, createLogger, type ServiceHandler } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

interface Trace {
  setRows: Array<{ skillId: string; kind: string; value: string }>;
  terminate: string[];
  addHost: Array<{ sessionId: string; host: string }>;
}

const EMPTY_CAPS = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

function buildMocks(opts: {
  draft: { id: string; proposalDelta: typeof EMPTY_CAPS } | null;
  activeSessionId: string | null;
  liveSessions: Set<string>;
}): { trace: Trace; services: Record<string, ServiceHandler> } {
  const trace: Trace = { setRows: [], terminate: [], addHost: [] };
  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({
      agent: {
        id: 'agent-1', ownerId: 'user-1', ownerType: 'user', visibility: 'personal',
        displayName: 'A', systemPrompt: '', allowedTools: [], mcpConfigIds: [],
        model: 'claude-sonnet-4-7', workspaceRef: null,
      },
    }),
    'agents:resolve-authored-skills': async () => ({
      skills: opts.draft === null ? [] : [{
        id: opts.draft.id, description: 'd', capabilities: EMPTY_CAPS,
        proposalDelta: opts.draft.proposalDelta, bodyMd: '', manifestYaml: '', files: [],
      }],
    }),
    'skills:approved-caps-set': async (_c, input: unknown) => {
      const i = input as { skillId: string; kind: string; value: string };
      trace.setRows.push({ skillId: i.skillId, kind: i.kind, value: i.value });
      return { created: true };
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

describe('agent:apply-authored-capability-grant', () => {
  it('a host-only delta writes a host row + widens live, no re-spawn', async () => {
    const mocks = buildMocks({
      draft: { id: 'linear', proposalDelta: { ...EMPTY_CAPS, allowedHosts: ['api.linear.app'] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: false });
    expect(mocks.trace.setRows).toEqual([{ skillId: 'linear', kind: 'host', value: 'api.linear.app' }]);
    expect(mocks.trace.addHost).toEqual([{ sessionId: 'sess-warm', host: 'api.linear.app' }]);
    expect(mocks.trace.terminate).toEqual([]);
  });

  it('a credential delta writes a slot row + re-spawns, no live add-host', async () => {
    const mocks = buildMocks({
      draft: { id: 'linear', proposalDelta: { ...EMPTY_CAPS, allowedHosts: ['api.linear.app'], credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: true });
    expect(mocks.trace.setRows).toEqual([
      { skillId: 'linear', kind: 'host', value: 'api.linear.app' },
      { skillId: 'linear', kind: 'slot', value: 'LINEAR_API_KEY' },
    ]);
    expect(mocks.trace.terminate).toEqual(['sess-warm']);
    expect(mocks.trace.addHost).toEqual([]);
  });

  it('a non-draft skillId returns not-authored and writes nothing', async () => {
    const mocks = buildMocks({ draft: null, activeSessionId: null, liveSessions: new Set() });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'catalog-skill',
    });
    expect(out).toEqual({ applied: false, reason: 'not-authored' });
    expect(mocks.trace.setRows).toEqual([]);
    expect(mocks.trace.terminate).toEqual([]);
  });

  it('a package-only delta widens the registry host live, no re-spawn', async () => {
    const mocks = buildMocks({
      draft: { id: 'tool', proposalDelta: { ...EMPTY_CAPS, packages: { npm: ['left-pad'], pypi: [] } } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'tool',
    });
    expect(out).toEqual({ applied: true, respawned: false });
    expect(mocks.trace.setRows).toEqual([{ skillId: 'tool', kind: 'npm', value: 'left-pad' }]);
    expect(mocks.trace.addHost).toEqual([{ sessionId: 'sess-warm', host: 'registry.npmjs.org' }]);
  });
});
