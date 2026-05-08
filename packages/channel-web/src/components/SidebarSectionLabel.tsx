/**
 * SidebarSectionLabel — small uppercase label used as a section heading
 * inside the sidebars and in popover footers.
 *
 * One typography spec for a tiny label that previously appeared in 5+
 * places with subtly drifting tracking and font-size:
 *
 *   - "ADMIN"            — admin sidebar, above the nav list.
 *   - "today / yesterday / earlier" — chat sidebar, session group labels.
 *   - "switch agent"     — chat agent menu header.
 *   - "AX V0.3"          — chat user menu footer.
 *
 * 10.5px, 0.12em tracking, uppercase, ink-ghost, font-medium. The
 * `AdminPaneHeader` eyebrow uses a different scale (11px / 0.06em /
 * muted-foreground) and stays separate.
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SidebarSectionLabelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function SidebarSectionLabel({
  className,
  children,
  ...props
}: SidebarSectionLabelProps) {
  return (
    <div
      className={cn(
        'text-[10.5px] tracking-[0.12em] uppercase font-medium text-ink-ghost',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
