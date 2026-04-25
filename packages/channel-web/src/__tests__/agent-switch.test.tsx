/**
 * Agent chip + menu — deferred-switch semantics.
 *
 * The three behaviors under test (see Task 12 plan):
 *
 *   1. Empty session: picking a different agent retags the existing
 *      session via PATCH. No new session is created.
 *
 *   2. Non-empty session: picking a different agent sets pendingAgentId
 *      only. The chat view goes blank, the previous session stays in the
 *      sidebar, and no network call fires until the next message lands.
 *
 *   3. Switching the active session (or starting a fresh one) clears
 *      pendingAgentId.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AgentChip } from '../components/AgentChip';
import { agentStoreActions } from '../lib/agent-store';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Reset store between tests to avoid bleed.
  agentStoreActions.setActiveSession(null, false);
  agentStoreActions.setSelectedAgent(null);
  agentStoreActions.setAgents([
    {
      id: 'tide',
      owner_id: 't1',
      owner_type: 'team',
      name: 'tide',
      desc: 'work',
      color: '#7aa6c9',
      tag: 'work',
      system_prompt: '',
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
      system_prompt: '',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    },
  ]);
});

describe('AgentChip + AgentMenu', () => {
  it('lists agents in the menu and shows checkmark on selected', () => {
    agentStoreActions.setSelectedAgent('tide');
    render(<AgentChip />);
    fireEvent.click(screen.getByRole('button', { name: /tide/i }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    const checks = screen.getAllByText('✓');
    expect(checks).toHaveLength(1);
  });

  it('empty session: picking a different agent retags via PATCH (no new session)', async () => {
    agentStoreActions.setSelectedAgent('tide');
    agentStoreActions.setActiveSession('sess-1', false);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    render(<AgentChip />);
    fireEvent.click(screen.getByRole('button', { name: /tide/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /mercy/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/sessions/sess-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  it('non-empty session: picking a different agent sets pending (no new session yet)', () => {
    agentStoreActions.setSelectedAgent('tide');
    agentStoreActions.setActiveSession('sess-1', true);
    render(<AgentChip />);
    fireEvent.click(screen.getByRole('button', { name: /tide/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /mercy/i }));
    // No PATCH, no POST — just pendingAgentId set
    expect(fetchMock).not.toHaveBeenCalled();
    // Chip now shows mercy
    expect(screen.getByRole('button', { name: /mercy/i })).toBeTruthy();
  });

  it('switching active session clears pendingAgentId', () => {
    // Set up a pending switch first (mercy pending while on sess-1).
    agentStoreActions.setSelectedAgent('tide');
    agentStoreActions.setActiveSession('sess-1', true);
    render(<AgentChip />);
    fireEvent.click(screen.getByRole('button', { name: /tide/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /mercy/i }));
    // Confirm pending was set (chip now reads mercy).
    expect(screen.getByRole('button', { name: /mercy/i })).toBeTruthy();

    // Now switch to a different session — pending should clear, chip
    // falls back to the explicitly-selected agent (tide).
    act(() => {
      agentStoreActions.setActiveSession('sess-2', false);
    });
    expect(screen.getByRole('button', { name: /tide/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /mercy/i })).toBeFalsy();
  });
});
