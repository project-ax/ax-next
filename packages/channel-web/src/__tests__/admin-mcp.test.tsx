/**
 * Admin MCP servers form — Task 23.
 *
 * Mirrors the agents test (Task 22): navigate to MCP Servers tab → reveal
 * form → POST → re-fetch. Adds two cases that don't exist on the agents path:
 *
 *   - The Test button calls `/admin/mcp-servers/:id/test` and
 *     surfaces "ok" inline on success.
 *   - The same button surfaces an "error" badge on failure (HTTP 5xx
 *     or `{ ok: false, error }` body).
 *
 * The mock middleware always returns `{ ok: true }`, so the failure
 * test fakes a non-OK response directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminSettings } from '../components/admin/AdminSettings';

const fetchMock = vi.fn();

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default: stub all fetches with empty responses so ProviderKeysTab settles.
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonOk({ providers: [], agents: [], teams: [], servers: [] })),
  );
});

const sampleServer = {
  id: 'mcp-1',
  name: 'fs',
  url: 'stdio://fs',
  transport: 'stdio',
  created_at: 0,
  updated_at: 0,
};

describe('AdminSettings — MCP Servers tab', () => {
  it('lists mcp servers', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ servers: [sampleServer] }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP Servers/i }));
    await waitFor(() => expect(screen.getByText('fs')).toBeTruthy());
  });

  it('+ New MCP server reveals the form', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ servers: [] }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP Servers/i }));
    await waitFor(() => screen.getByText(/New MCP server/i));
    fireEvent.click(screen.getByText(/New MCP server/i));
    expect(screen.getByLabelText(/^name/i)).toBeTruthy();
    expect(screen.getByLabelText(/^url/i)).toBeTruthy();
    expect(screen.getByLabelText(/^transport/i)).toBeTruthy();
  });

  it('POST creates a new server', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ servers: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ id: 'mcp-x' }));
    fetchMock.mockResolvedValueOnce(jsonOk({ servers: [] }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP Servers/i }));
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
          url === '/admin/mcp-servers' &&
          (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
    });
  });

  it('Test button surfaces success', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ servers: [sampleServer] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP Servers/i }));
    await waitFor(() => screen.getByText('fs'));
    fireEvent.click(screen.getByText(/Test/i));
    await waitFor(() => {
      expect(screen.getByText(/^ok$/i)).toBeTruthy();
    });
  });

  it('Test button surfaces failure', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ servers: [sampleServer] }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP Servers/i }));
    await waitFor(() => screen.getByText('fs'));
    fireEvent.click(screen.getByText(/Test/i));
    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeTruthy();
    });
  });

  it('Test button surfaces error if fetch throws (defensive try/catch)', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ servers: [sampleServer] }));
    // Network failure — the helper today catches this internally, but
    // this test guards against a future refactor that lets a throw
    // escape `testMcpServer`. The badge must move out of "testing…".
    fetchMock.mockRejectedValueOnce(new Error('network'));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP Servers/i }));
    await waitFor(() => screen.getByText('fs'));
    fireEvent.click(screen.getByText(/Test/i));
    await waitFor(() => {
      // Whatever path we took (current helper or future bypass), the
      // badge must end on `error`, not stuck on `testing…`.
      expect(screen.getByText(/error/i)).toBeTruthy();
      expect(screen.queryByText(/testing/i)).toBeNull();
    });
  });
});
