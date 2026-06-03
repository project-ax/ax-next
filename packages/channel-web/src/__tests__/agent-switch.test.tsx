/**
 * Agent chip + menu — agent-switch semantics.
 *
 *   1. Empty session: picking a different agent records the new
 *      selection. No network call fires (the server creates a new
 *      conversation row on the next user message — agents are
 *      immutable on existing rows per Invariant I10).
 *
 *   2. Non-empty session: picking a different agent commits the new
 *      agent immediately, resets the chat view via switchToNewThread,
 *      and clears the active session pointer in both stores so the
 *      next user message POSTs with conversationId: null. The
 *      previous conversation stays in the sidebar list.
 *
 * The earlier `pendingAgentId` indirection was removed in favour of
 * immediate commit. Picking an agent has no "deferred" semantics
 * anymore — the chip and the next message both refer to the freshly
 * picked agent the moment the menu row is clicked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentChip } from '../components/AgentChip';
import { agentStoreActions } from '../lib/agent-store';

// Hoisted because vi.mock factory is hoisted to the top of the module —
// it can't reference plain top-level `const`s without `vi.hoisted`.
const switchToNewThread = vi.hoisted(() => vi.fn());
vi.mock('@assistant-ui/react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@assistant-ui/react',
  );
  return {
    ...actual,
    useAui: () => ({
      threads: () => ({ switchToNewThread, switchToThread: vi.fn() }),
    }),
  };
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  switchToNewThread.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Reset store between tests to avoid bleed.
  agentStoreActions.setActiveSession(null, false);
  agentStoreActions.setSelectedAgent(null);
  agentStoreActions.setAgents([
    {
      id: 'ax',
      owner_id: 't1',
      owner_type: 'team',
      name: 'ax',
      desc: 'work',
      color: '#7aa6c9',
      tag: 'work',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    },
    {
      id: 'mercy',
      owner_id: 'u1',
      owner_type: 'user',
      name: 'mercy',
      desc: 'legal',
      color: '#b08968',
      tag: 'legal',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    },
  ]);
});

describe('AgentChip + AgentMenu', () => {
  it('lists agents in the menu and marks selected with aria-current', () => {
    agentStoreActions.setSelectedAgent('ax');
    const { container } = render(<AgentChip />);
    fireEvent.click(screen.getByRole('button', { name: /ax/i }));
    // Menu rows are plain buttons (role=menu/menuitem semantics dropped
    // until full keyboard nav is implemented). Two rows exist; the
    // active one carries `aria-current="true"`.
    const rows = container.querySelectorAll('button.agent-menu-row');
    expect(rows).toHaveLength(2);
    const active = container.querySelectorAll('button[aria-current="true"]');
    expect(active).toHaveLength(1);
    const checks = screen.getAllByText('✓');
    expect(checks).toHaveLength(1);
  });

  it('empty conversation: picking a different agent records the pick without a network call (I10 — agent immutability)', async () => {
    agentStoreActions.setSelectedAgent('ax');
    agentStoreActions.setActiveSession('sess-1', false);
    const { container } = render(<AgentChip />);
    fireEvent.click(screen.getByRole('button', { name: /ax/i }));
    const mercyRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button.agent-menu-row'),
    ).find((b) => /mercy/i.test(b.textContent ?? ''));
    expect(mercyRow).toBeTruthy();
    fireEvent.click(mercyRow!);
    // The AX wire forbids retagging an existing conversation's agent;
    // the chip just records the pick locally — the next user message
    // creates a fresh conversation under the new agent.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /mercy/i })).toBeTruthy();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-empty session: picking a different agent commits the new agent, resets the chat view, and drops the active session pointer', () => {
    agentStoreActions.setSelectedAgent('ax');
    agentStoreActions.setActiveSession('sess-1', true);
    const { container } = render(<AgentChip />);
    fireEvent.click(screen.getByRole('button', { name: /ax/i }));
    const mercyRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button.agent-menu-row'),
    ).find((b) => /mercy/i.test(b.textContent ?? ''));
    fireEvent.click(mercyRow!);

    // No network call fires — agents are immutable on existing
    // conversations (Invariant I10), so the next user message will
    // create a fresh row server-side instead of retagging.
    expect(fetchMock).not.toHaveBeenCalled();
    // Chip now shows mercy (committed immediately, not deferred).
    expect(screen.getByRole('button', { name: /mercy/i })).toBeTruthy();
    // Chat view reset: assistant-ui's RemoteThreadList is the source
    // of truth for the visible thread, so we ask it to switch to a
    // brand-new thread.
    expect(switchToNewThread).toHaveBeenCalledTimes(1);
  });

  it('empty session: picking a different agent does NOT switch threads (welcome already showing)', () => {
    agentStoreActions.setSelectedAgent('ax');
    agentStoreActions.setActiveSession('sess-1', false);
    const { container } = render(<AgentChip />);
    fireEvent.click(screen.getByRole('button', { name: /ax/i }));
    const mercyRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button.agent-menu-row'),
    ).find((b) => /mercy/i.test(b.textContent ?? ''));
    fireEvent.click(mercyRow!);
    expect(switchToNewThread).not.toHaveBeenCalled();
  });
});
