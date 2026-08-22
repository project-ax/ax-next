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
    state: 'waiting',
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
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

/**
 * The placeholder names the picked agent, so match on the shape rather than on
 * one phrasing of it.
 */
function composer(): HTMLElement {
  return screen.getByPlaceholderText(/^Ask /);
}

function ask(text: string) {
  const input = composer();
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

  it('promises nothing in the placeholder', () => {
    // The old placeholder suggested "find me 30 minutes with Marcus", which
    // presumes a scheduler, a calendar grant and a person named Marcus. A
    // brand-new agent has none of the three.
    setup();
    const placeholder = composer().getAttribute('placeholder') ?? '';
    expect(placeholder).not.toMatch(/Marcus/);
    expect(placeholder).not.toMatch(/30 minutes/);
    expect(placeholder).toMatch(/say hi/);
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

/**
 * The composer used to `await` both the routing call and the send with no
 * catch. A 503 rejected an unhandled promise, nothing rendered, and the draft
 * had already been cleared — the user's words were simply gone.
 */
describe('when the send does not go through', () => {
  it('keeps the draft and says so when routing fails', async () => {
    routeMock.mockRejectedValue(new Error('workspace /route → 503'));
    const { onSend } = setup();

    ask('please look at the roof quote');

    expect(
      await screen.findByText(/could not work out which agent/i),
    ).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    // The words survive. Retyping them is the one outcome we cannot ship.
    expect((composer() as HTMLInputElement).value).toBe(
      'please look at the roof quote',
    );
  });

  it('keeps the draft and says so when the send itself fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('send message → 500'));
    render(<HomeComposer agents={agents} onSend={onSend} />);

    // Pick the agent explicitly so the send is the only call in play.
    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('draft the reply to Dana');

    expect(await screen.findByText(/could not get that to/i)).toBeTruthy();
    expect((composer() as HTMLInputElement).value).toBe('draft the reply to Dana');
  });

  it('keeps the draft when the send fails after an Auto confirmation', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const onSend = vi.fn().mockRejectedValue(new Error('send message → 500'));
    render(<HomeComposer agents={agents} onSend={onSend} />);

    ask('find me a slot on Thursday');
    fireEvent.click(await screen.findByRole('button', { name: /Send to Scheduler/ }));

    expect(await screen.findByText(/could not get that to/i)).toBeTruthy();
    expect((composer() as HTMLInputElement).value).toBe('find me a slot on Thursday');
  });

  it('clears the draft once the send resolves', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<HomeComposer agents={agents} onSend={onSend} />);

    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('keep Thursdays clear');

    await waitFor(() => expect((composer() as HTMLInputElement).value).toBe(''));
  });
});
