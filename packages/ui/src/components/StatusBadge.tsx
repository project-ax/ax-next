import type { ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { BADGE_TONE, type StatusTone } from '../internal/status.js';
import { StatusMark } from './StatusMark.js';

export interface StatusBadgeProps {
  tone: StatusTone;
  dot?: boolean;
  size?: 'sm' | 'md';
  children: ReactNode;
}

const SIZE: Record<NonNullable<StatusBadgeProps['size']>, string> = {
  sm: 'ax-px-sm ax-py-none',
  md: 'ax-px-md ax-py-xs',
};

// Caption role, one line: long text truncates and carries the full text in title.
export function StatusBadge({ tone, dot, size = 'md', children }: StatusBadgeProps) {
  return (
    <span
      className={cx(
        'ax-box-border ax-inline-flex ax-max-w-full ax-min-w-none ax-items-center ax-gap-xs ax-rounded-full ax-text-caption ax-font-sans',
        BADGE_TONE[tone],
        SIZE[size],
      )}
    >
      {dot ? <StatusMark tone={tone} /> : null}
      <span className="ax-min-w-none ax-truncate" {...(typeof children === 'string' ? { title: children } : {})}>
        {children}
      </span>
    </span>
  );
}
