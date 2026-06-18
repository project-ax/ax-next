/**
 * UserMenu — popover at the bottom of the sidebar.
 *
 * Click the user row → opens a popover with: Settings (every user — TASK-42),
 * a theme tri-toggle (Light / Dark / System), and Sign out. (Neither Routines
 * nor Credentials is a top-level entry anymore — both live inside Settings:
 * Routines is a Settings tab, credentials live on each connector.)
 *
 * SECURITY NOTE — UI affordance only. Every user can now open Settings; the
 * admin-only *tabs* inside it are gated in-shell. That in-shell gating is a UX
 * nicety, not a security boundary — the real access control sits on the server:
 * every `/admin/*` route checks `role === 'admin'` regardless of what the menu
 * or the shell shows, and the user-scoped Settings routes server-force the
 * caller's own id (a user can only ever read/change their own data).
 */
import { useEffect, useRef, useState } from 'react';
import { LayoutGrid, LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react';
import { useUser } from '../lib/user-context';
import { signOut } from '../lib/auth';
import { useTheme, setTheme, type Theme } from '../lib/theme';
import { AvatarTile } from './AvatarTile';
import { SidebarSectionLabel } from './SidebarSectionLabel';

interface ThemeOption {
  value: Theme;
  label: string;
  Icon: typeof Sun;
}
const THEME_OPTIONS: ThemeOption[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  // 'auto' lets the OS preference drive (prefers-color-scheme); see lib/theme.ts.
  { value: 'auto', label: 'System', Icon: Monitor },
];

export function UserMenu({
  onOpenAdminSettings,
  onOpenFleet,
}: {
  onOpenAdminSettings?: (() => void) | undefined;
  onOpenFleet?: (() => void) | undefined;
} = {}) {
  const user = useUser();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!user) return null;

  return (
    <div className="user-row-wrap relative border-t border-border p-2" ref={ref}>
      <button
        type="button"
        // Keep `user-row` as a structural test hook — no CSS targets it.
        // The wrap (`user-row-wrap`) already has `p-2`, so the trigger
        // takes `w-full` and fills the wrap's content area exactly —
        // earlier `w-[calc(100%-16px)]` left an extra 16px gap on the
        // right edge and pushed the avatar off-centre when collapsed.
        className="
          user-row group flex items-center gap-2.5 cursor-pointer w-full
          px-2 py-[7px] rounded-lg transition-colors
          hover:bg-muted aria-expanded:bg-muted
          [body.sidebar-collapsed_&]:justify-center [body.sidebar-collapsed_&]:px-0
        "
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <AvatarTile
          shape="round"
          size={26}
          gradientStrength={26}
          className="user-avatar text-[11px] tracking-[0.04em] text-foreground"
        >
          {user.name[0]?.toUpperCase() ?? 'U'}
        </AvatarTile>
        <span className="flex flex-col gap-px min-w-0 flex-1 text-left [body.sidebar-collapsed_&]:hidden">
          <span className="user-name text-[12.5px] leading-[1.15] tracking-[-0.005em] text-foreground truncate">
            {user.name}
          </span>
          <span className="user-email text-[10.5px] leading-[1.15] text-muted-foreground truncate">
            {user.email}
          </span>
        </span>
        <svg
          viewBox="0 0 10 10"
          aria-hidden="true"
          className="
            shrink-0 h-2.5 w-2.5 text-muted-foreground transition-transform duration-150
            group-aria-expanded:rotate-180
            [body.sidebar-collapsed_&]:hidden
          "
        >
          <path
            d="M2.5 6 L5 3.5 L7.5 6"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          className="
            absolute bottom-[calc(100%-4px)] left-2 right-2 z-[70] p-1.5
            rounded-[10px] border border-border bg-card shadow-popover
            [body.sidebar-collapsed_&]:left-14 [body.sidebar-collapsed_&]:right-auto
            [body.sidebar-collapsed_&]:bottom-2 [body.sidebar-collapsed_&]:w-60
            animate-in fade-in-0 slide-in-from-bottom-1 zoom-in-95 duration-150
          "
          role="menu"
        >
          <div className="flex items-center gap-2.5 px-2.5 pb-2 mb-1 border-b border-border">
            <AvatarTile
              shape="round"
              size={36}
              background="muted"
              className="text-foreground font-semibold text-sm"
            >
              {user.name[0]?.toUpperCase() ?? 'U'}
            </AvatarTile>
            <div className="min-w-0">
              <div className="text-[14px] tracking-[-0.01em] leading-[1.1] text-foreground truncate">
                {user.name}
              </div>
              <div className="text-[11px] leading-[1.2] text-muted-foreground truncate">
                {user.email}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[12.5px] text-foreground hover:bg-muted transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenFleet?.();
            }}
            data-action="fleet"
          >
            <LayoutGrid aria-hidden="true" strokeWidth={1.4} />
            <span>Fleet</span>
          </button>
          <button
            type="button"
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[12.5px] text-foreground hover:bg-muted transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenAdminSettings?.();
            }}
            data-action="settings"
          >
            <Settings aria-hidden="true" strokeWidth={1.4} />
            <span>Settings</span>
          </button>
          <div className="h-px my-1 bg-border" />
          <div className="flex items-center gap-2.5 px-2.5 py-1.5" data-action="theme">
            <Moon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" strokeWidth={1.4} />
            <span className="text-[12.5px] text-foreground flex-1">Theme</span>
            <div
              className="ml-auto inline-flex items-center gap-0.5 p-0.5 rounded-md bg-muted border border-border"
              role="radiogroup"
              aria-label="Theme"
            >
              {THEME_OPTIONS.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  data-value={value}
                  role="radio"
                  aria-checked={theme === value}
                  aria-label={label}
                  title={label}
                  data-active={theme === value || undefined}
                  onClick={() => setTheme(value)}
                  className="
                    inline-flex items-center justify-center h-[22px] w-[22px] rounded-sm
                    text-muted-foreground transition-colors hover:text-foreground
                    data-[active]:bg-background data-[active]:text-primary data-[active]:shadow-sm
                  "
                >
                  <Icon className="h-3 w-3" aria-hidden="true" strokeWidth={1.4} />
                </button>
              ))}
            </div>
          </div>
          <div className="h-px my-1 bg-border" />
          <button
            type="button"
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[12.5px] text-foreground hover:bg-muted transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
            role="menuitem"
            onClick={() => signOut()}
            data-action="sign-out"
          >
            <LogOut aria-hidden="true" strokeWidth={1.4} />
            <span>Sign out</span>
          </button>
          <SidebarSectionLabel className="px-2.5 pt-2 pb-1 mt-1 border-t border-border">
            ax v0.3
          </SidebarSectionLabel>
        </div>
      )}
    </div>
  );
}
