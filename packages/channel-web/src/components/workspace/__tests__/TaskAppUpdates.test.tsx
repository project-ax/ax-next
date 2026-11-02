import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskAppUpdates } from '../TaskAppUpdates';
import { routineApi, type Routine } from '@/lib/routines';
import { routineFixture } from '@/components/routines/__tests__/routine-fixture';
vi.mock('@/lib/routines', async original => ({ ...(await original<typeof import('@/lib/routines')>()), routineApi: { get: vi.fn(), getWebhookStatus: vi.fn(), getTaskReceiver: vi.fn(), replaceTaskReceiver: vi.fn() } }));
vi.mock('@/components/credentials/CredentialSlotRow', () => ({ CredentialSlotRow: ({ destination }: { destination: unknown }) => <p>Signing secret {JSON.stringify(destination)}</p> }));
const helpText = /Paste the signing secret from the other app’s webhook settings/;
const legacyNote = /This task was set up to always check signatures/;
const unchecked = /Without a secret, updates aren’t checked/;
const row: Routine = { ...routineFixture, kind: 'stay-on-top', goodWhen: 'All handled.', webhook: { kind: 'webhook', path: '/updates', hmac: { app: 'slack' } } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(routineApi.get).mockResolvedValue(row);
  vi.mocked(routineApi.getWebhookStatus).mockResolvedValue({ agentId: 'a', routineId: 'opaque-r1', app: 'slack', setupReady: true, lastAcceptedAt: null, signatureChecked: false, timestampChecked: false, verifiedAt: null, windowStart: '2031-01-01T11:01:00.000Z', refusals: [] });
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
  it('shows the signing secret right under the address for a task with no signature settings', async () => {
    vi.mocked(routineApi.get).mockResolvedValue({ ...row, webhook: { kind: 'webhook', path: '/updates' } });
    show();
    const url = await screen.findByLabelText('Webhook URL');
    const secret = screen.getByText(/^Signing secret \{/);
    expect(url.compareDocumentPosition(secret) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(secret).toHaveTextContent('routine-hmac');
    expect(screen.getByText(helpText)).toBeVisible();
    expect(screen.queryByRole('switch', { name: 'Verify signature' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'App' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose the app/)).not.toBeInTheDocument();
    expect(screen.queryByText(legacyNote)).not.toBeInTheDocument();
    expect(screen.getByText(unchecked)).toBeVisible();
  });
  it('explains that a legacy task always checks signatures, and how to stop', async () => {
    show(); await screen.findByLabelText('Webhook URL');
    expect(screen.getByText(legacyNote)).toBeVisible();
    expect(screen.getByText(legacyNote)).toHaveTextContent('To stop checking, turn off its app updates and save, then turn them back on.');
    expect(screen.getByText(legacyNote)).toHaveTextContent('Paste the new one into the other app, because the old one stops working.');
    expect(screen.getByText(legacyNote)).not.toHaveTextContent('delete this task');
    expect(screen.getByText(helpText)).toBeVisible();
    // A legacy task's updates are never unchecked, so the help can't say they are.
    expect(screen.queryByText(unchecked)).not.toBeInTheDocument();
  });
  it('says when secret management is unavailable', async () => {
    vi.mocked(routineApi.get).mockResolvedValue({ ...row, permissions: { ...row.permissions, manageSecret: false } });
    show(); await screen.findByLabelText('Webhook URL');
    expect(screen.getByText('Signing secret management is currently unavailable.')).toBeVisible();
    expect(screen.queryByText(/^Signing secret \{/)).not.toBeInTheDocument();
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
