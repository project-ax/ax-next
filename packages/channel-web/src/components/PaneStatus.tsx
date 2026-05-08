/**
 * PaneStatus — pane-level loading / empty / error placeholder.
 *
 * Three patterns repeated across admin tabs and the credentials panel:
 *
 *   - "Loading <thing>…"    — `text-sm text-muted-foreground`.
 *   - "No <things> yet."     — same.
 *   - error rows             — `bg-destructive-soft border border-destructive/25
 *                              rounded-md text-[12.5px] text-destructive` with
 *                              `role="alert"`.
 *
 * One component so the placeholder copy and the error chrome stay in
 * sync as more list-style admin tabs land.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PaneStatusVariant = 'loading' | 'empty' | 'error';

export interface PaneStatusProps {
  variant: PaneStatusVariant;
  className?: string;
  children: ReactNode;
}

export function PaneStatus({ variant, className, children }: PaneStatusProps) {
  if (variant === 'error') {
    return (
      <div
        role="alert"
        className={cn(
          'px-3 py-2 rounded-md border bg-destructive-soft border-destructive/25 text-[12.5px] text-destructive',
          className,
        )}
      >
        {children}
      </div>
    );
  }
  return (
    <div className={cn('text-sm text-muted-foreground', className)}>{children}</div>
  );
}
