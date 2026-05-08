/**
 * AdminShell — main in-place settings shell tests.
 *
 * Pinned behaviors:
 *   1. Default tab is 'provider-keys' (ProviderKeysTab rendered, not AgentForm).
 *   2. Clicking "Model Config" nav item shows ModelConfigTab.
 *   3. Clicking "← chat" calls onClose.
 *   4. Clicking "Agents" nav item shows AgentForm content.
 *
 * ProviderKeysTab and ModelConfigTab make fetch calls on mount — we stub
 * fetch so those effects resolve without error rather than leaking unhandled
 * promise rejections.
 *
 * AdminSidebar requires a UserProvider (it calls useUser() and returns null
 * when no provider is mounted). We wrap every render in a UserProvider.
 *
 * NOTE: The canary banner was previously rendered in the old AdminSettings
 * body. That component was deleted in Task 1.4. The banner will be relocated
 * into ProviderKeysTab in Task 2.3. Until then, the canary banner tests are
 * skipped — see TODO(Task 2.3).
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

function emptyProviders(): Response {
  return new Response(JSON.stringify({ providers: [], agents: [], teams: [], servers: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderShell(onClose: () => void = () => {}) {
  return render(
    <UserProvider value={mockUser}>
      <AdminShell onClose={onClose} />
    </UserProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default stub: return a fresh Response on each call so the body is never
  // "already read" — Response.json() can only be consumed once per instance.
  fetchMock.mockImplementation(() => Promise.resolve(emptyProviders()));
});

describe('AdminShell', () => {
  it('default tab is provider-keys — ProviderKeysTab is rendered, not AgentForm', async () => {
    renderShell();
    // The "Provider keys" nav button should be present and active (data-active attr).
    const providerKeysBtn = screen.getByRole('button', { name: /provider keys/i });
    expect(providerKeysBtn).toBeTruthy();
    expect(providerKeysBtn.getAttribute('data-active')).toBe('true');
    // Wait for ProviderKeysTab to settle (it fetches on mount).
    await waitFor(() => {
      // AgentForm renders a "+ New agent" button — it must NOT be present.
      expect(screen.queryByText(/New agent/i)).toBeNull();
    });
  });

  // TODO(Task 2.3): Re-enable when CanaryAdvisory moves into ProviderKeysTab.
  // The canary banner was in the deleted AdminSettings body and is not yet
  // rendered by AdminShell or ProviderKeysTab. Re-enable + update selector
  // in Task 2.3 when the banner is relocated.
  it.skip('canary banner is present on default tab', async () => {
    renderShell();
    expect(screen.getByText(/canary scanner isn't wired in yet/i)).toBeTruthy();
    expect(screen.getByText(/no automated secret-leak veto/i)).toBeTruthy();
  });

  it('clicking "Model Config" nav item shows ModelConfigTab', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /model config/i }));
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

  it('all five nav items are present in the sidebar', () => {
    renderShell();
    expect(screen.getByRole('button', { name: /provider keys/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /model config/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^agents$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /mcp servers/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^teams$/i })).toBeTruthy();
  });
});
