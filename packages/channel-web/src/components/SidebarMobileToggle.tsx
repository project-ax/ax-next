/**
 * SidebarMobileToggle — hamburger button that flips `body.sidebar-open`.
 *
 * Visibility is responsive: hidden on desktop, inline-flex below the
 * 720px mobile breakpoint. Lives next to SidebarCollapseToggle in the
 * session header. The two toggles target different body classes
 * (sidebar-collapsed vs. sidebar-open) and only one is visible at any
 * breakpoint, so they never compete.
 */
import { setSidebarOpen, useSidebarOpen } from '../lib/sidebar-collapse';

export function SidebarMobileToggle() {
  const open = useSidebarOpen();
  return (
    <button
      type="button"
      data-testid="sidebar-mobile-toggle"
      className="
        hidden max-[720px]:inline-flex items-center justify-center
        h-7 w-7 rounded shrink-0
        text-muted-foreground hover:text-foreground hover:bg-muted
        focus-visible:text-foreground focus-visible:bg-muted focus-visible:outline-none
        transition-colors
      "
      aria-label={open ? 'Close sessions' : 'Open sessions'}
      aria-expanded={open}
      onClick={() => setSidebarOpen(!open)}
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
        <line x1="3" y1="5" x2="13" y2="5" />
        <line x1="3" y1="8" x2="13" y2="8" />
        <line x1="3" y1="11" x2="13" y2="11" />
      </svg>
    </button>
  );
}
