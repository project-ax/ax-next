/**
 * Admin MCP servers form — Task 23.
 *
 * Mirrors the agents test (Task 22): list → reveal form → POST →
 * re-fetch. Adds two cases that don't exist on the agents path:
 *
 *   - The Test button calls `/api/admin/mcp-servers/:id/test` and
 *     surfaces "ok" inline on success.
 *   - The same button surfaces an "error" badge on failure (HTTP 5xx
 *     or `{ ok: false, error }` body).
 *
 * The mock middleware always returns `{ ok: true }`, so the failure
 * test fakes a non-OK response directly.
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

describe('AdminPanel — MCP servers', () => {
  it('lists mcp servers', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          {
            id: 'mcp-1',
            name: 'fs',
            url: 'stdio://fs',
            transport: 'stdio',
            created_at: 0,
            updated_at: 0,
          },
        ],
      }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="mcp-servers" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => expect(screen.getByText('fs')).toBeTruthy());
  });

  it('+ New MCP server reveals the form', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ servers: [] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="mcp-servers" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText(/New MCP server/i));
    fireEvent.click(screen.getByText(/New MCP server/i));
    expect(screen.getByLabelText(/^name/i)).toBeTruthy();
    expect(screen.getByLabelText(/^url/i)).toBeTruthy();
    expect(screen.getByLabelText(/^transport/i)).toBeTruthy();
  });

  it('POST creates a new server', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ servers: [] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'mcp-x' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ servers: [] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="mcp-servers" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText(/New MCP server/i));
    fireEvent.click(screen.getByText(/New MCP server/i));
    fireEvent.change(screen.getByLabelText(/^name/i), {
      target: { value: 'fs' },
    });
    fireEvent.change(screen.getByLabelText(/^url/i), {
      target: { value: 'stdio://fs' },
    });
    fireEvent.click(screen.getByText(/Save/i));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, opts]) =>
          url === '/api/admin/mcp-servers' &&
          (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
    });
  });

  it('Test button surfaces success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          {
            id: 'mcp-1',
            name: 'fs',
            url: 'stdio://fs',
            transport: 'stdio',
            created_at: 0,
            updated_at: 0,
          },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="mcp-servers" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText('fs'));
    fireEvent.click(screen.getByText(/Test/i));
    await waitFor(() => {
      expect(screen.getByText(/^ok$/i)).toBeTruthy();
    });
  });

  it('Test button surfaces failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          {
            id: 'mcp-1',
            name: 'fs',
            url: 'stdio://fs',
            transport: 'stdio',
            created_at: 0,
            updated_at: 0,
          },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="mcp-servers" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText('fs'));
    fireEvent.click(screen.getByText(/Test/i));
    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeTruthy();
    });
  });
});
