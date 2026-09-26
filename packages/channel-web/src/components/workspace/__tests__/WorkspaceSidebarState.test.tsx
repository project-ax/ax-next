/**
 * TASK-485 — the roster says each agent's state, not just paints it.
 *
 * A sidebar roster row is a state dot plus the agent's name, and nothing else.
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
import { render, screen } from '@testing-library/react';
import { UserProvider } from '@/lib/user-context';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { WorkspaceSidebarNav } from '../WorkspaceSidebar';

function agent(id: string, name: string, state: WorkspaceAgent['state']): WorkspaceAgent {
  return { id, name, state, now: null } as unknown as WorkspaceAgent;
}

const AGENTS = [
  agent('a1', 'Ada', 'working'),
  agent('a2', 'Bo', 'waiting'),
  agent('a3', 'Cy', 'resting'),
  agent('a4', 'Di', 'stopped'),
];

function renderRoster(agents = AGENTS) {
  return render(
    <UserProvider
      value={{ id: 'u1', email: 'u@example.com', name: 'Uma', role: 'user' } as never}
    >
      <WorkspaceSidebarNav
        agents={agents}
        route="today"
        activeAgentId={null}
        pendingCount={0}
        rosterOpen
        onRoster={vi.fn()}
        onToday={vi.fn()}
        onActivity={vi.fn()}
        onAgent={vi.fn()}
      />
    </UserProvider>,
  );
}

describe('WorkspaceSidebar roster — agent state is not colour-only (TASK-485)', () => {
  it.each([
    ['Ada', 'Ada, working'],
    ['Bo', 'Bo, waiting on you'],
    ['Cy', 'Cy, resting'],
    ['Di', 'Di, stopped'],
  ])('names the %s row with its state', (_who, name) => {
    renderRoster();
    /*
      The row's children are flex items, and the accessible-name computation
      puts a space between block-level children — jsdom (no CSS) does it for
      every element — so the tree reads "Ada , working". The space before the
      comma is layout, not content; fold it out and compare the words.
    */
    const byName = (accessible: string) =>
      accessible.replace(/\s+,/g, ',') === name;
    expect(screen.getByRole('button', { name: byName })).toBeTruthy();
  });

  it('gives each state its own shape, not just its own colour', () => {
    renderRoster();
    const geometry = (who: string) => {
      const row = screen.getByText(who).closest('button')!;
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
});
