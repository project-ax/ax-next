/**
 * AdminShell — main in-place settings shell tests.
 *
 * Pinned behaviors:
 *   1. Default tab is 'providers' (ProvidersPanel rendered, not AgentForm).
 *   2. Clicking "Default AI model" nav item shows ModelConfigTab.
 *   3. Clicking "← chat" calls onClose.
 *   4. Clicking "Agents" nav item shows AgentForm content.
 *
 * ProvidersPanel and ModelConfigTab make fetch calls on mount — we stub
 * fetch so those effects resolve without error rather than leaking unhandled
 * promise rejections.
 *
 * AdminSidebar requires a UserProvider (it calls useUser() and returns null
 * when no provider is mounted). We wrap every render in a UserProvider.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminShell } from '../components/admin/AdminShell';
import { UserProvider } from '../lib/user-context';
import type { AuthUser } from '../lib/auth';

const fetchMock = vi.fn();

const mockUser: AuthUser = {
  id: 'usr-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin',
};

function emptyResponse(url: string): Response {
  // ProvidersPanel (default tab) calls adminCredentials.list() which hits
  // /admin/credentials (no trailing path) and expects { credentials: [] }.
  // ModelConfigTab calls listProviders() → /admin/credentials/providers → { providers: [] }.
  if (/\/admin\/credentials(\?|$)/.test(url) || /\/settings\/credentials(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ credentials: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  // SkillsTab (the default tab) lists the user's skills via /settings/skills
  // + /settings/skills/authored on mount. Empty lists keep the nav assertions
  // hermetic.
  if (/\/settings\/skills\/authored(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (/\/settings\/skills(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (/\/api\/chat\/agents(\?|$)/.test(url)) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ providers: [], agents: [], teams: [], connectors: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderShell(onClose: () => void = () => {}) {
  return render(
    <UserProvider value={mockUser}>
      <AdminShell isAdmin onClose={onClose} />
    </UserProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default stub: return a fresh Response on each call so the body is never
  // "already read" — Response.json() can only be consumed once per instance.
  fetchMock.mockImplementation((input: RequestInfo | URL) =>
    Promise.resolve(emptyResponse(String(input))),
  );
});

describe('AdminShell', () => {
  it('default tab is Skills — AgentForm is NOT rendered', async () => {
    renderShell();
    // Skills is the default active tab for every user (admins included).
    const skillsBtn = screen.getByRole('button', { name: /^skills$/i });
    expect(skillsBtn).toBeTruthy();
    expect(skillsBtn.getAttribute('data-active')).toBe('true');
    // AgentForm ("+ New agent") must NOT be present on the default tab.
    await waitFor(() => {
      expect(screen.queryByText(/New agent/i)).toBeNull();
    });
  });

  it('admin can navigate to AI model keys (ProvidersPanel)', async () => {
    renderShell();
    const providersBtn = screen.getByRole('button', { name: /^AI model keys$/i });
    fireEvent.click(providersBtn);
    expect(providersBtn.getAttribute('data-active')).toBe('true');
    await waitFor(() => {
      expect(screen.queryByText(/New agent/i)).toBeNull();
    });
  });

  it('clicking "Default AI model" nav item shows ModelConfigTab', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /default ai model/i }));
    // ModelConfigTab renders a save button.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save changes/i })).toBeTruthy();
    });
  });

  it('clicking back-to-chat button calls onClose', () => {
    const onClose = vi.fn();
    renderShell(onClose);
    // The back button in AdminSidebar renders as a button with text "chat"
    // (and a ChevronLeft icon). The accessible name is "chat".
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking "Agents" nav item shows AgentForm content', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /^agents$/i }));
    // AgentForm renders a "+ New agent" button in list view.
    await waitFor(() => {
      expect(screen.getByText(/New agent/i)).toBeTruthy();
    });
  });

  it('the admin nav items are present in the sidebar', () => {
    renderShell();
    expect(screen.getByRole('button', { name: /^AI model keys$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Default AI model$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^agents$/i })).toBeTruthy();
    // The admin connector registry is now labelled "Connector catalog" to
    // disambiguate from the user "Connectors" Settings tab.
    expect(screen.getByRole('button', { name: /^connector catalog$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^teams$/i })).toBeTruthy();
  });
});
