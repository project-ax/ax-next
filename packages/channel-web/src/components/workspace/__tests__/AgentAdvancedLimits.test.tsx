import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentAdvancedLimits } from '../AgentAdvancedLimits';
import { getAdminAgent, patchAgent } from '@/lib/admin';

vi.mock('@/lib/admin', () => ({ getAdminAgent: vi.fn(), patchAgent: vi.fn() }));

const loaded = { turnLimitMinutes: 30, idleMinutes: null, runnerSize: null };

function open() {
  render(<AgentAdvancedLimits agentId="a1" agentName="Quill" />);
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('AgentAdvancedLimits — loading and failing to load', () => {
  it('shows a busy status while the limits load, then the form', async () => {
    vi.mocked(getAdminAgent).mockResolvedValue(loaded as never);
    open();
    expect(screen.getByText('Loading limits').closest('[role="status"]')).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByLabelText('Longest one reply can run (minutes)')).toHaveValue(30);
  });

  it('offers Try again when the limits fail to load, and reads them again on click', async () => {
    vi.mocked(getAdminAgent).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(loaded as never);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load these limits.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Longest one reply can run (minutes)')).toHaveValue(30);
    expect(getAdminAgent).toHaveBeenCalledTimes(2);
  });

  it('says a failed save as an alert, and keeps what was typed', async () => {
    vi.mocked(getAdminAgent).mockResolvedValue(loaded as never);
    vi.mocked(patchAgent).mockRejectedValue(new Error('nope'));
    open();
    const turn = await screen.findByLabelText('Longest one reply can run (minutes)');
    fireEvent.change(turn, { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't save that.");
    await waitFor(() => expect(turn).toHaveValue(45));
  });
});
