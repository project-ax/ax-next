/**
 * The Today "Needs you / Working" filter, as a keyboard and a screen reader
 * meet it (TASK-429).
 *
 * jsdom has no CSS and no layout, so nothing here asserts that the selected
 * segment LOOKS raised — that assertion would pass against any stylesheet at
 * all. The accessibility tree is the part jsdom models honestly, and it is also
 * the part that was wrong: Radix's `ToggleGroup type="single"` gives the items
 * `role="radio"` + `aria-checked` and roots them at `role="group"`, and its
 * RovingFocusGroup moved focus on `ArrowRight` while leaving `aria-checked`
 * where it was. A screen-reader user heard focus land on "Working" and the
 * selection stay on "Needs you".
 *
 * WHAT THESE WOULD DO AGAINST THE UNFIXED COMPONENT: the arrow-key tests fail
 * on the `aria-checked` assertion (focus moved, selection did not — and it
 * moved asynchronously, inside Radix's `setTimeout`, which is why the focus
 * assertions are wrapped in `waitFor`); the role test fails on `radiogroup`
 * (it was `group`); the accessible-name test fails on the missing `aria-label`.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Segmented } from '../WorkspaceHeader';

type Filter = 'needs' | 'working';

/** The real Today control: two segments, "Needs you" selected. */
function Harness({ onChange }: { onChange?: (v: Filter) => void } = {}) {
  const [filter, setFilter] = useState<Filter>('needs');
  return (
    <Segmented<Filter>
      label="Filter today"
      value={filter}
      onValueChange={(v) => {
        setFilter(v);
        onChange?.(v);
      }}
      options={[
        { value: 'needs', label: 'Needs you', count: 2 },
        { value: 'working', label: 'Working' },
      ]}
    />
  );
}

function segments(): HTMLElement[] {
  return screen.getAllByRole('radio');
}

describe('Segmented — the radios have a radiogroup, and it is named', () => {
  it('roots the radios at role=radiogroup', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup');
    // The radios are INSIDE it — a radiogroup elsewhere on the page would
    // satisfy `getByRole` while leaving these radios unowned.
    for (const radio of segments()) expect(group).toContainElement(radio);
  });

  it('gives the group an accessible name', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Filter today' })).toBeInTheDocument();
  });
});

describe('Segmented — arrow keys move selection and focus together', () => {
  it('ArrowRight checks the next segment, not just focuses it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const [needs, working] = segments();

    needs.focus();
    expect(needs).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(needs, { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith('working');
    expect(working).toHaveAttribute('aria-checked', 'true');
    expect(needs).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(document.activeElement).toBe(working));
  });

  it('ArrowLeft checks the previous segment', async () => {
    render(<Harness />);
    const [needs, working] = segments();

    needs.focus();
    fireEvent.keyDown(needs, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(working));

    fireEvent.keyDown(working, { key: 'ArrowLeft' });
    expect(needs).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(document.activeElement).toBe(needs));
  });

  it('wraps at the ends, the way a radiogroup does', async () => {
    render(<Harness />);
    const [needs, working] = segments();

    needs.focus();
    // Backwards off the front lands on the last segment.
    fireEvent.keyDown(needs, { key: 'ArrowLeft' });
    expect(working).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(document.activeElement).toBe(working));

    // …and forwards off the end comes back to the first.
    fireEvent.keyDown(working, { key: 'ArrowRight' });
    expect(needs).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(document.activeElement).toBe(needs));
  });

  it('Home and End jump to the ends', async () => {
    render(<Harness />);
    const [needs, working] = segments();

    needs.focus();
    fireEvent.keyDown(needs, { key: 'End' });
    expect(working).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(document.activeElement).toBe(working));

    fireEvent.keyDown(working, { key: 'Home' });
    expect(needs).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(document.activeElement).toBe(needs));
  });

  it('moves from the FOCUSED segment when focus is on the group itself', async () => {
    // Nothing has been clicked yet, so Radix's roving focus leaves the track as
    // the tab stop and no item is focused. Arrowing from there must land
    // somewhere predictable rather than on whatever Radix would have focused.
    render(<Harness />);
    const [needs, working] = segments();
    screen.getByRole('radiogroup').focus();

    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });

    expect(working).toHaveAttribute('aria-checked', 'true');
    expect(needs).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(document.activeElement).toBe(working));
  });

  it('leaves modified arrows to whoever owns them', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const [needs] = segments();
    needs.focus();

    fireEvent.keyDown(needs, { key: 'ArrowRight', metaKey: true });

    expect(onChange).not.toHaveBeenCalled();
    expect(needs).toHaveAttribute('aria-checked', 'true');
  });
});
