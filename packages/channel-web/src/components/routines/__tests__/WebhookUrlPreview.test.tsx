import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { WebhookUrlPreview } from '../WebhookUrlPreview';
import { routines } from '@/lib/routines';
vi.mock('@/lib/routines', () => ({ routines: { webhookToken: vi.fn() } }));
const token = vi.mocked(routines.webhookToken);
const writeText = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  token.mockResolvedValue({ token: 'existing_token' });
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => vi.useRealTimers());
const props = { agentId: 'agent-a', path: '/events', editing: false, active: true };
function url() { return screen.getByLabelText('Webhook URL'); }

describe('WebhookUrlPreview', () => {
  it('previews before creation and updates immediately during editing without rotating the receiver', async () => {
    const { rerender } = render(<WebhookUrlPreview {...props} />);
    expect(url()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeDisabled();
    await waitFor(() => expect(url()).toHaveValue(`${location.origin}/webhooks/existing_token/events`));
    expect(screen.getByText(/Create this routine before/)).toBeTruthy();
    rerender(<WebhookUrlPreview {...props} editing path="/changed" />);
    expect(url()).toHaveValue(`${location.origin}/webhooks/existing_token/changed`);
    expect(screen.getByText(/Save to apply path changes/)).toBeTruthy();
    rerender(<WebhookUrlPreview {...props} active={false} />);
    expect(screen.queryByLabelText('Webhook URL')).toBeNull();
    rerender(<WebhookUrlPreview {...props} />);
    await waitFor(() => expect(url()).toHaveValue(`${location.origin}/webhooks/existing_token/events`));
    expect(token).toHaveBeenCalledExactlyOnceWith('agent-a');
  });

  it('never exposes a previous agent token or late response after switching agents', async () => {
    let resolveA!: (value: { token: string }) => void;
    let resolveB!: (value: { token: string }) => void;
    token.mockImplementation(id => new Promise(resolve => { if (id === 'agent-a') resolveA = resolve; else resolveB = resolve; }));
    const { rerender } = render(<WebhookUrlPreview {...props} />);
    rerender(<WebhookUrlPreview {...props} agentId="agent-b" />);
    await act(async () => resolveA({ token: 'secret_a' }));
    expect(url()).toHaveValue('');
    await act(async () => resolveB({ token: 'secret_b' }));
    expect(url()).toHaveValue(`${location.origin}/webhooks/secret_b/events`);
    rerender(<WebhookUrlPreview {...props} agentId={null} />);
    expect(url()).toHaveValue('');
  });

  it.each(['/./events', '/../events', '/double//events', 'missing-slash', '/events?secret=1'])('withholds invalid path %s', async path => {
    render(<WebhookUrlPreview {...props} path={path} />);
    await screen.findByText(/Enter a valid webhook path/);
    expect(url()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeDisabled();
  });

  it('shows unavailable tokens without a misleading URL', async () => {
    token.mockRejectedValue(new Error('403'));
    render(<WebhookUrlPreview {...props} />);
    await screen.findByText(/Only the agent owner/);
    expect(url()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeDisabled();
  });

  it('copies the complete current URL, briefly confirms, and resets on path changes', async () => {
    const { rerender } = render(<WebhookUrlPreview {...props} />);
    await waitFor(() => expect(url()).not.toHaveValue(''));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/webhooks/existing_token/events`);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    await act(async () => {});
    rerender(<WebhookUrlPreview {...props} path="/next" />);
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeTruthy();
  });

  it('offers manual copying after clipboard failure and discards stale success', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const { rerender } = render(<WebhookUrlPreview {...props} />);
    await waitFor(() => expect(url()).not.toHaveValue(''));
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    await screen.findByText(/copy it manually/);
    let resolve!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    rerender(<WebhookUrlPreview {...props} path="/new" />);
    await act(async () => resolve());
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });
});
