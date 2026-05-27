import { describe, it, expect } from 'vitest';
import { makeAgentContext, createLogger, type ServiceHandler } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

interface Trace {
  attach: Array<{
    userId: string;
    agentId: string;
    skillId: string;
    credentialBindings: Record<string, string>;
  }>;
  terminate: string[];
  isAlive: string[];
}

function buildMocks(opts: {
  /** declared credential slots of the skill being granted */
  slots: string[];
  activeSessionId: string | null;
  liveSessions: Set<string>;
}): { trace: Trace; services: Record<string, ServiceHandler> } {
  const trace: Trace = { attach: [], terminate: [], isAlive: [] };
  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({
      agent: {
        id: 'agent-1',
        ownerId: 'user-1',
        ownerType: 'user',
        visibility: 'personal',
        displayName: 'A',
        systemPrompt: '',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude-sonnet-4-7',
        workspaceRef: null,
      },
    }),
    'skills:resolve': async (_c, input: unknown) => {
      const ids = (input as { skillIds: string[] }).skillIds;
      return {
        skills: ids.map((id) => ({
          id,
          manifestYaml: '',
          bodyMd: '',
          capabilities: {
            allowedHosts: ['api.linear.app'],
            credentials: opts.slots.map((s) => ({ slot: s, kind: 'api-key' as const })),
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
        })),
      };
    },
    'skills:attach-for-user': async (_c, input: unknown) => {
      trace.attach.push(input as Trace['attach'][number]);
      return { created: true };
    },
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      return {
        conversation: {
          conversationId: i.conversationId,
          userId: i.userId,
          agentId: 'agent-1',
          activeSessionId: opts.activeSessionId,
          activeReqId: null,
        },
      };
    },
    'session:is-alive': async (_c, input: unknown) => {
      const sid = (input as { sessionId: string }).sessionId;
      trace.isAlive.push(sid);
      return { alive: opts.liveSessions.has(sid) };
    },
    'session:terminate': async (_c, input: unknown) => {
      trace.terminate.push((input as { sessionId: string }).sessionId);
      return {};
    },
    // Hard `calls` deps of @ax/chat-orchestrator (bootstrap verifyCalls needs a
    // registrant) that apply-capability-grant never dispatches — no-op stubs.
    'session:queue-work': async () => ({ cursor: 0 }),
    'sandbox:open-session': async () => ({
      runnerEndpoint: 'unix:///tmp/irrelevant.sock',
      handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
    }),
  };
  return { trace, services };
}

function ctx() {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'agent-1',
    userId: 'user-1',
    conversationId: 'cnv-1',
    logger: createLogger({ reqId: 'grant-test', writer: () => undefined }),
  });
}

async function harnessFor(mocks: ReturnType<typeof buildMocks>) {
  return createTestHarness({
    services: mocks.services,
    plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', oneShot: true })],
  });
}

describe('agent:apply-capability-grant', () => {
  it('attaches the skill with all declared slots bound to skill:<id>:<slot>', async () => {
    const mocks = buildMocks({
      slots: ['api_key'],
      activeSessionId: 'sess-warm',
      liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-capability-grant', ctx(), {
      conversationId: 'cnv-1',
      userId: 'user-1',
      agentId: 'agent-1',
      skillId: 'linear',
    });
    expect(out).toEqual({ attached: true });
    expect(mocks.trace.attach).toEqual([
      {
        userId: 'user-1',
        agentId: 'agent-1',
        skillId: 'linear',
        credentialBindings: { api_key: 'skill:linear:api_key' },
      },
    ]);
  });

  it('terminates the warm session so the next turn re-spawns', async () => {
    const mocks = buildMocks({
      slots: [],
      activeSessionId: 'sess-warm',
      liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    await h.bus.call('agent:apply-capability-grant', ctx(), {
      conversationId: 'cnv-1',
      userId: 'user-1',
      agentId: 'agent-1',
      skillId: 'notes',
    });
    expect(mocks.trace.terminate).toEqual(['sess-warm']);
  });

  it('binds {} for a slotless skill and does not terminate a dead/absent session', async () => {
    const mocks = buildMocks({ slots: [], activeSessionId: null, liveSessions: new Set() });
    const h = await harnessFor(mocks);
    await h.bus.call('agent:apply-capability-grant', ctx(), {
      conversationId: 'cnv-1',
      userId: 'user-1',
      agentId: 'agent-1',
      skillId: 'notes',
    });
    expect(mocks.trace.attach[0]?.credentialBindings).toEqual({});
    expect(mocks.trace.terminate).toEqual([]);
  });

  it('does not terminate a session that is-alive reports dead', async () => {
    const mocks = buildMocks({
      slots: [],
      activeSessionId: 'sess-stale',
      liveSessions: new Set(), // stale id present on row but not alive
    });
    const h = await harnessFor(mocks);
    await h.bus.call('agent:apply-capability-grant', ctx(), {
      conversationId: 'cnv-1',
      userId: 'user-1',
      agentId: 'agent-1',
      skillId: 'notes',
    });
    expect(mocks.trace.isAlive).toEqual(['sess-stale']);
    expect(mocks.trace.terminate).toEqual([]);
  });

  // JIT P2/P7.2, decision #13 — a slot tagged `account: <svc>` binds the SHARED
  // user vault entry `account:<svc>`; an untagged slot keeps the per-skill ref.
  // The card POSTs the IDENTICAL ref, so stored key and binding always agree.
  it('binds an account-tagged slot to account:<service> and a plain slot to skill:<id>:<slot>', async () => {
    const mocks = buildMocks({
      slots: [],
      activeSessionId: null,
      liveSessions: new Set(),
    });
    // Override skills:resolve to return one account-tagged slot + one plain slot.
    mocks.services['skills:resolve'] = async (_c, input: unknown) => {
      const ids = (input as { skillIds: string[] }).skillIds;
      return {
        skills: ids.map((id) => ({
          id,
          manifestYaml: '',
          bodyMd: '',
          capabilities: {
            allowedHosts: ['api.linear.app'],
            credentials: [
              { slot: 'LINEAR_TOKEN', kind: 'api-key' as const, account: 'linear' },
              { slot: 'EXTRA', kind: 'api-key' as const },
            ],
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
        })),
      };
    };
    const h = await harnessFor(mocks);
    await h.bus.call('agent:apply-capability-grant', ctx(), {
      conversationId: 'cnv-1',
      userId: 'user-1',
      agentId: 'agent-1',
      skillId: 'linear',
    });
    expect(mocks.trace.attach[0]?.credentialBindings).toEqual({
      LINEAR_TOKEN: 'account:linear',
      EXTRA: 'skill:linear:EXTRA',
    });
  });
});
