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
let discovery: Record<string, unknown>;
let clientIdUrl: string;
let stallRepeatedConnectorLoad = false;
let connectorReads = 0;
let toolPermsGets: string[];
let toolPermsPuts: { url: string; body: { verdicts: unknown[] } }[];
let toolPermsGet: () => Response;
let toolPermsPut: () => Response;
const initialCapabilities = structuredClone(fixture.capabilities);
beforeEach(() => {
  fixture.keyMode = 'personal';
  fixture.capabilities = structuredClone(initialCapabilities);
  writes = [];
  failLoad = false;
  failDiscovery = false;
  discovery = {
    hosts: ['auth.example.com'],
    auth: 'oauth',
    clientRegistration: { cimd: true, dcr: true },
  };
  clientIdUrl = 'https://ax.example.com/api/connectors/oauth/client-metadata';
  stallRepeatedConnectorLoad = false;
  connectorReads = 0;
  toolPermsGets = [];
  toolPermsPuts = [];
  toolPermsGet = () =>
    new Response(
      JSON.stringify({ status: 'ok', checkedAt: null, tools: [], defaults: [] }),
    );
  toolPermsPut = () => new Response(JSON.stringify({ ok: true }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/client-metadata'))
        return new Response(
          JSON.stringify({
            client_id: clientIdUrl,
            redirect_uris: [
              'https://ax.example.com/api/connectors/oauth/callback',
            ],
          }),
        );
      if (input.includes('/tool-permissions')) {
        if (init?.method === 'PUT') {
          toolPermsPuts.push({
            url: input,
            body: JSON.parse(String(init.body)) as { verdicts: unknown[] },
          });
          return toolPermsPut();
        }
        toolPermsGets.push(input);
        return toolPermsGet();
      }
      if (input.endsWith('/discover-hosts'))
        return failDiscovery
          ? new Response('', { status: 503 })
          : new Response(JSON.stringify(discovery));
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
async function openNew(isAdmin = false) {
  const options = { ...props(), target: 'new' as const, isAdmin };
  render(<ConnectorEditDialog {...options} />);
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'New MCP' },
  });
  fireEvent.change(screen.getByLabelText('Server URL'), {
    target: { value: 'https://public.example.com/mcp' },
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add connector' })).toBeEnabled(),
  );
  return options;
}
const withoutClientId = () => {
  fixture.capabilities.credentials = [
    { kind: 'oauth', slot: 'TOKEN', server: 'linear' },
  ];
};
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
  it('asks only for a name and URL until the server has been checked', async () => {
    render(<ConnectorEditDialog {...props()} target="new" />);
    expect(screen.getByLabelText('Name')).toBeVisible();
    expect(screen.getByLabelText('Server URL')).toBeVisible();
    expect(screen.queryByText(/Sign-in/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Request headers/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://public.example.com/mcp' },
    });
    expect(await screen.findByText('Sign-in: OAuth')).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Request headers/ }),
    ).toBeVisible();
  });
  it('preserves hidden data on the user route', async () => {
    const options = await openEditor();
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
  it('switches a custom client to automatic setup without asking CIMD or DCR', async () => {
    await openEditor();
    expect(screen.getByLabelText('Client ID')).toHaveValue('existing-client');
    expect(screen.getByText('Saved securely')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Use automatic setup instead' }),
    );
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
    expect(screen.queryByText(/CIMD|DCR/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.stringify(writes[0]!.body)).toContain(
      '"clientRegistration":"auto"',
    );
    expect(JSON.stringify(writes[0]!.body)).not.toContain('existing-client');
  });
  it('stores client secrets in the vault and writes only their reference to the connector', async () => {
    await openEditor();
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
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body.capabilities).toMatchObject({
      credentials: [{ clientSecretRef: 'account:linear:client' }],
    });
  });
  it('hides OAuth when the server needs no sign-in and keeps header values out of connector JSON', async () => {
    discovery = { hosts: ['mcp.example.com'], auth: 'none' };
    await openEditor();
    expect(screen.getByText('Sign-in: none')).toBeVisible();
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
    expect(screen.queryByText(/OAuth/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Request headers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByLabelText('Header name'), {
      target: { value: 'X-API-Key' },
    });
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'header-secret' },
    });
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
  it('points a server that challenges without OAuth at request headers', async () => {
    discovery = { hosts: ['mcp.example.com'], auth: 'other' };
    await openEditor();
    expect(screen.getByText('Sign-in: request header')).toBeVisible();
    expect(screen.getByText(/doesn’t\s+support OAuth/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add header' })).toBeVisible();
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
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
  it('keeps saved sign-in settings when the saved server cannot be checked', async () => {
    failDiscovery = true;
    await openEditor();
    expect(screen.getByText(/keep its saved settings/)).toBeVisible();
    expect(screen.getByLabelText('Client ID')).toHaveValue('existing-client');
    expect(
      screen.queryByLabelText(/allowed hosts/i),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body.capabilities).toMatchObject({
      credentials: [fixture.capabilities.credentials[0]],
      allowedHosts: fixture.capabilities.allowedHosts,
    });
  });
  it('blocks a new connector until its server can be checked, then retries', async () => {
    failDiscovery = true;
    render(<ConnectorEditDialog {...props()} target="new" />);
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://public.example.com/mcp' },
    });
    await screen.findByText(/Check the URL and try again/);
    expect(screen.getByRole('button', { name: 'Add connector' })).toBeDisabled();
    expect(screen.queryByText(/Sign-in/)).not.toBeInTheDocument();
    failDiscovery = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Sign-in: OAuth')).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add connector' }),
      ).toBeEnabled(),
    );
  });
  it('creates a remote server with no sign-in on the personal route', async () => {
    discovery = { hosts: ['public.example.com'], auth: 'none' };
    const options = await openNew();
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
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
    discovery = { hosts: ['public.example.com'], auth: 'none' };
    const options = await openNew(true);
    expect(screen.queryByRole('button', { name: /Workspace settings/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(writes[0]!.url).toBe('/admin/connectors');
    expect(writes[0]!.body).toMatchObject({ visibility: 'shared', defaultAttached: false, keyMode: 'personal' });
  });
  it.each([
    {
      method: 'CIMD',
      clientRegistration: { cimd: true, dcr: false },
      text: /published client details/,
    },
    {
      method: 'DCR',
      clientRegistration: { cimd: false, dcr: true },
      text: /registers itself with this server automatically/,
    },
  ])(
    'uses automatic setup for a $method server and saves headers with it',
    async ({ clientRegistration, text }) => {
      withoutClientId();
      discovery = {
        hosts: ['auth.example.com'],
        auth: 'oauth',
        clientRegistration,
      };
      await openEditor();
      expect(screen.getByText(text)).toBeVisible();
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
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
          { kind: 'oauth', clientRegistration: 'auto' },
          { kind: 'api-key', headerName: 'X-Key' },
        ],
      });
    },
  );
  it('requires a custom client when the server offers no automatic setup AX can use', async () => {
    withoutClientId();
    // CIMD needs AX at a public HTTPS URL; this deployment has none.
    clientIdUrl = 'http://localhost/api/connectors/oauth/client-metadata';
    discovery = {
      hosts: ['auth.example.com'],
      auth: 'oauth',
      clientRegistration: { cimd: true, dcr: false },
    };
    await openEditor();
    await waitFor(() =>
      expect(screen.getByLabelText('Client ID')).toBeVisible(),
    );
    expect(screen.getByText(/doesn’t support automatic setup/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /automatic setup instead/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Enter the client ID/)).toBeVisible();
    expect(writes).toEqual([]);
  });
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
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' }),
      ).toBeEnabled(),
    );
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
  it('saves discovered hosts without showing or asking for a host list', async () => {
    discovery = {
      hosts: ['auth.example.com', 'tokens.example.com'],
      auth: 'oauth',
      clientRegistration: { cimd: true, dcr: true },
    };
    await openEditor();
    expect(
      screen.queryByRole('list', { name: 'Connection hosts' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connection details/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/allowed hosts/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body.capabilities).toMatchObject({
      allowedHosts: [
        'mcp.example.com',
        'auth.example.com',
        'tokens.example.com',
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

describe('tool permissions (TASK-737)', () => {
  const inventory = (over: Record<string, unknown> = {}) => ({
    status: 'ok',
    checkedAt: '2026-10-01T00:00:00Z',
    tools: [
      { toolKey: 'mcp.linear.search_issues', name: 'search_issues', title: 'Search issues', description: 'Finds issues.', readOnly: true, outward: false },
      { toolKey: 'mcp.linear.get_issue', name: 'get_issue', title: 'Read an issue', description: '', readOnly: true, outward: false },
      { toolKey: 'mcp.linear.create_issue', name: 'create_issue', title: 'Create issue', description: '', readOnly: false, outward: true },
      { toolKey: 'mcp.linear.update_issue', name: 'update_issue', title: 'Update issue', description: '', readOnly: null, outward: null },
    ] as Record<string, unknown>[],
    defaults: [{ toolKey: 'mcp.linear.get_issue', verdict: 'deny' }],
    ...over,
  });
  const serve = (body: unknown, status = 200) => {
    toolPermsGet = () => new Response(JSON.stringify(body), { status });
  };
  const group = (title: string) =>
    screen.getByRole('group', { name: `Permission for ${title}` });
  const pressed = (title: string) =>
    within(group(title))
      .getAllByRole('radio')
      .filter((item) => item.getAttribute('aria-checked') === 'true')
      .map((item) => item.getAttribute('aria-label'));

  it('groups tools by what they do and flags the ones others may see', async () => {
    serve(inventory());
    await openEditor();
    const looksUp = await screen.findByRole('region', { name: 'Looks things up' });
    const makes = screen.getByRole('region', { name: 'Makes changes' });
    expect(within(looksUp).getByText('Search issues')).toBeVisible();
    expect(within(looksUp).getByText('Read an issue')).toBeVisible();
    expect(within(makes).getByText('Create issue')).toBeVisible();
    // Unknown behaviour lands with the tools that make changes.
    expect(within(makes).getByText('Update issue')).toBeVisible();
    expect(within(makes).getByText('Others may see these')).toBeVisible();
    expect(within(looksUp).queryByText('Others may see these')).toBeNull();
  });

  it('omits the "others may see" caption when no change tool is outward', async () => {
    const body = inventory();
    body.tools = body.tools.map((t) => ({ ...t, outward: false }));
    serve(body);
    await openEditor();
    await screen.findByRole('region', { name: 'Makes changes' });
    expect(screen.queryByText('Others may see these')).toBeNull();
  });

  it('prefills read-only tools as Allow, others as Ask first, and a saved default wins', async () => {
    serve(inventory());
    await openEditor();
    await screen.findByRole('group', { name: 'Permission for Search issues' });
    expect(pressed('Search issues')).toEqual(['Allow']);
    expect(pressed('Read an issue')).toEqual(['Deny']);
    expect(pressed('Create issue')).toEqual(['Ask first']);
    expect(pressed('Update issue')).toEqual(['Ask first']);
  });

  it('sends only changed rows, to the user base, after the connector saves', async () => {
    serve(
      inventory({
        defaults: [
          { toolKey: 'mcp.linear.search_issues', verdict: 'allow' },
          { toolKey: 'mcp.linear.get_issue', verdict: 'deny' },
          { toolKey: 'mcp.linear.create_issue', verdict: 'hold' },
          { toolKey: 'mcp.linear.update_issue', verdict: 'hold' },
        ],
      }),
    );
    const options = await openEditor();
    await screen.findByRole('group', { name: 'Permission for Create issue' });
    fireEvent.click(within(group('Create issue')).getByRole('radio', { name: 'Deny' }));
    // Clicking the selected choice again must not clear it.
    fireEvent.click(within(group('Search issues')).getByRole('radio', { name: 'Allow' }));
    expect(pressed('Search issues')).toEqual(['Allow']);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(writes).toHaveLength(1);
    expect(toolPermsPuts).toEqual([
      {
        url: '/settings/connectors/linear/tool-permissions',
        body: { verdicts: [{ toolKey: 'mcp.linear.create_issue', verdict: 'deny' }] },
      },
    ]);
  });

  it('writes on-screen prefills for tools with no saved default, on the admin base', async () => {
    serve(inventory({ defaults: [] }));
    const options = { ...props(), isAdmin: true };
    render(<ConnectorEditDialog {...options} />);
    await screen.findByRole('group', { name: 'Permission for Search issues' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled(),
    );
    expect(toolPermsGets).toEqual(['/admin/connectors/linear/tool-permissions']);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(toolPermsPuts).toHaveLength(1);
    expect(toolPermsPuts[0]!.url).toBe('/admin/connectors/linear/tool-permissions');
    expect(toolPermsPuts[0]!.body.verdicts).toEqual([
      { toolKey: 'mcp.linear.search_issues', verdict: 'allow' },
      { toolKey: 'mcp.linear.get_issue', verdict: 'allow' },
      { toolKey: 'mcp.linear.create_issue', verdict: 'hold' },
      { toolKey: 'mcp.linear.update_issue', verdict: 'hold' },
    ]);
  });

  it('makes no tool write when nothing changed', async () => {
    serve(
      inventory({
        defaults: inventory().tools.map((t) => ({ toolKey: t.toolKey, verdict: 'hold' })),
      }),
    );
    const options = await openEditor();
    await screen.findByRole('group', { name: 'Permission for Search issues' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(toolPermsPuts).toEqual([]);
  });

  it('keeps the dialog open when the connector saves but its tool permissions do not', async () => {
    serve(inventory({ defaults: [] }));
    toolPermsPut = () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
    const options = await openEditor();
    await screen.findByRole('group', { name: 'Permission for Search issues' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(
        'We saved the connector, but not its tool permissions. Try saving again.',
      ),
    ).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(options.onSaved).not.toHaveBeenCalled();
    expect(options.onOpenChange).not.toHaveBeenCalled();
  });

  it.each([
    [503, 'We saved the connector, but tool permissions can’t be saved right now. Try again in a little while.'],
    [400, 'We saved the connector, but these tool permissions didn’t look right to us. Reopen the connector and try again.'],
  ])('says why a tool-permissions save failed (%i)', async (status, message) => {
    serve(inventory({ defaults: [] }));
    toolPermsPut = () => new Response(JSON.stringify({ error: 'x' }), { status });
    const options = await openEditor();
    await screen.findByRole('group', { name: 'Permission for Search issues' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(options.onSaved).not.toHaveBeenCalled();
  });

  it('says which choices are unsaved suggestions before Save writes them', async () => {
    // get_issue has a saved default; the other three are suggestions.
    serve(inventory());
    await openEditor();
    const note = await screen.findByTestId('tool-permission-suggestions');
    expect(note).toHaveTextContent(
      /^3 tools haven’t been set yet, so we’ve suggested a choice for each based on how the tool describes itself\. Check them before you save\./,
    );
  });

  it('has no suggestion note once every listed tool has a saved choice', async () => {
    serve(
      inventory({
        defaults: inventory().tools.map((t) => ({ toolKey: t.toolKey, verdict: 'hold' })),
      }),
    );
    await openEditor();
    await screen.findByRole('group', { name: 'Permission for Search issues' });
    expect(screen.queryByTestId('tool-permission-suggestions')).toBeNull();
  });

  it('does not claim a server listed no tools while showing earlier choices without saying so', async () => {
    serve(inventory({ tools: [], defaults: [{ toolKey: 'mcp.linear.get_issue', verdict: 'deny' }] }));
    await openEditor();
    expect(
      await screen.findByText(
        /This connector didn’t list any tools this time\. The ones you set before are below\./,
      ),
    ).toBeVisible();
    expect(group('get_issue')).toBeVisible();
  });

  it('explains an unreachable inventory, keeps saved defaults editable, still saves, and checks again', async () => {
    serve({
      status: 'unreachable',
      checkedAt: null,
      tools: [],
      defaults: [{ toolKey: 'mcp.linear.archive_issue', verdict: 'deny' }],
    });
    const options = await openEditor();
    expect(
      await screen.findByText(
        /We couldn’t reach this connector to list its tools\. Everything else still saves\. Until you choose, agents ask before using any of its tools\./,
      ),
    ).toBeVisible();
    expect(pressed('archive_issue')).toEqual(['Deny']);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(toolPermsGets).toHaveLength(2));
    expect(toolPermsGets[1]).toBe('/settings/connectors/linear/tool-permissions?refresh=1');
    await screen.findByRole('group', { name: 'Permission for archive_issue' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
    expect(writes).toHaveLength(1);
    expect(toolPermsPuts).toEqual([]);
  });

  it.each([
    ['needs-auth', 'Sign in to this connector to see its tools.'],
    ['unknown', 'We can’t list this connector’s tools right now.'],
  ])('explains a %s inventory in plain words', async (status, copy) => {
    serve({ status, checkedAt: null, tools: [], defaults: [] });
    await openEditor();
    expect(
      await screen.findByText((text) => text.startsWith(copy)),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('offers a retry when tool permissions fail to load, and the connector still saves', async () => {
    serve({ error: 'unavailable' }, 503);
    const options = await openEditor();
    expect(
      await screen.findByText(
        'We couldn’t load tool permissions. Everything else still saves.',
      ),
    ).toBeVisible();
    serve(inventory());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('group', { name: 'Permission for Search issues' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(options.onSaved).toHaveBeenCalled());
  });

  it('shows nothing to a person who cannot edit the permissions', async () => {
    serve({ error: 'forbidden' }, 403);
    await openEditor();
    await waitFor(() => expect(toolPermsGets).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByText(/Looking up this connector/)).toBeNull(),
    );
    expect(screen.queryByText('Tool permissions')).toBeNull();
    expect(screen.queryByText(/couldn’t load tool permissions/)).toBeNull();
  });

  it('shows a loading line while the tools are looked up', async () => {
    toolPermsGet = () => new Promise<Response>(() => {}) as unknown as Response;
    await openEditor();
    expect(screen.getByText('Looking up this connector’s tools…')).toBeVisible();
  });

  it('for a new connector, shows a hint and never asks for tools', async () => {
    await openNew();
    expect(
      screen.getByText(
        'Once it’s saved, you can choose what each of its tools may do.',
      ),
    ).toBeVisible();
    expect(toolPermsGets).toEqual([]);
    expect(screen.queryByText('Tool permissions')).toBeNull();
  });

  it('renders a tool’s own description as text, behind a popover that says whose words they are', async () => {
    const body = inventory();
    body.tools[0] = { ...body.tools[0], description: '<img src=x onerror=alert(1)> Finds issues.' };
    serve(body);
    await openEditor();
    fireEvent.click(
      await screen.findByRole('button', { name: 'What Linear says Search issues does' }),
    );
    expect(
      await screen.findByText('<img src=x onerror=alert(1)> Finds issues.'),
    ).toBeVisible();
    expect(screen.getByText(/Those are their words, not ours/)).toBeVisible();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('never uses jargon in the section copy', async () => {
    serve(inventory());
    await openEditor();
    const section = (await screen.findByText('Tool permissions')).closest('fieldset')!;
    await within(section).findByText('Search issues');
    expect(section.textContent).not.toMatch(/\bMCP\b|\bscope|\bverdict|\bhold\b/i);
  });
});
