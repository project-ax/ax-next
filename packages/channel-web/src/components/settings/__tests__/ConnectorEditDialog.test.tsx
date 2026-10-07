import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LegacyConnectorEditDialog as ConnectorEditDialog } from '../LegacyConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import * as credentialsLib from '@/lib/credentials';
import * as oauthLib from '@/lib/connectors-oauth';
import type { ConnectorSummary, Connector, ConnectorOAuthSlot } from '@/lib/connectors';
import { connectorAccessCopy } from '@/lib/connector-access-copy';

const SUMMARY: ConnectorSummary = {
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive files.',
  usageNote: 'Read and write Drive.',
  keyMode: 'personal',
  visibility: 'private',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const FULL: Connector = {
  ...SUMMARY,
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    allowedHosts: ['drive.googleapis.com'],
    credentials: [{ slot: 'token', kind: 'api-key' }],
    // A Direct-API connector: a host + a key, no MCP server.
    mcpServers: [],
  },
};

const oauthResult = (hosts: string[]): oauthLib.OAuthDiscovery => ({
  hosts,
  auth: 'oauth',
  clientRegistration: { cimd: false, dcr: true },
});

describe('ConnectorEditDialog', () => {
  beforeEach(() => {
    vi.spyOn(oauthLib, 'discoverOAuthHosts').mockResolvedValue(oauthResult([]));
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

  const gmailUrl = 'https://gmailmcp.googleapis.com/mcp/v1';
  const gmailHosts = ['accounts.google.com', 'gmailmcp.googleapis.com', 'oauth2.googleapis.com'];
  async function httpDraft(url = gmailUrl) {
    render(<ConnectorEditDialog target="new" open onOpenChange={() => {}} onSaved={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/service name/i), { target: { value: 'Gmail' } });
    fireEvent.change(screen.getByLabelText(/^url$/i), { target: { value: url } });
  }

  it('shows discovered Gmail hosts before saving, then merges them with manual hosts without duplicates', async () => {
    vi.mocked(oauthLib.discoverOAuthHosts).mockResolvedValue(oauthResult(gmailHosts));
    await httpDraft();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    await screen.findByText('accounts.google.com', { exact: true });
    expect(screen.getByText('oauth2.googleapis.com', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/these hosts will be included/i)).toBeInTheDocument();
    expect(connectorsLib.createConnector).not.toHaveBeenCalled();
    expect(credentialsLib.setDestinationCredential).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/allowed hosts/i), { target: { value: 'custom.example.com, accounts.google.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const [body, base] = vi.mocked(connectorsLib.createConnector).mock.calls[0]!;
    expect(base).toBe('/admin/connectors');
    expect(body.capabilities.allowedHosts).toEqual(expect.arrayContaining([...gmailHosts, 'custom.example.com']));
    expect(body.capabilities.allowedHosts.filter((host) => host === 'accounts.google.com')).toHaveLength(1);
    expect(oauthLib.discoverOAuthHosts).toHaveBeenCalledWith(gmailUrl, expect.any(AbortSignal));
  });

  it('debounces URL edits and does not discover invalid or insecure URLs', async () => {
    await httpDraft('http://example.com/mcp');
    expect(oauthLib.discoverOAuthHosts).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^url$/i), { target: { value: 'https://old.example.com/mcp' } });
    fireEvent.change(screen.getByLabelText(/^url$/i), { target: { value: gmailUrl } });
    await waitFor(() => expect(oauthLib.discoverOAuthHosts).toHaveBeenCalledTimes(1));
    expect(oauthLib.discoverOAuthHosts).toHaveBeenCalledWith(gmailUrl, expect.any(AbortSignal));
  });

  it('discovers an existing HTTP connector on edit and preserves its other server and OAuth client configuration', async () => {
    const oauthSlot: ConnectorOAuthSlot = { slot: 'GMAIL_OAUTH', kind: 'oauth', server: 'gmail', clientId: 'dedicated-client', clientSecretRef: 'account:gmail:oauth-client-secret' };
    const secondServer = { name: 'other', transport: 'http' as const, url: 'https://mcp.example.com/other', allowedHosts: [], credentials: [] };
    const existing: Connector = { ...FULL, id: 'gmail', name: 'Gmail', capabilities: {
      ...connectorsLib.emptyCapabilities(), allowedHosts: ['custom.example.com'], credentials: [oauthSlot],
      mcpServers: [{ name: 'gmail', transport: 'http', url: gmailUrl, allowedHosts: [], credentials: [] }, secondServer],
    } };
    vi.mocked(connectorsLib.getConnector).mockResolvedValue(existing);
    vi.mocked(oauthLib.discoverOAuthHosts).mockResolvedValue(oauthResult(gmailHosts));
    render(<ConnectorEditDialog target={existing} open isAdmin onOpenChange={() => {}} onSaved={() => {}} />);
    await screen.findByText('accounts.google.com', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.patchConnector).toHaveBeenCalled());
    const [id, body] = vi.mocked(connectorsLib.patchConnector).mock.calls[0]!;
    expect(id).toBe('gmail');
    expect(body.capabilities!.allowedHosts).toEqual(expect.arrayContaining([...gmailHosts, 'custom.example.com']));
    expect(body.capabilities!.mcpServers[1]).toEqual(secondServer);
    expect(body.capabilities!.credentials[0]).toMatchObject(oauthSlot);
    expect(credentialsLib.setDestinationCredential).not.toHaveBeenCalled();
  });

  it('ignores a stale response after the URL changes and never saves the old hosts', async () => {
    let finishOld!: (value: oauthLib.OAuthDiscovery) => void;
    vi.mocked(oauthLib.discoverOAuthHosts).mockImplementation((url) => url === gmailUrl
      ? new Promise((resolve) => { finishOld = resolve; })
      : Promise.resolve(oauthResult(['new.example.com', 'new-auth.example.com'])));
    await httpDraft();
    await waitFor(() => expect(oauthLib.discoverOAuthHosts).toHaveBeenCalledTimes(1));
    const oldSignal = vi.mocked(oauthLib.discoverOAuthHosts).mock.calls[0]![1]!;
    fireEvent.change(screen.getByLabelText(/^url$/i), { target: { value: 'https://new.example.com/mcp' } });
    expect(oldSignal.aborted).toBe(true);
    await screen.findByText('new-auth.example.com', { exact: true });
    await act(async () => { finishOld(oauthResult(gmailHosts)); });
    expect(screen.queryByText('accounts.google.com', { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    expect(vi.mocked(connectorsLib.createConnector).mock.calls[0]![0].capabilities.allowedHosts).toEqual(['new.example.com', 'new-auth.example.com']);
  });

  it('offers retry after discovery fails and allows manual host entry', async () => {
    vi.mocked(oauthLib.discoverOAuthHosts).mockRejectedValueOnce(new Error('failed')).mockResolvedValue(oauthResult(gmailHosts));
    await httpDraft();
    await screen.findByText(/could not discover oauth hosts/i);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /retry discovery/i }));
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    await screen.findByText('accounts.google.com', { exact: true });
    expect(oauthLib.discoverOAuthHosts).toHaveBeenCalledTimes(2);
  });

  it('can save manually entered hosts when an MCP server has no usable OAuth metadata', async () => {
    vi.mocked(oauthLib.discoverOAuthHosts).mockRejectedValue(new Error('no metadata'));
    await httpDraft();
    await screen.findByText(/could not discover oauth hosts/i);
    fireEvent.change(screen.getByLabelText(/allowed hosts/i), { target: { value: 'manual.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    expect(vi.mocked(connectorsLib.createConnector).mock.calls[0]![0].capabilities.allowedHosts).toEqual(['manual.example.com', 'gmailmcp.googleapis.com']);
  });

  it('drops the preview when switching away from HTTP MCP', async () => {
    vi.mocked(oauthLib.discoverOAuthHosts).mockResolvedValue(oauthResult(gmailHosts));
    await httpDraft();
    await screen.findByText('accounts.google.com', { exact: true });
    fireEvent.click(screen.getByRole('radio', { name: /direct api/i }));
    expect(screen.queryByText('accounts.google.com', { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    expect(vi.mocked(connectorsLib.createConnector).mock.calls[0]![0].capabilities.allowedHosts).toEqual([]);
  });

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
    expect(body.visibility).toBe('shared');
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

  it('MCP is the default mechanism and shows the server URL (no transport, command or args)', async () => {
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
    expect(screen.getByLabelText(/^url$/i)).toBeInTheDocument();
    // Local (stdio) servers are gone: there is nothing to pick or type for one.
    expect(screen.queryByLabelText(/transport/i)).toBeNull();
    expect(screen.queryByLabelText(/^command$/i)).toBeNull();
    expect(screen.queryByLabelText(/^args/i)).toBeNull();
    // No package picker in MCP mode.
    expect(screen.queryByLabelText(/package name/i)).toBeNull();
  });

  it('Direct API hides the server URL + package picker', async () => {
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
    expect(screen.queryByLabelText(/^url$/i)).toBeNull();
    expect(screen.queryByLabelText(/package name/i)).toBeNull();
    expect(screen.getByLabelText(/allowed hosts/i)).toBeInTheDocument();
  });

  it('lets an HTTP MCP connector save the hosts needed for Google OAuth', async () => {
    render(<ConnectorEditDialog target="new" open isAdmin onOpenChange={() => {}} onSaved={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/service name/i), { target: { value: 'Gmail' } });
    fireEvent.change(screen.getByLabelText(/^url$/i), { target: { value: 'https://gmailmcp.googleapis.com/mcp/v1' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/allowed hosts/i), {
      target: { value: 'accounts.google.com, oauth2.googleapis.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const caps = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0].capabilities;
    expect(caps.allowedHosts).toEqual(expect.arrayContaining([
      'gmailmcp.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com',
    ]));
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

  it('admin variant exposes Sharing (and no default-on control)', async () => {
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
    expect(screen.queryByText(/default-on/i)).toBeNull();
  });

  it('user variant hides Sharing and defaults new connectors to shared', async () => {
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
    fireEvent.change(name, { target: { value: 'My Private' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
    const body = vi.mocked(connectorsLib.createConnector).mock.calls[0]![0];
    expect(body.visibility).toBe('shared');
    expect(body).not.toHaveProperty('defaultAttached');
  });

  // Slice 2a: the /settings/connectors write routes are gone, so even the
  // isAdmin={false} variant must never write there.
  it('creates through the /admin/connectors route base whatever the variant', async () => {
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
    expect(base).toBe('/admin/connectors');
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

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
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
          slot: 'OAUTH_CLIENT_SECRET', // TASK-762 — the route's SCREAMING_SNAKE slot grammar
        },
        // TASK-797 — a shared connector an admin writes keeps its secret at the
        // workspace (global), so people other than the admin can sign in.
        scope: { scope: 'global', ownerId: null },
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
      'account:my-oauth-svc:OAUTH_CLIENT_SECRET',
    );
    // The raw secret must NOT appear anywhere in the connector body.
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
  });

  // TASK-797 — the other two answers to "where does the secret go". Only a
  // shared connector written by an admin may keep it at the workspace.
  it.each([
    ['an admin makes the connector private', true, true],
    ['a non-admin writes it', false, false],
  ])(
    'keeps the client secret with its author when %s',
    async (_who, isAdmin, makePrivate) => {
      render(
        <ConnectorEditDialog
          target="new"
          open
          isAdmin={isAdmin}
          onOpenChange={() => {}}
          onSaved={() => {}}
        />,
      );
      fireEvent.change(await screen.findByLabelText(/service name/i), {
        target: { value: 'My OAuth Svc' },
      });
      if (makePrivate) {
        fireEvent.click(screen.getByRole('combobox', { name: /sharing/i }));
        fireEvent.click(await screen.findByRole('option', { name: /^private/i }));
      }
      fireEvent.click(screen.getByRole('button', { name: /add (key|secret)/i }));
      fireEvent.click(screen.getByRole('radio', { name: /^oauth$/i }));
      await waitFor(() => expect(screen.getByLabelText(/scopes/i)).toBeInTheDocument());
      const machineNames = screen.getAllByLabelText(/machine name/i);
      fireEvent.change(machineNames[machineNames.length - 1]!, {
        target: { value: 'MY_OAUTH' },
      });
      fireEvent.click(screen.getByRole('combobox', { name: /mcp server/i }));
      fireEvent.click(await screen.findByRole('option', { name: 'my-oauth-svc' }));
      fireEvent.click(
        screen.getByRole('button', { name: /advanced — custom oauth client/i }),
      );
      fireEvent.change(await screen.findByLabelText(/client secret/i), {
        target: { value: 'super-secret-value' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(connectorsLib.createConnector).toHaveBeenCalled());
      expect(credentialsLib.setDestinationCredential).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { scope: 'user', ownerId: null } }),
      );
    },
  );
});

// TASK-700 — the launch disclosure (TASK-328) on the authoring form. Defining a
// connector that takes a key is where the access is set up, so the form says what
// a key added for it will hand the assistant. It appears with the FIRST key row
// (a connector that needs no key hands over nothing to disclose) and goes when the
// last row does.
describe('ConnectorEditDialog — access disclosure (TASK-700)', () => {
  const NOTICE = 'connector-access-notice';

  beforeEach(() => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(FULL);
    vi.spyOn(connectorsLib, 'createConnector').mockResolvedValue(FULL);
    vi.spyOn(connectorsLib, 'patchConnector').mockResolvedValue(FULL);
    vi.spyOn(credentialsLib, 'setDestinationCredential').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['admin', true],
    ['user', false],
  ])('%s variant, editing a connector that takes a key: shows the author notice above the key rows', async (_l, isAdmin) => {
    render(
      <ConnectorEditDialog target={SUMMARY} open isAdmin={isAdmin} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    // FULL declares one key, loaded asynchronously into the form.
    const keyRow = await screen.findByText('Key 1');
    const notice = screen.getByTestId(NOTICE);
    expect(notice).toHaveTextContent(connectorAccessCopy('author').headline);
    expect(notice).toHaveTextContent(connectorAccessCopy('author').details);
    expect(
      notice.compareDocumentPosition(keyRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByTestId(NOTICE)).toHaveLength(1);
  });

  it('a new connector with no keys yet shows no notice; adding a key brings it, removing the key takes it away', async () => {
    render(
      <ConnectorEditDialog target="new" open isAdmin={false} onOpenChange={() => {}} onSaved={() => {}} />,
    );
    await screen.findByLabelText(/service name/i);
    expect(screen.getByText(/No keys needed/i)).toBeInTheDocument();
    expect(screen.queryByTestId(NOTICE)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^add (key|secret)$/i }));
    expect(await screen.findByTestId(NOTICE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /remove key 1/i }));
    await waitFor(() => expect(screen.queryByTestId(NOTICE)).toBeNull());
  });

  it('two key rows still get ONE notice', async () => {
    render(
      <ConnectorEditDialog target="new" open isAdmin onOpenChange={() => {}} onSaved={() => {}} />,
    );
    await screen.findByLabelText(/service name/i);
    const add = screen.getByRole('button', { name: /^add (key|secret)$/i });
    fireEvent.click(add);
    fireEvent.click(add);
    await screen.findByText('Key 2');
    expect(screen.getAllByTestId(NOTICE)).toHaveLength(1);
  });

  it('a notice is not a save error: the destructive alert stays the only role=alert', async () => {
    vi.mocked(connectorsLib.createConnector).mockRejectedValue(new Error('nope'));
    render(
      <ConnectorEditDialog target="new" open isAdmin onOpenChange={() => {}} onSaved={() => {}} />,
    );
    fireEvent.change(await screen.findByLabelText(/service name/i), { target: { value: 'Stripe' } });
    fireEvent.click(screen.getByRole('button', { name: /^add (key|secret)$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await screen.findByText(/couldn't save this connector/i);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByTestId(NOTICE)).toBeInTheDocument();
  });
});
