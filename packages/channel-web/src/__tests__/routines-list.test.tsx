import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
    fireNow: vi.fn(),
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
  it('shows the admitted waiting count without payload content', async () => {
    vi.mocked(routineApi.list).mockResolvedValue([{ ...row, delivery: { active: 3, waiting: 2 } }]);
    show();
    expect(await screen.findByText('2 app updates waiting.')).toBeVisible();
  });
  it('keeps a definitive busy response visible when the fire control releases its pending lock', async () => {
    vi.mocked(routineApi.fireNow).mockRejectedValue(new RoutineApiError(409,'busy','routineId'));
    show();await screen.findByText(row.name);
    fireEvent.click(screen.getByRole('button',{name:`Recent runs for ${row.name}`}));
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Fire now'}));});
    expect(routineApi.list).toHaveBeenCalledTimes(1);
    expect(screen.getByText('This task is already at its run limit. Try again when a run finishes.')).toBeVisible();
    expect(screen.getByRole('button',{name:'Fire now'})).toBeEnabled();
  });
  it('reloads the original agent when a different agent read is still pending', async () => {
    const props={agentName:'Caveman',onFired:vi.fn()};
    const view=render(<RoutinesList {...props} agentId="a"/>);await screen.findByText(row.name);
    vi.mocked(routineApi.list).mockImplementation(async id=>id==='b'?new Promise(()=>{}):[row]);
    view.rerender(<RoutinesList {...props} agentId="b"/>);
    view.rerender(<RoutinesList {...props} agentId="a"/>);
    expect(routineApi.list).toHaveBeenCalledTimes(3);
    expect(await screen.findByText(row.name)).toBeVisible();
  });
  it('shows the scheduled-run repair warning before opening history (TASK-924)', async () => {
    const warning = 'Scheduled runs need repair. Choose different start and end times for active hours.';
    vi.mocked(routineApi.list).mockResolvedValue([{ ...row, activeHours: { start: '09:00', end: '09:00', tz: 'UTC' }, lastWarning: warning, nextRunAt: null }]);
    show();
    expect(await screen.findByText(warning)).toBeVisible();
    expect(screen.getByRole('switch', { name: `Enabled for ${row.name}` })).toBeEnabled();
  });
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
  it('renders a stay-on-top task like any authored routine', async () => {
    vi.mocked(routineApi.list).mockResolvedValue([
      { ...row, kind: 'stay-on-top', goodWhen: 'Inbox at zero.' },
    ]);
    show();
    await screen.findByText(row.name);
    expect(
      screen.getByRole('button', { name: `Edit ${row.name}` }),
    ).toBeVisible();
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
  it('lets a stop-only team manager disable and delete, but never enable, edit or fire', async () => {
    const managed = { ...row, permissions: { edit: false, stop: true, fire: false, manageSecret: false } };
    vi.mocked(routineApi.list).mockResolvedValue([managed]);
    vi.mocked(routineApi.update).mockImplementation(async () => { const disabled = { ...managed, enabled: false, revision: 'disabled-v' }; vi.mocked(routineApi.list).mockResolvedValue([disabled]); return disabled; });
    show();
    await screen.findByText(row.name);
    expect(screen.queryByRole('button', { name: `Edit ${row.name}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked());
    expect(routineApi.update).toHaveBeenCalledWith({ agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, requestId: expect.any(String), patch: { enabled: false } });
    expect(screen.getByRole('switch')).toBeDisabled();
    fireEvent.click(screen.getByRole('switch'));
    expect(routineApi.update).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: `Recent runs for ${row.name}` }));
    expect(screen.queryByRole('button', { name: 'Fire now' })).not.toBeInTheDocument();
    vi.mocked(routineApi.remove).mockResolvedValue({ deleted: true, cleanupPending: false });
    fireEvent.click(screen.getByRole('button', { name: 'Delete routine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(routineApi.remove).toHaveBeenCalledWith({ agentId: 'a', routineId: row.routineId, expectedRevision: 'disabled-v', requestId: expect.any(String) }));
  });
  it('shows HMAC credential controls to a member owner with secret-management permission', async () => {
    vi.mocked(routineApi.list).mockResolvedValue([{ ...row, schedule: null, webhook: { kind: 'webhook', path: '/member', hmac: { header: 'sig', algorithm: 'sha256' } } }]);
    show(); // isAdmin=false, while the real owner shape has manageSecret=true
    await screen.findByText(row.name);
    fireEvent.click(screen.getByRole('button', { name: `Recent runs for ${row.name}` }));
    expect(await screen.findByText('Webhook HMAC secret')).toBeInTheDocument();
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
  it('preserves a pending/lost fire across attempted collapse and deferred refresh until exact retry reconciles', async () => {
    let lose!: (error: Error) => void;
    let reconcile!: (value: { status: 'ok' }) => void;
    vi.mocked(routineApi.fireNow)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        lose = reject;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        reconcile = resolve;
      }));
    const fired = vi.fn();
    const view = render(
      <RoutinesList agentId="a" agentName="Caveman" onFired={fired} />,
    );
    await screen.findByText(row.name);
    const disclosure = () =>
      screen.getByRole('button', { name: `Recent runs for ${row.name}` });
    fireEvent.click(disclosure());
    fireEvent.click(screen.getByRole('button', { name: 'Fire now' }));
    fireEvent.click(disclosure());
    fireEvent.click(disclosure());
    expect(disclosure()).toBeDisabled();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect(routineApi.fireNow).toHaveBeenCalledTimes(1);
    vi.mocked(routineApi.list).mockResolvedValue([{ ...row, revision: 'new-revision' }]);
    view.rerender(<RoutinesList agentId="a" agentName="Caveman" refreshKey={1} onFired={fired} />);
    expect(routineApi.list).toHaveBeenCalledTimes(1);
    await act(async () => lose(new RoutineApiError(0)));
    await screen.findByText('Routine management is temporarily unavailable.');
    fireEvent.click(disclosure());
    fireEvent.click(disclosure());
    view.rerender(<RoutinesList agentId="a" agentName="Caveman" refreshKey={2} onFired={fired} />);
    expect(routineApi.list).toHaveBeenCalledTimes(1);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Fire now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Starting…' }));
    expect(routineApi.fireNow).toHaveBeenCalledTimes(2);
    expect(vi.mocked(routineApi.fireNow).mock.calls[1]).toEqual(
      vi.mocked(routineApi.fireNow).mock.calls[0],
    );
    expect(routineApi.fireNow).toHaveBeenLastCalledWith({
      agentId: 'a',
      routineId: row.routineId,
      expectedRevision: row.revision,
      requestId: expect.any(String),
    });
    await act(async () => reconcile({ status: 'ok' }));
    await waitFor(() => expect(routineApi.list).toHaveBeenCalledTimes(2));
    await screen.findByText(row.name);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(disclosure()).toBeEnabled();
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
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

describe('agent settings routine creation', () => {
  it('opens the create dialog from a parent-owned button while list data is pending', async () => {
    vi.mocked(routineApi.list).mockImplementation(() => new Promise(() => {}));
    const props = { agentId: 'a', agentName: 'Caveman', onFired: vi.fn(), hideCreateAction: true };
    const { rerender } = render(<RoutinesList {...props} createRequest={0} />);
    expect(screen.getByLabelText('Loading routines')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New routine' })).toBeNull();
    rerender(<RoutinesList {...props} createRequest={1} />);
    expect(await screen.findByRole('dialog', { name: 'New routine' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
