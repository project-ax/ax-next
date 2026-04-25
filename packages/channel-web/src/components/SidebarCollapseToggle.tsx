/**
 * SidebarCollapseToggle — small button that flips
 * `body.sidebar-collapsed` on/off. CSS rules in `index.css` (copied from
 * the Tide handoff) own the actual width transitions.
 *
 * Lives in `.sidebar-head` for now; Task 16 may move/duplicate it into
 * the session header. Kept as its own component so the move is a
 * one-line import change.
 *
 * Glyph is a panel-with-rail SVG. It does NOT rotate on collapse — the
 * design treats the icon as a stable affordance rather than a state arrow.
 */
import { setSidebarCollapsed, useSidebarCollapsed } from '../lib/sidebar-collapse';

export function SidebarCollapseToggle() {
  const collapsed = useSidebarCollapsed();
  return (
    <button
      type="button"
      className="sidebar-collapse"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      title="Toggle sidebar (⌘\)"
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
