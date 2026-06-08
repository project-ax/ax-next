/**
 * AgentSelfImprovementSection — the per-agent "Skill self-improvement"
 * toggle (TASK-179).
 *
 * Pinned behaviors:
 *   - One Switch per owned agent, initial state from listAgentDefaults
 *     (default-ON: enabled === true unless overridden false).
 *   - Flipping the Switch calls setAgentDefaultEnabled with the right
 *     agentId / defaultRoutineId / enabled.
 *   - A save failure rolls the Switch back and surfaces the error.
 *   - An agent whose catalog has no skill-reflection default renders no row.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentSelfImprovementSection } from '../AgentSelfImprovementSection';
import { agentStoreActions } from '@/lib/agent-store';

vi.mock('@/lib/routines', () => ({
  routines: {
    listAgentDefaults: vi.fn(),
    setAgentDefaultEnabled: vi.fn(),
  },
}));

import { routines } from '@/lib/routines';

const listAgentDefaults = vi.mocked(routines.listAgentDefaults);
const setAgentDefaultEnabled = vi.mocked(routines.setAgentDefaultEnabled);

function seedAgents(
  agents: Array<{ id: string; name: string }>,
): void {
  agentStoreActions.setAgents(
    agents.map((a) => ({
      id: a.id,
      owner_id: 'u1',
      owner_type: 'user' as const,
      name: a.name,
      tag: '',
      desc: '',
      color: '#888',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    })),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  agentStoreActions.resetForTest();
});
afterEach(() => {
  agentStoreActions.resetForTest();
});

describe('AgentSelfImprovementSection', () => {
  it('renders an ON switch per owned agent (default-ON)', async () => {
    listAgentDefaults.mockResolvedValue([
      { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: true },
    ]);
    seedAgents([{ id: 'a1', name: 'Research Bot' }]);

    render(<AgentSelfImprovementSection />);

    const sw = await screen.findByRole('switch', {
      name: 'Skill self-improvement for Research Bot',
    });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('reflects a per-agent disabled override (switch OFF)', async () => {
    listAgentDefaults.mockResolvedValue([
      { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: false },
    ]);
    seedAgents([{ id: 'a1', name: 'Research Bot' }]);

    render(<AgentSelfImprovementSection />);

    const sw = await screen.findByRole('switch', {
      name: 'Skill self-improvement for Research Bot',
    });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });

  it('flips the toggle off via setAgentDefaultEnabled', async () => {
    listAgentDefaults.mockResolvedValue([
      { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: true },
    ]);
    setAgentDefaultEnabled.mockResolvedValue(undefined);
    seedAgents([{ id: 'a1', name: 'Research Bot' }]);

    render(<AgentSelfImprovementSection />);
    const sw = await screen.findByRole('switch', {
      name: 'Skill self-improvement for Research Bot',
    });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(sw);

    await waitFor(() =>
      expect(setAgentDefaultEnabled).toHaveBeenCalledWith({
        agentId: 'a1',
        defaultRoutineId: 'skill-reflection',
        enabled: false,
      }),
    );
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });

  it('rolls the switch back and shows an error when the save fails', async () => {
    listAgentDefaults.mockResolvedValue([
      { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: true },
    ]);
    setAgentDefaultEnabled.mockRejectedValue(new Error('forbidden'));
    seedAgents([{ id: 'a1', name: 'Research Bot' }]);

    render(<AgentSelfImprovementSection />);
    const sw = await screen.findByRole('switch', {
      name: 'Skill self-improvement for Research Bot',
    });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(sw);

    await screen.findByText(/Couldn't save: forbidden/);
    // Rolled back to ON after the failure.
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('renders no row for an agent whose catalog lacks skill-reflection', async () => {
    listAgentDefaults.mockResolvedValue([
      { defaultRoutineId: 'heartbeat', name: 'heartbeat', enabled: true },
    ]);
    seedAgents([{ id: 'a1', name: 'Research Bot' }]);

    render(<AgentSelfImprovementSection />);
    // The card title is always present; the per-agent toggle row is not.
    await waitFor(() => expect(listAgentDefaults).toHaveBeenCalled());
    expect(
      screen.queryByRole('switch', {
        name: 'Skill self-improvement for Research Bot',
      }),
    ).toBeNull();
  });

  it('shows the empty state when the user has no agents', () => {
    seedAgents([]);
    render(<AgentSelfImprovementSection />);
    expect(screen.getByText(/No agents yet/)).toBeInTheDocument();
  });
});
