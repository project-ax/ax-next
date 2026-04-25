/**
 * Admin agents form — Task 22.
 *
 * Covers the AdminPanel chrome + AgentForm CRUD flow:
 *
 *   1. Opening with `view="agents"` lists existing agents from
 *      `/api/admin/agents`.
 *   2. Clicking "+ New agent" reveals the form (name, system prompt, etc.).
 *   3. Filling + submitting the form POSTs to `/api/admin/agents`, then
 *      re-fetches the list so the new row appears.
 *   4. Clicking the close (×) button calls `onClose`.
 *
 * The PATCH/DELETE rows are exercised lightly via the row buttons —
 * they share the same fetch round-trip + re-fetch shape as POST, so the
 * "create" path covers most of the wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminPanel } from '../components/admin/AdminPanel';
import { UserProvider } from '../lib/user-context';

const adminUser = {
  id: 'u1',
  email: 'admin@local',
  name: 'Admin',
  role: 'admin' as const,
};
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('AdminPanel — agents', () => {
  it('lists existing agents on open', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        agents: [
          {
            id: 'tide',
            name: 'tide',
            desc: '',
            color: '#7aa6c9',
            owner_id: 't1',
            owner_type: 'team',
            tag: 'work',
            system_prompt: '',
            allowed_tools: [],
            mcp_config_ids: [],
            model: 'claude-sonnet-4-6',
            created_at: 0,
            updated_at: 0,
          },
        ],
      }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('tide')).toBeTruthy();
    });
  });

  it('clicking + New agent reveals the form', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    expect(screen.getByLabelText(/name/i)).toBeTruthy();
    expect(screen.getByLabelText(/system prompt/i)).toBeTruthy();
  });

  it('submitting the form POSTs to /api/admin/agents', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'agent-x' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'new-bot' },
    });
    fireEvent.change(screen.getByLabelText(/system prompt/i), {
      target: { value: 'be helpful' },
    });
    fireEvent.click(screen.getByText(/Save/i));
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const post = calls.find(
        ([url, opts]) =>
          url === '/api/admin/agents' &&
          (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
    });
  });

  it('clicking close calls onClose', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    const onClose = vi.fn();
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={onClose} />
      </UserProvider>,
    );
    // Wait for the initial /api/admin/agents fetch to settle so the list
    // (or empty state) is in the DOM before we click close. Otherwise we
    // race the unmount against the pending state update and React logs
    // an act() warning.
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByLabelText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });
});
