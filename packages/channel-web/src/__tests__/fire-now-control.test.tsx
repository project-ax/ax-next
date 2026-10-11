import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FireNowControl } from '../components/routines/FireNowControl';
import { routineFixture } from '../components/routines/__tests__/routine-fixture';
import { routineApi, RoutineApiError } from '@/lib/routines';
vi.mock('@/lib/routines', async (original) => ({
  ...(await original<typeof import('@/lib/routines')>()),
  routineApi: { fireNow: vi.fn() },
}));
beforeEach(() => vi.resetAllMocks());
describe('Fire now', () => {
  it.each(['interval', 'webhook'] as const)(
    'accepts %s with ID, revision and request ID; does not invent turn success',
    async (kind) => {
      vi.mocked(routineApi.fireNow).mockResolvedValue({ status: 'ok' });
      const routine = {
        ...routineFixture,
        trigger:
          kind === 'webhook'
            ? { kind, path: '/updates' }
            : { kind, every: '1h' },
      };
      const fired = vi.fn();
      render(<FireNowControl routine={routine} onFired={fired} />);
      fireEvent.click(screen.getByRole('button', { name: 'Fire now' }));
      expect(
        await screen.findByText(
          'Run accepted. Check recent runs for the outcome.',
        ),
      ).toBeVisible();
      expect(routineApi.fireNow).toHaveBeenCalledWith({
        agentId: routine.agentId,
        routineId: routine.routineId,
        expectedRevision: routine.revision,
        requestId: expect.any(String),
      });
      expect(fired).toHaveBeenCalledTimes(1);
    },
  );
  it('retains exact request after transport error, and blocks overlapping requests', async () => {
    vi.mocked(routineApi.fireNow)
      .mockRejectedValueOnce(new RoutineApiError(0))
      .mockResolvedValue({ status: 'ok' });
    const { rerender } = render(
      <FireNowControl routine={routineFixture} onFired={vi.fn()} />,
    );
    const button = screen.getByRole('button', { name: 'Fire now' });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText('Routine management is temporarily unavailable.');
    expect(routineApi.fireNow).toHaveBeenCalledTimes(1);
    rerender(
      <FireNowControl
        routine={{ ...routineFixture, revision: 'new-revision' }}
        onFired={vi.fn()}
      />,
    );
    fireEvent.click(button);
    await waitFor(() => expect(routineApi.fireNow).toHaveBeenCalledTimes(2));
    expect(vi.mocked(routineApi.fireNow).mock.calls[0]).toEqual(
      vi.mocked(routineApi.fireNow).mock.calls[1],
    );
  });
  it('disables unavailable or disabled runs', () => {
    render(
      <FireNowControl
        routine={{ ...routineFixture, enabled: false }}
        onFired={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Fire now' })).toBeDisabled();
  });
});
