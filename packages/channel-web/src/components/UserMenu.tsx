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
import { useUser } from '../lib/user-context';
import { signOut } from '../lib/auth';
import type { AdminView } from '../lib/admin';
import { useTheme, setTheme } from '../lib/theme';

const THEMES = ['auto', 'light', 'dark'] as const;

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
        </span>
        <span className="user-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="user-menu" role="menu">
          <div className="user-menu-head">
            <div className="user-menu-name">{user.name}</div>
            <div className="user-menu-email">{user.email}</div>
          </div>
          <button
            type="button"
            className="user-menu-item"
            role="menuitem"
            data-action="account"
          >
            Account
          </button>
          <button
            type="button"
            className="user-menu-item"
            role="menuitem"
            data-action="preferences"
          >
            Preferences
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
            <span className="user-menu-row-label">Theme</span>
            <div className="theme-seg" role="radiogroup" aria-label="Theme">
              {THEMES.map((value) => (
                <button
                  key={value}
                  type="button"
                  data-value={value}
                  role="radio"
                  aria-checked={theme === value}
                  data-active={theme === value || undefined}
                  onClick={() => setTheme(value)}
                >
                  {value}
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
            Sign out
          </button>
          <div className="user-menu-foot">
            <img src="/ax-logo.svg" alt="ax" className="user-menu-logo" />
          </div>
        </div>
      )}
    </div>
  );
}
