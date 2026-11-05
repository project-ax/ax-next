/**
 * The agent switcher: which agent the sidebar is about, plus its ⋮ menu
 * (settings, delete). Replaced the always-open Agents roster.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { deleteAgent } from '@/lib/admin';
import { NEW_AGENT_OPENER_ATTR } from '@/lib/new-agent-return-focus';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { AgentSwitcher } from '../AgentSwitcher';

vi.mock('@/lib/admin', () => ({ deleteAgent: vi.fn() }));
const deleteMock = vi.mocked(deleteAgent);

function agent(id: string, name: string, state: WorkspaceAgent['state'] = 'resting'): WorkspaceAgent {
  return { id, name, state, now: null, counter: null, startedAt: null, stoppedReason: null };
}
const ADA = agent('a1', 'Ada');
const BO = agent('a2', 'Bo');

function renderSwitcher(over: Partial<React.ComponentProps<typeof AgentSwitcher>> = {}) {
  const props = {
    agents: [ADA, BO],
    selected: ADA as WorkspaceAgent | null,
    onSelect: vi.fn(),
    onCreateAgent: vi.fn(),
    onOpenSettings: vi.fn(),
    onDeleted: vi.fn(),
    ...over,
  };
  return { ...render(<AgentSwitcher {...props} />), props };
}

const press = (el: HTMLElement) => fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
const trigger = () => screen.getByRole('button', { name: /Switch agent$/ });

async function openDelete() {
  press(screen.getByRole('button', { name: 'Options for Ada' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete agent…' }));
  return screen.findByRole('dialog', { name: 'Delete agent?' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentSwitcher — picking an agent', () => {
  it('lists every agent with a check on the selected one, and switches', async () => {
    const { props } = renderSwitcher();
    press(trigger());
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Ada, resting', 'Bo, resting', 'New agent']);
    const [ada, bo] = items as [HTMLElement, HTMLElement, HTMLElement];
    expect(ada.querySelector('.lucide-check')).toBeTruthy();
    expect(bo.querySelector('.lucide-check')).toBeNull();
    fireEvent.click(bo);
    expect(props.onSelect).toHaveBeenCalledWith('a2');
  });

  it('starts a new agent from the menu', async () => {
    const { props } = renderSwitcher();
    press(trigger());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New agent' }));
    expect(props.onCreateAgent).toHaveBeenCalledTimes(1);
  });

  it('marks the trigger as where focus returns after the new-agent flow (TASK-510)', () => {
    renderSwitcher();
    expect(trigger()).toHaveAttribute(NEW_AGENT_OPENER_ATTR);
    expect(document.querySelectorAll(`[${NEW_AGENT_OPENER_ATTR}]`)).toHaveLength(1);
  });

  it('flags another agent waiting on you — and only another one', () => {
    const dot = () => trigger().querySelector('.bg-warning');
    const { unmount } = renderSwitcher({ agents: [agent('a1', 'Ada', 'waiting'), BO], selected: agent('a1', 'Ada', 'waiting') });
    expect(dot()).toBeNull();
    unmount();
    renderSwitcher({ agents: [ADA, agent('a2', 'Bo', 'waiting')] });
    expect(dot()).toBeTruthy();
  });

  it('offers only "Create your first agent" when there are no agents', () => {
    const { props } = renderSwitcher({ agents: [], selected: null });
    expect(screen.queryByRole('button', { name: /Switch agent/ })).toBeNull();
    const create = screen.getByRole('button', { name: 'Create your first agent' });
    expect(create).toHaveAttribute(NEW_AGENT_OPENER_ATTR);
    fireEvent.click(create);
    expect(props.onCreateAgent).toHaveBeenCalledTimes(1);
  });
});

describe('AgentSwitcher — the ⋮ agent menu', () => {
  it('sits beside the switcher with the vertical three-dot icon', () => {
    renderSwitcher();
    const dots = screen.getByRole('button', { name: 'Options for Ada' });
    expect(dots.querySelector('svg')?.getAttribute('class')).toMatch(/ellipsis-vertical/);
  });

  it('opens the selected agent’s settings', async () => {
    const { props } = renderSwitcher();
    press(screen.getByRole('button', { name: 'Options for Ada' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Agent settings' }));
    expect(props.onOpenSettings).toHaveBeenCalledWith('a1');
  });

  it('never locks the page (it opens a dialog)', async () => {
    renderSwitcher();
    press(screen.getByRole('button', { name: 'Options for Ada' }));
    expect(await screen.findAllByRole('menuitem')).not.toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('deletes only after a confirmation that says what goes with it', async () => {
    deleteMock.mockResolvedValueOnce(undefined);
    const { props } = renderSwitcher();
    const dialog = await openDelete();
    expect(dialog).toHaveTextContent('conversations');
    expect(dialog).toHaveTextContent('cannot be undone');
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith('a1'));
    expect(deleteMock).toHaveBeenCalledWith('a1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog open and says nothing was removed when the delete fails', async () => {
    deleteMock.mockRejectedValueOnce(new Error('delete agent: 403'));
    const { props } = renderSwitcher();
    await openDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));
    expect(
      await screen.findByText('We couldn’t delete this agent just now, so nothing was removed. Please try again.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Delete agent?' })).toBeTruthy();
    expect(props.onDeleted).not.toHaveBeenCalled();
  });

  it('Cancel deletes nothing', async () => {
    renderSwitcher();
    await openDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('draws no ⋮ when there is nothing to put in it', () => {
    renderSwitcher({ onOpenSettings: undefined, onDeleted: undefined });
    expect(screen.queryByRole('button', { name: 'Options for Ada' })).toBeNull();
  });
});
