/**
 * BrandMark — the 5px primary dot + product wordmark.
 *
 * One source of truth for the dot's size, the dot/word gap, the
 * baseline tweak (`-translate-y-[3px]`), and the wordmark typography.
 * Used in the chat sidebar header, the admin sidebar header, and the
 * sign-in card.
 *
 * Sizes track the existing call-sites:
 *   - `md` — 19px wordmark, 5px dot (sidebar headers).
 *   - `xl` — 28px wordmark, 7px dot (login card).
 */
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

export type BrandMarkSize = 'md' | 'xl';

export interface BrandMarkProps {
  word: string;
  size?: BrandMarkSize;
  className?: string;
}

const SIZE: Record<
  BrandMarkSize,
  { dot: CSSProperties; word: string }
> = {
  md: {
    dot: { width: '5px', height: '5px' },
    word: 'text-[19px] font-medium tracking-[-0.015em] leading-none',
  },
  xl: {
    dot: { width: '7px', height: '7px' },
    word: 'text-[28px] font-medium tracking-[-0.015em] leading-none',
  },
};

export function BrandMark({ word, size = 'md', className }: BrandMarkProps) {
  const cfg = SIZE[size];
  return (
    <span className={cn('flex items-center', className)}>
      <span
        aria-hidden="true"
        className="inline-block rounded-full bg-primary mr-2 -translate-y-[3px]"
        style={cfg.dot}
      />
      <span className={cn(cfg.word, 'text-foreground')}>{word}</span>
    </span>
  );
}
