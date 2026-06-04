import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorEditDialog } from '../ConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import type { ConnectorSummary, Connector } from '@/lib/connectors';

const SUMMARY: ConnectorSummary = {
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive files.',
  usageNote: 'Read and write Drive.',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const FULL: Connector = {
  ...SUMMARY,
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    allowedHosts: ['drive.googleapis.com'],
    credentials: [{ slot: 'token', kind: 'api-key' }],
    mcpServers: [
      {
        name: 'gdrive',
        transport: 'stdio',
        command: 'mcp-gdrive',
        args: [],
        allowedHosts: [],
        credentials: [],
      },
    ],
  },
};

describe('ConnectorEditDialog', () => {
  beforeEach(() => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(FULL);
    vi.spyOn(connectorsLib, 'createConnector').mockResolvedValue(FULL);
    vi.spyOn(connectorsLib, 'patchConnector').mockResolvedValue(FULL);
  });
  afterEach(() => vi.restoreAllMocks());

  it('create mode: a blank form, submitting calls createConnector with a slugged id', async () => {
    const onSaved = vi.fn();
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={onSaved}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    fireEvent.change(name, { target: { value: 'Stripe Billing' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    expect(body.connectorId).toBe('stripe-billing');
    expect(body.name).toBe('Stripe Billing');
    expect(body.visibility).toBe('private');
    expect(onSaved).toHaveBeenCalled();
  });

  it('create mode: a name-less submit never creates a connector', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const form = (await screen.findByLabelText(/service name/i)).closest('form')!;
    fireEvent.submit(form);
    await Promise.resolve();
    expect(connectorsLib.createConnector).not.toHaveBeenCalled();
  });

  it('edit mode: prefills from the full connector and patches on save', async () => {
    const onSaved = vi.fn();
    render(
      <ConnectorEditDialog
        target={SUMMARY}
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={onSaved}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    await waitFor(() => expect(name).toHaveValue('Google Drive'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      // The admin variant writes via the /admin/connectors route base (TASK-129).
      expect(connectorsLib.patchConnector).toHaveBeenCalledWith(
        'gdrive',
        expect.objectContaining({ connectorId: 'gdrive', name: 'Google Drive' }),
        '/admin/connectors',
      ),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  // --- mechanism-first picker ---------------------------------------------

  it('leads with the segmented mechanism picker (no Advanced disclosure)', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    // All three mechanism options are present up-front.
    expect(screen.getByRole('radio', { name: /mcp server/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /direct api/i })).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /command-line tool/i }),
    ).toBeInTheDocument();
    // The Advanced disclosure is gone.
    expect(
      screen.queryByRole('button', { name: /advanced — how it connects/i }),
    ).toBeNull();
  });

  it('MCP is the default mechanism and shows transport + command', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    expect(screen.getByLabelText(/transport/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^command$/i)).toBeInTheDocument();
    // No package picker in MCP mode.
    expect(screen.queryByLabelText(/package name/i)).toBeNull();
  });

  it('Direct API hides transport + package picker', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    fireEvent.click(screen.getByRole('radio', { name: /direct api/i }));
    expect(screen.queryByLabelText(/transport/i)).toBeNull();
    expect(screen.queryByLabelText(/package name/i)).toBeNull();
    expect(screen.getByLabelText(/allowed hosts/i)).toBeInTheDocument();
  });

  it('Command-line tool shows the npm/pypi package picker and submits packages', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    fireEvent.change(name, { target: { value: 'My CLI' } });
    fireEvent.click(screen.getByRole('radio', { name: /command-line tool/i }));
    const pkg = screen.getByLabelText(/package name/i);
    expect(pkg).toBeInTheDocument();
    fireEvent.change(pkg, { target: { value: '@org/cli' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    expect(body.capabilities.packages).toEqual({ npm: ['@org/cli'], pypi: [] });
    expect(body.capabilities.mcpServers).toEqual([]);
  });

  // --- structured credential slot rows ------------------------------------

  it('credential slots are structured rows (Label + Machine name only — no share-by-service field)', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    fireEvent.change(name, { target: { value: 'OAuth Svc' } });
    fireEvent.click(screen.getByRole('radio', { name: /direct api/i }));
    // Add a slot row and fill its structured fields.
    fireEvent.click(screen.getByRole('button', { name: /add (key|secret)/i }));
    fireEvent.change(screen.getByLabelText(/machine name/i), {
      target: { value: 'API_KEY' },
    });
    fireEvent.change(screen.getByLabelText(/label \(what it is\)/i), {
      target: { value: 'Secret API key' },
    });
    // The share-by-service field is GONE — each connector owns its own key.
    expect(screen.queryByLabelText(/share key by service/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    expect(body.capabilities.credentials).toEqual([
      { slot: 'API_KEY', kind: 'api-key', description: 'Secret API key' },
    ]);
  });

  it('edit mode prefills the structured slot row from the loaded connector', async () => {
    render(
      <ConnectorEditDialog
        target={SUMMARY}
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    await waitFor(() =>
      expect(screen.getByLabelText(/machine name/i)).toHaveValue('token'),
    );
  });

  // --- admin vs user variant ----------------------------------------------

  it('admin variant exposes Sharing + default-on', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    expect(screen.getByText(/^Sharing$/i)).toBeInTheDocument();
    expect(screen.getByText(/default-on for all agents/i)).toBeInTheDocument();
  });

  it('user variant hides Sharing + default-on and forces visibility private', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin={false}
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    expect(screen.queryByText(/^Sharing$/i)).toBeNull();
    expect(screen.queryByText(/default-on for all agents/i)).toBeNull();
    fireEvent.change(name, { target: { value: 'My Private' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    expect(body.visibility).toBe('private');
    expect(body.defaultAttached).toBe(false);
  });

  it('user variant creates through the /settings/connectors route base (TASK-129)', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin={false}
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    fireEvent.change(name, { target: { value: 'My Private' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const base = vi.mocked(connectorsLib.createConnector).mock.calls[0]![1];
    expect(base).toBe('/settings/connectors');
  });

  // --- services section (TASK-154 — service bundle) -----------------------

  const PINNED = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);

  it('renders a Services (service bundle) section with a compose paste box', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    // The section title (an exact "Services" text node) + paste box + translate.
    expect(
      screen.getByText((_, el) => el?.textContent === 'Services'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/paste a docker-compose/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /translate compose/i }),
    ).toBeInTheDocument();
  });

  it('pasting a compose with a host mount shows the "we removed these" drop notice', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    const paste = screen.getByLabelText(/paste a docker-compose/i);
    fireEvent.change(paste, {
      target: {
        value: `services:\n  db:\n    image: ${PINNED}\n    privileged: true\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /translate compose/i }));
    await waitFor(() =>
      expect(screen.getByText(/we removed a few things/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/can.?t cross into the sandbox/i)).toBeInTheDocument();
    // The dropped field names appear in the notice list (also echoed in the
    // paste box, hence getAllByText — at least one is the drop-list <li>).
    expect(screen.getAllByText(/privileged/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/volumes/).length).toBeGreaterThan(0);
  });

  it('pasting a compose with an un-pinned image surfaces a pin-the-image flag', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    const paste = screen.getByLabelText(/paste a docker-compose/i);
    fireEvent.change(paste, {
      target: { value: `services:\n  cache:\n    image: redis:7\n` },
    });
    fireEvent.click(screen.getByRole('button', { name: /translate compose/i }));
    await waitFor(() =>
      expect(screen.getByText(/pin/i)).toBeInTheDocument(),
    );
    // The un-pinned service did not silently become a usable descriptor.
    expect(screen.queryByDisplayValue('redis:7')).toBeNull();
  });

  it('a malformed compose paste shows an error, not a crash', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    const paste = screen.getByLabelText(/paste a docker-compose/i);
    fireEvent.change(paste, { target: { value: '- not a mapping' } });
    fireEvent.click(screen.getByRole('button', { name: /translate compose/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/couldn.?t read that as a compose file/i),
      ).toBeInTheDocument(),
    );
  });

  it('a translated pinned service submits onto capabilities.services', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    fireEvent.change(name, { target: { value: 'PG bundle' } });
    const paste = screen.getByLabelText(/paste a docker-compose/i);
    fireEvent.change(paste, {
      target: {
        value: `services:\n  db:\n    image: ${PINNED}\n    ports: ["5432:5432"]\n`,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /translate compose/i }));
    await waitFor(() => expect(screen.getByDisplayValue(PINNED)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    expect(body.capabilities.services).toEqual([
      { name: 'db', image: PINNED, ports: [5432], env: {}, writablePaths: [] },
    ]);
  });

  it('edit mode prefills declared services from the loaded connector', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue({
      ...FULL,
      capabilities: {
        ...FULL.capabilities,
        services: [
          { name: 'db', image: PINNED, ports: [5432], env: {}, writablePaths: [] },
        ],
      },
    });
    render(
      <ConnectorEditDialog
        target={SUMMARY}
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    await screen.findByLabelText(/service name/i);
    await waitFor(() =>
      expect(screen.getByDisplayValue(PINNED)).toBeInTheDocument(),
    );
  });

  it('surfaces a save error from the server', async () => {
    vi.spyOn(connectorsLib, 'createConnector').mockRejectedValue(
      new Error('connector id taken'),
    );
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const name = await screen.findByLabelText(/service name/i);
    fireEvent.change(name, { target: { value: 'Dup' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(screen.getByText(/connector id taken/i)).toBeInTheDocument(),
    );
  });
});
