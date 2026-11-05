/**
 * The chat header's icon toggles: one per side-panel view. Pressing an icon
 * opens (or switches to) its panel; pressing the pressed one closes it.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { ChatPanelToggles } from '../ChatPanelToggles';
import { RAIL_PANEL_IDS, type RailPanel } from '../AgentRail';

function Harness({
  initial = null,
  onChange,
}: {
  initial?: RailPanel | null;
  onChange?: (v: RailPanel | null) => void;
}) {
  const [value, setValue] = useState<RailPanel | null>(initial);
  return (
    <>
      <ChatPanelToggles
        panels={RAIL_PANEL_IDS}
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <output data-testid="open">{value ?? 'none'}</output>
    </>
  );
}

const group = () => screen.getByRole('group', { name: 'Side panel' });
const toggle = (name: string) => within(group()).getByRole('radio', { name });

describe('ChatPanelToggles', () => {
  it('draws Memory, Files and Activity in that order, none pressed when closed', () => {
    render(<Harness />);
    const items = within(group()).getAllByRole('radio');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual([
      'Memory',
      'Files',
      'Activity',
    ]);
    for (const item of items) expect(item.getAttribute('aria-checked')).toBe('false');
  });

  it('opens a panel, switches to another, and closes when the pressed one is pressed again', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(toggle('Files'));
    expect(screen.getByTestId('open').textContent).toBe('files');
    expect(toggle('Files').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle('Activity'));
    expect(screen.getByTestId('open').textContent).toBe('activity');
    expect(toggle('Files').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle('Activity'));
    expect(screen.getByTestId('open').textContent).toBe('none');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('only draws the panels it is given (Memory is absent without facts memory)', () => {
    render(
      <ChatPanelToggles panels={['files', 'activity']} value={null} onValueChange={vi.fn()} />,
    );
    expect(within(group()).queryByRole('radio', { name: 'Memory' })).toBeNull();
    expect(within(group()).getAllByRole('radio')).toHaveLength(2);
  });

  it('uses a custom accessible name and draws a dot for a panel with something new', () => {
    render(
      <ChatPanelToggles
        panels={RAIL_PANEL_IDS}
        value={null}
        onValueChange={vi.fn()}
        labels={{ memory: 'Memory, 2 new memories' }}
        dots={{ memory: true }}
      />,
    );
    const memory = toggle('Memory, 2 new memories');
    expect(memory.querySelector('span.rounded-full')).not.toBeNull();
    expect(toggle('Files').querySelector('span.rounded-full')).toBeNull();
  });
});
