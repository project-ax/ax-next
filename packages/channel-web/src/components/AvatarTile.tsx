/**
 * AvatarTile — small bordered tile used in the sidebars.
 *
 * Two surfaces:
 *
 *   - `gradient` — the primary→muted blend used for "branded" tiles
 *     (agent chip, user-menu trigger). Strength is configurable so the
 *     tile reads slightly stronger when it's the primary identity
 *     marker (UserMenu trigger at 26%) vs. nestled inside a row
 *     (AgentChip avatar at 22%).
 *
 *   - `muted` — plain bg-muted, used where the tile is a backdrop for
 *     content with its own colour (the agent menu rows put a dot in
 *     the agent's colour inside; the user-menu popover header puts the
 *     initials in foreground).
 *
 * Shape (`square` rounded-md vs `round` rounded-full) and pixel size
 * are props because the call-sites really do need the variation:
 * 22px square in the agent chip, 26px round in the user trigger,
 * 36px round in the popover header.
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
