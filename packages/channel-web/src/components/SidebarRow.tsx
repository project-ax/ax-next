/**
 * SidebarRow — shared base for left-rail rows.
 *
 * Both `AdminNavItem` (admin shell) and `SessionRow` (chat sessions
 * list) render this exact frame: same padding, gap, text size, hover
 * tone, active wash. Two consumers, one source of truth — visual drift
 * between them would otherwise be a forever-ongoing Whac-A-Mole.
 *
 * Slots:
 *
 *   - `accent`  — left-edge bar (2px wide, full row height minus 10px
 *                 vertical padding, rounded-full). Admin passes nothing
 *                 and gets a primary-blue bar when `active`. Chat passes
 *                 a custom node coloured per-agent so the bar is always
 *                 visible and identifies which agent owns the session.
 *
 *   - `children` — leading icon (admin), the title, and any trailing
 *                  affordance (chat's `⋯` menu). Caller controls the
 *                  layout inside the row.
 *
 * The frame is a `<button>` by default. Callers that need a non-button
 * container (e.g. for the inline rename / delete-confirm edges in
 * SessionRow) should opt out and apply the same Tailwind frame manually
 * — see `sidebarRowBaseClass` below for the exact set.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const sidebarRowBaseClass =
  'group relative flex items-center gap-2.5 w-full px-2.5 py-2 rounded-sm text-[13px] cursor-pointer transition-colors';

export const sidebarRowActiveClass = 'bg-muted text-foreground';
export const sidebarRowInactiveClass =
  'text-foreground/75 hover:bg-muted hover:text-foreground';

/**
 * The default primary-blue accent bar admin uses when `active` is true
 * and no `accent` slot is provided. Exported so consumers that bypass
 * the `<SidebarRow>` component (e.g. SessionRow's confirm-delete edge)
 * can render the same bar against the same row frame.
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
