/**
 * The one ⋯ menu on the Slack card (TASK-1187): the card's own, and each
 * channel row's. Not modal, and an item runs only after the menu has closed.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentSlackMenu } from '../AgentSlackMenu';

async function openMenu(name: string) {
  const trigger = await screen.findByRole('button', { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

describe('AgentSlackMenu', () => {
  it('with no items there is no ⋯ at all', () => {
    const { container } = render(<AgentSlackMenu label="Actions for @quill" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on a press, lists its items, and never locks the page', async () => {
    render(
      <AgentSlackMenu
        label="Actions for @quill"
        items={[
          { label: 'Rename', onSelect: vi.fn() },
          { label: 'Change picture', onSelect: vi.fn() },
        ]}
      />,
    );
    await openMenu('Actions for @quill');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Change picture' })).toBeInTheDocument();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('an item runs once the menu has closed, with focus back on the ⋯', async () => {
    const onSelect = vi.fn();
    render(<AgentSlackMenu label="Actions for @quill" items={[{ label: 'Rename', onSelect }]} />);
    await openMenu('Actions for @quill');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for @quill' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('a destructive item comes after a separator, drawn as destructive', async () => {
    render(
      <AgentSlackMenu
        label="Actions for @quill"
        items={[
          { label: 'Remove from Slack', onSelect: vi.fn(), destructive: true },
          { label: 'Rename', onSelect: vi.fn() },
        ]}
      />,
    );
    await openMenu('Actions for @quill');
    expect(screen.getByRole('separator')).toBeInTheDocument();
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Rename', 'Remove from Slack']);
    expect(items[1]?.className).toContain('text-destructive');
    expect(items[0]?.className).not.toContain('text-destructive');
  });

  it('disabled: the ⋯ is disabled', () => {
    render(<AgentSlackMenu label="Actions for #help" disabled items={[{ label: 'Rename', onSelect: vi.fn() }]} />);
    expect(screen.getByRole('button', { name: 'Actions for #help' })).toBeDisabled();
  });
});
