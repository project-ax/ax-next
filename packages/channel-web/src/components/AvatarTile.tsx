/**
 * AvatarTile — small bordered tile used in the sidebars.
 *
 * Two surfaces:
 *
 *   - `gradient` — the primary→muted blend used for "branded" tiles
 *     (user-menu trigger). Strength is configurable so the tile reads
 *     slightly stronger when it's the primary identity marker (UserMenu
 *     trigger at 26%) vs. a smaller instance elsewhere.
 *
 *   - `muted` — plain bg-muted, used where the tile is a backdrop for
 *     content with its own colour (the user-menu popover header puts the
 *     initials in foreground).
 *
 * Shape (`square` rounded-md vs `round` rounded-full) and pixel size
 * are props because the call-sites really do need the variation:
 * `AgentTile` in the workspace uses `square`; the user trigger and popover
 * header use `round` at 26px/36px.
 */
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AvatarTileShape = 'square' | 'round';
export type AvatarTileBackground = 'gradient' | 'muted';

export interface AvatarTileProps {
  shape?: AvatarTileShape;
  /** Tile size in CSS pixels. */
  size: number;
  background?: AvatarTileBackground;
  /** Primary mix percentage for `background='gradient'`. Defaults to 22. */
  gradientStrength?: number;
  className?: string;
  children?: ReactNode;
}

export function AvatarTile({
  shape = 'square',
  size,
  background = 'gradient',
  gradientStrength = 22,
  className,
  children,
}: AvatarTileProps) {
  const style: CSSProperties = { width: size, height: size };
  if (background === 'gradient') {
    style.background = `linear-gradient(135deg, color-mix(in srgb, hsl(var(--primary)) ${gradientStrength}%, hsl(var(--muted))), hsl(var(--muted)))`;
  }
  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        'inline-flex items-center justify-center shrink-0 border border-border',
        shape === 'square' ? 'rounded-md' : 'rounded-full',
        background === 'muted' && 'bg-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}
