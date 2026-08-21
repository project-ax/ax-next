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

function setup() {
  const onSend = vi.fn();
  render(<HomeComposer agents={agents} onSend={onSend} />);
  return { onSend };
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

describe('Auto routing', () => {
  it('confirms before dispatching, however confident the route is', async () => {
    // No opt-out: a confident route is still a routing decision the human gets
    // to see before an agent starts acting on their request.
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const { onSend } = setup();

    ask('find me 30 minutes with Marcus');

    expect(await screen.findByText(/Auto picked/)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('says so plainly when it cannot tell', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'nothing in it pointed anywhere in particular',
      confident: false,
    });
    const { onSend } = setup();

    ask('can you look into that thing from yesterday');

    expect(await screen.findByText(/Auto is not sure/)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('dispatches on confirmation', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const { onSend } = setup();

    ask('find me 30 minutes with Marcus');
    fireEvent.click(await screen.findByRole('button', { name: /Send to Scheduler/ }));

    expect(onSend).toHaveBeenCalledWith(
      'scheduler',
      'find me 30 minutes with Marcus',
    );
  });

  it('never routes at all when an agent was picked explicitly', async () => {
    const { onSend } = setup();

    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('keep Thursdays clear');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('scheduler', 'keep Thursdays clear'),
    );
    expect(routeMock).not.toHaveBeenCalled();
  });
});
