/**
 * AdminSettings — main in-place settings shell tests.
 *
 * Pinned behaviors:
 *   1. Default tab is 'provider-keys' (ProviderKeysTab rendered, not AgentForm).
 *   2. Clicking "Model Config" tab shows ModelConfigTab.
 *   3. Clicking "← Back to chat" calls onClose.
 *   4. Clicking "Agents" tab shows AgentForm content.
 *
 * ProviderKeysTab and ModelConfigTab make fetch calls on mount — we stub
 * fetch so those effects resolve without error rather than leaking unhandled
 * promise rejections.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminSettings } from '../components/admin/AdminSettings';

const fetchMock = vi.fn();

function emptyProviders(): Response {
  return new Response(JSON.stringify({ providers: [], agents: [], teams: [], servers: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default stub: return a fresh Response on each call so the body is never
  // "already read" — Response.json() can only be consumed once per instance.
  fetchMock.mockImplementation(() => Promise.resolve(emptyProviders()));
});

describe('AdminSettings', () => {
  it('default tab is provider-keys — ProviderKeysTab is rendered, not AgentForm', async () => {
    render(<AdminSettings onClose={() => {}} />);
    // The provider-keys tab button should be selected.
    const tab = screen.getByRole('tab', { name: /Provider Keys/i });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    // Canary banner is present and visible.
    expect(screen.getByText(/canary scanner isn't wired in yet/i)).toBeTruthy();
    expect(screen.getByText(/no automated secret-leak veto/i)).toBeTruthy();
    // Wait for ProviderKeysTab to settle (it fetches on mount).
    await waitFor(() => {
      // AgentForm renders a "+ New agent" button — it must NOT be present.
      expect(screen.queryByText(/New agent/i)).toBeNull();
    });
  });

  it('clicking "Model Config" tab shows ModelConfigTab', async () => {
    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /Model Config/i }));
    // ModelConfigTab renders a save button.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save changes/i })).toBeTruthy();
    });
  });

  it('clicking "← Back to chat" calls onClose', () => {
    const onClose = vi.fn();
    render(<AdminSettings onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Back to chat/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking "Agents" tab shows AgentForm content', async () => {
    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Agents$/i }));
    // AgentForm renders a "+ New agent" button in list view.
    await waitFor(() => {
      expect(screen.getByText(/New agent/i)).toBeTruthy();
    });
  });

  it('all five tabs are present in the nav', () => {
    render(<AdminSettings onClose={() => {}} />);
    expect(screen.getByRole('tab', { name: /Provider Keys/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Model Config/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Agents$/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /MCP Servers/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Teams/i })).toBeTruthy();
  });
});
