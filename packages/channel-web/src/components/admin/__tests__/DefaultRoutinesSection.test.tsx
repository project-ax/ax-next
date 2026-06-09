import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DefaultRoutinesSection } from '../DefaultRoutinesSection';
import type { DefaultRoutineSummary } from '@ax/routines';

// Mock the wire client
vi.mock('@/lib/default-routines', () => ({
  listDefaultRoutines: vi.fn(),
  deleteDefaultRoutine: vi.fn(),
  getDefaultRoutine: vi.fn(),
  upsertDefaultRoutine: vi.fn(),
  updateDefaultRoutine: vi.fn(),
}));

// Mock the shared RoutineEditor so these tests stay focused on the section's
// table / dialog / delete behaviour, not the editor internals.
vi.mock('@/components/routines/RoutineEditor', () => ({
  RoutineEditor: ({ onCancel }: { onCancel: () => void }) => (
    <div data-testid="routine-editor">
      <button onClick={onCancel}>Cancel editor</button>
    </div>
  ),
}));

import {
  listDefaultRoutines,
  deleteDefaultRoutine,
  getDefaultRoutine,
} from '@/lib/default-routines';

const mockList = vi.mocked(listDefaultRoutines);
const mockDelete = vi.mocked(deleteDefaultRoutine);
const mockGet = vi.mocked(getDefaultRoutine);

const HEARTBEAT: DefaultRoutineSummary = {
  defaultRoutineId: 'heartbeat',
  name: 'heartbeat',
  description: 'Daily check-in.',
  trigger: { kind: 'interval', every: '1d' },
  enabled: true,
  updatedAt: '2026-05-19T00:00:00.000Z',
};

const HOURLY: DefaultRoutineSummary = {
  defaultRoutineId: 'hourly-poll',
  name: 'hourly-poll',
  description: 'Hourly poll.',
  trigger: { kind: 'interval', every: '1h' },
  enabled: false,
  updatedAt: '2026-05-18T00:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDelete.mockResolvedValue(undefined);
});

describe('DefaultRoutinesSection', () => {
  it('renders a list of default routines on mount', async () => {
    mockList.mockResolvedValueOnce([HEARTBEAT, HOURLY]);
    render(<DefaultRoutinesSection />);

    await waitFor(() => {
      expect(screen.getByText('heartbeat')).toBeTruthy();
      expect(screen.getByText('hourly-poll')).toBeTruthy();
    });

    expect(screen.getByText('Daily check-in.')).toBeTruthy();
    expect(screen.getByText('Hourly poll.')).toBeTruthy();
    expect(screen.getByText('interval 1d')).toBeTruthy();
    expect(screen.getByText('interval 1h')).toBeTruthy();
  });

  it('renders a "disabled" badge for disabled defaults', async () => {
    mockList.mockResolvedValueOnce([HEARTBEAT, HOURLY]);
    render(<DefaultRoutinesSection />);

    const hourlyCell = await screen.findByText('hourly-poll');
    const hourlyRow = hourlyCell.closest('tr');
    expect(hourlyRow).toBeTruthy();
    expect(hourlyRow!.textContent).toMatch(/disabled/i);

    const heartbeatRow = screen.getByText('heartbeat').closest('tr');
    expect(heartbeatRow!.textContent).not.toMatch(/disabled/i);
  });

  it('shows empty state when no defaults exist', async () => {
    mockList.mockResolvedValueOnce([]);
    render(<DefaultRoutinesSection />);

    await waitFor(() => {
      expect(screen.getByText(/No default routines yet/)).toBeTruthy();
    });
  });

  it('shows loading state before promise resolves', () => {
    // Never resolve so we can observe the loading state
    mockList.mockReturnValueOnce(new Promise(() => {}));
    render(<DefaultRoutinesSection />);

    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows error alert when fetch fails', async () => {
    mockList.mockRejectedValueOnce(new Error('Network error'));
    render(<DefaultRoutinesSection />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
  });

  it('clicking "New default routine" opens the editor dialog', async () => {
    mockList.mockResolvedValueOnce([]);
    render(<DefaultRoutinesSection />);

    await waitFor(() => {
      expect(screen.getByText(/No default routines yet/)).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: /new default routine/i }),
    );

    await waitFor(() => {
      expect(screen.getByText('Create a default routine')).toBeTruthy();
    });
    expect(screen.getByTestId('routine-editor')).toBeTruthy();
  });

  it('clicking edit fetches the routine and opens the editor populated', async () => {
    mockList.mockResolvedValueOnce([HEARTBEAT]);
    mockGet.mockResolvedValueOnce({
      ...HEARTBEAT,
      sourceMd: '---\nname: heartbeat\n---\nbody',
      silenceToken: null,
      silenceMax: 300,
      conversation: 'shared',
      activeHours: null,
      promptBody: 'check in',
    });
    render(<DefaultRoutinesSection />);

    await waitFor(() => {
      expect(screen.getByText('heartbeat')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit heartbeat' }));

    await waitFor(() => {
      expect(
        screen.getByText('Edit default routine: heartbeat'),
      ).toBeTruthy();
    });
    // The editor renders once getDefaultRoutine resolves and fields load.
    expect(await screen.findByTestId('routine-editor')).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith('heartbeat');
  });

  it('clicking delete shows confirm; clicking Delete calls deleteDefaultRoutine', async () => {
    mockList.mockResolvedValue([HEARTBEAT]);
    render(<DefaultRoutinesSection />);

    await waitFor(() => {
      expect(screen.getByText('heartbeat')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete heartbeat' }));

    await waitFor(() => {
      expect(screen.getByText('Delete default routine?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('heartbeat');
    });
  });

  it('server-side delete error surfaces in the alert', async () => {
    mockList.mockResolvedValue([HEARTBEAT]);
    mockDelete.mockRejectedValueOnce(new Error('delete-failed'));
    render(<DefaultRoutinesSection />);

    await waitFor(() => {
      expect(screen.getByText('heartbeat')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete heartbeat' }));
    await waitFor(() => {
      expect(screen.getByText('Delete default routine?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByText('delete-failed')).toBeTruthy();
    });
  });
});
