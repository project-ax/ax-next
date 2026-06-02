/**
 * Integration regression test for the first-run AgentBootstrap done-screen bug.
 *
 * The unit test for <AgentBootstrap> in isolation never caught this: in
 * isolation the component always renders its own 'done' step. The real bug was
 * an *interaction* with App's first-run gate — hydrating/selecting the agent
 * inside create() populated the agent store, which flipped the gate
 * (`shouldShowAgentBootstrap` → false) and unmounted AgentBootstrap before its
 * 'done' screen could paint. The user jumped straight to chat; "Start chatting →"
 * was dead code in first-run.
 *
 * This harness mirrors AppContent's gate exactly — it uses the REAL
 * `shouldShowAgentBootstrap` predicate (the same one AppContent calls) against
 * the REAL live agent store (`useAgentStore`), and a mocked `hydrateAgentsOnce`
 * that mutates the store the way the real one does (calls `setAgents`). So when
 * AgentBootstrap mutates the store, the gate re-renders against it —
 * reproducing the unmount-before-done interaction. (Rendering the full
 * <AppContent> would drag the whole chat runtime in, which the gate test
 * doesn't need.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { shouldShowAgentBootstrap } from '../../lib/agent-bootstrap-gate';
import { AgentBootstrap } from '../onboard/AgentBootstrap';
import { agentStoreActions, useAgentStore } from '../../lib/agent-store';
import type { Agent } from '../../../mock/agents';

vi.mock('../../lib/agent-bootstrap', () => ({
  bootstrapAgent: vi.fn(async () => ({ agentId: 'a-new', displayName: 'Ada', visibility: 'personal' })),
}));
// Faithful mock: the real hydrateAgentsOnce fetches /api/chat/agents and calls
// agentStoreActions.setAgents(...), which sets agentsStatus 'ready' with a
// populated list — exactly the store mutation that flips the first-run gate.
vi.mock('../../lib/hydrate-agents', () => ({
  hydrateAgentsOnce: vi.fn(async () => {
    const agent = { id: 'a-new', name: 'Ada' } as unknown as Agent;
    agentStoreActions.setAgents([agent]);
  }),
}));

import { hydrateAgentsOnce } from '../../lib/hydrate-agents';

/**
 * A faithful stand-in for AppContent's gate: same predicate, same live store,
 * rendering AgentBootstrap or a chat-shell sentinel. No chat runtime.
 */
function GatedSurface() {
  const { agents, agentsStatus } = useAgentStore();
  if (shouldShowAgentBootstrap({ agentsStatus, agentCount: agents.length, createAgentOpen: false })) {
    return <AgentBootstrap onDone={() => {}} />;
  }
  return <div data-testid="chat-shell">chat shell — active agent: {agents[0]?.id ?? '∅'}</div>;
}

beforeEach(() => agentStoreActions.resetForTest());
afterEach(() => vi.clearAllMocks());

describe('first-run AgentBootstrap gate interaction', () => {
  it('keeps the done screen reachable: create → "{name} is ready" (chat shell NOT shown), then Start chatting → chat', async () => {
    // First-run: agent list loaded ready + empty ⇒ the gate mounts AgentBootstrap.
    agentStoreActions.setAgents([]);
    render(<GatedSurface />);

    // Gate mounts AgentBootstrap, not the chat shell.
    expect(screen.queryByTestId('chat-shell')).toBeNull();

    // Walk name → soul → purpose → Create.
    fireEvent.change(screen.getByLabelText(/what should we call/i), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i })); // soul (default)
    fireEvent.click(screen.getByRole('button', { name: /create ada/i }));

    // The done screen renders — and the chat shell does NOT. This is the
    // regression: pre-fix, create() hydrated the store mid-flow, the gate
    // flipped, AgentBootstrap unmounted, and the chat shell showed instead.
    await waitFor(() => expect(screen.getByText(/ada is ready/i)).toBeTruthy());
    expect(screen.queryByTestId('chat-shell')).toBeNull();
    expect(hydrateAgentsOnce).not.toHaveBeenCalled();

    // "Start chatting →" commits the store mutation: gate flips, AgentBootstrap
    // unmounts, and the chat shell renders with the new agent active.
    fireEvent.click(screen.getByRole('button', { name: /start chatting/i }));
    await waitFor(() => expect(screen.getByTestId('chat-shell')).toBeTruthy());
    expect(hydrateAgentsOnce).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chat-shell').textContent).toContain('a-new');
    expect(screen.queryByText(/ada is ready/i)).toBeNull();
  });
});
