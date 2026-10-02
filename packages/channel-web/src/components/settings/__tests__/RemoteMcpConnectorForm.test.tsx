import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { ConnectorEditDialog } from '../ConnectorEditDialog';
import type { Connector } from '@/lib/connectors';

const fixture: Connector = {
  id: 'linear',
  name: 'Linear',
  description: 'Preserved description',
  usageNote: 'Preserved instructions',
  keyMode: 'personal',
  visibility: 'shared',
  defaultAttached: true,
  createdAt: '',
  updatedAt: '',
  capabilities: {
    allowedHosts: ['mcp.example.com', 'auth.example.com'],
    credentials: [
      {
        kind: 'oauth',
        slot: 'TOKEN',
        server: 'linear',
        clientId: 'existing-client',
        clientSecretRef: 'account:linear:client',
        authServerUrl: 'https://auth.example.com',
      },
    ],
    mcpServers: [
      {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        allowedHosts: [],
        credentials: [],
      },
    ],
    packages: { npm: ['preserved'], pypi: [] },
    services: [],
  },
};
let writes: { url: string; body: Record<string, unknown> }[];
let failLoad = false;
let failDiscovery = false;
let stallRepeatedConnectorLoad = false;
let connectorReads = 0;
const initialCapabilities = structuredClone(fixture.capabilities);
beforeEach(() => {
  fixture.keyMode = 'personal';
  fixture.capabilities = structuredClone(initialCapabilities);
  writes = [];
  failLoad = false;
  failDiscovery = false;
  stallRepeatedConnectorLoad = false;
  connectorReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/client-metadata'))
        return new Response(
          JSON.stringify({
            client_id:
              'https://ax.example.com/api/connectors/oauth/client-metadata',
            redirect_uris: [
              'https://ax.example.com/api/connectors/oauth/callback',
            ],
          }),
        );
      if (input.endsWith('/discover-hosts'))
        return failDiscovery
          ? new Response('', { status: 503 })
          : new Response(JSON.stringify({ hosts: ['auth.example.com'] }));
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        writes.push({
          url: input,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ connector: fixture }));
      }
      connectorReads++;
      if (stallRepeatedConnectorLoad && connectorReads > 1)
        return new Promise<Response>(() => {});
      return failLoad
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ connector: fixture }));
    }),
  );
});
const props = () => ({
  target: fixture,
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
});
async function openEditor() {
  const options = props();
  render(<ConnectorEditDialog {...options} />);
  await screen.findByLabelText('Name');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled(),
  );
  return options;
}
describe('remote connector editor', () => {
  it('opens invalid header fields and associates their errors for assistive technology', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /Request headers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.click(screen.getByRole('button', { name: /Request headers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const input = await screen.findByLabelText('Header name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.closest('[data-slot="field"]')).toHaveAttribute(
      'data-invalid',
      'true',
    );
    expect(
      document.getElementById(input.getAttribute('aria-describedby')!),
    ).toHaveTextContent(/header name/i);
    await waitFor(() => expect(input).toHaveFocus());
    expect(writes).toEqual([]);
  });
  it('starts with compact disclosures and preserves hidden data on the user route', async () => {
    const options = await openEditor();
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /OAuth client Custom client/ }),
    ).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Linear updated' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toBe('/settings/connectors/linear');
    expect(writes[0]!.body).not.toHaveProperty('visibility');
    expect(writes[0]!.body).not.toHaveProperty('defaultAttached');
    expect(writes[0]!.body).not.toHaveProperty('description');
    expect(writes[0]!.body.capabilities).toMatchObject({
      packages: fixture.capabilities.packages,
      credentials: [fixture.capabilities.credentials[0]],
    });
  });
  it('supports all OAuth methods and custom fields only when requested', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /OAuth client/ }));
    expect(screen.getByLabelText('Client ID')).toHaveValue('existing-client');
    expect(screen.getByText('Saved securely')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change method' }));
    expect(
      within(
        screen.getByRole('radiogroup', { name: 'OAuth client method' }),
      ).getAllByRole('radio'),
    ).toHaveLength(4);
    fireEvent.click(screen.getByLabelText('Register automatically (DCR)'));
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.stringify(writes[0]!.body)).toContain(
      '"clientRegistration":"dcr"',
    );
    expect(JSON.stringify(writes[0]!.body)).not.toContain('existing-client');
  });
  it('stores client secrets in the vault and writes only their reference to the connector', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /OAuth client/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.change(screen.getByLabelText(/Client secret/), {
      target: { value: 'new-confidential-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]!.url).toBe('/settings/destinations/account/credential');
    expect(writes[0]!.body.payloadB64).toBe(btoa('new-confidential-value'));
    expect(writes[1]!.body.capabilities).toMatchObject({
      credentials: [{ clientSecretRef: 'account:linear:oauth-client-secret' }],
    });
    expect(JSON.stringify(writes[1]!.body)).not.toContain(
      'new-confidential-value',
    );
  });
  it('preserves a saved secret if Replace is opened and left empty', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /OAuth client/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body.capabilities).toMatchObject({
      credentials: [{ clientSecretRef: 'account:linear:client' }],
    });
  });
  it('adds headers with OAuth or no sign-in without sending values in connector JSON', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /Request headers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByLabelText('Header name'), {
      target: { value: 'X-API-Key' },
    });
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'header-secret' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'No sign-in' }));
    expect(
      screen.queryByRole('button', { name: /OAuth client/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('connector-access-notice')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]!.body.destination).toMatchObject({
      kind: 'account',
      service: 'linear',
      slot: expect.stringMatching(/^header-/),
    });
    expect(writes[1]!.body.capabilities).toMatchObject({
      credentials: [
        { kind: 'api-key', headerName: 'X-API-Key', server: 'linear' },
      ],
    });
    expect(JSON.stringify(writes[1]!.body)).not.toContain('header-secret');
  });
  it('blocks saving on a load failure and offers a safe retry', async () => {
    failLoad = true;
    render(<ConnectorEditDialog {...props()} />);
    await screen.findByText(/couldn’t load/);
    expect(
      screen.queryByRole('button', { name: 'Save changes' }),
    ).not.toBeInTheDocument();
    expect(writes).toEqual([]);
    failLoad = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByLabelText('Name');
  });
  it('requires an explicit manual-host decision when OAuth discovery fails', async () => {
    failDiscovery = true;
    render(<ConnectorEditDialog {...props()} />);
    await screen.findByText(/couldn’t discover/);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Enter hosts manually' }),
    );
    expect(
      screen.getByLabelText('Additional allowed hosts (optional)'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });
  it('creates a remote server with no sign-in on the personal route', async () => {
    const options = { ...props(), target: 'new' as const };
    render(<ConnectorEditDialog {...options} />);
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Public MCP' },
    });
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://public.example.com/mcp' },
    });
    expect(
      screen.queryByRole('button', { name: /OAuth client/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toBe('/settings/connectors');
    expect(writes[0]!.body).toMatchObject({
      keyMode: 'personal',
      visibility: 'shared',
      defaultAttached: false,
      capabilities: {
        credentials: [],
        allowedHosts: ['public.example.com'],
        mcpServers: [
          { transport: 'http', url: 'https://public.example.com/mcp' },
        ],
      },
    });
  });
  it('creates an admin connector shared and off by default without workspace controls', async () => {
    const options = { ...props(), target: 'new' as const, isAdmin: true };
    render(<ConnectorEditDialog {...options} />);
    expect(screen.queryByRole('button', { name: /Workspace settings/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New MCP' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://public.example.com/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(writes[0]!.url).toBe('/admin/connectors');
    expect(writes[0]!.body).toMatchObject({ visibility: 'shared', defaultAttached: false, keyMode: 'personal' });
  });
  it.each(['auto', 'cimd'] as const)(
    'saves the %s OAuth method and headers together',
    async (registration) => {
      await openEditor();
      fireEvent.click(screen.getByRole('button', { name: /OAuth client/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Change method' }));
      fireEvent.click(
        screen.getByLabelText(
          registration === 'auto'
            ? 'Automatic (recommended)'
            : 'AX’s published identity (CIMD)',
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: /Request headers/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
      fireEvent.change(screen.getByLabelText('Header name'), {
        target: { value: 'X-Key' },
      });
      fireEvent.change(screen.getByLabelText('Value'), {
        target: { value: 'new-key' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]!.body.capabilities).toMatchObject({
        credentials: [
          { kind: 'oauth', clientRegistration: registration },
          { kind: 'api-key', headerName: 'X-Key' },
        ],
      });
    },
  );
  it('preserves existing sharing, default attachment and workspace key permissions', async () => {
    const original = fixture.keyMode;
    fixture.keyMode = 'workspace';
    const options = { ...props(), isAdmin: true };
    render(<ConnectorEditDialog {...options} />);
    await screen.findByLabelText('Name');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(writes[0]!.url).toBe('/admin/connectors/linear');
    expect(writes[0]!.body.keyMode).toBe('workspace');
    expect(writes[0]!.body).not.toHaveProperty('visibility');
    expect(writes[0]!.body).not.toHaveProperty('defaultAttached');
    expect(screen.queryByRole('button', { name: /Workspace settings/ })).not.toBeInTheDocument();
    fixture.keyMode = original;
  });
  it('requires confirmation before sending saved headers to a changed host', async () => {
    const original = fixture.capabilities.credentials;
    fixture.capabilities.credentials = [
      {
        kind: 'api-key',
        slot: 'header-old',
        server: 'linear',
        headerName: 'X-Key',
      },
    ];
    await openEditor();
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://other.example.com/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const confirm = await screen.findByLabelText(
      'Send saved headers to other.example.com',
    );
    expect(writes).toEqual([]);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    fixture.capabilities.credentials = original;
  });
  it('shows saved and discovered hosts separately from additional hosts', async () => {
    await openEditor();
    fireEvent.click(
      screen.getByRole('button', { name: /Connection details 2 hosts/ }),
    );
    expect(
      within(screen.getByRole('list', { name: 'Connection hosts' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['mcp.example.com', 'auth.example.com']);
    expect(
      screen.getByLabelText('Additional allowed hosts (optional)'),
    ).toHaveValue('');
    fireEvent.change(
      screen.getByLabelText('Additional allowed hosts (optional)'),
      {
        target: { value: 'extra.example.com, auth.example.com' },
      },
    );
    expect(
      screen.getByRole('button', { name: /Connection details 3 hosts/ }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body.capabilities).toMatchObject({
      allowedHosts: [
        'mcp.example.com',
        'auth.example.com',
        'extra.example.com',
      ],
    });
  });
  it('removes the chosen header and keeps the remaining value and summary', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /Request headers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByLabelText('Header name'), {
      target: { value: 'X-First' },
    });
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'first-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByLabelText('Header name 2'), {
      target: { value: 'X-Second' },
    });
    fireEvent.change(screen.getByLabelText('Value 2'), {
      target: { value: 'second-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove header 1' }));
    expect(screen.getByLabelText('Header name')).toHaveValue('X-Second');
    expect(screen.getByLabelText('Value')).toHaveValue('second-secret');
    expect(
      screen.getByRole('button', { name: /Request headers 1 header/ }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]!.body.payloadB64).toBe(btoa('second-secret'));
    expect(JSON.stringify(writes)).not.toContain('first-secret');
  });
  it.each(['cimd', 'dcr'] as const)(
    'explains %s without expanding the OAuth client choices',
    async (method) => {
      fixture.capabilities.credentials = [
        {
          kind: 'oauth',
          slot: 'TOKEN',
          server: 'linear',
          clientRegistration: method,
        },
      ];
      await openEditor();
      expect(
        screen.getByText(
          method === 'cimd'
            ? 'AX shares its client details from a published URL. There are no credentials to enter.'
            : 'AX registers an OAuth client with this server when an account connects.',
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole('radiogroup', { name: 'OAuth client method' }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /OAuth client/ }));
      expect(
        screen.getByRole('radiogroup', { name: 'OAuth client method' }),
      ).toBeVisible();
    },
  );
  it.each(['api', 'cli', 'stdio'] as const)(
    'keeps the %s connector editor reachable without converting it to remote MCP',
    async (mechanism) => {
      // A redundant fetch must not leave Save operating on summary-only data.
      stallRepeatedConnectorLoad = true;
      fixture.capabilities.credentials = [];
      fixture.capabilities.mcpServers =
        mechanism === 'stdio'
          ? [
              {
                name: 'local',
                transport: 'stdio',
                command: 'node',
                args: ['server.js'],
                allowedHosts: [],
                credentials: [],
              },
            ]
          : [];
      fixture.capabilities.packages = {
        npm: mechanism === 'cli' ? ['example-cli'] : [],
        pypi: [],
      };
      const options = props();
      render(<ConnectorEditDialog {...options} />);
      await screen.findByLabelText(/service name/i);
      expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
      expect(writes[0]!.body.capabilities).toMatchObject({
        mcpServers: fixture.capabilities.mcpServers,
        packages: fixture.capabilities.packages,
      });
      expect(connectorReads).toBe(1);
    },
  );
});
