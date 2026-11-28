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
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AgentDefaultControls, AgentSelfImprovementSection } from '../AgentSelfImprovementSection';
import { agentStoreActions } from '@/lib/agent-store';

vi.mock('@/lib/routines', () => ({
  routineApi: {
    listAgentDefaults: vi.fn(),
    setAgentDefaultEnabled: vi.fn(),
  },
}));

import { routineApi } from '@/lib/routines';

const listAgentDefaults = vi.mocked(routineApi.listAgentDefaults);
const setAgentDefaultEnabled = vi.mocked(routineApi.setAgentDefaultEnabled);

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

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save: forbidden");
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
    expect(screen.getByText('No agents yet')).toBeInTheDocument();
  });

  it('a failed read says so (not "Couldn’t save") and Try again re-reads', async () => {
    listAgentDefaults.mockRejectedValueOnce(new Error('offline'));
    listAgentDefaults.mockResolvedValueOnce([
      { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: true },
    ]);
    seedAgents([{ id: 'a1', name: 'Research Bot' }]);

    render(<AgentSelfImprovementSection />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load this setting: offline");
    expect(alert).not.toHaveTextContent(/save/i);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const sw = await screen.findByRole('switch', { name: 'Skill self-improvement for Research Bot' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    expect(listAgentDefaults).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed save is a plain error with no retry button', async () => {
    listAgentDefaults.mockResolvedValue([
      { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: true },
    ]);
    setAgentDefaultEnabled.mockRejectedValue(new Error('forbidden'));
    seedAgents([{ id: 'a1', name: 'Research Bot' }]);
    render(<AgentSelfImprovementSection />);
    const sw = await screen.findByRole('switch', { name: 'Skill self-improvement for Research Bot' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save: forbidden");
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Saving…')).toBeNull();
  });
});

describe('AgentDefaultControls', () => {
  it('a failed read offers Try again, which re-reads the defaults', async () => {
    listAgentDefaults.mockRejectedValueOnce(new Error('nope'));
    listAgentDefaults.mockResolvedValueOnce([
      { defaultRoutineId: 'heartbeat', name: 'Heartbeat', enabled: true },
    ]);
    render(<AgentDefaultControls agentId="a1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Default routines are unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('switch', { name: 'Heartbeat' })).toBeInTheDocument();
    expect(listAgentDefaults).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed change is an error Notice, not a loading state, and the list stays', async () => {
    listAgentDefaults.mockResolvedValue([{ defaultRoutineId: 'heartbeat', name: 'Heartbeat', enabled: true }]);
    setAgentDefaultEnabled.mockRejectedValue(new Error('x'));
    render(<AgentDefaultControls agentId="a1" />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Heartbeat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t change this default routine.');
    expect(screen.getByRole('switch', { name: 'Heartbeat' })).toBeInTheDocument();
  });
});

describe('AgentSelfImprovementSection list', () => {
  it('is one named list with a row per agent, each with its own switch (the agent can be named from the row)', async () => {
    listAgentDefaults.mockResolvedValue([
      { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: true },
    ]);
    seedAgents([{ id: 'a1', name: 'Research Bot' }, { id: 'a2', name: 'Writer Bot' }]);
    render(<AgentSelfImprovementSection />);
    const list = await screen.findByRole('list', { name: 'Skill self-improvement' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Research Bot');
    expect(within(rows[1]!).getByRole('switch', { name: 'Skill self-improvement for Writer Bot' })).toBeInTheDocument();
  });

  it('a failed save puts its alert in a row of its own, right under the agent, and rolls the switch back', async () => {
    listAgentDefaults.mockResolvedValue([
      { defaultRoutineId: 'skill-reflection', name: 'skill-reflection', enabled: true },
    ]);
    setAgentDefaultEnabled.mockRejectedValue(new Error('nope'));
    seedAgents([{ id: 'a1', name: 'Research Bot' }]);
    render(<AgentSelfImprovementSection />);
    const sw = await screen.findByRole('switch', { name: 'Skill self-improvement for Research Bot' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw);
    const row = sw.closest('li') as HTMLElement;
    // The alert is inside the agent's own list item, and the list still has one item per agent.
    expect(await within(row).findByRole('alert')).toHaveTextContent("Couldn't save: nope");
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });
});
