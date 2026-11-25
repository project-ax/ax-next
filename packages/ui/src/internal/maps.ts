import type { SpaceToken } from '../foundation/tokens.js';

// Literal lookup maps only: Tailwind finds classes by scanning source text, so none may be built by string concatenation.
export const GAP: Record<SpaceToken, string> = {
  none: 'ax-gap-none',
  xs: 'ax-gap-xs',
  sm: 'ax-gap-sm',
  md: 'ax-gap-md',
  lg: 'ax-gap-lg',
  xl: 'ax-gap-xl',
  section: 'ax-gap-section',
};
