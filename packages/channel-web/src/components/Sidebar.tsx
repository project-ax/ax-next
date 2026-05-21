/**
 * Sidebar — left rail shell.
 *
 * Mirrors AdminSidebar's outer shape so admin and chat present the same
 * surface tone, brand mark, and rail width. Inner contents (agent chip,
 * sessions list, user menu) keep their existing wiring.
 */
import { BrandMark } from './BrandMark';
import { NewSessionButton } from './NewSessionButton';
import { SessionList } from './SessionList';
import { SidebarCollapseToggle } from './SidebarCollapseToggle';
import { UserMenu } from './UserMenu';

export function Sidebar({
  onOpenAdminSettings,
  onOpenRoutines,
  onOpenUserSkills,
}: {
  onOpenAdminSettings?: (() => void) | undefined;
  onOpenRoutines?: (() => void) | undefined;
  onOpenUserSkills?: (() => void) | undefined;
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
        max-[720px]:fixed max-[720px]:inset-y-0 max-[720px]:left-0 max-[720px]:z-50
        max-[720px]:!w-[280px] max-[720px]:-translate-x-full
        max-[720px]:transition-transform max-[720px]:duration-200
        [body.sidebar-open_&]:max-[720px]:translate-x-0
        max-[720px]:shadow-[0_0_40px_rgba(0,0,0,0.08)]
      "
    >
      <div
        className="
          flex items-center justify-between gap-2 px-3 pt-3.5 pb-2 min-h-[48px]
          [body.sidebar-collapsed_&]:justify-center [body.sidebar-collapsed_&]:px-2
        "
      >
        <BrandMark word="ax" className="[body.sidebar-collapsed_&]:hidden" />
        <SidebarCollapseToggle />
      </div>
      <NewSessionButton />
      <div
        className="
          flex-1 overflow-y-auto pb-3 px-1
          [body.sidebar-collapsed_&]:invisible [body.sidebar-collapsed_&]:pointer-events-none
          [scrollbar-width:thin]
        "
        role="navigation"
        aria-label="sessions"
      >
        <SessionList />
      </div>
      <UserMenu
        onOpenAdminSettings={onOpenAdminSettings}
        onOpenRoutines={onOpenRoutines}
        onOpenUserSkills={onOpenUserSkills}
      />
    </aside>
  );
}
