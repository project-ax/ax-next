/**
 * The workspace's route to Settings.
 *
 * Before this existed, `WorkspaceSidebar` rendered `<UserMenu />` bare. The
 * menu item was still there and still clickable — `UserMenu` renders it
 * unconditionally — and the handler behind it was `onOpenAdminSettings?.()`,
 * which resolved to undefined. So Settings silently did nothing, which is the
 * failure `hideClose` was added to stop (TASK-340 / audit B4): a control that
 * cannot work reads as a broken product, not as a door somewhere else.
 *
 * It is load-bearing for what comes next. `AdminShell` mounts in exactly one
 * place, `App.tsx`, and until now only in the chat branch — so with the
 * workspace as the only interface, this menu item is the ONLY way to reach AI
 * model keys, Sign-in methods, Connectors, Skills, Teams, Routines and
 * Branding. ~11k lines of settings UI hang off this one callback.
 *
 * These tests pin the thread the app depends on — shell → sidebar → UserMenu —
 * rather than the existence of a prop, which would pass on a rail that
 * accepted the callback and dropped it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
    },
  };
});

const boardMock = vi.mocked(workspaceApi.board);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

beforeEach(() => {
  window.history.replaceState(null, '', '/workspace');
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: [] });
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
});

function renderShell(onOpenAdminSettings?: () => void) {
  return render(
    <UserProvider value={user}>
      <WorkspaceShell
        {...(onOpenAdminSettings ? { onOpenAdminSettings } : {})}
      />
    </UserProvider>,
  );
}

/** Open the user menu and return its Settings entry. */
async function openSettingsEntry(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: /Uma/ });
  // Radix menus open on pointerdown, not click.
  fireEvent.pointerDown(
    trigger,
    new PointerEvent('pointerdown', { bubbles: true }),
  );
  fireEvent.click(trigger);
  return waitFor(() => screen.getByRole('menuitem', { name: /Settings/i }));
}

describe('workspace route to Settings', () => {
  it('the Settings entry reaches the app, through the sidebar', async () => {
    const onOpenAdminSettings = vi.fn();
    renderShell(onOpenAdminSettings);

    const entry = await openSettingsEntry();
    fireEvent.click(entry);

    // The whole point: the click lands on the app's handler, which is what
    // mounts AdminShell. Before this it landed on `undefined`.
    await waitFor(() => expect(onOpenAdminSettings).toHaveBeenCalledTimes(1));
  });

  /**
   * Proves the test above is not vacuous. The entry renders either way — so if
   * this ever stops finding it, the assertion above has stopped meaning
   * anything and is passing on a menu that is not there.
   */
  it('renders the entry at all, so the test above is about the wiring', async () => {
    renderShell(vi.fn());
    expect(await openSettingsEntry()).toBeInTheDocument();
  });
});
