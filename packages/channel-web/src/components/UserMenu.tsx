/**
 * UserMenu — popover at the bottom of the sidebar.
 *
 * Click the user row → opens a popover with: Account, Preferences,
 * role-gated Admin entries (Agents / MCP Servers / Teams), theme
 * tri-toggle (auto / light / dark, persisted to `localStorage['tide-theme']`),
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
import { LogOut, Moon, Settings, Sun, UserRound } from 'lucide-react';
import { useUser } from '../lib/user-context';
import { signOut } from '../lib/auth';
import type { AdminView } from '../lib/admin';
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
  onOpenAdmin,
}: { onOpenAdmin?: ((view: AdminView) => void) | undefined } = {}) {
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
        <div className="user-menu" role="menu">
          <div className="user-menu-head">
            <span className="user-avatar lg" aria-hidden="true">
              {user.name[0]?.toUpperCase() ?? 'U'}
            </span>
            <div className="user-menu-meta">
              <div className="user-menu-name">{user.name}</div>
              <div className="user-menu-email">{user.email}</div>
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
            className="user-menu-item"
            role="menuitem"
            data-action="account"
            disabled
            aria-disabled="true"
            title="Coming soon"
          >
            <UserRound aria-hidden="true" />
            <span>Account &amp; billing</span>
          </button>
          <button
            type="button"
            className="user-menu-item"
            role="menuitem"
            data-action="settings"
            disabled
            aria-disabled="true"
            title="Coming soon"
          >
            <Settings aria-hidden="true" />
            <span>Settings</span>
            <span className="kbd">⌘,</span>
          </button>
          {isAdmin && (
            <>
              <div className="user-menu-divider" />
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onOpenAdmin?.('agents');
                }}
                data-action="admin-agents"
              >
                Admin · Agents
              </button>
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onOpenAdmin?.('mcp-servers');
                }}
                data-action="admin-mcp"
              >
                Admin · MCP Servers
              </button>
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onOpenAdmin?.('teams');
                }}
                data-action="admin-teams"
              >
                Admin · Teams
              </button>
            </>
          )}
          <div className="user-menu-divider" />
          <div className="user-menu-row" data-action="theme">
            <Moon aria-hidden="true" />
            <span className="user-menu-row-label">Theme</span>
            <div className="theme-seg" role="radiogroup" aria-label="Theme">
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
                >
                  <Icon aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <div className="user-menu-divider" />
          <button
            type="button"
            className="user-menu-item"
            role="menuitem"
            onClick={() => signOut()}
            data-action="sign-out"
          >
            <LogOut aria-hidden="true" />
            <span>Sign out</span>
          </button>
          <div className="user-menu-foot">
            <span>tide v0.3</span>
          </div>
        </div>
      )}
    </div>
  );
}
