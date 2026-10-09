/**
 * SidebarRow — shared base for left-rail rows.
 *
 * `AdminNavItem` (admin shell) renders this exact frame: same padding, gap,
 * text size, hover tone, active wash. The deleted chat UI's `SessionRow` used
 * to render it too — the shared base kept the two from drifting apart while
 * both existed.
 *
 * Slots:
 *
 *   - `accent`  — left-edge bar (2px wide, full row height minus 10px
 *                 vertical padding, rounded-full). Admin passes nothing
 *                 and gets a primary-blue bar when `active`.
 *
 *   - `children` — leading icon, the title, and any trailing affordance.
 *                  Caller controls the layout inside the row.
 *
 * The frame is a `<button>` by default. Callers that need a non-button
 * container should opt out and apply the same Tailwind frame manually — see
 * `sidebarRowBaseClass` below for the exact set.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const sidebarRowBaseClass =
  'group relative flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-sm cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1';

export const sidebarRowActiveClass = 'bg-primary-soft text-primary';
export const sidebarRowInactiveClass =
  'text-foreground/75 hover:bg-muted hover:text-foreground';

/**
 * The default primary-blue accent bar admin uses when `active` is true
 * and no `accent` slot is provided. Exported so a consumer that bypasses
 * the `<SidebarRow>` component can still render the same bar against the
 * same row frame.
 */
export const SidebarRowDefaultAccent = () => (
  <span
    aria-hidden="true"
    className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-primary"
  />
);

export interface SidebarRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean | undefined;
  accent?: ReactNode | undefined;
  children: ReactNode;
}

export const SidebarRow = forwardRef<HTMLButtonElement, SidebarRowProps>(
  function SidebarRow({ active, accent, className, children, ...props }, ref) {
    const accentNode = accent ?? (active ? <SidebarRowDefaultAccent /> : null);
    return (
      <button
        ref={ref}
        type="button"
        data-active={active || undefined}
        className={cn(
          sidebarRowBaseClass,
          active ? sidebarRowActiveClass : sidebarRowInactiveClass,
          className,
        )}
        {...props}
      >
        {accentNode}
        {children}
      </button>
    );
  },
);
