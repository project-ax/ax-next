import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorEditDialog } from '../ConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import * as credentialsLib from '@/lib/credentials';
import type { ConnectorSummary, Connector, ConnectorOAuthSlot } from '@/lib/connectors';

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
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockResolvedValue(undefined);
    vi.spyOn(credentialsLib, 'refForDestination').mockImplementation(
      (dest) => {
        if (dest.kind === 'account' && dest.slot !== undefined) {
          return `account:${dest.service}:${dest.slot}`;
        }
        if (dest.kind === 'account') {
          return `account:${dest.service}`;
        }
        return 'ref';
      },
    );
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

  it('a starter-example chip drops its proven descriptor onto capabilities.services (TASK-159)', async () => {
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
    fireEvent.change(name, { target: { value: 'Mongo bundle' } });
    // One click on the MongoDB example chip fills a service row with the proven
    // digest-pinned image + writable paths — no half-wired dead constant.
    fireEvent.click(screen.getByRole('button', { name: /^MongoDB$/ }));
    const mongoImage =
      'docker.io/library/mongo@sha256:4b5bf3c2bb7516164f6dcb44acce4fdcb428abfe5771a1128304a0f34ab9ff7c';
    await waitFor(() =>
      expect(screen.getByDisplayValue(mongoImage)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    expect(body.capabilities.services).toEqual([
      {
        name: 'mongo',
        image: mongoImage,
        ports: [27017],
        env: {},
        writablePaths: ['/data/db', '/tmp'],
      },
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

  it('surfaces a friendly save error when the server rejects', async () => {
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
      expect(screen.getByText(/couldn't save this connector/i)).toBeInTheDocument(),
    );
  });

  // --- oauth credential slot rows (Task 14) --------------------------------

  it('switching a slot row to kind "oauth" shows server select + scopes and hides api-key fields; Advanced fields are hidden until opened', async () => {
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

    // Add a slot row (starts as api-key).
    fireEvent.click(screen.getByRole('button', { name: /add (key|secret)/i }));
    // The api-key fields are visible.
    expect(screen.getByLabelText(/label \(what it is\)/i)).toBeInTheDocument();
    // The oauth fields are NOT visible yet.
    expect(screen.queryByLabelText(/scopes/i)).toBeNull();

    // Switch the row to oauth kind.
    fireEvent.click(screen.getByRole('radio', { name: /^oauth$/i }));

    // Scopes input should now be present.
    await waitFor(() =>
      expect(screen.getByLabelText(/scopes/i)).toBeInTheDocument(),
    );
    // The api-key description field should no longer be present.
    expect(screen.queryByLabelText(/label \(what it is\)/i)).toBeNull();

    // The Advanced section (clientId + client secret) is hidden until the trigger is clicked.
    expect(screen.queryByLabelText(/client id/i)).toBeNull();
    expect(screen.queryByLabelText(/client secret/i)).toBeNull();

    // Click the Advanced trigger.
    fireEvent.click(
      screen.getByRole('button', { name: /advanced — custom oauth client/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/client id/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/client secret/i)).toBeInTheDocument();
  });

  it('authoring an oauth slot (server + scopes) produces the correct capabilities.credentials entry', async () => {
    // Stub getConnector to return a connector with an http MCP server so the
    // server select has an option to pick.
    const OAUTH_FULL: Connector = {
      ...FULL,
      capabilities: {
        ...connectorsLib.emptyCapabilities(),
        mcpServers: [
          {
            name: 'gdrive',
            transport: 'http',
            url: 'https://gdrive.example.com/mcp',
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    };
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(OAUTH_FULL);

    render(
      <ConnectorEditDialog
        target={SUMMARY}
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const nameInput = await screen.findByLabelText(/service name/i);
    await waitFor(() => expect(nameInput).toHaveValue('Google Drive'));

    // Add a slot and switch it to oauth.
    fireEvent.click(screen.getByRole('button', { name: /add (key|secret)/i }));
    fireEvent.click(screen.getByRole('radio', { name: /^oauth$/i }));

    // Fill the machine name.
    await waitFor(() => expect(screen.getByLabelText(/scopes/i)).toBeInTheDocument());
    // machine name input — after switching to oauth kind the first input in
    // the row is the machine name field.
    const machineNameInputs = screen.getAllByLabelText(/machine name/i);
    fireEvent.change(machineNameInputs[machineNameInputs.length - 1]!, {
      target: { value: 'GDRIVE_OAUTH' },
    });

    // Pick the server from the select.
    // The select has a trigger with the placeholder "Pick a server".
    const serverTrigger = screen.getByRole('combobox', { name: /mcp server/i });
    fireEvent.click(serverTrigger);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'gdrive' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('option', { name: 'gdrive' }));

    // Fill scopes.
    fireEvent.change(screen.getByLabelText(/scopes/i), {
      target: { value: 'read' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.patchConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.patchConnector).mock.calls[0]![1];
    const creds = body.capabilities!.credentials;
    const oauthSlot = creds.find(
      (s: { kind: string }) => s.kind === 'oauth',
    );
    expect(oauthSlot).toBeDefined();
    expect(oauthSlot).toMatchObject({
      kind: 'oauth',
      server: 'gdrive',
      scopes: ['read'],
    });
    // No raw secret on the connector body.
    expect(JSON.stringify(body)).not.toContain('client_secret');
  });

  it('entering a client_secret in Advanced calls setDestinationCredential and sets clientSecretRef; raw secret is absent from connector body', async () => {
    render(
      <ConnectorEditDialog
        target="new"
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={() => {}}
      />,
    );
    const nameInput = await screen.findByLabelText(/service name/i);
    fireEvent.change(nameInput, { target: { value: 'My OAuth Svc' } });

    // Add a slot and switch to oauth.
    fireEvent.click(screen.getByRole('button', { name: /add (key|secret)/i }));
    fireEvent.click(screen.getByRole('radio', { name: /^oauth$/i }));
    await waitFor(() => expect(screen.getByLabelText(/scopes/i)).toBeInTheDocument());

    // Fill machine name.
    const machineNameInputs = screen.getAllByLabelText(/machine name/i);
    fireEvent.change(machineNameInputs[machineNameInputs.length - 1]!, {
      target: { value: 'MY_OAUTH' },
    });

    // Pick a server from the select so the oauth slot is not dropped (rowsToSlots
    // drops an oauth row where server is empty).
    const serverTrigger2 = screen.getByRole('combobox', { name: /mcp server/i });
    fireEvent.click(serverTrigger2);
    await waitFor(() =>
      // The derived server name from the connector name "My OAuth Svc".
      expect(screen.getByRole('option', { name: 'my-oauth-svc' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('option', { name: 'my-oauth-svc' }));

    // Open Advanced and fill the client_secret.
    fireEvent.click(
      screen.getByRole('button', { name: /advanced — custom oauth client/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/client secret/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/client secret/i), {
      target: { value: 'super-secret-value' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());

    // setDestinationCredential was called with the right destination + scope.
    expect(credentialsLib.setDestinationCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          kind: 'account',
          service: 'my-oauth-svc',
          slot: 'oauth-client-secret',
        },
        scope: { scope: 'user', ownerId: null }, // personal keyMode → user scope
        payload: 'super-secret-value',
      }),
    );

    // The connector body carries the ref, NOT the raw secret.
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    const creds2 = body.capabilities!.credentials;
    const oauthSlot = creds2.find(
      (s: { kind: string }) => s.kind === 'oauth',
    ) as ConnectorOAuthSlot | undefined;
    expect(oauthSlot).toBeDefined();
    expect(oauthSlot!.clientSecretRef).toBe(
      'account:my-oauth-svc:oauth-client-secret',
    );
    // The raw secret must NOT appear anywhere in the connector body.
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
  });
});
