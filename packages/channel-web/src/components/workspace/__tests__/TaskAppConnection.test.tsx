import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutineWebhookStatus } from '@ax/routines-contract';
import { TaskAppUpdates } from '../TaskAppUpdates';
import { TaskAppConnection } from '../TaskAppConnection';
import { routineApi } from '@/lib/routines';
import { routineFixture } from '@/components/routines/__tests__/routine-fixture';
vi.mock('@/lib/routines', async original => ({ ...(await original<typeof import('@/lib/routines')>()), routineApi: { get: vi.fn(), getWebhookStatus: vi.fn(), getTaskReceiver: vi.fn() } }));
const waiting: RoutineWebhookStatus = { agentId: 'a', routineId: 'opaque-r1', app: 'zendesk', setupReady: true, lastAcceptedAt: null, signatureChecked: false, verifiedAt: null, windowStart: '2031-01-01T11:01:00.000Z', refusals: [] };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(routineApi.getWebhookStatus).mockResolvedValue(waiting); });
const show = () => render(<TaskAppConnection agentId="a" routineId="opaque-r1" />);
describe('app connection truth and recovery', () => {
  it('waits for a real app test, then explains acceptance separately from execution', async () => {
    show(); expect(await screen.findByRole('status')).toHaveTextContent('Waiting for the first update');
    expect(screen.getByText(/Send a test/)).toHaveTextContent('may start paid work');
    vi.mocked(routineApi.getWebhookStatus).mockResolvedValue({ ...waiting, lastAcceptedAt: '2031-01-01T12:00:00.000Z', signatureChecked: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Zendesk connected');
    expect(screen.getByRole('status')).toHaveTextContent('signature checked');
    expect(screen.getByRole('status')).toHaveTextContent('Check Updates for the check-in’s result');
  });
  it('does not call a verified Slack address a connected stream of updates', async () => {
    vi.mocked(routineApi.getWebhookStatus).mockResolvedValue({ ...waiting, app: 'slack', verifiedAt: '2031-01-01T12:00:00.000Z' });
    show(); expect(await screen.findByRole('status')).toHaveTextContent('App address verified');
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for the first update');
    expect(screen.queryByText(/connected/)).not.toBeInTheDocument();
  });
  it('shows bounded refusal counts with fixed recovery wording, never provider error details', async () => {
    vi.mocked(routineApi.getWebhookStatus).mockResolvedValue({ ...waiting, refusals: [{ reason: 'signature', count: 4 }, { reason: 'capacity', count: 2 }] });
    show(); expect(await screen.findByRole('status')).toHaveTextContent('4 because the signature didn’t match');
    expect(screen.getByRole('status')).toHaveTextContent('2 because the update queue or storage limit was reached');
    expect(screen.queryByText(/connected/)).not.toBeInTheDocument();
    vi.mocked(routineApi.getWebhookStatus).mockRejectedValueOnce(new Error('PRIVATE-provider-detail'));
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-provider-detail');
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Waiting for the first update');
  });
  it('drops previous task status before effects run and ignores its late response', async () => {
    let resolve!: (status: RoutineWebhookStatus) => void;
    vi.mocked(routineApi.get).mockResolvedValue({ ...routineFixture, webhook: { kind: 'webhook', path: '/hook' } });
    vi.mocked(routineApi.getTaskReceiver).mockResolvedValue({ url: '/webhooks/test-fixture', version: 'a'.repeat(64), legacyActive: false });
    vi.mocked(routineApi.getWebhookStatus).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const h = render(<TaskAppUpdates agentId="a" routineId="opaque-r1" onEdit={() => {}} />);
    await screen.findByLabelText('Checking app connection');
    h.rerender(<TaskAppUpdates agentId="b" routineId="other" onEdit={() => {}} />);
    await act(async () => resolve({ ...waiting, lastAcceptedAt: '2031-01-01T12:00:00.000Z' }));
    expect(screen.queryByText(/connected/)).not.toBeInTheDocument();
  });
  it('rejects status for another task or a malformed response', async () => {
    vi.mocked(routineApi.getWebhookStatus).mockResolvedValue({ ...waiting, routineId: 'other', lastAcceptedAt: '2031-01-01T12:00:00.000Z' });
    show(); expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t check');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
