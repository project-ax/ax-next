import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ConnectorsTab } from '../ConnectorsTab';
import * as connectorsLib from '@/lib/connectors';
import * as agentsLib from '@/lib/agents';
import * as connLib from '@/lib/connections';
import * as credLib from '@/lib/credentials';
import type { ConnectorSummary, Connector } from '@/lib/connectors';

const PRIVATE_CONN: ConnectorSummary = {
  id: 'my-notion',
  name: 'My Notion',
  description: 'Personal Notion workspace.',
  usageNote: 'Ask the agent to read or update Notion pages.',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

// A SHARED connector → catalog-sourced (badge present). keyMode workspace → the
// connect flow spends one shared key.
const SHARED_CONN: ConnectorSummary = {
  id: 'company-salesforce',
  name: 'Salesforce',
  description: 'The company Salesforce org.',
  usageNote: 'Drive the sf CLI for our workflows.',
  keyMode: 'workspace',
  visibility: 'shared',
  defaultAttached: false,
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

// An admin default-on connector that is still visibility:'private'. TASK-110:
// the user list must badge it "Catalog" via `defaultAttached`.
const DEFAULT_ON_PRIVATE_CONN: ConnectorSummary = {
  id: 'org-github',
  name: 'Org GitHub',
  description: 'The org GitHub, attached to every agent by default.',
  usageNote: 'Read and write org repos.',
  keyMode: 'workspace',
  visibility: 'private',
  defaultAttached: true,
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

/** Build the full connector a `getConnector` mock returns (carries capabilities). */
function fullOf(summary: ConnectorSummary, slotAccount?: string): Connector {
  return {
    ...summary,
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      credentials: [
        {
          slot: 'token',
          kind: 'api-key',
          ...(slotAccount !== undefined ? { account: slotAccount } : {}),
        },
      ],
    },
  };
}

describe('ConnectorsTab', () => {
  beforeEach(() => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
      PRIVATE_CONN,
      SHARED_CONN,
    ]);
    // Each tile derives connected-state + the connect plan from the full
    // connector. Default: a single api-key slot, account keyed off the id.
    vi.spyOn(connectorsLib, 'getConnector').mockImplementation(async (id: string) => {
      if (id === PRIVATE_CONN.id) return fullOf(PRIVATE_CONN, 'notion');
      if (id === DEFAULT_ON_PRIVATE_CONN.id) return fullOf(DEFAULT_ON_PRIVATE_CONN);
      return fullOf(SHARED_CONN);
    });
    // No stored credentials by default → every connector reads "not connected".
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([]);
    vi.spyOn(credLib.adminCredentials, 'list').mockResolvedValue([]);
    // Allowed-sites section deps — default empty so most tests focus on the
    // connector list. Tests that exercise allowed-sites override these.
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([]);
    vi.spyOn(connLib, 'getAllowedSites').mockResolvedValue({
      agentId: 'a1',
      hosts: [],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists the user connectors by service name', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    expect(await screen.findByText('My Notion')).toBeInTheDocument();
    expect(screen.getByText('Salesforce')).toBeInTheDocument();
  });

  it('renders Connected and Available section headers', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    expect(screen.getByText(/^Connected \(/)).toBeInTheDocument();
    expect(screen.getByText(/^Available \(/)).toBeInTheDocument();
  });

  it('puts a connector with all keys present on the Connected shelf, others on Available', async () => {
    // notion key stored → my-notion connected; salesforce missing → available.
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      {
        scope: 'user',
        ownerId: 'u1',
        ref: 'account:notion',
        kind: 'api-key',
        createdAt: '2026-05-20T00:00:00Z',
      },
    ]);
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    await waitFor(() => {
      expect(screen.getByText('Connected (1)')).toBeInTheDocument();
      expect(screen.getByText('Available (1)')).toBeInTheDocument();
    });
    // The connected tile offers Reconnect; the available tile offers Connect.
    const notionTile = screen.getByTestId('connector-tile-my-notion');
    expect(within(notionTile).getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
    const sfTile = screen.getByTestId('connector-tile-company-salesforce');
    expect(within(sfTile).getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
  });

  it('all connectors with no keys land on the Available shelf', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    await waitFor(() => {
      expect(screen.getByText('Available (2)')).toBeInTheDocument();
      expect(screen.getByText('Connected (0)')).toBeInTheDocument();
    });
  });

  it('shows the single "Catalog" badge ONLY on the catalog-sourced (shared) connector', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Salesforce');
    const badges = screen.getAllByText('Catalog');
    expect(badges).toHaveLength(1);
    const sharedTile = screen.getByTestId('connector-tile-company-salesforce');
    expect(sharedTile.textContent).toMatch(/Catalog/);
    const privateTile = screen.getByTestId('connector-tile-my-notion');
    expect(privateTile.textContent).not.toMatch(/Catalog/);
  });

  it('badges an admin default-on connector "Catalog" even when its visibility is private (TASK-110)', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
      PRIVATE_CONN,
      DEFAULT_ON_PRIVATE_CONN,
    ]);
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Org GitHub');
    const defaultTile = screen.getByTestId('connector-tile-org-github');
    expect(defaultTile.textContent).toMatch(/Catalog/);
    const privateTile = screen.getByTestId('connector-tile-my-notion');
    expect(privateTile.textContent).not.toMatch(/Catalog/);
    expect(screen.getAllByText('Catalog')).toHaveLength(1);
  });

  it('keeps the default view mechanism-free (no transport/command/url/args)', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/stdio/i);
    expect(body).not.toMatch(/transport/i);
    expect(body).not.toMatch(/command/i);
    expect(body).not.toMatch(/\bargs\b/i);
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('captions what each connector needs (a key) without naming the mechanism', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Salesforce');
    expect(screen.getByText(/shared key/i)).toBeInTheDocument();
    expect(screen.getByText(/personal key/i)).toBeInTheDocument();
  });

  it('shows the empty state with no "catalog" language for a solo user', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([]);
    render(<ConnectorsTab isAdmin={false} />);
    await waitFor(() => {
      expect(screen.getByText(/no connectors yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Catalog')).toBeNull();
    expect(screen.queryByText(/catalog/i)).toBeNull();
  });

  it('surfaces a load error in an alert', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockRejectedValue(
      new Error('connectors boom'),
    );
    render(<ConnectorsTab isAdmin={false} />);
    await waitFor(() => {
      expect(screen.getByText('connectors boom')).toBeInTheDocument();
    });
  });

  it('shows a Connect action on an Available tile and opens the connect dialog (self-connect)', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const privateTile = screen.getByTestId('connector-tile-my-notion');
    const connectBtn = within(privateTile).getByRole('button', { name: /^connect$/i });
    fireEvent.click(connectBtn);
    // The dialog loads the full connector and (personal) shows the key form.
    expect(await screen.findByText(/Connect My Notion/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/API key/i)).toBeInTheDocument();
  });

  // --- status wording (TASK-130): Ready / Needs a key / Can't reach it / Checking… ---

  it('a connector with all keys present reads "Ready" (no literal "connected" status)', async () => {
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      {
        scope: 'user',
        ownerId: 'u1',
        ref: 'account:notion',
        kind: 'api-key',
        createdAt: '2026-05-20T00:00:00Z',
      },
    ]);
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    await waitFor(() => expect(within(tile).getByText('Ready')).toBeInTheDocument());
    // The old literal status verb is gone from the tile (Reconnect button aside).
    expect(within(tile).queryByText(/^connected$/i)).toBeNull();
    expect(within(tile).queryByText(/^not connected$/i)).toBeNull();
  });

  it('a personal connector with NO stored key reads "Needs a key" (not the old "not connected")', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    await waitFor(() => expect(within(tile).getByText('Needs a key')).toBeInTheDocument());
    expect(within(tile).queryByText(/^not connected$/i)).toBeNull();
  });

  it('no literal "connected / not connected / checking…" status verbs remain on any tile', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    // status settles off the "Checking…" placeholder
    await waitFor(() =>
      expect(screen.getAllByText('Needs a key').length).toBeGreaterThan(0),
    );
    // Scope to the tiles, not the "Connected (n)" shelf headers / empty-state copy
    // (those are TASK-127 app-store sectioning, intentionally kept).
    for (const id of ['my-notion', 'company-salesforce']) {
      const tile = screen.getByTestId(`connector-tile-${id}`);
      expect(tile.textContent).not.toMatch(/\bnot connected\b/i);
      // status verb is one of the friendly four; the only "connect" left is the
      // Connect/Reconnect button label.
      expect(within(tile).queryByText(/^connected$/i)).toBeNull();
      expect(within(tile).queryByText(/checking…/i)).toBeNull();
    }
  });

  it('admin Test "unreachable" verdict reads "Can\'t reach it" (mechanism-agnostic)', async () => {
    vi.spyOn(connectorsLib, 'testConnector').mockResolvedValue({
      status: 'unreachable',
    });
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(tile.textContent).toMatch(/can't reach it/i));
    expect(tile.textContent).not.toMatch(/\bunreachable\b/i);
  });

  it('the self-connect of a workspace/shared connector shows the capability-consent gate', async () => {
    // Admin self-connecting a SHARED catalog connector. keyMode workspace → the
    // shared-key consent gate must show before any key form.
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('Salesforce');
    const tile = screen.getByTestId('connector-tile-company-salesforce');
    fireEvent.click(within(tile).getByRole('button', { name: /^connect$/i }));
    expect(
      await screen.findByText(
        /Sharing this key lets their assistant act as you on Salesforce/i,
      ),
    ).toBeInTheDocument();
    // Key form blocked until consent.
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

  // --- admin inline curation (TASK-127) ------------------------------------

  it('hides ALL curation controls (New/Edit/Delete/set-default/Test) from a non-admin', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    expect(screen.queryByRole('button', { name: /new connector/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /set default/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^test$/i })).toBeNull();
  });

  it('shows admin curation controls (New + per-row Edit/Delete/set-default/Test) for an admin', async () => {
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('My Notion');
    expect(screen.getByRole('button', { name: /new connector/i })).toBeInTheDocument();
    const tile = screen.getByTestId('connector-tile-my-notion');
    expect(within(tile).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /set default/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /^test$/i })).toBeInTheDocument();
  });

  it('admin "New connector" opens the create form', async () => {
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('My Notion');
    fireEvent.click(screen.getByRole('button', { name: /new connector/i }));
    expect(await screen.findByLabelText(/service name/i)).toBeInTheDocument();
  });

  it('admin per-row Edit opens the edit form prefilled', async () => {
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^edit$/i }));
    const nameInput = await screen.findByLabelText(/service name/i);
    await waitFor(() => expect(nameInput).toHaveValue('My Notion'));
  });

  it('admin set-default toggles defaultAttached via patchConnector and refreshes', async () => {
    const patch = vi
      .spyOn(connectorsLib, 'patchConnector')
      .mockResolvedValue(fullOf(PRIVATE_CONN));
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /set default/i }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('my-notion', { defaultAttached: true }),
    );
  });

  it('admin Delete opens a styled confirm and deletes on confirm', async () => {
    const del = vi.spyOn(connectorsLib, 'deleteConnector').mockResolvedValue();
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/delete connector\?/i)).toBeInTheDocument();
    // The dialog's Delete button (the destructive confirm) is the last one.
    const dialogDelete = screen
      .getAllByRole('button', { name: /^delete$/i })
      .at(-1)!;
    fireEvent.click(dialogDelete);
    await waitFor(() => expect(del).toHaveBeenCalledWith('my-notion'));
  });

  it('admin Test probes the connector and shows the verdict', async () => {
    vi.spyOn(connectorsLib, 'testConnector').mockResolvedValue({
      status: 'needs-key',
    });
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(tile.textContent).toMatch(/needs a key/i));
  });

  // --- allowed sites: own section + proactive add (TASK-131) ----------------

  it('shows the per-agent Allowed sites mirror and revokes a host', async () => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([
      { agentId: 'a1', displayName: 'Research', visibility: 'personal' },
    ]);
    vi.spyOn(connLib, 'getAllowedSites').mockResolvedValue({
      agentId: 'a1',
      hosts: [{ host: 'status.example.com', grantedAt: '2026-05-20T00:00:00Z' }],
    });
    const revoke = vi.spyOn(connLib, 'revokeAllowedSite').mockResolvedValue();
    render(<ConnectorsTab isAdmin={false} />);
    expect(await screen.findByText('Allowed sites')).toBeInTheDocument();
    expect(await screen.findByText('status.example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('a1', 'status.example.com'));
  });

  it('explains the Allowed sites section as "always allow" host grants, distinct from the connectors above', async () => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([
      { agentId: 'a1', displayName: 'Research', visibility: 'personal' },
    ]);
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Allowed sites');
    const caption = await screen.findByText(/always allow/i);
    expect(caption).toBeInTheDocument();
    expect(caption.textContent ?? '').toMatch(/connector/i);
  });

  it('proactively adds a site and reloads the list', async () => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([
      { agentId: 'a1', displayName: 'Research', visibility: 'personal' },
    ]);
    // First load empty; after the add, the list returns the new host.
    const getSites = vi
      .spyOn(connLib, 'getAllowedSites')
      .mockResolvedValueOnce({ agentId: 'a1', hosts: [] })
      .mockResolvedValue({
        agentId: 'a1',
        hosts: [{ host: 'docs.example.com', grantedAt: '2026-06-01T00:00:00Z' }],
      });
    const add = vi
      .spyOn(connLib, 'addAllowedSite')
      .mockResolvedValue({ created: true });

    render(<ConnectorsTab isAdmin={false} />);
    const input = await screen.findByRole('textbox', { name: /add a site/i });
    fireEvent.change(input, { target: { value: 'docs.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /add a site/i }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('a1', 'docs.example.com'),
    );
    // The list reloads (initial load + post-add reload) and shows the new host.
    expect(await screen.findByText('docs.example.com')).toBeInTheDocument();
    expect(getSites.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The input clears on success.
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('shows the add error inline and keeps the typed host', async () => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([
      { agentId: 'a1', displayName: 'Research', visibility: 'personal' },
    ]);
    vi.spyOn(connLib, 'getAllowedSites').mockResolvedValue({
      agentId: 'a1',
      hosts: [],
    });
    vi.spyOn(connLib, 'addAllowedSite').mockRejectedValue(
      new Error('That doesn’t look like a valid hostname.'),
    );

    render(<ConnectorsTab isAdmin={false} />);
    const input = await screen.findByRole('textbox', { name: /add a site/i });
    fireEvent.change(input, { target: { value: 'http://bad' } });
    fireEvent.click(screen.getByRole('button', { name: /add a site/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/valid hostname/i);
    // The bad host stays in the field so the user can fix it.
    expect((input as HTMLInputElement).value).toBe('http://bad');
  });
});
