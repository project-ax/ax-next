import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
// the user list must badge it "Catalog" via `defaultAttached`. Before TASK-110
// the LIST summary dropped `defaultAttached`, so this connector wrongly showed
// no badge (the badge keyed off `visibility` alone).
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
    defaultAttached: false,
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

  it('shows the single "Catalog" badge ONLY on the catalog-sourced (shared) connector', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Salesforce');
    // Exactly one Catalog badge across the whole tab (only the shared connector).
    const badges = screen.getAllByText('Catalog');
    expect(badges).toHaveLength(1);
    // It belongs to the Salesforce tile (the shared/catalog connector).
    const sharedTile = screen.getByTestId('connector-tile-company-salesforce');
    expect(sharedTile.textContent).toMatch(/Catalog/);
    // The private connector's tile carries no "Catalog" copy.
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
    // The default-on connector wears the single "Catalog" badge (sourced via
    // defaultAttached), the plain private one does not.
    const defaultTile = screen.getByTestId('connector-tile-org-github');
    expect(defaultTile.textContent).toMatch(/Catalog/);
    const privateTile = screen.getByTestId('connector-tile-my-notion');
    expect(privateTile.textContent).not.toMatch(/Catalog/);
    // Exactly one Catalog badge on the tab (only the default-on connector).
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
    // workspace keyMode → a shared key; personal → a personal key.
    expect(screen.getByText(/shared key/i)).toBeInTheDocument();
    expect(screen.getByText(/personal key/i)).toBeInTheDocument();
  });

  it('shows the empty state with no "catalog" language for a solo user', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([]);
    render(<ConnectorsTab isAdmin={false} />);
    await waitFor(() => {
      expect(screen.getByText(/no connected services/i)).toBeInTheDocument();
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

  it('shows a Connect action on each tile and opens the connect dialog', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const privateTile = screen.getByTestId('connector-tile-my-notion');
    const connectBtn = privateTile.querySelector('button');
    expect(connectBtn).not.toBeNull();
    fireEvent.click(connectBtn!);
    // The dialog loads the full connector and (personal) shows the key form.
    expect(await screen.findByText(/Connect My Notion/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/API key/i)).toBeInTheDocument();
  });

  it('a personal connector with NO stored key reads "not connected"', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    await waitFor(() => expect(tile.textContent).toMatch(/not connected/i));
  });

  it('a connector whose plan slot HAS a stored credential reads "connected"', async () => {
    // notion key stored at the per-user account vault → connected.
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
    await waitFor(() => {
      expect(tile.textContent).toMatch(/connected/i);
      expect(tile.textContent).not.toMatch(/not connected/i);
    });
    // The action reads "Reconnect" once connected.
    expect(tile.querySelector('button')?.textContent).toMatch(/reconnect/i);
  });

  it('the workspace connect dialog shows the shared-key consent gate (admin)', async () => {
    render(<ConnectorsTab isAdmin />);
    await screen.findByText('Salesforce');
    const tile = screen.getByTestId('connector-tile-company-salesforce');
    fireEvent.click(tile.querySelector('button')!);
    expect(
      await screen.findByText(
        /Sharing this key lets their assistant act as you on Salesforce/i,
      ),
    ).toBeInTheDocument();
    // Key form blocked until consent.
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

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
    // A one-line helper ties the section to the connectors above: these are
    // hosts the agent was granted "always allow", not connectors.
    const caption = await screen.findByText(/always allow/i);
    expect(caption).toBeInTheDocument();
    expect(caption.textContent ?? '').toMatch(/connector/i);
  });
});
