/**
 * TASK-546 — the state dot's slot is at least as wide as the widest dot.
 *
 * `StateDot`'s shapes differ in width by state (`STATE_SHAPE` in `bits.tsx`),
 * so every call site that lines text up after a dot puts it in one shared
 * `StateDotSlot` (TASK-544). The slot only does its job while it is at least
 * as wide as every shape. Nothing linked the two numbers before this test: a
 * wider shape would spill out of the slot into the gap beside it.
 *
 * jsdom has no layout, so this reads the width CLASSES the real components
 * render and turns them into pixels. It checks LAYOUT width. The fixed slot
 * is what places the text; this pin keeps a shape from outgrowing it. A
 * `rotate-*` transform does not change layout, so the 6px diamond (about 8.5px
 * corner to corner) passes, and its sub-pixel overhang lands in the row gap.
 *
 * A width class this parser cannot read fails the test instead of being
 * skipped, so a new spelling cannot slip past it.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { STATE_SHAPE, StateDot, StateDotSlot } from '../bits';

/** Tailwind's default spacing scale: one step is 0.25rem = 4px. */
const PX_PER_STEP = 4;

/** The layout width, in px, that a class list sets. Throws if it can't tell. */
function widthPx(className: string): number {
  const tokens = className.split(/\s+/);
  // Classes that also move the horizontal extent. They would make the dot
  // wider than its `w-*` says, so a shape using one fails loudly here.
  // Border COLOURS (`border-transparent`) are not widths; border widths are.
  const sneaky = tokens.find(
    (c) =>
      /^(min-w|max-w|basis|p|px|pl|pr|ps|pe)-/.test(c) ||
      /^border(-[xlrse])?(-(\d+|\[[^\]]+\]))?$/.test(c),
  );
  if (sneaky && !(sneaky.startsWith('border') && tokens.includes('box-border'))) throw new Error(`"${sneaky}" also sets width; teach this test how to read it`);
  const widths = tokens
    .filter((c) => /^(w|size)-/.test(c))
    .map((c) => {
      const arbitrary = /^(?:w|size)-\[(\d+(?:\.\d+)?)px\]$/.exec(c);
      if (arbitrary) return Number(arbitrary[1]);
      const scale = /^(?:w|size)-(\d+(?:\.\d+)?)$/.exec(c);
      if (scale) return Number(scale[1]) * PX_PER_STEP;
      throw new Error(`can't read a width from "${c}" in "${className}"`);
    });
  if (widths.length !== 1) {
    throw new Error(`expected exactly one width class in "${className}", got ${widths.length}`);
  }
  return widths[0]!;
}

function renderSlotted(state: keyof typeof STATE_SHAPE) {
  const { container, unmount } = render(
    <StateDotSlot>
      <StateDot state={state} />
    </StateDotSlot>,
  );
  const slot = container.firstElementChild as HTMLElement;
  const dot = slot.firstElementChild as HTMLElement;
  const result = { slot: slot.className, dot: dot.className };
  unmount();
  return result;
}

const STATES = Object.keys(STATE_SHAPE) as Array<keyof typeof STATE_SHAPE>;

describe('StateDotSlot fits every STATE_SHAPE (TASK-546)', () => {
  it('covers every state the dot can draw', () => {
    expect([...STATES].sort()).toEqual([
      'done',
      'held',
      'needs-you',
      'no-recent-update',
      'no-update',
      'off-track',
      'on-track',
      'paused',
      'resting',
      'stopped',
      'waiting',
      'working',
    ]);
  });

  it.each(STATES)('%s: the dot is no wider than its slot', (state) => {
    const { slot, dot } = renderSlotted(state);
    expect(widthPx(dot)).toBeLessThanOrEqual(widthPx(slot));
  });

  it('the slot is fixed width and centres the dot', () => {
    const { slot } = renderSlotted('working');
    expect(slot.split(/\s+/)).toEqual(
      expect.arrayContaining(['flex', 'shrink-0', 'justify-center']),
    );
  });

  it('resting is a hollow ring rather than a dash or filled circle', () => {
    const { dot } = renderSlotted('resting');
    expect(dot).toContain('rounded-full');
    expect(dot).toContain('border-state-quiet');
    expect(dot).not.toMatch(/\bbg-/);
    expect(widthPx(dot)).toBe(7);
  });

  it('draws a task mark like the agent mark it means (TASK-909)', () => {
    expect(STATE_SHAPE['needs-you']).toBe(STATE_SHAPE.waiting);
    expect(STATE_SHAPE['off-track']).toBe(STATE_SHAPE.stopped);
    expect(STATE_SHAPE['on-track']).toBe(STATE_SHAPE.working);
    expect(STATE_SHAPE['no-update']).toBe(STATE_SHAPE.resting);

    expect(renderSlotted('needs-you').dot).toContain('bg-warning');
    expect(renderSlotted('off-track').dot).toContain('bg-destructive');
    expect(renderSlotted('on-track').dot).toContain('bg-primary');
    const noUpdate = renderSlotted('no-update').dot;
    expect(noUpdate).toContain('border-state-quiet');
    expect(noUpdate).not.toMatch(/\bbg-/);
  });

  it('draws no-recent-update as the hollow ring a resting mark is (TASK-930)', () => {
    expect(STATE_SHAPE['no-recent-update']).toBe(STATE_SHAPE.resting);
    const dot = renderSlotted('no-recent-update').dot;
    expect(dot).toContain('border-state-quiet');
    expect(dot).not.toMatch(/\bbg-/);
  });

  it('draws paused as a dash no agent mark uses (TASK-909)', () => {
    const { dot } = renderSlotted('paused');
    expect(widthPx(STATE_SHAPE.paused)).toBe(8);
    expect(STATE_SHAPE.paused).toContain('h-[3px]');
    for (const agent of ['working', 'waiting', 'held', 'resting', 'stopped'] as const) {
      expect(STATE_SHAPE.paused).not.toBe(STATE_SHAPE[agent]);
    }
    expect(dot).toContain('bg-state-quiet');
  });

  it('draws done as a check no other mark uses (TASK-950)', () => {
    const { dot } = renderSlotted('done');
    expect(widthPx(STATE_SHAPE.done)).toBe(4);
    expect(STATE_SHAPE.done).toContain('rotate-45');
    expect(STATE_SHAPE.done).toContain('border-b-[1.5px]');
    expect(STATE_SHAPE.done).toContain('border-r-[1.5px]');
    for (const other of STATES.filter((s) => s !== 'done')) {
      expect(STATE_SHAPE.done).not.toBe(STATE_SHAPE[other]);
    }
    expect(dot).toContain('border-primary');
    expect(dot).not.toMatch(/\bbg-/);
  });

  it('reads the widths it is meant to read', () => {
    expect(widthPx('w-2')).toBe(8);
    expect(widthPx('h-[3px] w-[8px] rounded-full')).toBe(8);
    expect(widthPx('size-[7px]')).toBe(7);
    expect(() => widthPx('w-full')).toThrow(/can't read/);
    expect(() => widthPx('h-2')).toThrow(/exactly one/);
    expect(() => widthPx('w-[6px] min-w-[12px]')).toThrow(/also sets width/);
    expect(() => widthPx('box-border w-[6px] min-w-[12px]')).toThrow(/also sets width/);
    expect(() => widthPx('w-[6px] px-1')).toThrow(/also sets width/);
    expect(() => widthPx('w-[6px] border')).toThrow(/also sets width/);
    expect(() => widthPx('w-[6px] border-x-2')).toThrow(/also sets width/);
    // Colour classes are not widths.
    expect(widthPx('w-[7px] bg-primary border-transparent')).toBe(7);
  });
});
