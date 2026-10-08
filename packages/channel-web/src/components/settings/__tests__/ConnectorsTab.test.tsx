import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ConnectorsTab } from '../ConnectorsTab';
import * as connectorsLib from '@/lib/connectors';
import * as agentsLib from '@/lib/agents';
import * as connLib from '@/lib/connections';
import * as credLib from '@/lib/credentials';
import type { ConnectorSummary, Connector } from '@/lib/connectors';
import {
  headingOutline,
  headingOutlineProblems,
} from '@/test-utils/heading-outline';

const PRIVATE_CONN: ConnectorSummary = {
  id: 'my-notion',
  name: 'My Notion',
  description: 'Personal Notion workspace.',
  usageNote: 'Ask the agent to read or update Notion pages.',
  keyMode: 'personal',
  visibility: 'private',
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

// A SHARED connector (catalog-sourced). keyMode workspace → it needs one shared key.
const SHARED_CONN: ConnectorSummary = {
  id: 'company-salesforce',
  name: 'Salesforce',
  description: 'The company Salesforce org.',
  usageNote: 'Drive the sf CLI for our workflows.',
  keyMode: 'workspace',
  visibility: 'shared',
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

/** Build the full connector a `getConnector` mock returns (carries capabilities).
 *  A single api-key slot — the connector owns its own key, keyed by the id, so the
 *  derived presence ref is `account:<connectorId>`. */
function fullOf(summary: ConnectorSummary): Connector {
  return {
    ...summary,
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      credentials: [{ slot: 'token', kind: 'api-key' }],
    },
  };
}

describe('ConnectorsTab', () => {
  beforeEach(() => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
      PRIVATE_CONN,
      SHARED_CONN,
    ]);
    // The tab no longer reads a connector's full record or anyone's credential
    // presence (no Ready / Needs a key status, no Connect). These spies stay so
    // a test can assert those reads never happen.
    vi.spyOn(connectorsLib, 'getConnector').mockImplementation(async (id: string) => {
      if (id === PRIVATE_CONN.id) return fullOf(PRIVATE_CONN);
      return fullOf(SHARED_CONN);
    });
    vi.spyOn(credLib.adminCredentials, 'list').mockResolvedValue([]);
    // No connector requests by default → the Awaiting approval shelf is absent.
    // Tests that exercise it override this.
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([]);
    // The site lists live on Settings › Sites now; these spies stay so a test
    // can assert this tab never reads them.
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([]);
    vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists the connectors by service name', async () => {
    render(<ConnectorsTab />);
    expect(await screen.findByText('My Notion')).toBeInTheDocument();
    expect(screen.getByText('Salesforce')).toBeInTheDocument();
  });

  // Slice 2c — Awaiting approval: every person's connector requests (an agent
  // needed a connector nobody had defined). Approval is creation: "Set it up"
  // opens the normal create editor prefilled from the request.
  const REQUEST_LINEAR: connectorsLib.AuthoredProposal = {
    connectorId: 'linear',
    name: 'Linear',
    usageNote: 'Drive the Linear CLI',
    keyMode: 'personal',
    proposal: {
      allowedHosts: ['api.linear.app'],
      credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    },
    updatedAt: '2026-10-07T00:00:00Z',
    proposedBy: { userId: 'u_ada', label: 'Ada Lovelace' },
  };
  const REQUEST_NOTION: connectorsLib.AuthoredProposal = {
    connectorId: 'notion',
    name: 'Notion',
    usageNote: '',
    keyMode: 'workspace',
    proposal: {
      allowedHosts: [],
      credentials: [],
      mcpServers: [
        {
          name: 'notion',
          transport: 'http',
          url: 'https://mcp.notion.com/mcp',
          allowedHosts: [],
          credentials: [],
        },
      ],
      packages: { npm: [], pypi: [] },
    },
    updatedAt: '2026-10-07T00:00:00Z',
    proposedBy: { userId: 'u_grace', label: 'grace@example.com' },
  };

  it('lists every person’s requests under Awaiting approval', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([
      REQUEST_LINEAR,
      REQUEST_NOTION,
    ]);
    render(<ConnectorsTab />);
    expect(await screen.findByText('Awaiting approval (2)')).toBeInTheDocument();
    const linear = await screen.findByTestId('connector-request-linear');
    expect(within(linear).getByText('Linear')).toBeInTheDocument();
    expect(
      within(linear).getByText('Asked for by Ada Lovelace for one of their agents'),
    ).toBeInTheDocument();
    expect(within(linear).getByText('Would reach api.linear.app')).toBeInTheDocument();
    expect(within(linear).getByRole('button', { name: 'Set it up' })).toBeInTheDocument();
    expect(within(linear).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    const notion = screen.getByTestId('connector-request-notion');
    expect(
      within(notion).getByText('Asked for by grace@example.com for one of their agents'),
    ).toBeInTheDocument();
    expect(within(notion).getByText('Would reach mcp.notion.com')).toBeInTheDocument();
  });

  it('renders agent-written request text as text, never markup', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([
      {
        ...REQUEST_LINEAR,
        name: '<img src=x onerror=alert(1)>',
        proposal: { ...REQUEST_LINEAR.proposal, allowedHosts: ['<b>evil</b>'] },
      },
    ]);
    render(<ConnectorsTab />);
    const row = await screen.findByTestId('connector-request-linear');
    expect(within(row).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(within(row).getByText('Would reach <b>evil</b>')).toBeInTheDocument();
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
  });

  it('groups requests by connector: one row per id, saying whose request it shows and who else asked', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([
      REQUEST_LINEAR,
      {
        ...REQUEST_LINEAR,
        usageNote: 'Newer note',
        updatedAt: '2026-10-08T00:00:00Z',
        proposedBy: { userId: 'u_bob', label: 'Bob' },
      },
    ]);
    const dismiss = vi
      .spyOn(connectorsLib, 'dismissAuthoredProposal')
      .mockResolvedValue(undefined);
    render(<ConnectorsTab />);
    expect(await screen.findByText('Awaiting approval (1)')).toBeInTheDocument();
    const rows = screen.getAllByTestId('connector-request-linear');
    expect(rows).toHaveLength(1);
    expect(
      within(rows[0]!).getByText('Showing Bob’s request. Ada Lovelace also asked for this.'),
    ).toBeInTheDocument();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('The people who asked won’t be notified.'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^dismiss$/i }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
    expect(dismiss).toHaveBeenCalledWith('linear');
  });

  it('credits the shown request to its proposer even when they are not first in the list', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([
      REQUEST_LINEAR,
      {
        ...REQUEST_LINEAR,
        name: 'Linear (Carol’s wording)',
        updatedAt: '2026-10-09T00:00:00Z',
        proposedBy: { userId: 'u_carol', label: 'Carol' },
      },
      {
        ...REQUEST_LINEAR,
        updatedAt: '2026-10-08T00:00:00Z',
        proposedBy: { userId: 'u_bob', label: 'Bob' },
      },
    ]);
    render(<ConnectorsTab />);
    const row = await screen.findByTestId('connector-request-linear');
    expect(within(row).getByText('Linear (Carol’s wording)')).toBeInTheDocument();
    expect(
      within(row).getByText('Showing Carol’s request. Ada Lovelace and Bob also asked for this.'),
    ).toBeInTheDocument();
  });

  it('shows how long ago each request was made, so a stale one is easy to spot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00'));
    try {
      vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([
        { ...REQUEST_LINEAR, updatedAt: '2026-10-07T12:00:00' },
        { ...REQUEST_NOTION, updatedAt: '2026-10-21T09:00:00' },
      ]);
      render(<ConnectorsTab />);
      const linear = await screen.findByTestId('connector-request-linear');
      expect(within(linear).getByText('Requested 2 weeks ago')).toBeInTheDocument();
      expect(
        within(screen.getByTestId('connector-request-notion')).getByText('Requested today'),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Set it up carries only what the editor shows, lists the rest, and fixes Sharing to Shared', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([
      {
        ...REQUEST_LINEAR,
        proposal: {
          allowedHosts: ['api.linear.app'],
          credentials: [
            { slot: 'LINEAR_API_KEY', kind: 'api-key', headerName: 'X-Key', server: 'x' },
          ],
          mcpServers: [],
          packages: { npm: ['@linear/cli', 'sneaky-extra'], pypi: ['also-sneaky'] },
        },
      },
    ]);
    const create = vi
      .spyOn(connectorsLib, 'createConnector')
      .mockResolvedValue({ ...fullOf(SHARED_CONN), id: 'linear' });
    render(<ConnectorsTab />);
    const row = await screen.findByTestId('connector-request-linear');
    fireEvent.click(within(row).getByRole('button', { name: 'Set it up' }));
    const dialog = await screen.findByRole('dialog');
    const note = await within(dialog).findByTestId('request-left-out');
    expect(within(note).getByText('the npm package sneaky-extra')).toBeInTheDocument();
    expect(within(note).getByText('the PyPI package also-sneaky')).toBeInTheDocument();
    expect(
      within(note).getByText('sending the key LINEAR_API_KEY as the header X-Key'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /sharing/i })).toBeDisabled();
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/service name/i)).toHaveValue('Linear'),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [body] = create.mock.calls[0]!;
    expect(body.visibility).toBe('shared');
    expect(body.capabilities.packages).toEqual({ npm: ['@linear/cli'], pypi: [] });
    expect(body.capabilities.credentials).toEqual([
      { slot: 'LINEAR_API_KEY', kind: 'api-key' },
    ]);
  });

  it('omits the Awaiting approval shelf when there are no requests', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(screen.queryByText(/Awaiting approval/i)).not.toBeInTheDocument();
  });

  it('says so, with Retry, when the request list can’t load (and the tab keeps working)', async () => {
    const list = vi
      .spyOn(connectorsLib, 'listAuthoredProposals')
      .mockRejectedValueOnce(new Error('list connector requests: 500'))
      .mockResolvedValueOnce([REQUEST_LINEAR]);
    render(<ConnectorsTab />);
    expect(await screen.findByText('My Notion')).toBeInTheDocument();
    const alert = await screen.findByTestId('connector-requests-failed');
    expect(
      within(alert).getByText('Couldn’t load requests waiting for approval.'),
    ).toBeInTheDocument();
    // The raw error text is not shown.
    expect(screen.queryByText(/500/)).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('connector-request-linear')).toBeInTheDocument();
    expect(screen.queryByTestId('connector-requests-failed')).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shows nothing at all when this preset has no request queue (the lib answers [] for a 404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/admin/connectors/authored') {
        return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    vi.mocked(connectorsLib.listAuthoredProposals).mockRestore();
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/admin/connectors/authored', { credentials: 'include' },
    ));
    expect(screen.queryByText(/Awaiting approval/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('connector-requests-failed')).not.toBeInTheDocument();
  });

  it('Set it up opens the create editor prefilled, and Save creates a shared connector under the requested id', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals')
      .mockResolvedValueOnce([REQUEST_LINEAR]) // initial load
      .mockResolvedValue([]); // after the create → the server cleared it
    const create = vi
      .spyOn(connectorsLib, 'createConnector')
      .mockResolvedValue({ ...fullOf(SHARED_CONN), id: 'linear' });

    render(<ConnectorsTab />);
    const row = await screen.findByTestId('connector-request-linear');
    fireEvent.click(within(row).getByRole('button', { name: 'Set it up' }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/service name/i)).toHaveValue('Linear'),
    );
    expect(within(dialog).getByLabelText(/how to use it/i)).toHaveValue(
      'Drive the Linear CLI',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [body, writeBase] = create.mock.calls[0]!;
    expect(writeBase).toBe('/admin/connectors');
    expect(body).toMatchObject({
      connectorId: 'linear',
      name: 'Linear',
      usageNote: 'Drive the Linear CLI',
      visibility: 'shared',
      keyMode: 'personal',
    });
    expect(body.capabilities.allowedHosts).toEqual(['api.linear.app']);
    expect(body.capabilities.credentials).toEqual([
      expect.objectContaining({ slot: 'LINEAR_API_KEY', kind: 'api-key' }),
    ]);
    // The shelf refreshes and the request is gone.
    await waitFor(() =>
      expect(screen.queryByTestId('connector-request-linear')).not.toBeInTheDocument(),
    );
  });

  it('Set it up says so plainly when a connector with that id already exists', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([REQUEST_LINEAR]);
    vi.spyOn(connectorsLib, 'createConnector').mockRejectedValue(
      new Error(connectorsLib.CONNECTOR_ID_TAKEN),
    );
    render(<ConnectorsTab />);
    const row = await screen.findByTestId('connector-request-linear');
    fireEvent.click(within(row).getByRole('button', { name: 'Set it up' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/service name/i)).toHaveValue('Linear'),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    expect(
      await within(dialog).findByText(
        'A connector with this id already exists. Dismiss this request if it’s no longer needed.',
      ),
    ).toBeInTheDocument();
  });

  it('Set it up on an MCP request opens the remote-server form', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([REQUEST_NOTION]);
    render(<ConnectorsTab />);
    const row = await screen.findByTestId('connector-request-notion');
    fireEvent.click(within(row).getByRole('button', { name: 'Set it up' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Notion');
    expect(within(dialog).getByLabelText('Server URL')).toHaveValue(
      'https://mcp.notion.com/mcp',
    );
  });

  it('Dismiss confirms, then clears the request and refreshes the shelf', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals')
      .mockResolvedValueOnce([REQUEST_LINEAR]) // initial load
      .mockResolvedValue([]); // after dismiss → shelf empties
    const dismiss = vi
      .spyOn(connectorsLib, 'dismissAuthoredProposal')
      .mockResolvedValue(undefined);

    render(<ConnectorsTab />);
    const row = await screen.findByTestId('connector-request-linear');
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Dismiss this request?')).toBeInTheDocument();
    expect(
      within(dialog).getByText('The person who asked won’t be notified.'),
    ).toBeInTheDocument();
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /^dismiss$/i }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('linear'));
    await waitFor(() =>
      expect(screen.queryByTestId('connector-request-linear')).not.toBeInTheDocument(),
    );
  });

  it('keeps the default view mechanism-free (no transport/command/url/args)', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/stdio/i);
    expect(body).not.toMatch(/transport/i);
    expect(body).not.toMatch(/command/i);
    expect(body).not.toMatch(/\bargs\b/i);
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('captions what each connector needs (a key) without naming the mechanism', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    // Slice 2a: a per-person key is added per agent, so the caption says so.
    // The stored keyMode is still 'personal' — only the words changed.
    expect(
      within(screen.getByTestId('connector-tile-my-notion')).getByText(
        'Each agent adds its own key',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('connector-tile-company-salesforce')).getByText(
        'One shared key for everyone',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/personal key/i)).toBeNull();
  });

  it('shows the empty state with no "catalog" language', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([]);
    render(<ConnectorsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no connectors yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Add one to make it available to the workspace\./),
    ).toBeInTheDocument();
    expect(screen.queryByText('Catalog')).toBeNull();
    expect(screen.queryByText(/catalog/i)).toBeNull();
  });

  it('surfaces a load error in an alert', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockRejectedValue(
      new Error('connectors boom'),
    );
    render(<ConnectorsTab />);
    await waitFor(() => {
      expect(screen.getByText('connectors boom')).toBeInTheDocument();
    });
  });

  it('an owner can edit a shared personal definition', async () => {
    vi.mocked(connectorsLib.listConnectors).mockResolvedValue([
      { ...PRIVATE_CONN, visibility: 'shared', canEdit: true },
    ]);
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    expect(within(tile).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('a definition the server marks read-only shows no Edit or Delete', async () => {
    vi.mocked(connectorsLib.listConnectors).mockResolvedValue([
      { ...SHARED_CONN, canEdit: false },
    ]);
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    const tile = screen.getByTestId('connector-tile-company-salesforce');
    expect(within(tile).queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(within(tile).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  // --- admin curation (TASK-127; admin-only since slice 2a) ----------------

  it('a connector the server sent without canEdit is editable (any admin may edit a shared one)', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    const tile = screen.getByTestId('connector-tile-company-salesforce');
    expect(within(tile).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('reads the list from /admin/connectors, never the /settings/connectors routes', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(connectorsLib.listConnectors).toHaveBeenCalledWith('/admin/connectors');
    expect(connectorsLib.listConnectors).not.toHaveBeenCalledWith('/settings/connectors');
  });

  it('shows admin curation controls (New + per-row Edit/Delete) for an admin', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(screen.getByRole('button', { name: /new connector/i })).toBeInTheDocument();
    const tile = screen.getByTestId('connector-tile-my-notion');
    expect(within(tile).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    // The connector "default" concept is gone: no per-row default toggle.
    expect(within(tile).queryByRole('button', { name: /default/i })).toBeNull();
  });

  it('admin "New connector" opens the create form', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    fireEvent.click(screen.getByRole('button', { name: /new connector/i }));
    expect(await screen.findByLabelText(/^name$/i)).toBeInTheDocument();
  });

  it('admin per-row Edit opens the edit form prefilled', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^edit$/i }));
    const nameInput = await screen.findByLabelText(/service name/i);
    await waitFor(() => expect(nameInput).toHaveValue('My Notion'));
  });

  it('admin Delete opens a styled confirm and deletes on confirm', async () => {
    const del = vi.spyOn(connectorsLib, 'deleteConnector').mockResolvedValue();
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/delete connector\?/i)).toBeInTheDocument();
    // The dialog's Delete button (the destructive confirm) is the last one.
    const dialogDelete = screen
      .getAllByRole('button', { name: /^delete$/i })
      .at(-1)!;
    fireEvent.click(dialogDelete);
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith('my-notion', '/admin/connectors'),
    );
  });

  it('a delete that lost the race to another admin says so plainly and reloads the list', async () => {
    vi.spyOn(connectorsLib, 'deleteConnector').mockRejectedValue(
      new Error(connectorsLib.CONNECTOR_GONE),
    );
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const listCalls = vi.mocked(connectorsLib.listConnectors).mock.calls.length;
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^delete$/i }));
    await screen.findByText(/delete connector\?/i);
    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i }).at(-1)!);
    expect(await screen.findByText('Someone already removed this connector.')).toBeInTheDocument();
    expect(screen.queryByText(/404/)).not.toBeInTheDocument();
    expect(vi.mocked(connectorsLib.listConnectors).mock.calls.length).toBeGreaterThan(listCalls);
  });

  // --- one flat list of definitions (no per-viewer status, no connect) -------
  //
  // Signing in / adding keys moved to each agent's Connectors tab, so this tab
  // must not grow a Connect / Update key, a Test probe, a "Ready" / "Needs a
  // key" status that's only true for whoever is looking, or a "Catalog" badge.

  it('renders one list with no Connected / Available shelves', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(screen.getByTestId('connector-tile-my-notion')).toBeInTheDocument();
    expect(screen.getByTestId('connector-tile-company-salesforce')).toBeInTheDocument();
    expect(screen.queryByText(/^Connected \(/)).toBeNull();
    expect(screen.queryByText(/^Available \(/)).toBeNull();
  });

  it('tells people where they sign in', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(
      screen.getByText(/People sign in from each agent’s Connectors tab\./),
    ).toBeInTheDocument();
  });

  it('an admin tile has no Test / Connect / Update key, no status words, no Catalog badge', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    for (const id of ['my-notion', 'company-salesforce']) {
      const tile = screen.getByTestId(`connector-tile-${id}`);
      expect(within(tile).queryByRole('button', { name: /^test$/i })).toBeNull();
      expect(within(tile).queryByRole('button', { name: /^connect$/i })).toBeNull();
      expect(within(tile).queryByRole('button', { name: /update key/i })).toBeNull();
      expect(tile.textContent).not.toMatch(/\bReady\b/);
      expect(tile.textContent).not.toMatch(/Needs a key/);
      expect(tile.textContent).not.toMatch(/Can't reach it|Checking…/);
      expect(tile.textContent).not.toMatch(/Catalog/);
    }
    // A tile's caption still says what it needs.
    expect(
      within(screen.getByTestId('connector-tile-company-salesforce')).getByText(
        'One shared key for everyone',
      ),
    ).toBeInTheDocument();
  });

  it('reads no credential presence and no full connector records', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    // Give any stray follow-up reads a chance to fire.
    await waitFor(() => expect(connectorsLib.listConnectors).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(connectorsLib.getConnector).not.toHaveBeenCalled();
    expect(credLib.adminCredentials.list).not.toHaveBeenCalled();
  });

  it('an editable tile shows exactly Edit and Delete', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    expect(
      within(tile)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Edit', 'Delete']);
  });

  it('a tile this person may not edit shows no buttons at all', async () => {
    vi.mocked(connectorsLib.listConnectors).mockResolvedValue([
      { ...SHARED_CONN, canEdit: false },
    ]);
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    const tile = screen.getByTestId('connector-tile-company-salesforce');
    expect(within(tile).queryAllByRole('button')).toEqual([]);
  });

  // Slice 2a: the two site lists moved to their own Settings › Sites page
  // (SitesTab.test.tsx). Connectors is an admin page; the site lists are
  // everyone's, so they must not ride along here.
  it('no longer carries the site lists', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(screen.queryByText('Allowed sites')).toBeNull();
    expect(screen.queryByText('Sites we read without asking')).toBeNull();
    expect(connLib.listAllAllowedSites).not.toHaveBeenCalled();
  });

  /*
    THE TAB'S HEADING LEVELS (TASK-446).

    A FRAGMENT, so the expected top level is 2, not 1: this body renders inside
    `AdminPane`, under the pane title's `h1` ("Connectors"). It used to open at
    `h3` with `h4` shelves under it, which — with no `h1` above it anywhere in
    the shell — meant the tab's outline began two levels down from a heading
    that did not exist.

    The `h2` is the tab's one top-level section (the two site sections that
    used to follow it moved to Settings › Sites in slice 2a); the `h3` is the
    Awaiting approval shelf inside it. The connector list itself
    is one flat list with no shelf headings (no Connected / Available split). Asserting the exact
    list, not just "no skipped levels", is what stops the levels being fixed by
    deleting a section heading.
  */
  it('opens at h2 and steps down one level to the Awaiting approval shelf', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([
      REQUEST_LINEAR,
    ]);
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');

    expect(headingOutlineProblems(document.body, 2)).toEqual([]);
    expect(headingOutline()).toEqual([
      'h2: Connectors',
      'h3: Awaiting approval (1)',
    ]);
  });
});
