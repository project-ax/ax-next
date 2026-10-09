import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoutinesList } from '../components/routines/RoutinesList';
import { routineApi, RoutineApiError } from '@/lib/routines';
import { routineFixture as row } from '../components/routines/__tests__/routine-fixture';
vi.mock('@/lib/routines', async (original) => ({
  ...(await original<typeof import('@/lib/routines')>()),
  routineApi: {
    list: vi.fn(),
    get: vi.fn(),
    recentFires: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(routineApi.list).mockResolvedValue([row]);
  vi.mocked(routineApi.recentFires).mockResolvedValue([]);
  vi.mocked(routineApi.get).mockResolvedValue(row);
});
function show() {
  render(<RoutinesList agentId="a" agentName="Caveman" onFired={vi.fn()} />);
}
describe('routine list', () => {
  it('shows only authored routines, and loads fires by opaque ID on disclosure', async () => {
    vi.mocked(routineApi.list).mockResolvedValue([
      row,
      {
        ...row,
        routineId: 'default:heartbeat',
        origin: 'default',
        name: 'Heartbeat',
      },
    ]);
    show();
    await screen.findByText(row.name);
    expect(screen.queryByText('Heartbeat')).not.toBeInTheDocument();
    expect(routineApi.recentFires).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: `Recent runs for ${row.name}` }),
    );
    expect(await screen.findByText('No runs yet.')).toBeVisible();
    expect(routineApi.recentFires).toHaveBeenCalledWith({
      agentId: 'a',
      routineId: row.routineId,
      limit: 20,
    });
  });
  it('uses read permissions for edit, stop, fire and secret controls', async () => {
    vi.mocked(routineApi.list).mockResolvedValue([
      {
        ...row,
        permissions: {
          edit: false,
          stop: false,
          fire: false,
          manageSecret: false,
        },
      },
    ]);
    show();
    await screen.findByText(row.name);
    expect(
      screen.queryByRole('button', { name: `Edit ${row.name}` }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: `Recent runs for ${row.name}` }),
    );
    expect(
      screen.queryByRole('button', { name: 'Fire now' }),
    ).not.toBeInTheDocument();
  });
  it('opens a fresh edit and sends enable/delete revision checks with retry-stable IDs', async () => {
    vi.mocked(routineApi.remove)
      .mockRejectedValueOnce(new RoutineApiError(0))
      .mockResolvedValue({ deleted: true, cleanupPending: false });
    show();
    await screen.findByText(row.name);
    fireEvent.click(screen.getByRole('button', { name: `Edit ${row.name}` }));
    await screen.findByDisplayValue(row.name);
    expect(routineApi.get).toHaveBeenCalledWith({
      agentId: 'a',
      routineId: row.routineId,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(
      screen.getByRole('button', { name: `Recent runs for ${row.name}` }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete routine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Routine management is temporarily unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(routineApi.remove).toHaveBeenCalledTimes(2));
    expect(vi.mocked(routineApi.remove).mock.calls[0]).toEqual(
      vi.mocked(routineApi.remove).mock.calls[1],
    );
    expect(routineApi.remove).toHaveBeenCalledWith({
      agentId: 'a',
      routineId: row.routineId,
      expectedRevision: row.revision,
      requestId: expect.any(String),
    });
  });
  it('retries an unconfirmed enable change with its original revision even after refresh', async () => {
    vi.mocked(routineApi.update)
      .mockRejectedValueOnce(new RoutineApiError(0))
      .mockResolvedValue(row);
    show();
    await screen.findByText(row.name);
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText('Routine management is temporarily unavailable.');
    vi.mocked(routineApi.list).mockResolvedValue([
      { ...row, revision: 'new-revision', enabled: !row.enabled },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(routineApi.list).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Retry change' }));
    await waitFor(() => expect(routineApi.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(routineApi.update).mock.calls[1]).toEqual(
      vi.mocked(routineApi.update).mock.calls[0],
    );
  });
  it('does not show failed list reads as an empty list', async () => {
    vi.mocked(routineApi.list).mockRejectedValue(new Error('private'));
    show();
    expect(await screen.findByText('We couldn’t load routines.')).toBeVisible();
    expect(screen.queryByText('No routines yet')).not.toBeInTheDocument();
  });
  it('renders model-authored names as text', async () => {
    vi.mocked(routineApi.list).mockResolvedValue([
      { ...row, name: '<img src=x onerror=evil()>' },
    ]);
    show();
    expect(await screen.findByText('<img src=x onerror=evil()>')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });
});
