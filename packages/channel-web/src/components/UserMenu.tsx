/**
 * UserMenu — popover at the bottom of the sidebar.
 *
 * Click the user row → opens a popover with: Account, Preferences,
 * role-gated Admin entries (Agents / MCP Servers / Teams), theme
 * tri-toggle (auto / light / dark, persisted to `localStorage['ax-theme']`),
 * and Sign out. Footer carries the AX logo.
 *
 * SECURITY NOTE — UI affordance only. Hiding the Admin entries from
 * non-admins is a UX nicety, not a security boundary. The real access
 * control sits on the server: every `/api/admin/*` endpoint checks
 * `role === 'admin'` regardless of menu visibility. Task 7's mock
 * middleware enforces this today, and Week 9.5's real backend will too.
 * If anyone files a "the menu still hides admin items but I'm an admin"
 * bug, that's a UI bug. If anyone files a "non-admin can hit `/api/admin/*`"
 * bug, that's a security bug — and the fix lives on the server, not here.
 */
import { useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut, Moon, Settings, Sun, UserRound } from 'lucide-react';
import { useUser } from '../lib/user-context';
import { signOut } from '../lib/auth';
import { useTheme, setTheme, type Theme } from '../lib/theme';

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
    <div className="user-row-wrap" ref={ref}>
      <button
        type="button"
        className="user-row"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-avatar" aria-hidden="true">
          {user.name[0]?.toUpperCase() ?? 'U'}
        </span>
        <span className="user-meta">
          <span className="user-name">{user.name}</span>
          <span className="user-email">{user.email}</span>
        </span>
        <svg className="user-caret" viewBox="0 0 10 10" aria-hidden="true">
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
          className="absolute bottom-full left-0 mb-1 w-64 bg-card border border-border rounded-md shadow-md p-1 z-50"
          role="menu"
        >
          {/* Header: avatar + name + email */}
          <div className="flex items-center gap-3 px-2 py-1.5 border-b border-border mb-1">
            <span
              className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-foreground font-semibold text-sm shrink-0"
              aria-hidden="true"
            >
              {user.name[0]?.toUpperCase() ?? 'U'}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-foreground truncate">{user.name}</div>
              <div className="text-[11px] text-muted-foreground truncate">{user.email}</div>
            </div>
          </div>
          {/*
            Account / Preferences are placeholders until the screens
            land. Disabled (rather than removed) so the menu shape is
            visible to designers without misleading users into thinking
            they go somewhere. Disabled buttons announce their state to
            screen readers and don't trap focus.
            TODO: wire when account/preferences screens land.
          */}
          <button
            type="button"
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-[13px] text-foreground opacity-50 cursor-not-allowed transition-colors"
            role="menuitem"
            data-action="account"
            disabled
            aria-disabled="true"
            title="Coming soon"
          >
            <UserRound className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Account &amp; billing</span>
          </button>
          <button
            type="button"
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-[13px] text-foreground opacity-50 cursor-not-allowed transition-colors"
            role="menuitem"
            data-action="settings"
            disabled
            aria-disabled="true"
            title="Coming soon"
          >
            <Settings className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Settings</span>
            <span className="ml-auto text-[10px] font-mono text-muted-foreground bg-muted border border-border rounded px-1 py-px">
              ⌘,
            </span>
          </button>
          <button
            type="button"
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-[13px] text-foreground hover:bg-muted transition-colors"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.();
            }}
            data-action="my-credentials"
          >
            <KeyRound className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>My credentials</span>
          </button>
          {isAdmin && (
            <>
              <div className="h-px my-1 bg-border" />
              <button
                type="button"
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-[13px] text-foreground hover:bg-muted transition-colors"
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
          <div className="flex items-center gap-2 px-2 py-1.5" data-action="theme">
            <Moon className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="text-[13px] text-foreground">Theme</span>
            <div className="ml-auto flex items-center gap-0.5" role="radiogroup" aria-label="Theme">
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
                  className="inline-flex items-center justify-center w-7 h-7 rounded-sm hover:bg-muted data-[active]:bg-muted data-[active]:text-primary text-muted-foreground transition-colors"
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <div className="h-px my-1 bg-border" />
          <button
            type="button"
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-[13px] text-foreground hover:bg-muted transition-colors"
            role="menuitem"
            onClick={() => signOut()}
            data-action="sign-out"
          >
            <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Sign out</span>
          </button>
          <div className="px-2 py-1 border-t border-border mt-1 text-[10.5px] text-muted-foreground">
            ax v0.3
          </div>
        </div>
      )}
    </div>
  );
}
