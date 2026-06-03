import { describe, it, expect } from 'vitest';
import {
  makeAgentContext,
  createLogger,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// The connector approval card must surface AT PROPOSAL TIME, not only at the
// start of the NEXT turn.
//
// Bug (found 2026-06-03): `connector_propose` persists a PENDING authored draft
// mid-turn, but the orchestrator only fired the approval card inside
// `agent:invoke` (turn start). A user who proposed a connector and never sent a
// second message never saw the card — the draft was stranded `pending`.
//
// Fix: `connectors:install-authored` fires a `connectors:proposed` subscriber
// event; the orchestrator subscribes and fires the same upfront card (reusing
// `fireUpfrontConnectorCards`), so the card delivers live on the in-flight turn
// — the proven `request_capability` (skill JIT card) pattern.
//
// This test drives the subscriber directly: firing `connectors:proposed` (no
// full agent:invoke) must produce exactly ONE kind:'connector' card on the
// firing ctx's conversation.
// ---------------------------------------------------------------------------

// The orchestrator declares these four as hard `calls`; the harness verifies
// every declared call is registered before bootstrap. They are irrelevant to
// the connectors:proposed path under test — stub them so bootstrap succeeds.
const HARD_CALL_STUBS: Record<string, ServiceHandler> = {
  'session:queue-work': async () => ({ cursor: 0 }),
  'session:terminate': async () => ({}),
  'sandbox:open-session': async () => ({
    runnerEndpoint: 'unix:///tmp/mock.sock',
    handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
  }),
  'agents:resolve': async () => ({ agent: {} }),
};

function proposeCtx(opts: { conversationId: string; userId: string; agentId: string }) {
  return makeAgentContext({
    sessionId: 'sess-propose',
    agentId: opts.agentId,
    userId: opts.userId,
    conversationId: opts.conversationId,
    reqId: 'req-propose',
    logger: createLogger({ reqId: 'orch-test', writer: () => undefined }),
  });
}

const LINEAR_DRAFT = {
  connectorId: 'linear',
  name: 'Linear',
  usageNote: '',
  keyMode: 'personal' as const,
  status: 'pending' as const,
  proposal: {
    allowedHosts: ['api.linear.app'],
    credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
    mcpServers: [],
    packages: { npm: ['@schpet/linear-cli'], pypi: [] },
  },
};

describe('chat-orchestrator — connectors:proposed fires the card mid-turn', () => {
  it('fires ONE connector card when connectors:proposed is fired (no agent:invoke turn)', async () => {
    const listAuthoredCalls: Array<{ ownerUserId: string; agentId: string }> = [];
    const services: Record<string, ServiceHandler> = {
      ...HARD_CALL_STUBS,
      'connectors:list-authored': async (_ctx, input: unknown) => {
        listAuthoredCalls.push(input as { ownerUserId: string; agentId: string });
        return { drafts: [LINEAR_DRAFT] };
      },
    };

    const h = await createTestHarness({
      services,
      plugins: [
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          chatTimeoutMs: 5_000,
        }),
      ],
    });

    const cards: Array<Record<string, unknown>> = [];
    h.bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      if ((p as { kind?: string }).kind === 'connector') cards.push(p as Record<string, unknown>);
      return undefined;
    });

    await h.bus.fire(
      'connectors:proposed',
      proposeCtx({ conversationId: 'conv-x', userId: 'user-x', agentId: 'agent-x' }),
      { ownerUserId: 'user-x', agentId: 'agent-x', connectorId: 'linear', status: 'pending' },
    );

    // The subscriber resolved the draft for the firing (user, agent)…
    expect(listAuthoredCalls).toEqual([{ ownerUserId: 'user-x', agentId: 'agent-x' }]);
    // …and surfaced exactly one connector card on the firing conversation.
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: 'connector',
      connectorId: 'linear',
      name: 'Linear',
      hosts: ['api.linear.app'],
      packages: { npm: ['@schpet/linear-cli'], pypi: [] },
    });
  });

  it('does not fire a card when the proposing ctx has no conversation (canary/unbound)', async () => {
    const services: Record<string, ServiceHandler> = {
      ...HARD_CALL_STUBS,
      'connectors:list-authored': async () => ({ drafts: [LINEAR_DRAFT] }),
    };
    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 })],
    });

    const cards: Array<Record<string, unknown>> = [];
    h.bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      if ((p as { kind?: string }).kind === 'connector') cards.push(p as Record<string, unknown>);
      return undefined;
    });

    // No conversationId on ctx → nothing the card can key off → no card.
    await h.bus.fire(
      'connectors:proposed',
      makeAgentContext({
        sessionId: 'sess',
        agentId: 'agent-x',
        userId: 'user-x',
        reqId: 'req',
        logger: createLogger({ reqId: 'orch-test', writer: () => undefined }),
      }),
      { ownerUserId: 'user-x', agentId: 'agent-x', connectorId: 'linear', status: 'pending' },
    );

    expect(cards).toHaveLength(0);
  });
});
