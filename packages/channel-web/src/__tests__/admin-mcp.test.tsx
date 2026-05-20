/**
 * Admin MCP servers form — Task 23 / Task 12.
 *
 * Mirrors the agents test (Task 22): render McpServerForm directly →
 * reveal form → POST → re-fetch. Adds two cases that don't exist on the
 * agents path:
 *
 *   - The Test button calls `/admin/mcp-servers/:id/test` and
 *     surfaces "ok" inline on success.
 *   - The same button surfaces an "error" badge on failure (HTTP 5xx
 *     or `{ ok: false, error }` body).
 *
 * Task 12 replaces the old `credentials_id` field with per-env/per-header
 * CredentialSlotRow lists. The form now accepts an optional `initialConfig`
 * prop for testability — when provided it skips the list view and opens
 * the form directly in "edit" mode.
 *
 * The mock middleware always returns `{ ok: true }`, so the failure
 * test fakes a non-OK response directly.
 *
 * Strategy: render McpServerForm directly (no shell wrapper). The
 * AdminSettings shell was deleted in Task 1.4 and replaced by AdminShell;
 * the tab content components are unchanged and can be tested in isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { McpServerForm } from '../components/admin/McpServerForm';
import type { McpServerConfig } from '../../mock/admin/mcp-servers';

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
  // Default: stub all fetches with empty responses, including credential list
  // queries that CredentialSlotRow fires on mount.
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonOk({ providers: [], agents: [], teams: [], servers: [], credentials: [] })),
  );
});

const sampleServer = {
  id: 'mcp-1',
  name: 'fs',
  url: 'stdio://fs',
  transport: 'stdio' as const,
  created_at: 0,
  updated_at: 0,
};

describe('AdminSettings — MCP Servers tab', () => {
  it('lists mcp servers', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonOk({ servers: [sampleServer], credentials: [] })),
    );

    render(<McpServerForm />);
    await waitFor(() => expect(screen.getByText('fs')).toBeTruthy());
  });

  it('+ New MCP server reveals the form', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonOk({ servers: [], credentials: [] })),
    );

    render(<McpServerForm />);
    await waitFor(() => screen.getByText(/New MCP server/i));
    fireEvent.click(screen.getByText(/New MCP server/i));
    expect(screen.getByLabelText(/^name/i)).toBeTruthy();
    expect(screen.getByLabelText(/^transport/i)).toBeTruthy();
  });

  it('POST creates a new server', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonOk({ servers: [], credentials: [], id: 'mcp-x' })),
    );

    render(<McpServerForm />);
    await waitFor(() => screen.getByText(/New MCP server/i));
    fireEvent.click(screen.getByText(/New MCP server/i));
    fireEvent.change(screen.getByLabelText(/^name/i), {
      target: { value: 'fs' },
    });
    fireEvent.change(screen.getByLabelText(/^command/i), {
      target: { value: 'mcp-fs' },
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
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/test')) return Promise.resolve(jsonOk({ ok: true }));
      return Promise.resolve(jsonOk({ servers: [sampleServer], credentials: [] }));
    });

    render(<McpServerForm />);
    await waitFor(() => screen.getByText('fs'));
    fireEvent.click(screen.getByText(/Test/i));
    await waitFor(() => {
      expect(screen.getByText(/^ok$/i)).toBeTruthy();
    });
  });

  it('Test button surfaces failure', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/test'))
        return Promise.resolve(new Response(null, { status: 500 }));
      return Promise.resolve(jsonOk({ servers: [sampleServer], credentials: [] }));
    });

    render(<McpServerForm />);
    await waitFor(() => screen.getByText('fs'));
    fireEvent.click(screen.getByText(/Test/i));
    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeTruthy();
    });
  });

  it('Test button surfaces error if fetch throws (defensive try/catch)', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/test')) return Promise.reject(new Error('network'));
      return Promise.resolve(jsonOk({ servers: [sampleServer], credentials: [] }));
    });

    render(<McpServerForm />);
    await waitFor(() => screen.getByText('fs'));
    fireEvent.click(screen.getByText(/Test/i));
    await waitFor(() => {
      // Whatever path we took (current helper or future bypass), the
      // badge must end on `error`, not stuck on `testing…`.
      expect(screen.getByText(/error/i)).toBeTruthy();
      expect(screen.queryByText(/testing/i)).toBeNull();
    });
  });

  it('renders one CredentialSlotRow per declared env var (stdio)', async () => {
    const config: McpServerConfig = {
      id: 'github',
      enabled: true,
      transport: 'stdio',
      command: 'mcp-github',
      args: [],
      env: { GH_TOKEN: '', GH_HOST: 'api.github.com' },
      ownerId: null,
    };
    render(<McpServerForm initialConfig={config} />);
    expect(await screen.findByText('GH_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('GH_HOST')).toBeInTheDocument();
  });

  it('renders one CredentialSlotRow per declared header (http transports)', async () => {
    const config: McpServerConfig = {
      id: 'gh-http',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://example.com',
      headerCredentialRefs: { Authorization: '', 'X-Trace': '' },
      ownerId: null,
    };
    render(<McpServerForm initialConfig={config} />);
    expect(await screen.findByText('Authorization')).toBeInTheDocument();
    expect(screen.getByText('X-Trace')).toBeInTheDocument();
  });
});
