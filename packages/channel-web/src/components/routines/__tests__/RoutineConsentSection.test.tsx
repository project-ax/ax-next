import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoutineConsentSection } from '../RoutineConsentSection';
import { routineApi } from '@/lib/routines';
vi.mock('@/lib/routines', () => ({
  routineApi: { getConsent: vi.fn(), revokeConsent: vi.fn() },
}));
beforeEach(() => vi.resetAllMocks());
describe('routine permissions', () => {
  it('does not present a failed permission read as Ask or Always Allow', async () => {
    vi.mocked(routineApi.getConsent).mockRejectedValue(
      new Error('network unavailable'),
    );
    render(<RoutineConsentSection agentId="a" agentName="Caveman" />);
    expect(
      await screen.findByText('Task permissions are unavailable.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Revoke' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Ask before creating or editing tasks'),
    ).not.toBeInTheDocument();
  });
  it('loads without guessing permission and has no grant toggle', async () => {
    vi.mocked(routineApi.getConsent).mockResolvedValue({
      enabled: false,
      revision: 'v1',
    });
    render(<RoutineConsentSection agentId="a" agentName="Caveman" />);
    expect(screen.getByLabelText('Loading task permissions')).toBeVisible();
    expect(
      await screen.findByText('Ask before creating or editing tasks'),
    ).toBeVisible();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
  it("says a task's instructions still ask once Always Allow is on (TASK-906)", async () => {
    vi.mocked(routineApi.getConsent).mockResolvedValue({
      enabled: true,
      revision: 'v1',
    });
    render(<RoutineConsentSection agentId="a" agentName="Caveman" />);
    expect(
      await screen.findByText(
        "Caveman may create and edit tasks for you. Delete, Fire now and a task's instructions still ask.",
      ),
    ).toBeVisible();
  });
  it('keeps the not-granted line as it was', async () => {
    vi.mocked(routineApi.getConsent).mockResolvedValue({
      enabled: false,
      revision: 'v1',
    });
    render(<RoutineConsentSection agentId="a" agentName="Caveman" />);
    expect(
      await screen.findByText(
        'Choose Always Allow on a request from Caveman to permit future creates and edits.',
      ),
    ).toBeVisible();
  });
  it('retains the grant on revoke failure and refreshes after success', async () => {
    vi.mocked(routineApi.getConsent).mockResolvedValue({
      enabled: true,
      revision: 'v1',
    });
    vi.mocked(routineApi.revokeConsent)
      .mockRejectedValueOnce(new Error('private failure'))
      .mockResolvedValue({ enabled: false, revision: 'v2' });
    const changed = vi.fn();
    window.addEventListener('ax:routine-permissions-changed', changed);
    render(<RoutineConsentSection agentId="a" agentName="Caveman" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(
      await screen.findByText(
        'We couldn’t revoke task permission. Try again.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Always allow for this agent')).toBeVisible();
    vi.mocked(routineApi.getConsent).mockResolvedValue({
      enabled: false,
      revision: 'v2',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(
      await screen.findByText('Ask before creating or editing tasks'),
    ).toBeVisible();
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    window.removeEventListener('ax:routine-permissions-changed', changed);
  });
});
