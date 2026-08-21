import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HomeComposer } from '../HomeComposer';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return { ...actual, workspaceApi: { route: vi.fn() } };
});

const routeMock = vi.mocked(workspaceApi.route);

const agents: WorkspaceAgent[] = [
  {
    id: 'scheduler',
    name: 'Scheduler',
    role: 'Guards your calendar',
    icon: 'calendar-days',
    state: 'waiting',
    channel: 'routine',
    now: '',
    counter: null,
    startedAt: null,
    stoppedReason: null,
    paused: false,
    footer: '',
  },
];

function setup(autoDispatch: boolean) {
  const onSend = vi.fn();
  const onSetAutoDispatch = vi.fn();
  render(
    <HomeComposer
      agents={agents}
      autoDispatchWhenConfident={autoDispatch}
      onSetAutoDispatch={onSetAutoDispatch}
      onSend={onSend}
    />,
  );
  return { onSend, onSetAutoDispatch };
}

/**
 * Radix's DropdownMenuTrigger opens on pointerdown, and jsdom's `click` does not
 * synthesize one — a plain click leaves the menu closed and the failure looks
 * like a missing menu item rather than an unopened menu.
 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
}

function ask(text: string) {
  const input = screen.getByPlaceholderText(/Ask for something/);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

beforeEach(() => {
  routeMock.mockReset();
});

describe('Auto routing — the confirm is a default, not a law', () => {
  it('confirms a confident route when the preference is off', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const { onSend } = setup(false);

    ask('find me 30 minutes with Marcus');

    expect(await screen.findByText(/Auto picked/)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('dispatches a confident route straight through when the preference is on', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const { onSend } = setup(true);

    ask('find me 30 minutes with Marcus');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        'scheduler',
        'find me 30 minutes with Marcus',
      ),
    );
    expect(screen.queryByText(/Auto picked/)).toBeNull();
  });

  it('STILL confirms an unsure route with the preference on', async () => {
    // The asymmetry is the whole reason the setting is safe to offer: it
    // removes the question where the answer was obvious, never the question
    // where it was not. If this test ever goes green the other way, the
    // checkbox's label has become a lie.
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'nothing in it pointed anywhere in particular',
      confident: false,
    });
    const { onSend } = setup(true);

    ask('can you look into that thing from yesterday');

    expect(await screen.findByText(/Auto is not sure/)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('never routes at all when an agent was picked explicitly', async () => {
    const { onSend } = setup(false);

    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('keep Thursdays clear');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('scheduler', 'keep Thursdays clear'),
    );
    expect(routeMock).not.toHaveBeenCalled();
  });

  it('the checkbox turns the preference on from the confirmation', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const { onSetAutoDispatch } = setup(false);

    ask('find me 30 minutes with Marcus');
    fireEvent.click(await screen.findByLabelText(/Don't ask me again/));

    expect(onSetAutoDispatch).toHaveBeenCalledWith(true);
  });
});
