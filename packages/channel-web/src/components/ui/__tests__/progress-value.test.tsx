// @vitest-environment jsdom
/**
 * A progress bar that does not say how far along it is.
 *
 * `Progress` pulled `value` out of its props to compute the indicator's
 * transform, and then never handed it to the Radix `Root`. Visually it was
 * right — the bar moved. To anyone using a screen reader it was a progressbar
 * with no value at all: no `aria-valuenow`, and `data-state` stuck on
 * `indeterminate` forever, which is the ARIA way of saying "we have no idea
 * how long this will take". Every `Progress` in the app was affected.
 *
 * TASK-353 is what surfaced it: the workspace composer's upload chip renders
 * one of these while a file uploads, and "uploading" is one of the three
 * states that card requires to be perceivable. A bar that only *looks* like
 * it is moving does not clear that bar for everyone.
 *
 * These assertions fail against the unfixed component: it rendered no
 * `aria-valuenow` attribute at all, so `toHaveAttribute` was false, not merely
 * a different number.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Progress } from '../progress';

describe('Progress reports its value to assistive tech', () => {
  it('sets aria-valuenow from the value prop', () => {
    render(<Progress value={42} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
  });

  it('clamps an out-of-range value for the accessibility tree too, not just the paint', () => {
    // The component already clamped the *transform* so the indicator could not
    // run past the track. The announced number has to agree with the paint, or
    // a sighted user and a screen-reader user are told two different things.
    const { rerender } = render(<Progress value={140} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    rerender(<Progress value={-20} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
  });

  it('stays indeterminate when no value is given', () => {
    // Genuinely unknown progress is a real state and must NOT be reported as
    // 0% — that would be a claim we cannot back.
    render(<Progress />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
  });
});
