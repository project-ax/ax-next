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
 * on the `aria-checked` assertion (focus moved, selection did not); the role
 * test fails on `radiogroup` (it was `group`); the accessible-name test fails
 * on the missing `aria-label`. Measured: with `onKeyDown`, `role` and
 * `aria-label` reverted off the component, 7 of the 8 fail. The survivor is
 * "leaves modified arrows to whoever owns them", which asserts that we do NOT
 * act — it is a guard against over-reach and is supposed to hold either way. It
 * reddens if the modifier check is deleted instead.
 *
 * THE FOCUS ASSERTIONS ARE SYNCHRONOUS, AND THAT IS THE POINT. Radix's roving
 * focus moves focus inside a `setTimeout`; ours moves it in the handler, in the
 * same tick as the selection. So `expect(document.activeElement)` with no
 * `waitFor` is the assertion that the two travelled together rather than
 * arriving separately and happening to agree.
 *
 * WHAT IS *NOT* ASSERTED HERE, said plainly: that Radix's roving handler stands
 * down (see `WorkspaceHeader`'s header for why it does). In every configuration
 * this component's props can produce — LTR, no disabled segment — our target
 * arithmetic and Radix's agree, so a handler that ran anyway would be invisible.
 * There is no honest test for it; the argument is from the installed dist.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

/**
 * Both segments, fetched BY NAME rather than by index.
 *
 * Indexing a `getAllByRole` array hands `noUncheckedIndexedAccess` a
 * `HTMLElement | undefined` at every use, and the obvious way out — a bare
 * `const working = () => …` accessor — is worse: `expect(working)` then
 * asserts against the FUNCTION and passes whatever the DOM says.
 */
function bothSegments(): { needs: HTMLElement; working: HTMLElement } {
  return {
    // The label carries its count ("Needs you2"), so match the start of it.
    needs: screen.getByRole('radio', { name: /^Needs you/ }),
    working: screen.getByRole('radio', { name: 'Working' }),
  };
}

describe('Segmented — the radios have a radiogroup, and it is named', () => {
  it('roots the radios at role=radiogroup', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup');
    // The radios are INSIDE it — a radiogroup elsewhere on the page would
    // satisfy `getByRole` while leaving these radios unowned.
    const { needs, working } = bothSegments();
    expect(group).toContainElement(needs);
    expect(group).toContainElement(working);
  });

  it('gives the group an accessible name', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Filter today' })).toBeInTheDocument();
  });
});

describe('Segmented — arrow keys move selection and focus together', () => {
  it('ArrowRight checks the next segment, not just focuses it', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const { needs, working } = bothSegments();

    needs.focus();
    expect(needs).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(needs, { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith('working');
    expect(working).toHaveAttribute('aria-checked', 'true');
    expect(needs).toHaveAttribute('aria-checked', 'false');
    expect(document.activeElement).toBe(working);
  });

  it('ArrowLeft checks the previous segment', () => {
    render(<Harness />);
    const { needs, working } = bothSegments();

    needs.focus();
    fireEvent.keyDown(needs, { key: 'ArrowRight' });
    // Pinned, or the rest of this test is vacuous: against the unfixed
    // component the selection never leaves "Needs you", so the closing
    // assertion below would hold without a single thing having worked.
    expect(working).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(working);

    fireEvent.keyDown(working, { key: 'ArrowLeft' });
    expect(needs).toHaveAttribute('aria-checked', 'true');
    expect(working).toHaveAttribute('aria-checked', 'false');
    expect(document.activeElement).toBe(needs);
  });

  it('wraps at the ends, the way a radiogroup does', () => {
    render(<Harness />);
    const { needs, working } = bothSegments();

    needs.focus();
    // Backwards off the front lands on the last segment.
    fireEvent.keyDown(needs, { key: 'ArrowLeft' });
    expect(working).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(working);

    // …and forwards off the end comes back to the first.
    fireEvent.keyDown(working, { key: 'ArrowRight' });
    expect(needs).toHaveAttribute('aria-checked', 'true');
    expect(working).toHaveAttribute('aria-checked', 'false');
    expect(document.activeElement).toBe(needs);
  });

  it('Home and End jump to the ends', () => {
    render(<Harness />);
    const { needs, working } = bothSegments();

    needs.focus();
    fireEvent.keyDown(needs, { key: 'End' });
    expect(working).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(working);

    fireEvent.keyDown(working, { key: 'Home' });
    expect(needs).toHaveAttribute('aria-checked', 'true');
    expect(working).toHaveAttribute('aria-checked', 'false');
    expect(document.activeElement).toBe(needs);
  });

  it('handles the key when the TRACK itself is the target', () => {
    // The group-level handler, which exists for the one case an item's own
    // handler cannot see. Note this fires directly on the track rather than
    // reproducing how a browser gets there: Radix's entry-focus moves focus
    // onto an item as soon as the group takes keyboard focus, so in a real
    // browser the track is rarely the target. What is under test is that the
    // group handler moves selection the same way an item's does — not the
    // route by which a key reaches it.
    render(<Harness />);
    const { needs, working } = bothSegments();
    const group = screen.getByRole('radiogroup');
    group.focus();

    fireEvent.keyDown(group, { key: 'ArrowRight' });

    expect(working).toHaveAttribute('aria-checked', 'true');
    expect(needs).toHaveAttribute('aria-checked', 'false');
    expect(document.activeElement).toBe(working);
  });

  it('leaves modified arrows to whoever owns them', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const { needs, working } = bothSegments();
    needs.focus();

    fireEvent.keyDown(needs, { key: 'ArrowRight', metaKey: true });

    expect(onChange).not.toHaveBeenCalled();
    expect(needs).toHaveAttribute('aria-checked', 'true');
    expect(working).toHaveAttribute('aria-checked', 'false');
  });
});
