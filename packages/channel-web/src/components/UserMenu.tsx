/**
 * UserMenu — popover at the bottom of the sidebar.
 *
 * Click the user row → opens a popover with: Account, Settings, My
 * credentials, role-gated Admin Settings, theme tri-toggle, Sign out.
 *
 * SECURITY NOTE — UI affordance only. Hiding the Admin entries from
 * non-admins is a UX nicety, not a security boundary. The real access
 * control sits on the server: every `/api/admin/*` endpoint checks
 * `role === 'admin'` regardless of menu visibility.
 */
import { useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut, Moon, Settings, Sun, UserRound } from 'lucide-react';
import { useUser } from '../lib/user-context';
import { signOut } from '../lib/auth';
import { useTheme, setTheme, type Theme } from '../lib/theme';
import { SidebarSectionLabel } from './SidebarSectionLabel';

interface ThemeOption {
  value: Theme;
  label: string;
  Icon: typeof Sun;
}
const THEME_OPTIONS: ThemeOption[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function UserMenu({
  onOpenAdminSettings,
  onOpenSettings,
}: {
  onOpenAdminSettings?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
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
  const isAdmin = user.role === 'admin';

  return (
    <div className="user-row-wrap relative border-t border-border p-2" ref={ref}>
      <button
        type="button"
        // Keep `user-row` as a structural test hook — no CSS targets it.
        className="
          user-row group flex items-center gap-2.5 cursor-pointer w-[calc(100%-16px)]
          px-2 py-[7px] rounded-lg transition-colors
          hover:bg-muted aria-expanded:bg-muted
          [body.sidebar-collapsed_&]:justify-center [body.sidebar-collapsed_&]:px-[7px]
        "
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden="true"
          className="
            user-avatar inline-flex items-center justify-center shrink-0
            h-[26px] w-[26px] rounded-full border border-border
            text-[11px] tracking-[0.04em] text-foreground
          "
          style={{
            background:
              'linear-gradient(135deg, color-mix(in srgb, hsl(var(--primary)) 26%, hsl(var(--muted))), hsl(var(--muted)))',
          }}
        >
          {user.name[0]?.toUpperCase() ?? 'U'}
        </span>
        <span className="flex flex-col gap-px min-w-0 flex-1 [body.sidebar-collapsed_&]:hidden">
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
            <span
              aria-hidden="true"
              className="
                inline-flex items-center justify-center shrink-0
                h-9 w-9 rounded-full border border-border bg-muted
                text-foreground font-semibold text-sm
              "
            >
              {user.name[0]?.toUpperCase() ?? 'U'}
            </span>
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
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[12.5px] text-muted-foreground opacity-50 cursor-not-allowed transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
            role="menuitem"
            data-action="account"
            disabled
            aria-disabled="true"
            title="Coming soon"
          >
            <UserRound aria-hidden="true" strokeWidth={1.4} />
            <span>Account &amp; billing</span>
          </button>
          <button
            type="button"
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[12.5px] text-muted-foreground opacity-50 cursor-not-allowed transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
            role="menuitem"
            data-action="settings"
            disabled
            aria-disabled="true"
            title="Coming soon"
          >
            <Settings aria-hidden="true" strokeWidth={1.4} />
            <span>Settings</span>
            <span className="ml-auto text-[10px] font-mono text-ink-ghost tracking-[0.02em]">
              ⌘,
            </span>
          </button>
          <button
            type="button"
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[12.5px] text-foreground hover:bg-muted transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.();
            }}
            data-action="my-credentials"
          >
            <KeyRound aria-hidden="true" strokeWidth={1.4} />
            <span>My credentials</span>
          </button>
          {isAdmin && (
            <>
              <div className="h-px my-1 bg-border" />
              <button
                type="button"
                className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[12.5px] text-foreground hover:bg-muted transition-colors"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onOpenAdminSettings?.();
                }}
                data-action="admin-settings"
              >
                Admin Settings
              </button>
            </>
          )}
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
