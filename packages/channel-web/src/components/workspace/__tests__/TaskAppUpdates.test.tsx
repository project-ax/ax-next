import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskAppUpdates } from '../TaskAppUpdates';
import { routineApi, type Routine } from '@/lib/routines';
import { routineFixture } from '@/components/routines/__tests__/routine-fixture';
vi.mock('@/lib/routines', async original => ({ ...(await original<typeof import('@/lib/routines')>()), routineApi: { get: vi.fn(), getTaskReceiver: vi.fn(), replaceTaskReceiver: vi.fn() } }));
vi.mock('@/components/credentials/CredentialSlotRow', () => ({ CredentialSlotRow: ({ destination }: { destination: unknown }) => <p>Signing secret {JSON.stringify(destination)}</p> }));
const row: Routine = { ...routineFixture, kind: 'stay-on-top', goodWhen: 'All handled.', webhook: { kind: 'webhook', path: '/updates', hmac: { app: 'slack' } } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(routineApi.get).mockResolvedValue(row);
  vi.mocked(routineApi.getTaskReceiver).mockResolvedValue({ url: '/webhooks/private-task-token', version: 'a'.repeat(64), legacyActive: false });
});
function show() { const onEdit = vi.fn(); return { ...render(<TaskAppUpdates agentId="a" routineId="opaque-r1" onEdit={onEdit} />), onEdit }; }
describe('private task app setup', () => {
  it('shows owner-scoped copy/replace and signing secret with honest saved configuration', async () => {
    const h = show();
    const url = await screen.findByLabelText('Webhook URL');
    expect(url).toHaveValue(`${window.location.origin}/webhooks/private-task-token/updates`);
    expect(routineApi.getTaskReceiver).toHaveBeenCalledWith({ agentId: 'a', routineId: 'opaque-r1' });
    expect(screen.getByText(/Signing secret/)).toHaveTextContent('opaque-r1');
    expect(screen.queryByText(/connected|signature checked/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit app setup' }));
    expect(h.onEdit).toHaveBeenCalledOnce();
  });
  it.each([
    { ownedByCaller: false }, { permissions: { ...row.permissions, edit: false } }, { origin: 'default' as const }, { webhook: null },
  ])('refuses setup before requesting a bearer when the management read changes: %j', async patch => {
    vi.mocked(routineApi.get).mockResolvedValue({ ...row, ...patch });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your access or the task may have changed');
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument();
    expect(routineApi.getTaskReceiver).not.toHaveBeenCalled();
  });
  it('drops the former target synchronously on a task switch and ignores its late answer', async () => {
    let resolve!: (value: Routine) => void;
    vi.mocked(routineApi.get).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const h = show();
    h.rerender(<TaskAppUpdates agentId="b" routineId="other" onEdit={h.onEdit} />);
    await act(async () => resolve(row));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument();
    expect(routineApi.getTaskReceiver).not.toHaveBeenCalled();
  });
  it('reloads setup after a transient error without drawing provider details', async () => {
    vi.mocked(routineApi.get).mockRejectedValueOnce(new Error('PRIVATE-provider-detail'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Reload app setup' }));
    await screen.findByLabelText('Webhook URL');
    expect(document.body).not.toHaveTextContent('PRIVATE-provider-detail');
  });
  it('revokes the displayed address during an uncertain replacement until it reloads', async () => {
    show(); await screen.findByLabelText('Webhook URL');
    vi.mocked(routineApi.replaceTaskReceiver).mockRejectedValueOnce(new Error('PRIVATE-response'));
    fireEvent.click(screen.getByRole('button', { name: 'Replace address' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace address' }));
    await waitFor(() => expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Retry app setup' })).toBeVisible();
    expect(document.body).not.toHaveTextContent('PRIVATE-response');
  });
});
