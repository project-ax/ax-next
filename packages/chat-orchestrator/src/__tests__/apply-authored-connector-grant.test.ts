import { describe, it, expect } from 'vitest';
import { makeAgentContext, createLogger, type ServiceHandler } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// agent:apply-authored-connector-grant (TASK-94) — the approval gate. Mirrors
// the authored-skill grant test, but the SUBJECT is a connector: the grant
// writes connector-subject approved-caps rows (the TASK-93 wall,
// skills:approved-caps-set with `connectorId`) and flips the connector draft
// active (connectors:activate-authored).
// ---------------------------------------------------------------------------

interface Trace {
  setRows: Array<{ connectorId?: string; skillId?: string; kind: string; value: string }>;
  terminate: string[];
  addHost: Array<{ sessionId: string; host: string }>;
  activate: Array<{ ownerUserId: string; agentId: string; connectorId: string }>;
  upsert: Array<{
    userId: string;
    connectorId: string;
    name: string;
    description: string;
    usageNote: string;
    keyMode: string;
    visibility: string;
    capabilities: Proposal;
  }>;
}

const EMPTY = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

type Proposal = typeof EMPTY;

function buildMocks(opts: {
  draft: { connectorId: string; proposal: Proposal } | null;
  activeSessionId: string | null;
  liveSessions: Set<string>;
  resolveThrows?: boolean;
  /** Drop the `connectors:upsert` service to exercise the hasService back-compat guard. */
  noUpsert?: boolean;
}): { trace: Trace; services: Record<string, ServiceHandler> } {
  const trace: Trace = { setRows: [], terminate: [], addHost: [], activate: [], upsert: [] };
  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({
      agent: {
        id: 'agent-1', ownerId: 'user-1', ownerType: 'user', visibility: 'personal',
        displayName: 'A', allowedTools: [], mcpConfigIds: [],
        model: 'claude-sonnet-4-7', workspaceRef: null,
      },
    }),
    'connectors:list-authored': async () => {
      if (opts.resolveThrows === true) throw new Error('db connection reset');
      return {
        drafts: opts.draft === null ? [] : [{
          connectorId: opts.draft.connectorId, name: 'Linear', usageNote: 'Use the Linear CLI.',
          keyMode: 'personal', status: 'pending', proposal: opts.draft.proposal,
        }],
      };
    },
    'skills:approved-caps-set': async (_c, input: unknown) => {
      const i = input as { connectorId?: string; skillId?: string; kind: string; value: string };
      trace.setRows.push({
        ...(i.connectorId !== undefined ? { connectorId: i.connectorId } : {}),
        ...(i.skillId !== undefined ? { skillId: i.skillId } : {}),
        kind: i.kind, value: i.value,
      });
      return { created: true };
    },
    'connectors:activate-authored': async (_c, input: unknown) => {
      const i = input as { ownerUserId: string; agentId: string; connectorId: string };
      trace.activate.push({ ownerUserId: i.ownerUserId, agentId: i.agentId, connectorId: i.connectorId });
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
  // TASK-113 — promote-on-approval: the grant upserts the approved connector
  // into the curated registry. Registered unless `noUpsert` exercises the
  // hasService back-compat guard.
  if (opts.noUpsert !== true) {
    services['connectors:upsert'] = async (_c, input: unknown) => {
      const i = input as Trace['upsert'][number] & { connector?: unknown };
      trace.upsert.push({
        userId: i.userId,
        connectorId: i.connectorId,
        name: i.name,
        description: i.description,
        usageNote: i.usageNote,
        keyMode: i.keyMode,
        visibility: i.visibility,
        capabilities: i.capabilities,
      });
      return {
        connector: {
          id: i.connectorId, name: i.name, description: i.description, usageNote: i.usageNote,
          keyMode: i.keyMode, visibility: i.visibility, capabilities: i.capabilities,
          defaultAttached: false, createdAt: '', updatedAt: '',
        },
        created: true,
      };
    };
  }
  return { trace, services };
}

function ctx() {
  return makeAgentContext({
    sessionId: 's', agentId: 'agent-1', userId: 'user-1', conversationId: 'cnv-1',
    logger: createLogger({ reqId: 'conngrant', writer: () => undefined }),
  });
}

async function harnessFor(mocks: ReturnType<typeof buildMocks>) {
  return createTestHarness({
    services: mocks.services,
    plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', oneShot: true })],
  });
}

describe('agent:apply-authored-connector-grant', () => {
  it('a host-only proposal writes a connector-subject host row + widens live, no re-spawn', async () => {
    const mocks = buildMocks({
      draft: { connectorId: 'linear', proposal: { ...EMPTY, allowedHosts: ['api.linear.app'] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: false });
    // The grant is attributed to the CONNECTOR subject (TASK-93 wall), never a skill.
    expect(mocks.trace.setRows).toEqual([{ connectorId: 'linear', kind: 'host', value: 'api.linear.app' }]);
    expect(mocks.trace.addHost).toEqual([{ sessionId: 'sess-warm', host: 'api.linear.app' }]);
    expect(mocks.trace.terminate).toEqual([]);
    expect(mocks.trace.activate).toEqual([{ ownerUserId: 'user-1', agentId: 'agent-1', connectorId: 'linear' }]);
  });

  it('a credential proposal writes a slot row + re-spawns, no live add-host', async () => {
    const mocks = buildMocks({
      draft: { connectorId: 'linear', proposal: { ...EMPTY, allowedHosts: ['api.linear.app'], credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: true });
    expect(mocks.trace.setRows).toEqual([
      { connectorId: 'linear', kind: 'host', value: 'api.linear.app' },
      { connectorId: 'linear', kind: 'slot', value: 'LINEAR_API_KEY' },
    ]);
    expect(mocks.trace.terminate).toEqual(['sess-warm']);
    expect(mocks.trace.addHost).toEqual([]);
    expect(mocks.trace.activate).toEqual([{ ownerUserId: 'user-1', agentId: 'agent-1', connectorId: 'linear' }]);
  });

  it('a package proposal allowlists the public registries on live-widen', async () => {
    const mocks = buildMocks({
      draft: { connectorId: 'sf', proposal: { ...EMPTY, allowedHosts: ['login.salesforce.com'], packages: { npm: ['@salesforce/cli'], pypi: [] } } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'sf',
    });
    expect(out).toEqual({ applied: true, respawned: false });
    expect(mocks.trace.setRows).toEqual([
      { connectorId: 'sf', kind: 'host', value: 'login.salesforce.com' },
      { connectorId: 'sf', kind: 'npm', value: '@salesforce/cli' },
    ]);
    // npm package → registry.npmjs.org live-added alongside the declared host.
    expect(mocks.trace.addHost.map((h) => h.host)).toEqual(['login.salesforce.com', 'registry.npmjs.org']);
  });

  it('an unknown connectorId returns not-authored (server is authoritative)', async () => {
    const mocks = buildMocks({ draft: null, activeSessionId: null, liveSessions: new Set() });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'ghost',
    });
    expect(out).toEqual({ applied: false, reason: 'not-authored' });
    expect(mocks.trace.setRows).toEqual([]);
    expect(mocks.trace.activate).toEqual([]);
  });

  it('a resolve failure returns not-authored (no mis-apply on a DB hiccup)', async () => {
    const mocks = buildMocks({ draft: { connectorId: 'linear', proposal: EMPTY }, activeSessionId: null, liveSessions: new Set(), resolveThrows: true });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'linear',
    });
    expect(out).toEqual({ applied: false, reason: 'not-authored' });
  });

  it('shown TOCTOU guard: a cap NOT in `shown` is skipped even if in the current proposal', async () => {
    // The draft proposes two hosts, but the card only showed one — the widened
    // host must never be approved (client `shown` can only NARROW).
    const mocks = buildMocks({
      draft: { connectorId: 'linear', proposal: { ...EMPTY, allowedHosts: ['api.linear.app', 'evil.example.com'] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'linear',
      shown: { hosts: ['api.linear.app'], slots: [], npm: [], pypi: [] },
    });
    expect(out).toEqual({ applied: true, respawned: false });
    expect(mocks.trace.setRows).toEqual([{ connectorId: 'linear', kind: 'host', value: 'api.linear.app' }]);
  });

  it('early approval with NO conversationId writes rows + activates, retires nothing', async () => {
    const mocks = buildMocks({
      draft: { connectorId: 'linear', proposal: { ...EMPTY, allowedHosts: ['api.linear.app'], credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      userId: 'user-1', agentId: 'agent-1', connectorId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: false });
    expect(mocks.trace.activate).toEqual([{ ownerUserId: 'user-1', agentId: 'agent-1', connectorId: 'linear' }]);
    expect(mocks.trace.terminate).toEqual([]);
    expect(mocks.trace.addHost).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // TASK-113 — promote-on-approval. The grant PROMOTES the approved authored
  // connector into the curated registry (`connectors:upsert`), so the EXISTING
  // registry read paths (resolveEffectiveConnectors → foldConnectorCaps, the 3
  // UI surfaces) pick it up with no further changes. Without this the approved
  // connector's reach is never folded (npx hits npm 403 + the reactive wall)
  // and it's invisible/unattachable in the UI — the TASK-101-walk bug.
  // -------------------------------------------------------------------------
  it('promotes the approved connector into the registry with keyMode/visibility + approved caps', async () => {
    const mocks = buildMocks({
      draft: {
        connectorId: 'linear',
        proposal: {
          ...EMPTY,
          allowedHosts: ['api.linear.app'],
          credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
          packages: { npm: ['@linear/cli'], pypi: [] },
        },
      },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: true });
    // The registry upsert carries the owner, id, name/usageNote/keyMode from the
    // resolved draft, the safe `private` visibility, and the APPROVED caps.
    expect(mocks.trace.upsert).toEqual([{
      userId: 'user-1',
      connectorId: 'linear',
      name: 'Linear',
      description: '',
      usageNote: 'Use the Linear CLI.',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
        mcpServers: [],
        packages: { npm: ['@linear/cli'], pypi: [] },
      },
    }]);
    // Audit flip still happens.
    expect(mocks.trace.activate).toEqual([{ ownerUserId: 'user-1', agentId: 'agent-1', connectorId: 'linear' }]);
  });

  it('the `shown` TOCTOU narrowing flows into the promoted caps (a non-shown host is absent from the registry row)', async () => {
    const mocks = buildMocks({
      draft: { connectorId: 'linear', proposal: { ...EMPTY, allowedHosts: ['api.linear.app', 'evil.example.com'] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']),
    });
    const h = await harnessFor(mocks);
    await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'linear',
      shown: { hosts: ['api.linear.app'], slots: [], npm: [], pypi: [] },
    });
    expect(mocks.trace.upsert).toHaveLength(1);
    // The widened (non-shown) host must NOT reach the registry row — promoted
    // reach == approved reach, never the full proposal.
    expect(mocks.trace.upsert[0]!.capabilities.allowedHosts).toEqual(['api.linear.app']);
  });

  it('mcpServers from the proposal ride into the promoted capabilities', async () => {
    const mcp = {
      name: 'drive', transport: 'http' as const, url: 'https://mcp.example.com',
      allowedHosts: ['mcp.example.com'], credentials: [],
    };
    const mocks = buildMocks({
      draft: { connectorId: 'drive', proposal: { ...EMPTY, mcpServers: [mcp] } },
      activeSessionId: null, liveSessions: new Set(),
    });
    const h = await harnessFor(mocks);
    await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      userId: 'user-1', agentId: 'agent-1', connectorId: 'drive',
    });
    expect(mocks.trace.upsert).toHaveLength(1);
    expect(mocks.trace.upsert[0]!.capabilities.mcpServers).toEqual([mcp]);
  });

  it('an unknown connectorId promotes nothing (server is authoritative)', async () => {
    const mocks = buildMocks({ draft: null, activeSessionId: null, liveSessions: new Set() });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'ghost',
    });
    expect(out).toEqual({ applied: false, reason: 'not-authored' });
    expect(mocks.trace.upsert).toEqual([]);
  });

  it('back-compat: with no `connectors:upsert` registered the grant still applies (hasService-guarded)', async () => {
    const mocks = buildMocks({
      draft: { connectorId: 'linear', proposal: { ...EMPTY, allowedHosts: ['api.linear.app'] } },
      activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']), noUpsert: true,
    });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-authored-connector-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', connectorId: 'linear',
    });
    expect(out).toEqual({ applied: true, respawned: false });
    expect(mocks.trace.upsert).toEqual([]);
    // The wall row + activate still happen even when promotion is unavailable.
    expect(mocks.trace.setRows).toEqual([{ connectorId: 'linear', kind: 'host', value: 'api.linear.app' }]);
    expect(mocks.trace.activate).toEqual([{ ownerUserId: 'user-1', agentId: 'agent-1', connectorId: 'linear' }]);
  });
});
