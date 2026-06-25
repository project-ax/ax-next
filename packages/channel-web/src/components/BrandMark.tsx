/**
 * BrandMark — the product mark in the chat sidebar, admin sidebar, sign-in
 * card, and setup wizard. One source of truth, now driven by the operator's
 * branding config (`useBranding()`):
 *
 *   - No logo            → the 5px primary dot + the product name (default "ax").
 *   - Logo, type "full"  → the logo alone (it carries its own wordmark).
 *   - Logo, type "icon"  → a small square logo + the name beside it.
 *
 * Light/dark: render the variant matching the resolved theme; if only a light
 * logo is set, CSS-invert it in dark mode (ideal for monochrome marks).
 *
 * The dot + name is also the loading/unbranded state — BrandMark mounts after
 * App's own loading gate, so a branded deploy lands straight on its logo
 * without flashing "ax", while an unbranded deploy shows "ax" immediately.
 *
 * `size` tracks the call-sites: `md` (19px wordmark) for sidebar headers, `xl`
 * (28px) for the login + setup cards. The logo height tracks the wordmark.
 */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { useBranding } from '@/lib/branding-context';
import { logoUrl } from '@/lib/branding';
import { useResolvedTheme } from '@/lib/theme';

export type BrandMarkSize = 'md' | 'xl';

export interface BrandMarkProps {
  size?: BrandMarkSize;
  className?: string;
}

const SIZE: Record<
  BrandMarkSize,
  { dot: CSSProperties; word: string; logoHeight: string }
> = {
  md: {
    dot: { width: '5px', height: '5px' },
    word: 'text-[19px] font-medium tracking-[-0.015em] leading-none',
    logoHeight: '20px',
  },
  xl: {
    dot: { width: '7px', height: '7px' },
    word: 'text-[28px] font-medium tracking-[-0.015em] leading-none',
    logoHeight: '30px',
  },
};

// Defang a light-only logo for dark mode. Ideal for monochrome marks; a
// multi-color logo should supply an explicit dark variant instead.
const INVERT_FILTER = 'invert(1) hue-rotate(180deg)';

export function BrandMark({ size = 'md', className }: BrandMarkProps) {
  const cfg = SIZE[size];
  const { branding, loaded } = useBranding();
  const resolved = useResolvedTheme();
  const name = branding.name.length > 0 ? branding.name : 'ax';

  const showLogo = loaded && branding.light;
  if (!showLogo) {
    return (
      <span className={cn('flex items-center', className)}>
        <span
          aria-hidden="true"
          className="inline-block rounded-full bg-primary mr-2 -translate-y-[3px]"
          style={cfg.dot}
        />
        <span className={cn(cfg.word, 'text-foreground')}>{name}</span>
      </span>
    );
  }

  const dark = resolved === 'dark';
  const variant: 'light' | 'dark' = dark && branding.dark ? 'dark' : 'light';
  const invert = dark && !branding.dark;
  const src = logoUrl(variant, branding.version);

  if (branding.logoType === 'icon') {
    const iconStyle: CSSProperties = invert
      ? { height: cfg.logoHeight, width: cfg.logoHeight, filter: INVERT_FILTER }
      : { height: cfg.logoHeight, width: cfg.logoHeight };
    return (
      <span className={cn('flex items-center', className)}>
        <img
          src={src}
          alt=""
          aria-hidden="true"
          className="mr-2 object-contain"
          style={iconStyle}
        />
        <span className={cn(cfg.word, 'text-foreground')}>{name}</span>
      </span>
    );
  }

  // logoType === 'full' — the logo carries its own wordmark, so render it alone.
  const fullStyle: CSSProperties = invert
    ? { height: cfg.logoHeight, width: 'auto', filter: INVERT_FILTER }
    : { height: cfg.logoHeight, width: 'auto' };
  return (
    <span className={cn('flex items-center', className)}>
      <img src={src} alt={name} className="object-contain" style={fullStyle} />
    </span>
  );
}
