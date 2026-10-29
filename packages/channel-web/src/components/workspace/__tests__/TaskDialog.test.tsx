import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskDialog } from '../TaskDialog';
import { workspaceApi } from '@/lib/workspace-api';
import { routineApi, RoutineApiError } from '@/lib/routines';
import { routineFixture } from '@/components/routines/__tests__/routine-fixture';

vi.mock('@/lib/workspace-api', async original => ({ ...(await original<typeof import('@/lib/workspace-api')>()), workspaceApi: { taskAgents: vi.fn() } }));
vi.mock('@/lib/routines', async original => ({ ...(await original<typeof import('@/lib/routines')>()), routineApi: { create: vi.fn(), get: vi.fn(), update: vi.fn(), getReceiverAccess: vi.fn(), getReceiver: vi.fn() } }));
const saved = { ...routineFixture, agentId: 'a1', routineId: 'saved-task' };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(workspaceApi.taskAgents).mockResolvedValue({ agents: [{ agentId: 'a1', agentName: 'Caveman' }] }); vi.mocked(routineApi.create).mockResolvedValue(saved); });
afterEach(() => vi.restoreAllMocks());
function show() {
  const onWriteSucceeded = vi.fn(), onSaved = vi.fn(), onOpenChange = vi.fn();
  return { ...render(<TaskDialog open onOpenChange={onOpenChange} onWriteSucceeded={onWriteSucceeded} onSaved={onSaved} onClosed={vi.fn()} />), onWriteSucceeded, onSaved, onOpenChange };
}
async function fill() {
  await screen.findByLabelText('What should Caveman do?');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Look after the queue' } });
  fireEvent.change(screen.getByLabelText('What should Caveman do?'), { target: { value: 'Answer easy questions.' } });
  fireEvent.change(screen.getByLabelText('Going well when'), { target: { value: 'No question waits a day.' } });
}
describe('shared task dialog', () => {
  it('uses its sole eligible agent, announces a landed write first, and opens the real saved ID', async () => {
    const h = show(); await fill();
    expect(screen.queryByRole('button', { name: /^Agent:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(h.onSaved).toHaveBeenCalledWith('a1', 'saved-task'));
    expect(h.onWriteSucceeded.mock.invocationCallOrder[0]).toBeLessThan(h.onSaved.mock.invocationCallOrder[0]!);
    expect(vi.mocked(routineApi.create).mock.calls[0]![0]).toMatchObject({ agentId: 'a1', definition: { kind: 'stay-on-top' } });
  });
  it('shows a picker only for multiple eligible agents and preserves the brief while switching', async () => {
    vi.mocked(workspaceApi.taskAgents).mockResolvedValue({ agents: [{ agentId: 'a1', agentName: 'Caveman' }, { agentId: 'a2', agentName: 'Juniper' }] });
    show(); await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Agent: Caveman' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Juniper' }));
    expect(screen.getByRole('button', { name: 'Agent: Juniper' })).toBeVisible();
    expect(screen.getByLabelText('What should Juniper do?')).toHaveValue('Answer easy questions.');
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(routineApi.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(routineApi.create).mock.calls[0]![0].agentId).toBe('a2');
  });
  it('keeps an uncertain retry on one logical request and freezes dialog dismissal', async () => {
    vi.mocked(routineApi.create).mockRejectedValueOnce(new RoutineApiError(500, 'unavailable')).mockResolvedValue(saved);
    const h = show(); await fill(); fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    const retry = await screen.findByRole('button', { name: 'Retry save' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(1));
    expect(vi.mocked(routineApi.create).mock.calls[1]![0]).toEqual(vi.mocked(routineApi.create).mock.calls[0]![0]);
  });
  it('still invalidates the shell read when a saved response arrives after unmount', async () => {
    let finish!: (value: typeof saved) => void;
    vi.mocked(routineApi.create).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const h = show(); await fill(); fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(routineApi.create).toHaveBeenCalledTimes(1));
    h.unmount(); await act(async () => finish(saved));
    expect(h.onWriteSucceeded).toHaveBeenCalledTimes(1);
    expect(h.onSaved).not.toHaveBeenCalled();
  });
});
