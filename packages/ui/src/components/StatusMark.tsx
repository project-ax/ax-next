import { cx } from '../internal/cx.js';
import { MARK_COLOR, SHAPE, type StatusTone } from '../internal/status.js';

export type { StatusTone };

export interface StatusMarkProps {
  tone: StatusTone;
  // With a label the mark is an image with that name; without one it is decorative (aria-hidden).
  label?: string;
}

// The shape is exposed as data-shape (diamond | square | circle | check | ring): a public, documented attribute.
export function StatusMark({ tone, label }: StatusMarkProps) {
  const shape = SHAPE[tone];
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg
      viewBox="0 0 12 12"
      data-shape={shape}
      data-tone={tone}
      focusable="false"
      {...a11y}
      className={cx('ax-inline-block ax-h-md ax-w-md ax-shrink-0', MARK_COLOR[tone])}
    >
      {shape === 'diamond' ? <path d="M6 0.5 11.5 6 6 11.5 0.5 6Z" fill="currentColor" /> : null}
      {shape === 'square' ? <rect x="1.5" y="1.5" width="9" height="9" fill="currentColor" /> : null}
      {shape === 'circle' ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
      {shape === 'check' ? (
        <path d="M2 6.5 5 9.5 10 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {shape === 'ring' ? <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.75" /> : null}
    </svg>
  );
}
