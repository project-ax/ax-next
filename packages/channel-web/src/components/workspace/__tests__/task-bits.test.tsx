/**
 * The Tasks surfaces' shared icon pieces (2026-10-29): every icon keeps its
 * words, once. A disabled icon action still says what it is and why it's off,
 * in a tooltip a pointer or the keyboard can open; a chip's or an action's
 * words are read once, from one source, not again from its open tooltip.
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Clock, RefreshCw } from 'lucide-react';
import { IconAction, MetaChip } from '../task-bits';

describe('IconAction', () => {
  it('an enabled action is named by its label, and its open tooltip adds no second description', async () => {
    render(<IconAction icon={RefreshCw} label="Check now" />);
    const button = screen.getByRole('button', { name: 'Check now' });
    act(() => button.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Check now');
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(button).toHaveAccessibleDescription('');
  });

  it('keeps the caller’s description through an open tooltip', async () => {
    render(
      <>
        <p id="why">Paused.</p>
        <IconAction icon={RefreshCw} label="Check now" aria-describedby="why" />
      </>,
    );
    const button = screen.getByRole('button', { name: 'Check now' });
    act(() => button.focus());
    await screen.findByRole('tooltip');
    expect(button).toHaveAccessibleDescription('Paused.');
  });

  it('a disabled action is wrapped in a focusable trigger whose tooltip says the label and why', async () => {
    render(
      <>
        <p id="why">Paused. It won’t check in until you resume it.</p>
        <IconAction
          icon={RefreshCw}
          label="Check now"
          disabled
          aria-describedby="why"
          reason="Paused. It won’t check in until you resume it."
        />
      </>,
    );
    const button = screen.getByRole('button', { name: 'Check now' });
    expect(button).toBeDisabled();
    // The button keeps its own description.
    expect(button).toHaveAccessibleDescription('Paused. It won’t check in until you resume it.');
    const wrapper = button.parentElement!;
    expect(wrapper.tagName).toBe('SPAN');
    expect(wrapper).toHaveAttribute('tabindex', '0');
    act(() => wrapper.focus());
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Check now');
    expect(tip).toHaveTextContent('Paused. It won’t check in until you resume it.');
    expect(wrapper).not.toHaveAttribute('aria-describedby');
  });

  it('a disabled action’s tooltip opens on hover of its wrapper too', async () => {
    render(<IconAction icon={RefreshCw} label="Send" disabled reason="Write something first." />);
    const wrapper = screen.getByRole('button', { name: 'Send' }).parentElement!;
    fireEvent.pointerMove(wrapper, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip', {}, { timeout: 2000 })).toHaveTextContent('Write something first.');
  });

  it('the wrapper is a tab stop only while the button is disabled, and the button node survives the change', () => {
    const view = render(<IconAction icon={RefreshCw} label="Check now" />);
    const button = screen.getByRole('button', { name: 'Check now' });
    expect(button.parentElement).not.toHaveAttribute('tabindex');
    view.rerender(<IconAction icon={RefreshCw} label="Check now" disabled />);
    expect(screen.getByRole('button', { name: 'Check now' })).toBe(button);
    expect(button.parentElement).toHaveAttribute('tabindex', '0');
  });
});

describe('MetaChip', () => {
  it('says its sentence once: its hidden text, not again as its open tooltip’s description', async () => {
    render(<MetaChip icon={Clock} label="1 hr" description="Quill checks in every hour." />);
    const chip = screen.getByText('Quill checks in every hour.', { selector: '.sr-only' }).parentElement!;
    act(() => chip.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Quill checks in every hour.');
    expect(chip).not.toHaveAttribute('aria-describedby');
  });
});
