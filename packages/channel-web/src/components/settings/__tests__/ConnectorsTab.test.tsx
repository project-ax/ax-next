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
    // Each tile derives connected-state + the connect plan from the full
    // connector. Default: a single api-key slot, account keyed off the id.
    vi.spyOn(connectorsLib, 'getConnector').mockImplementation(async (id: string) => {
      if (id === PRIVATE_CONN.id) return fullOf(PRIVATE_CONN);
      if (id === DEFAULT_ON_PRIVATE_CONN.id) return fullOf(DEFAULT_ON_PRIVATE_CONN);
      return fullOf(SHARED_CONN);
    });
    // No stored credentials by default → every connector reads "not connected".
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([]);
    vi.spyOn(credLib.adminCredentials, 'list').mockResolvedValue([]);
    // No proposed (pending authored) drafts by default → the Proposed shelf is
    // absent (#310). Tests that exercise the fallback override this.
    vi.spyOn(connectorsLib, 'listAuthoredPending').mockResolvedValue([]);
    // Allowed-sites lives in its own child panel now (AllowedSitesPanel, tested
    // separately). Stub its deps so the embedded panel is a quiet empty list and
    // these tests stay focused on the connector shelves.
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([]);
    vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists the user connectors by service name', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    expect(await screen.findByText('My Notion')).toBeInTheDocument();
    expect(screen.getByText('Salesforce')).toBeInTheDocument();
  });

  // The Settings "Proposed by your assistant" fallback (2026-06-03): a connector
  // the assistant proposed mid-turn lands as a PENDING authored draft. If the
  // in-chat approval card was missed, the user can approve it here.
  const PROPOSED_LINEAR: connectorsLib.PendingAuthoredConnector = {
    connectorId: 'linear',
    agentId: 'agt_1',
    name: 'Linear',
    usageNote: 'Drive the Linear CLI',
    keyMode: 'personal',
    status: 'pending',
    proposal: {
      allowedHosts: ['api.linear.app'],
      credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
      mcpServers: [],
      packages: { npm: ['@schpet/linear-cli'], pypi: [] },
    },
  };

  it('shows a "Proposed by your assistant" shelf when there are pending authored drafts', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending').mockResolvedValue([PROPOSED_LINEAR]);
    render(<ConnectorsTab isAdmin={false} />);
    expect(await screen.findByText(/Proposed by your assistant/i)).toBeInTheDocument();
    const tile = await screen.findByTestId('proposed-connector-linear');
    expect(within(tile).getByText('Linear')).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('omits the Proposed shelf when there are no pending drafts', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    expect(screen.queryByText(/Proposed by your assistant/i)).not.toBeInTheDocument();
  });

  it('approving a proposed connector writes the key then calls approve, and refreshes', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending')
      .mockResolvedValueOnce([PROPOSED_LINEAR]) // initial load
      .mockResolvedValue([]); // after approval → shelf empties
    const setCred = vi
      .spyOn(credLib, 'setDestinationCredential')
      .mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof credLib.setDestinationCredential>>);
    const approve = vi
      .spyOn(connectorsLib, 'approveAuthoredConnector')
      .mockResolvedValue(undefined);

    render(<ConnectorsTab isAdmin={false} />);
    const tile = await screen.findByTestId('proposed-connector-linear');
    fireEvent.click(within(tile).getByRole('button', { name: /approve/i }));

    // The approve dialog opens with a key field for the declared slot.
    const keyField = await screen.findByLabelText('LINEAR_API_KEY');
    fireEvent.change(keyField, { target: { value: 'lin_secret_123' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    // The key is written to the user's vault under the connector's account ref —
    // never sent through the approve call.
    expect(setCred).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { kind: 'account', service: 'linear' },
        payload: 'lin_secret_123',
        scope: { scope: 'user', ownerId: null },
      }),
    );
    expect(approve).toHaveBeenCalledWith('linear', {
      agentId: 'agt_1',
      shown: { hosts: ['api.linear.app'], slots: ['LINEAR_API_KEY'], npm: ['@schpet/linear-cli'], pypi: [] },
    });
  });

  it('offers a Dismiss action on a proposed connector', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending').mockResolvedValue([PROPOSED_LINEAR]);
    render(<ConnectorsTab isAdmin={false} />);
    const tile = await screen.findByTestId('proposed-connector-linear');
    expect(within(tile).getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('dismissing a proposed connector rejects it (no key) and refreshes the shelf', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending')
      .mockResolvedValueOnce([PROPOSED_LINEAR]) // initial load
      .mockResolvedValue([]); // after dismiss → shelf empties
    const setCred = vi
      .spyOn(credLib, 'setDestinationCredential')
      .mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof credLib.setDestinationCredential>>);
    const reject = vi
      .spyOn(connectorsLib, 'rejectAuthoredConnector')
      .mockResolvedValue(undefined);

    render(<ConnectorsTab isAdmin={false} />);
    const tile = await screen.findByTestId('proposed-connector-linear');
    fireEvent.click(within(tile).getByRole('button', { name: /dismiss/i }));

    // Confirm in the dialog (its own Dismiss button).
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^dismiss$/i }));

    await waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    expect(reject).toHaveBeenCalledWith('linear', { agentId: 'agt_1' });
    // Dismiss never touches the vault — that was the whole bug.
    expect(setCred).not.toHaveBeenCalled();
    // The shelf empties on refresh.
    await waitFor(() =>
      expect(screen.queryByTestId('proposed-connector-linear')).not.toBeInTheDocument(),
    );
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
        ref: 'account:my-notion',
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
    // The connected tile offers "Update credentials" (the credential enter/replace
    // dialog); the available tile offers Connect.
    const notionTile = screen.getByTestId('connector-tile-my-notion');
    expect(
      within(notionTile).getByRole('button', { name: /update credentials/i }),
    ).toBeInTheDocument();
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
        ref: 'account:my-notion',
        kind: 'api-key',
        createdAt: '2026-05-20T00:00:00Z',
      },
    ]);
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    await waitFor(() => expect(within(tile).getByText('Ready')).toBeInTheDocument());
    // The old literal status verb is gone from the tile (Manage button aside).
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
      // Connect/Manage button label.
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

  // --- user authoring (TASK-129) -------------------------------------------

  it('a non-admin gets "New connector" + Edit/Delete on a PRIVATE owned connector', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    // The authoring entry point is open to every user now.
    expect(
      screen.getByRole('button', { name: /new connector/i }),
    ).toBeInTheDocument();
    const privateTile = screen.getByTestId('connector-tile-my-notion');
    expect(
      within(privateTile).getByRole('button', { name: /^edit$/i }),
    ).toBeInTheDocument();
    expect(
      within(privateTile).getByRole('button', { name: /^delete$/i }),
    ).toBeInTheDocument();
  });

  it('a non-admin sees NO Edit/Delete on a catalog/shared connector (read-only)', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Salesforce');
    const sharedTile = screen.getByTestId('connector-tile-company-salesforce');
    expect(
      within(sharedTile).queryByRole('button', { name: /^edit$/i }),
    ).toBeNull();
    expect(
      within(sharedTile).queryByRole('button', { name: /^delete$/i }),
    ).toBeNull();
    // It still offers Connect/Manage — read-only ≠ unusable.
    expect(
      within(sharedTile).getByRole('button', { name: /^connect$/i }),
    ).toBeInTheDocument();
  });

  it('a non-admin sees NO Edit/Delete on an admin default-on (catalog) connector', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
      PRIVATE_CONN,
      DEFAULT_ON_PRIVATE_CONN,
    ]);
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Org GitHub');
    const defaultTile = screen.getByTestId('connector-tile-org-github');
    expect(
      within(defaultTile).queryByRole('button', { name: /^edit$/i }),
    ).toBeNull();
    expect(
      within(defaultTile).queryByRole('button', { name: /^delete$/i }),
    ).toBeNull();
    // …but the user's own private connector remains editable.
    const privateTile = screen.getByTestId('connector-tile-my-notion');
    expect(
      within(privateTile).getByRole('button', { name: /^edit$/i }),
    ).toBeInTheDocument();
  });

  it('a non-admin gets NO admin-only controls (set-default / Test)', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    expect(screen.queryByRole('button', { name: /set default/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^test$/i })).toBeNull();
  });

  it('non-admin "New connector" opens the user-variant create form (no Sharing field)', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    fireEvent.click(screen.getByRole('button', { name: /new connector/i }));
    expect(await screen.findByLabelText(/service name/i)).toBeInTheDocument();
    // The user variant hides the admin-only Sharing field.
    expect(screen.queryByLabelText(/^sharing$/i)).toBeNull();
  });

  it('non-admin Delete on a private connector deletes via the /settings/connectors route', async () => {
    const del = vi.spyOn(connectorsLib, 'deleteConnector').mockResolvedValue();
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/delete connector\?/i)).toBeInTheDocument();
    const dialogDelete = screen
      .getAllByRole('button', { name: /^delete$/i })
      .at(-1)!;
    fireEvent.click(dialogDelete);
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith('my-notion', '/settings/connectors'),
    );
  });

  // --- admin inline curation (TASK-127) ------------------------------------

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
      // The admin variant writes via the /admin/connectors route base (TASK-129).
      expect(patch).toHaveBeenCalledWith(
        'my-notion',
        { defaultAttached: true },
        '/admin/connectors',
      ),
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
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith('my-notion', '/admin/connectors'),
    );
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

  // Allowed sites moved into its own AllowedSitesPanel (one list across agents);
  // its behavior is covered by AllowedSitesPanel.test.tsx. ConnectorsTab only
  // embeds it (with deps stubbed empty in beforeEach).
  it('embeds the Allowed sites panel', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    expect(await screen.findByText('Allowed sites')).toBeInTheDocument();
  });
});
