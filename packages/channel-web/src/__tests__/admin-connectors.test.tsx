/**
 * Admin connector registry — TASK-98.
 *
 * Replaces admin-mcp.test.tsx. The standalone MCP-server form collapsed into
 * the connector registry (invariant #4 — one source of truth). An MCP-backed
 * connector is just a connector whose `capabilities.mcpServers` is non-empty;
 * the backing mechanism (transport / command / url) lives only behind an
 * "Advanced" disclosure.
 *
 * Strategy: render ConnectorRegistry directly (no shell wrapper). Mock
 * `globalThis.fetch` to stand in for the `/admin/connectors` routes.
 *
 *   1. Lists connectors from `/admin/connectors` (default view: service name).
 *   2. "New connector" reveals the form (service name + whose-key + sharing).
 *   3. Mechanism fields (transport/command/url) are HIDDEN by default and
 *      revealed only by the "Advanced" affordance.
 *   4. Create POSTs to `/admin/connectors` with the connector shape + CSRF
 *      header; an MCP server entered under Advanced lands in capabilities.
 *   5. Edit PATCHes `/admin/connectors/:id`.
 *   6. Delete sends DELETE with the CSRF header.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectorRegistry } from '../components/admin/ConnectorRegistry';

const fetchMock = vi.fn();

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sampleConnector = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Files',
  usageNote: '',
  keyMode: 'personal' as const,
  visibility: 'private' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const fullConnector = (over: Partial<Record<string, unknown>> = {}) => ({
  ...sampleConnector(over),
  defaultAttached: false,
  capabilities: {
    allowedHosts: ['drive.googleapis.com'],
    credentials: [{ slot: 'gdrive', kind: 'api-key' }],
    mcpServers: [
      {
        name: 'gdrive',
        transport: 'http',
        url: 'https://mcp.example.com/gdrive',
        allowedHosts: [],
        credentials: [],
      },
    ],
    packages: { npm: [], pypi: [] },
  },
  ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(() => Promise.resolve(jsonOk({ connectors: [] })));
});

describe('Admin — Connectors registry', () => {
  it('lists connectors', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonOk({ connectors: [sampleConnector()] })),
    );
    render(<ConnectorRegistry />);
    await waitFor(() => expect(screen.getByText('Google Drive')).toBeTruthy());
    // Default view shows connected state, not the mechanism.
    expect(screen.getByText(/^connected$/i)).toBeTruthy();
    expect(screen.queryByText(/transport/i)).toBeNull();
  });

  it('New connector reveals the form with name + whose-key + sharing', async () => {
    render(<ConnectorRegistry />);
    await waitFor(() => screen.getByText(/New connector/i));
    fireEvent.click(screen.getByText(/New connector/i));
    expect(screen.getByLabelText(/service name/i)).toBeTruthy();
    expect(screen.getByLabelText(/whose key/i)).toBeTruthy();
    expect(screen.getByLabelText(/sharing/i)).toBeTruthy();
  });

  it('mechanism fields are hidden until Advanced is expanded', async () => {
    render(<ConnectorRegistry />);
    await waitFor(() => screen.getByText(/New connector/i));
    fireEvent.click(screen.getByText(/New connector/i));
    // Mechanism (transport/command) hidden by default.
    expect(screen.queryByLabelText(/transport/i)).toBeNull();
    expect(screen.queryByLabelText(/command/i)).toBeNull();
    // Expand Advanced → mechanism appears.
    fireEvent.click(screen.getByText(/Advanced/i));
    expect(await screen.findByLabelText(/transport/i)).toBeTruthy();
    expect(screen.getByLabelText(/command/i)).toBeTruthy();
  });

  it('Save POSTs a connector to /admin/connectors with CSRF + capabilities', async () => {
    let posted: { url: unknown; opts: RequestInit } | null = null;
    fetchMock.mockImplementation((url: RequestInfo | URL, opts?: RequestInit) => {
      if (url === '/admin/connectors' && opts?.method === 'POST') {
        posted = { url, opts };
        return Promise.resolve(jsonOk({ connector: fullConnector(), created: true }, 201));
      }
      return Promise.resolve(jsonOk({ connectors: [] }));
    });

    render(<ConnectorRegistry />);
    await waitFor(() => screen.getByText(/New connector/i));
    fireEvent.click(screen.getByText(/New connector/i));
    fireEvent.change(screen.getByLabelText(/service name/i), {
      target: { value: 'Google Drive' },
    });
    // Enter mechanism under Advanced.
    fireEvent.click(screen.getByText(/Advanced/i));
    fireEvent.change(await screen.findByLabelText(/command/i), {
      target: { value: 'mcp-gdrive' },
    });
    fireEvent.change(screen.getByLabelText(/allowed hosts/i), {
      target: { value: 'drive.googleapis.com' },
    });
    fireEvent.click(screen.getByText(/^Save$/i));

    await waitFor(() => {
      expect(posted).toBeTruthy();
    });
    const opts = posted!.opts;
    const body = JSON.parse(String(opts.body));
    expect(body.name).toBe('Google Drive');
    expect(body.connectorId).toBe('google-drive');
    expect(body.capabilities.mcpServers).toHaveLength(1);
    expect(body.capabilities.mcpServers[0].command).toBe('mcp-gdrive');
    expect(body.capabilities.allowedHosts).toEqual(['drive.googleapis.com']);
    const headers = opts.headers as Record<string, string>;
    expect(headers['x-requested-with']).toBe('ax-admin');
  });

  it('edit PATCHes /admin/connectors/:id', async () => {
    let patched: RequestInit | null = null;
    fetchMock.mockImplementation((url: RequestInfo | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u === '/admin/connectors' && (!opts || opts.method === undefined)) {
        return Promise.resolve(jsonOk({ connectors: [sampleConnector()] }));
      }
      if (u === '/admin/connectors/gdrive' && (!opts || opts.method === undefined)) {
        return Promise.resolve(jsonOk({ connector: fullConnector() }));
      }
      if (u === '/admin/connectors/gdrive' && opts?.method === 'PATCH') {
        patched = opts;
        return Promise.resolve(jsonOk({ connector: fullConnector(), created: false }));
      }
      return Promise.resolve(jsonOk({ connectors: [sampleConnector()] }));
    });

    render(<ConnectorRegistry />);
    await waitFor(() => screen.getByText('Google Drive'));
    fireEvent.click(screen.getByText(/^edit$/i));
    // The form opens populated; rename + save.
    const nameInput = await screen.findByLabelText(/service name/i);
    expect((nameInput as HTMLInputElement).value).toBe('Google Drive');
    fireEvent.change(nameInput, { target: { value: 'Drive (renamed)' } });
    fireEvent.click(screen.getByText(/^Save$/i));

    await waitFor(() => expect(patched).toBeTruthy());
    const body = JSON.parse(String(patched!.body));
    expect(body.name).toBe('Drive (renamed)');
    // Mechanism preserved through the edit (loaded from the full connector).
    expect(body.capabilities.mcpServers).toHaveLength(1);
  });

  it('editing a CLI/package-backed connector preserves its packages on save (regression)', async () => {
    // A Salesforce-shaped connector: zero mcpServers, npm package backing. The
    // form doesn't surface `packages`, so a naive rebuild would WIPE it.
    const cliConnector = {
      ...sampleConnector({ id: 'sf', name: 'Salesforce' }),
      defaultAttached: false,
      capabilities: {
        allowedHosts: ['login.salesforce.com'],
        credentials: [{ slot: 'sf', kind: 'api-key' }],
        mcpServers: [],
        packages: { npm: ['@salesforce/cli'], pypi: [] },
      },
    };
    let patched: RequestInit | null = null;
    fetchMock.mockImplementation((url: RequestInfo | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u === '/admin/connectors' && (!opts || opts.method === undefined)) {
        return Promise.resolve(
          jsonOk({ connectors: [sampleConnector({ id: 'sf', name: 'Salesforce' })] }),
        );
      }
      if (u === '/admin/connectors/sf' && (!opts || opts.method === undefined)) {
        return Promise.resolve(jsonOk({ connector: cliConnector }));
      }
      if (u === '/admin/connectors/sf' && opts?.method === 'PATCH') {
        patched = opts;
        return Promise.resolve(jsonOk({ connector: cliConnector, created: false }));
      }
      return Promise.resolve(jsonOk({ connectors: [] }));
    });

    render(<ConnectorRegistry />);
    await waitFor(() => screen.getByText('Salesforce'));
    fireEvent.click(screen.getByText(/^edit$/i));
    const nameInput = await screen.findByLabelText(/service name/i);
    fireEvent.change(nameInput, { target: { value: 'Salesforce CRM' } });
    fireEvent.click(screen.getByText(/^Save$/i));

    await waitFor(() => expect(patched).toBeTruthy());
    const body = JSON.parse(String(patched!.body));
    expect(body.name).toBe('Salesforce CRM');
    // The un-surfaced npm package backing survives the edit.
    expect(body.capabilities.packages.npm).toEqual(['@salesforce/cli']);
    expect(body.capabilities.mcpServers).toHaveLength(0);
  });

  it('admin can flag a new connector default-on (POST carries defaultAttached:true)', async () => {
    let posted: RequestInit | null = null;
    fetchMock.mockImplementation((url: RequestInfo | URL, opts?: RequestInit) => {
      if (url === '/admin/connectors' && opts?.method === 'POST') {
        posted = opts;
        return Promise.resolve(
          jsonOk({ connector: fullConnector({ defaultAttached: true }), created: true }, 201),
        );
      }
      return Promise.resolve(jsonOk({ connectors: [] }));
    });

    render(<ConnectorRegistry />);
    await waitFor(() => screen.getByText(/New connector/i));
    fireEvent.click(screen.getByText(/New connector/i));
    fireEvent.change(screen.getByLabelText(/service name/i), {
      target: { value: 'Company Salesforce' },
    });
    // Flag default-on (the connector half of the admin Catalog).
    fireEvent.click(screen.getByLabelText(/default-on for all agents/i));
    fireEvent.click(screen.getByText(/^Save$/i));

    await waitFor(() => expect(posted).toBeTruthy());
    const body = JSON.parse(String(posted!.body));
    expect(body.defaultAttached).toBe(true);
  });

  it('editing a default-on connector pre-checks the default toggle', async () => {
    fetchMock.mockImplementation((url: RequestInfo | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u === '/admin/connectors' && (!opts || opts.method === undefined)) {
        return Promise.resolve(jsonOk({ connectors: [sampleConnector()] }));
      }
      if (u === '/admin/connectors/gdrive' && (!opts || opts.method === undefined)) {
        return Promise.resolve(jsonOk({ connector: fullConnector({ defaultAttached: true }) }));
      }
      return Promise.resolve(jsonOk({ connectors: [sampleConnector()] }));
    });

    render(<ConnectorRegistry />);
    await waitFor(() => screen.getByText('Google Drive'));
    fireEvent.click(screen.getByText(/^edit$/i));
    const toggle = await screen.findByLabelText(/default-on for all agents/i);
    await waitFor(() =>
      expect(toggle.getAttribute('data-state') ?? toggle.getAttribute('aria-checked')).toMatch(
        /checked|true/,
      ),
    );
  });

  it('delete sends DELETE with X-Requested-With: ax-admin', async () => {
    let deleted: RequestInit | null = null;
    fetchMock.mockImplementation((url: RequestInfo | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u === '/admin/connectors/gdrive' && opts?.method === 'DELETE') {
        deleted = opts;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonOk({ connectors: [sampleConnector()] }));
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<ConnectorRegistry />);
    await waitFor(() => screen.getByText('Google Drive'));
    fireEvent.click(screen.getByText(/^delete$/i));
    await waitFor(() => expect(deleted).toBeTruthy());
    const headers = deleted!.headers as Record<string, string>;
    expect(headers['x-requested-with']).toBe('ax-admin');
    confirmSpy.mockRestore();
  });
});
