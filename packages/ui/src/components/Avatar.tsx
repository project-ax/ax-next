import { cx } from '../internal/cx.js';

export interface AvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  shape?: 'square' | 'round';
  tone?: 'brand' | 'neutral';
  label?: boolean;
}

const SIZE: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'ax-w-avatar-xs ax-h-avatar-xs ax-text-avatar-xs',
  sm: 'ax-w-avatar-sm ax-h-avatar-sm ax-text-avatar-sm',
  md: 'ax-w-avatar-md ax-h-avatar-md ax-text-avatar-md',
  lg: 'ax-w-avatar-lg ax-h-avatar-lg ax-text-avatar-lg',
};

const SHAPE: Record<NonNullable<AvatarProps['shape']>, string> = {
  square: 'ax-rounded-md',
  round: 'ax-rounded-full',
};

const TONE: Record<NonNullable<AvatarProps['tone']>, string> = {
  brand: 'ax-bg-accent-soft ax-text-accent',
  neutral: 'ax-bg-muted ax-text-fg ax-border ax-border-solid ax-border-line-border',
};

// First letters of the first two words (one for a single word), uppercase.
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

// Decorative by default (the name is almost always printed next to it); label makes it an image named by `name`.
export function Avatar({ name, size = 'md', shape = 'square', tone = 'brand', label }: AvatarProps) {
  return (
    <span
      {...(label ? { role: 'img', 'aria-label': name } : { 'aria-hidden': true })}
      className={cx(
        'ax-box-border ax-inline-flex ax-shrink-0 ax-items-center ax-justify-center ax-select-none ax-font-sans',
        SIZE[size],
        SHAPE[shape],
        TONE[tone],
      )}
    >
      {initials(name)}
    </span>
  );
}
