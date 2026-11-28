/**
 * Spec §6.3 rule 8: "Waiting-on-you is the warning diamond everywhere
 * (sidebar, switcher, queue, chat)." One agent waiting on you must draw the
 * warning diamond on each surface that shows it, and say the same words.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { UserProvider } from '@/lib/user-context';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { WorkspaceSidebarNav } from '../WorkspaceSidebar';
import { AgentSwitcher } from '../AgentSwitcher';
import { DecisionRow } from '../DecisionRow';
import { ApprovalCard } from '../ApprovalCard';
import { STATE_WORDS } from '../bits';
import { decisionFixture } from './decision-fixture';

const WAITING = { id: 'a2', name: 'Bo', state: 'waiting', now: null } as unknown as WorkspaceAgent;
const OTHER = { id: 'a1', name: 'Ada', state: 'working', now: null } as unknown as WorkspaceAgent;
const WORDS = STATE_WORDS.waiting.toLowerCase();

const diamondIn = (el: Element) => el.querySelector('svg[data-shape="diamond"][data-tone="warning"]');

describe('waiting on you is the warning diamond on every surface (rule 8)', () => {
  it('the switcher trigger flags another agent waiting', () => {
    render(
      <AgentSwitcher agents={[OTHER, WAITING]} selected={OTHER} onSelect={vi.fn()} onCreateAgent={vi.fn()} />,
    );
    const trigger = screen.getByRole('button', { name: /Switch agent$/ });
    expect(diamondIn(trigger)).not.toBeNull();
    // The diamond is decorative; the control's name says it, in the same words as the menu item.
    expect(trigger.getAttribute('aria-label')!.toLowerCase()).toContain(WORDS);
  });

  it('the switcher menu draws the diamond on the waiting agent and says the words', () => {
    render(
      <AgentSwitcher agents={[OTHER, WAITING]} selected={OTHER} onSelect={vi.fn()} onCreateAgent={vi.fn()} />,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: /Switch agent$/ }), { button: 0, ctrlKey: false });
    const item = screen.getByRole('menuitem', { name: /^Bo\b/ });
    expect(diamondIn(item)).not.toBeNull();
    expect(item.textContent!.toLowerCase()).toContain(WORDS);
  });

  function renderNav(collapsed: boolean, pendingCount: number) {
    return render(
      <UserProvider value={{ id: 'u1', email: 'u@example.com', name: 'Uma', role: 'user' } as never}>
        <WorkspaceSidebarNav
          agents={[OTHER, WAITING]}
          route="tasks"
          selectedAgentId="a1"
          pendingCount={pendingCount}
          collapsed={collapsed}
          onToday={vi.fn()}
          onTasks={vi.fn()}
          onAgent={vi.fn()}
          chats={null}
          chatsError={false}
          onOpenChat={vi.fn()}
          onNewChat={vi.fn(async () => {})}
          onChatsChanged={vi.fn()}
        />
      </UserProvider>,
    );
  }

  // Both rail states draw the diamond and say the same words, count included.
  it.each([
    ['collapsed', true],
    ['expanded', false],
  ])('the %s sidebar rail flags Today when something waits on you', (_state, collapsed) => {
    renderNav(collapsed, 2);
    const today = screen.getByRole('button', { name: /^Today/ });
    expect(diamondIn(today)).not.toBeNull();
    expect(today).toHaveAccessibleName(`Today 2 ${WORDS}`);
  });

  // WCAG 2.5.3 (axe label-content-name-mismatch): the name starts with what the button shows, so a voice
  // user saying "click Today 2" reaches it. The before/after walk caught "Today, 1 waiting on you" vs "Today 1".
  it('the expanded rail names Today by its visible text first', () => {
    renderNav(false, 2);
    const today = screen.getByRole('button', { name: /^Today/ });
    expect(within(today).getByText('2')).toBeTruthy();
    expect(today).toHaveAccessibleName(/^Today 2\b/);
  });

  it.each([
    ['collapsed', true],
    ['expanded', false],
  ])('the %s sidebar rail says just Today, with no diamond, when nothing waits', (_state, collapsed) => {
    renderNav(collapsed, 0);
    const today = screen.getByRole('button', { name: /^Today/ });
    expect(diamondIn(today)).toBeNull();
    expect(today).toHaveAccessibleName('Today');
  });

  it('the expanded rail still shows the count', () => {
    renderNav(false, 3);
    const today = screen.getByRole('button', { name: /^Today/ });
    expect(within(today).getByText('3')).toBeTruthy();
  });

  it('the Today queue row for a held question draws the diamond and says the words', () => {
    const d = decisionFixture();
    const { container } = render(
      <DecisionRow
        decision={d}
        agent={{ ...WAITING, id: 'scheduler', name: 'Scheduler' }}
        expanded={false}
        onToggle={vi.fn()}
        onOpenAgent={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    const row = container.querySelector(`[data-testid="decision-${d.id}"]`)!.closest('li')!;
    expect(diamondIn(row)).not.toBeNull();
    expect(row.textContent!.toLowerCase()).toContain(WORDS);
    // Said exactly, in the row's meta (the title is the question).
    expect(within(row).getByText('Scheduler, waiting on you')).toBeTruthy();
  });

  it('the chat approval card badge draws the diamond and says the words', () => {
    const { container } = render(
      <ApprovalCard decision={decisionFixture()} onApprove={vi.fn()} onDismiss={vi.fn()} onUndo={vi.fn()} />,
    );
    const label = screen.getByText(STATE_WORDS.waiting);
    expect(diamondIn(label.parentElement!)).not.toBeNull();
    expect(container.textContent!.toLowerCase()).toContain(WORDS);
  });
});
