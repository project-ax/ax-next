import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoutinesTab } from '../components/routines/RoutinesTab';
import { routineApi } from '@/lib/routines';
import { routineFixture } from '../components/routines/__tests__/routine-fixture';

vi.mock('@/lib/routines', async original => ({
  ...(await original<typeof import('@/lib/routines')>()),
  routineApi: { list: vi.fn(), recentFires: vi.fn(), fireNow: vi.fn(), listAgentDefaults: vi.fn(), setAgentDefaultEnabled: vi.fn(), getConsent: vi.fn() },
}));
// Exact materialized-default permission shape from routines' routinePermissions:
// owner may fire; authored edit, stop/delete, and credential management are false.
const heartbeat = { ...routineFixture, routineId: 'default:default-heartbeat-2026-05-19', defaultRoutineId: 'default-heartbeat-2026-05-19', name: 'Heartbeat', origin: 'default' as const, permissions: { edit: false, stop: false, fire: true, manageSecret: false } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(routineApi.list).mockResolvedValue([heartbeat]);
  vi.mocked(routineApi.listAgentDefaults).mockResolvedValue([
    { defaultRoutineId: heartbeat.defaultRoutineId, name: 'Heartbeat', enabled: true },
    { defaultRoutineId: 'skill-reflection', name: 'Skill reflection', enabled: true },
  ]);
  vi.mocked(routineApi.getConsent).mockResolvedValue({ enabled: false, revision: 'none' });
  vi.mocked(routineApi.recentFires).mockResolvedValue([{ agentId: 'a', routineId: heartbeat.routineId, firedAt: '2031-01-01T00:00:00Z', triggerSource: 'manual', status: 'ok', conversationId: 'preserved-default-conversation', error: null, renderedPrompt: 'Preserved default history', warning: null, report: null }]);
  vi.mocked(routineApi.fireNow).mockResolvedValue({ status: 'ok' });
  vi.mocked(routineApi.setAgentDefaultEnabled).mockResolvedValue(undefined);
});
it('keeps default toggles, manual fire and actual history reachable in Self-improvement without authored controls', async () => {
  render(<RoutinesTab isAdmin={false} agentId="a" agentName="Caveman" />);
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Self-improvement' }), { button: 0, ctrlKey: false });
  const heartbeatToggle = await screen.findByRole('switch', { name: 'Heartbeat' });
  const reflectionToggle = await screen.findByRole('switch', { name: 'Skill self-improvement for Caveman' });
  fireEvent.click(await screen.findByRole('button', { name: 'Recent runs for Heartbeat' }));
  expect(await screen.findByText('Preserved default history')).toBeVisible();
  expect(routineApi.recentFires).toHaveBeenCalledWith({ agentId: 'a', routineId: heartbeat.routineId, limit: 20 });
  expect(screen.queryByRole('button', { name: 'New routine' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit Heartbeat' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Delete routine' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Fire now' }));
  await waitFor(() => expect(routineApi.fireNow).toHaveBeenCalledWith({ agentId: 'a', routineId: heartbeat.routineId, expectedRevision: heartbeat.revision, requestId: expect.any(String) }));
  fireEvent.click(heartbeatToggle);
  await waitFor(() => expect(routineApi.setAgentDefaultEnabled).toHaveBeenCalledWith({ agentId: 'a', defaultRoutineId: heartbeat.defaultRoutineId, enabled: false }));
  fireEvent.click(reflectionToggle);
  await waitFor(() => expect(routineApi.setAgentDefaultEnabled).toHaveBeenCalledWith({ agentId: 'a', defaultRoutineId: 'skill-reflection', enabled: false }));

});
