/**
 * Sidebar — left rail shell.
 *
 * Mirrors AdminSidebar's outer shape so admin and chat present the same
 * surface tone, brand mark, and rail width. Inner contents (agent chip,
 * sessions list, user menu) keep their existing wiring.
 */
import { NewSessionButton } from './NewSessionButton';
import { SessionList } from './SessionList';
import { SidebarCollapseToggle } from './SidebarCollapseToggle';
import { UserMenu } from './UserMenu';

export function Sidebar({
  onOpenAdminSettings,
  onOpenSettings,
}: {
  onOpenAdminSettings?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
} = {}) {
  return (
    <aside
      data-testid="sidebar"
      id="sidebar"
      className="
        sticky top-0 self-start h-screen overflow-visible
        w-[240px] shrink-0 border-r border-border bg-background
        flex flex-col font-sans
        transition-[width] duration-200 [body.sidebar-collapsed_&]:w-[56px]
      "
    >
      <div
        className="
          flex items-center justify-between gap-2 px-3 pt-3.5 pb-2.5
          [body.sidebar-collapsed_&]:justify-center [body.sidebar-collapsed_&]:px-2
        "
      >
        <span className="flex items-center [body.sidebar-collapsed_&]:hidden">
          <span className="inline-block w-[5px] h-[5px] rounded-full bg-primary mr-2 -translate-y-[3px]" />
          <span className="text-[19px] font-medium tracking-[-0.015em] leading-none">ax</span>
        </span>
        <SidebarCollapseToggle />
      </div>
      <NewSessionButton />
      <div
        className="
          flex-1 overflow-y-auto pb-3
          [body.sidebar-collapsed_&]:invisible [body.sidebar-collapsed_&]:pointer-events-none
          [scrollbar-width:thin]
        "
        role="navigation"
        aria-label="sessions"
      >
        <SessionList />
      </div>
      <UserMenu onOpenAdminSettings={onOpenAdminSettings} onOpenSettings={onOpenSettings} />
    </aside>
  );
}
