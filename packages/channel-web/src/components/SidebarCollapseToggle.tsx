/**
 * SidebarCollapseToggle — small button that flips
 * `body.sidebar-collapsed` on/off. Sidebar width transitions are driven
 * by a Tailwind arbitrary selector on the sidebar element.
 *
 * Glyph is a panel-with-rail SVG. It does NOT rotate on collapse — the
 * design treats the icon as a stable affordance rather than a state arrow.
 */
import { setSidebarCollapsed, useSidebarCollapsed } from '../lib/sidebar-collapse';
import { cn } from '@/lib/utils';

export function SidebarCollapseToggle({ className }: { className?: string } = {}) {
  const collapsed = useSidebarCollapsed();
  return (
    <button
      type="button"
      data-testid="sidebar-collapse"
      className={cn(
        'inline-flex items-center justify-center h-[22px] w-[22px] rounded shrink-0',
        'text-muted-foreground hover:text-foreground hover:bg-muted',
        'focus-visible:text-foreground focus-visible:bg-muted focus-visible:outline-none',
        'transition-colors',
        className,
      )}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      title="Toggle sidebar (⌘\\)"
      onClick={() => setSidebarCollapsed(!collapsed)}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <line x1="6" y1="3" x2="6" y2="13" />
      </svg>
    </button>
  );
}
