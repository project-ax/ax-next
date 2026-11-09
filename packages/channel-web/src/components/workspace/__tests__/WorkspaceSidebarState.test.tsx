/**
 * TASK-485 — the roster says each agent's state, not just paints it.
 *
 * The roster is now the agent switcher's menu: each item is a state dot plus
 * the agent's name, and the trigger names the selected agent and its state.
 * The dot was `aria-hidden` and told the state by colour alone, so two readers
 * got no state at all: someone who cannot tell the hues apart (WCAG 1.4.1), and
 * someone on a screen reader, for whom the state was not in the tree (1.1.1).
 *
 * jsdom has no CSS and no layout, so nothing here asserts what a dot LOOKS
 * like. The first block asserts the accessibility tree, which is real: each
 * row's accessible name carries the state. The second pins that the non-colour
 * channel exists at all — every state group gets its own geometry classes, once
 * the colour (`bg-*`) classes are set aside — which is a structural claim about
 * the markup, not a visual one.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { UserProvider } from '@/lib/user-context';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { WorkspaceSidebarNav } from '../WorkspaceSidebar';
import { StateDotSlot } from '../bits';

function agent(id: string, name: string, state: WorkspaceAgent['state']): WorkspaceAgent {
  return { id, name, state, now: null } as unknown as WorkspaceAgent;
}

const AGENTS = [
  agent('a1', 'Ada', 'working'),
  agent('a2', 'Bo', 'waiting'),
  agent('a3', 'Cy', 'resting'),
  agent('a4', 'Di', 'stopped'),
];

function renderRoster(
  agents = AGENTS,
  overrides: Partial<React.ComponentProps<typeof WorkspaceSidebarNav>> = {},
) {
  return render(
    <UserProvider
      value={{ id: 'u1', email: 'u@example.com', name: 'Uma', role: 'user' } as never}
    >
      <WorkspaceSidebarNav
        agents={agents}
        route="today"
        selectedAgentId="a1"
        pendingCount={0}
        onToday={vi.fn()}
        onTasks={vi.fn()}
        onAgent={vi.fn()}
        chats={null}
        chatsError={false}
        onOpenChat={vi.fn()}
        onNewChat={vi.fn(async () => {})}
        onChatsChanged={vi.fn()}
        {...overrides}
      />
    </UserProvider>,
  );
}

/** Open the switcher (Radix opens on pointerdown, not click). */
function openSwitcher() {
  fireEvent.pointerDown(screen.getByRole('button', { name: /Switch agent$/ }), {
    button: 0,
    ctrlKey: false,
  });
}

/** "Ada , working" → "Ada, working": jsdom spaces flex children in names. */
const folded = (want: string) => (n: string) => n.replace(/\s+,/g, ',') === want;

describe('WorkspaceSidebar switcher — agent state is not colour-only (TASK-485)', () => {
  it.each([
    ['Ada', 'Ada, working'],
    ['Bo', 'Bo, waiting on you'],
    ['Cy', 'Cy, resting'],
    ['Di', 'Di, stopped'],
  ])('names the %s menu item with its state', (_who, name) => {
    renderRoster();
    openSwitcher();
    expect(screen.getByRole('menuitem', { name: folded(name) })).toBeTruthy();
  });

  it('names the selected agent and its state on the trigger', () => {
    renderRoster(AGENTS, { selectedAgentId: 'a2' });
    expect(
      screen.getByRole('button', { name: 'Bo, waiting on you. Switch agent' }),
    ).toBeTruthy();
  });

  it('reads an out-of-contract state as resting, not a crash', () => {
    // Malformed server data: the state word must not turn into a thrown render.
    renderRoster([agent('a9', 'Ez', 'paused' as WorkspaceAgent['state'])], {
      selectedAgentId: 'a9',
    });
    openSwitcher();
    expect(screen.getByRole('menuitem', { name: folded('Ez, resting') })).toBeTruthy();
  });

  it('gives each state its own shape, not just its own colour', () => {
    renderRoster();
    openSwitcher();
    const geometry = (who: string) => {
      const row = screen.getByRole('menuitem', { name: new RegExp(`^${who}\\b`) });
      const dot = row.querySelector('span[aria-hidden="true"]');
      expect(dot, `${who} row has no state mark`).not.toBeNull();
      return dot!.className
        .split(/\s+/)
        .filter((c) => c && !c.startsWith('bg-'))
        .sort()
        .join(' ');
    };
    const shapes = ['Ada', 'Bo', 'Cy', 'Di'].map(geometry);
    expect(new Set(shapes).size).toBe(4);
  });

  it('puts every dot in the shared StateDotSlot (TASK-546)', () => {
    // The slot's width is pinned against every shape in StateDotSlot.test;
    // that pin only covers the roster while the roster uses THIS slot.
    const shared = render(<StateDotSlot>x</StateDotSlot>);
    const slotClass = (shared.container.firstElementChild as HTMLElement).className;
    shared.unmount();
    renderRoster();
    openSwitcher();
    for (const who of ['Ada', 'Bo', 'Cy', 'Di']) {
      const row = screen.getByRole('menuitem', { name: new RegExp(`^${who}\\b`) });
      const dot = row.querySelector('span[aria-hidden="true"]')!;
      expect(dot.parentElement!.className, who).toBe(slotClass);
    }
  });

  it('switches agents from the menu', () => {
    const onAgent = vi.fn();
    renderRoster(AGENTS, { onAgent });
    openSwitcher();
    fireEvent.click(screen.getByRole('menuitem', { name: folded('Cy, resting') }));
    expect(onAgent).toHaveBeenCalledWith('a3');
  });
});

describe('the Tasks row (TASK-909)', () => {
  const workspaceNav = () => screen.getByRole('navigation', { name: 'Workspace' });

  it('lists Today, Tasks, then the agent switcher, and opens Tasks', () => {
    const onTasks = vi.fn();
    renderRoster(AGENTS, { onTasks });
    const names = within(workspaceNav())
      .getAllByRole('button')
      .slice(0, 3)
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    expect(names).toEqual(['Today', 'Tasks', 'Ada, working. Switch agent']);
    expect(within(workspaceNav()).queryByRole('button', { name: /^Agents/ })).toBeNull();

    fireEvent.click(within(workspaceNav()).getByRole('button', { name: 'Tasks' }));
    expect(onTasks).toHaveBeenCalledTimes(1);
  });

  it('marks Tasks active on the Tasks page', () => {
    renderRoster(AGENTS, { route: 'tasks' });
    const nav = within(workspaceNav());
    expect(nav.getByRole('button', { name: 'Tasks' })).toHaveAttribute('data-active', 'true');
    expect(nav.getByRole('button', { name: 'Today' })).toHaveAttribute('data-active', 'false');
    expect(nav.queryByRole('button', { name: 'Activity' })).toBeNull();
  });

  it('puts Tasks between Today and the switcher in the icon rail', () => {
    renderRoster(AGENTS, { collapsed: true });
    const labels = within(workspaceNav())
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Today',
      'Tasks',
      'Ada, working. Switch agent',
      'New chat',
      'Search chats',
    ]);
  });
});

describe('the sidebar chat list', () => {
  const chats = {
    agentId: 'a1',
    chats: [
      { id: 'c-live', title: 'New plans', lastActivityAt: new Date().toISOString() },
      { id: 'c-old', title: 'Old plans', lastActivityAt: new Date().toISOString() },
    ],
    openId: 'c-old',
    busy: false,
  };

  it('lists the selected agent\'s chats under New chat and Search', () => {
    renderRoster(AGENTS, { chats, route: 'agent' });
    const nav = within(screen.getByRole('navigation', { name: 'Workspace' }));
    expect(nav.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(nav.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(nav.getByRole('button', { name: 'Old plans' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks no chat as open off the agent route', () => {
    renderRoster(AGENTS, { chats, route: 'today' });
    expect(screen.getByRole('button', { name: 'Old plans' })).not.toHaveAttribute('aria-current');
  });

  it('opens the collapsed rail\'s Search straight into the search box', () => {
    const onCollapse = vi.fn();
    const { rerender } = renderRoster(AGENTS, { chats, collapsed: true, onCollapse });
    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    rerender(
      <UserProvider
        value={{ id: 'u1', email: 'u@example.com', name: 'Uma', role: 'user' } as never}
      >
        <WorkspaceSidebarNav
          agents={AGENTS}
          route="today"
          selectedAgentId="a1"
          pendingCount={0}
          onToday={vi.fn()}
          onTasks={vi.fn()}
          onAgent={vi.fn()}
          chats={chats}
          chatsError={false}
          onOpenChat={vi.fn()}
          onNewChat={vi.fn(async () => {})}
          onChatsChanged={vi.fn()}
          collapsed={false}
          onCollapse={onCollapse}
        />
      </UserProvider>,
    );
    expect(screen.getByRole('searchbox', { name: 'Search chats by title' })).toBeTruthy();
  });
});
